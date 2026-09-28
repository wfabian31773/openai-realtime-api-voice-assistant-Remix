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
