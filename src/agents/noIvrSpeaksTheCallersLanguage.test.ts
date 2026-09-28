/**
 * THE AFTER-HOURS LINE CAN FOLLOW A SPANISH CALLER ON THE RUNTIME (v75).
 *
 * xAI, Speech to Speech → Supported Languages: *"The model automatically
 * detects the input language and responds naturally in the same language — no
 * configuration required."* → Language Hint: *"Bias transcription toward a
 * specific language by setting audio.input.transcription.language_hint ...
 * Can be changed mid-session. For Spanish and Portuguese, you must specify a
 * regional variant (e.g. "es-MX", "es-ES")."*
 *
 * The four queue lanes have carried `set_spoken_language` since 2026-09-03; it
 * is how the model tells the bridge to send that mid-session hint. The
 * after-hours lane builds its tools by hand and never had it, so on the
 * runtime — where it is about to move, carrying all overnight and weekend
 * volume — its transcription could never follow a caller who switched.
 *
 * WHAT THIS DRIVES: the REAL agent (`createNoIvrAgent`), the tool invoked the
 * way the SDK invokes it, and the bridge's name table read from source — a
 * test on `spokenLanguageResult` alone would prove the helper and not that
 * this lane carries it or that the bridge would act on it (failure mode 10).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

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
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { DEFAULT_LANGUAGE_TOOL_NAMES } = await import('../runtime/mediaStreamBridge');
const { SET_SPOKEN_LANGUAGE_TOOL_NAME, SET_SPOKEN_LANGUAGE_DESCRIPTION } = await import('../tools/languageTools');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const META = {
  callId: 'noivr-lang-1',
  callSid: 'CA0000000000000000000000000000abcd',
  callerPhone: '+15555550100',
  get callLogId() { return 4242; },
} as any;

describe('the after-hours lane speaks the caller\'s language', () => {
  it('carries set_spoken_language, under the name the bridge switches on', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const names = agent.tools.map((t: any) => t.name);
    expect(names).toContain(SET_SPOKEN_LANGUAGE_TOOL_NAME);
    // The bridge matches the tool by NAME (DEFAULT_LANGUAGE_TOOL_NAMES) and
    // reads `language` off its result; a renamed copy would be inert.
    expect(DEFAULT_LANGUAGE_TOOL_NAMES).toContain(SET_SPOKEN_LANGUAGE_TOOL_NAME);
  });

  it('answers "Spanish" with the tag the wire accepts, and the bridge makes it es-MX', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const out = await call(agent, SET_SPOKEN_LANGUAGE_TOOL_NAME, { language: 'Spanish' });
    expect(out).toMatchObject({ success: true, language: 'es' });
    // The regional variant the docs require for Spanish is the SESSION's job
    // (sttLanguageHint), and the same function the queue lanes' switch uses.
    const { sttLanguageHint } = await import('../runtime/language');
    expect(sttLanguageHint(out.language)).toBe('es-MX');
  });

  it('asks rather than switching when it is handed nothing', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const out = await call(agent, SET_SPOKEN_LANGUAGE_TOOL_NAME, { language: '   ' });
    expect(out.success).toBe(false);
    expect(out).not.toHaveProperty('language');
  });

  it('carries the SAME words as the registry copy — one description, not two', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const t = (agent as any).tools.find((x: any) => x.name === SET_SPOKEN_LANGUAGE_TOOL_NAME);
    expect(t?.description).toBe(SET_SPOKEN_LANGUAGE_DESCRIPTION);
  });

  /**
   * The prompt's language block is written in the shape xAI's Prompting Guide
   * calls a language lock — *"Control language explicitly if unwanted language
   * switching appears"* — and names the tool, because the guide's tool rule is
   * that a tool the prompt scripts must be on the tool list and vice versa.
   */
  it('the prompt names the tool and the two languages this line speaks', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const p = String(agent.instructions);
    expect(p).toMatch(/call set_spoken_language\s+with "Spanish"/);
    expect(p).toMatch(/You speak English and Spanish\. Start in English\./);
    expect(p).toMatch(/Switch only if the caller switches/);
    expect(p).toMatch(/Keep every tool ARGUMENT in English/);
    // The old workaround wording is gone.
    expect(p).not.toMatch(/English and Spanish are the ONLY languages you speak/);
    expect(p).not.toMatch(/EVERYTHING else .* stays in ENGLISH/);
  });

  it('the source carries no second copy of the tool\'s words', () => {
    const src = readFileSync('src/agents/noIvrAgent.ts', 'utf8');
    expect(src).not.toContain('Switch the language you speak and listen in');
    expect(src).toContain('spokenLanguageResult(');
  });
});
