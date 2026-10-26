/**
 * THE AFTER-HOURS LINE CAN FOLLOW A SPANISH CALLER ON THE RUNTIME — BECAUSE THE
 * RUNTIME MAKES IT SO (v75, moved to the runtime on v77).
 *
 * xAI, Speech to Speech: *"The model automatically detects the input language
 * … no configuration required."* → Language Hint: *"Bias transcription toward
 * a specific language by setting audio.input.transcription.language_hint …
 * Can be changed mid-session. For Spanish … you must specify a regional
 * variant (e.g. "es-MX")."*
 *
 * v75 gave this lane a hand-built copy of `set_spoken_language`, the fifth
 * lane to list the same tool. The operator asked whether that should not be
 * the runtime's in general; v77 made it so: `laneRegistry` binds the tool to
 * every lane (`RUNTIME_OWNED_TOOLS`) and `languageMechanism.ts` appends the
 * one copy of the words, with this lane's English-and-Spanish policy rendered
 * from its registration. This file keeps the lane-specific claims — the
 * policy, the regional hint, and that the legacy body (old core) no longer
 * scripts a tool it does not have.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
process.env.XAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: async () => ({ success: true, ticketNumber: 'VA-TEST' }),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { resolveLane, defaultLaneSource } = await import('../runtime/laneRegistry');
const { createNoIvrAgent } = await import('./noIvrAgent');
const { sttLanguageHint } = await import('../runtime/language');
const { languageToSwitchTo } = await import('../runtime/mediaStreamBridge');
const { LANGUAGE_NOT_SPOKEN_HERE, languageAllowedOnThisLine, spokenLanguageResult } = await import('../tools/languageTools');

async function noIvrOnTheRuntime() {
  const source = await defaultLaneSource();
  const lane = await resolveLane(
    'no-ivr',
    { callSid: 'CA0000000000000000000000000000abcd', callId: 'noivr-lang-1', callerPhone: '+15555550100', dialedNumber: '+15555550199', pipeline: 'runtime' },
    { source, env: {}, handoff: () => async () => undefined },
  );
  expect(lane).not.toBeNull();
  return lane!;
}

describe("the after-hours lane speaks the caller's language, by the runtime's hand", () => {
  it('is offered set_spoken_language by the runtime and answers "Spanish" with the tag the wire accepts', async () => {
    const lane = await noIvrOnTheRuntime();
    expect(lane.agent.toolNames).toContain('set_spoken_language');
    const out = await lane.agent.dispatch('set_spoken_language', { language: 'Spanish' });
    expect(JSON.parse(out.output)).toMatchObject({ success: true, language: 'es' });
    // The regional variant the docs require is the SESSION's job, the same
    // function the queue lanes' switch has always used.
    expect(sttLanguageHint('es')).toBe('es-MX');
  });

  it('asks rather than switching when handed nothing', async () => {
    const lane = await noIvrOnTheRuntime();
    const out = await lane.agent.dispatch('set_spoken_language', { language: '   ' });
    const parsed = JSON.parse(out.output);
    expect(parsed.success).toBe(false);
    expect(parsed).not.toHaveProperty('language');
  });

  it("carries this line's policy — English and Spanish — in the runtime's one language block", async () => {
    const p = (await noIvrOnTheRuntime()).agent.instructions;
    expect(p).toContain('This line speaks English and Spanish.');
    expect(p).toMatch(/call set_spoken_language with that language/);
    expect(p).toMatch(/Switch only if the caller switches/);
    // The lane's own text no longer carries a second copy of the mechanism.
    expect(p.match(/set_spoken_language/g)!.length).toBe(1);
    expect(p).not.toMatch(/English and Spanish are the ONLY languages you speak/);
  });

  /**
   * CODEX P2 ON #336: the runtime bound the SAME tool to every lane, so this
   * lane's prompt said "for any other language, continue in English" while
   * its tool said "call this the moment the caller speaks another language —
   * then carry on in that language", and the tool's result is the newer
   * instruction. A Tagalog caller would have had the whole session retargeted
   * into Tagalog against the policy. The policy now reaches the tool as
   * injected context and the tool refuses at dispatch.
   */
  it('refuses a language this line does not speak — no `language` key, so the wire does not move', async () => {
    const lane = await noIvrOnTheRuntime();
    const out = await lane.agent.dispatch('set_spoken_language', { language: 'Tagalog' });
    expect(out.ok).toBe(true); // a refusal is an ANSWER to the model, not a tool failure
    const parsed = JSON.parse(out.output);
    expect(parsed.success).toBe(false);
    expect(parsed).not.toHaveProperty('language');
    expect(parsed).not.toHaveProperty('message'); // v43: nothing for the caller to hear from a rule
    expect(parsed.suppressed).toBe(LANGUAGE_NOT_SPOKEN_HERE);
    expect(parsed.fix).toContain('This line speaks English and Spanish.');
    expect(parsed.fix).toMatch(/Tagalog/);
    expect(parsed.fix).toMatch(/NOTHING was switched/);
    // The bridge's own reader — the ONE place a switch reaches the session.
    expect(languageToSwitchTo(parsed)).toBeUndefined();
  });

  it('still switches to either language it does speak, by name or by tag', async () => {
    const lane = await noIvrOnTheRuntime();
    for (const [asked, tag] of [['Spanish', 'es'], ['es-MX', 'es'], ['English', 'en'], ['en', 'en']] as const) {
      const parsed = JSON.parse((await lane.agent.dispatch('set_spoken_language', { language: asked })).output);
      expect(parsed, asked).toMatchObject({ success: true, language: tag });
      expect(languageToSwitchTo(parsed), asked).toBe(tag);
    }
  });

  it('the policy is compared on normalised tags — a registration written as names or regional codes still means the same languages', () => {
    // The registered lane's list is already ['en','es'], so the dispatch tests
    // above cannot see this: a mutation comparing raw strings survived them.
    // The predicate's own contract is that "Spanish", "es" and "es-MX" are one
    // language, whichever side of the comparison spells it which way.
    expect(languageAllowedOnThisLine('es', ['English', 'Spanish'])).toBe(true);
    expect(languageAllowedOnThisLine('es', ['en', 'es-MX'])).toBe(true);
    expect(languageAllowedOnThisLine('tl', ['English', 'Spanish'])).toBe(false);
    expect(languageAllowedOnThisLine('tl', undefined)).toBe(true);
    expect(languageAllowedOnThisLine('tl', [])).toBe(true);
    expect(spokenLanguageResult('Spanish', ['English', 'es-MX'])).toMatchObject({ success: true, language: 'es' });
    expect(spokenLanguageResult('Korean', ['English', 'es-MX'])).toMatchObject({ success: false, suppressed: LANGUAGE_NOT_SPOKEN_HERE });
  });

  it("the tool's own words carry this line's policy, so the description and the prompt agree", async () => {
    const lane = await noIvrOnTheRuntime();
    const def = lane.agent.tools.find((t) => t.name === 'set_spoken_language')!;
    expect(def.description).toContain('This line speaks English and Spanish.');
    expect(def.description).toMatch(/Do NOT call it for any other language/);
    expect(def.description).not.toMatch(/speaks a language other than the one you are using/);
    // The shared tail survives on both shapes of the description.
    expect(def.description).toMatch(/Keep the ARGUMENTS you send to every other tool in English/);
  });

  it('the old-core body scripts no tool it does not have, and still states the policy', async () => {
    // No `pipeline`, so the legacy body; on that pipeline the runtime binds nothing.
    const agent = await createNoIvrAgent(async () => {}, { callId: 'legacy-1', callSid: 'CA0000000000000000000000000000abce' } as any);
    const p = String((agent as any).instructions);
    expect(agent.tools.map((t: any) => t.name)).not.toContain('set_spoken_language');
    expect(p).not.toContain('set_spoken_language');
    expect(p).toMatch(/You speak English and Spanish\. Start in English\./);
    expect(p).toMatch(/Switch only if the caller switches/);
  });
});
