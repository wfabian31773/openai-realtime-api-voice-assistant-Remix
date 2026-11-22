import { describe, it, expect, vi } from 'vitest';

/**
 * v265: a caller the agent has heard is never read the after-hours ghost
 * script, and nobody on this line is told to call back (standing
 * instruction 10).
 *
 * The before: the runtime Grok body scripted the ghost exchange as
 *   "What can I help you with today?", then "I'm having trouble hearing you.
 *    If you need assistance, please call back.", then "Take care, goodbye."
 * and the model said its middle line to callers it HAD heard: on 14 no-ivr
 * runtime calls between 2026-11-08 and 2026-11-22 the agent told a caller
 * with a transcribed line to call back, and 4 of those 14 calls have no
 * ticket of any provenance. A true ghost (no caller transcript) is the
 * runtime silence ladder's to end, and that is untouched.
 *
 * The corpus below is the 14 calls by real call SID with a SYNTHETIC stand-in
 * for the caller's line in the same shape (the real words stay on disk), plus
 * two controls: heard callers who only asked the agent to repeat itself.
 */

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
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { GHOST_CALL_RESTRICTION, hasCallerTranscript, ghostCallRefusal } = await import(
  '../services/ghostCallProtection'
);

async function grokBody(callSid: string): Promise<string> {
  const agent = await createNoIvrAgent(async () => {}, {
    callId: `ghost-${callSid}`,
    callSid,
    callerPhone: '+15555550100',
    pipeline: 'runtime',
  } as any);
  return String((agent as any).instructions);
}

/** Every line the body tells the agent to SAY, i.e. every quoted string. */
function scriptedLines(body: string): string[] {
  return [...body.matchAll(/"([^"]{3,})"/g)].map((m) => m[1]);
}

const TOLD_TO_CALL_BACK = /\bcall(?:s|ing)?\s+(?:us\s+)?back\b|\bllam(?:e|ar)\s+(?:de\s+)?nuevo\b/i;

/** The 14 calls of 2026-11-08..22 whose heard caller was told to call back. */
const CORPUS: Array<{ sid: string; ticket: string | null; caller: string }> = [
  { sid: 'CA20cc4cd1c2c9f9414b7a4e485fb396a1', ticket: 'VA-82944', caller: 'Hello?' },
  { sid: 'CAf28da19f20714f2da2f1f3e12839c7dc', ticket: null, caller: 'Hello? Can you hear me?' },
  { sid: 'CA9da0497abf20966a1f889af9c7a370bc', ticket: 'VA-84160', caller: 'Yes, hi.' },
  { sid: 'CAab6a2ae09fab5cd7e2560e2463baa598', ticket: 'VA-85387', caller: '¿Bueno? ¿Hola?' },
  { sid: 'CA1024155df48383630817b2589dc859d6', ticket: 'VA-85445', caller: 'Hello, hello?' },
  { sid: 'CA20b708aceb0702468389d427ed32df39', ticket: 'VA-86167', caller: 'Hi, I need to reschedule.' },
  { sid: 'CAdb24e7255c2ed4427be3427e8ef87749', ticket: null, caller: 'Hello?' },
  { sid: 'CA2a92384a4fc14174d9273db2f5e58315', ticket: 'VA-87792', caller: 'Yeah, I am here.' },
  { sid: 'CAde22ea2c7e8197ba754a768e2d09711e', ticket: 'VA-88326', caller: 'Hello? Is anyone there?' },
  { sid: 'CA44630cf469e63ec0a23ea421b8872b9d', ticket: null, caller: 'Hello?' },
  { sid: 'CA2a6772933998a774e44e19906ffbbf7a', ticket: 'VA-88329', caller: 'Hi, yes.' },
  { sid: 'CA686fc1953cd1be93d112d7a9a27fd2b3', ticket: 'VA-88334', caller: 'I have a question about my appointment.' },
  { sid: 'CAbc4c801506d269ec3cde2d27cab795a0', ticket: 'VA-88344', caller: 'Hello?' },
  { sid: 'CA6d34f1f2690bc12298a0019cb1051a05', ticket: null, caller: 'Hello? Hello?' },
];

/** Heard callers who only asked the agent to repeat itself. */
const CONTROLS = [
  { sid: 'CA05d2d0e942b9a2f66522535eb548c5ea', caller: 'Sorry, can you repeat that?' },
  { sid: 'CA917a784fe35d78661accbb9e420b5ab0', caller: 'What? Say that again.' },
];

describe('v265: a heard caller is never a ghost, and is never told to call back', () => {
  it('the corpus is the 14 calls, 4 of them with no ticket', () => {
    expect(CORPUS).toHaveLength(14);
    expect(new Set(CORPUS.map((c) => c.sid)).size).toBe(14);
    expect(CORPUS.filter((c) => c.ticket === null)).toHaveLength(4);
    for (const c of [...CORPUS, ...CONTROLS]) expect(c.sid).toMatch(/^CA[0-9a-f]{32}$/);
  });

  it.each([...CORPUS, ...CONTROLS])('$sid: the caller was heard, and nothing the body scripts tells them to call back', async ({ sid, caller }) => {
    // The caller's line is a transcript, so the runtime's own guard refuses a
    // ghost_call hangup on this call (v131): they are not a ghost.
    expect(hasCallerTranscript(`AGENT: What can I help you with today?\nCALLER: ${caller}`)).toBe(true);
    expect(ghostCallRefusal('ghost_call', true)).not.toBeNull();

    const body = await grokBody(sid);
    const toldToCallBack = scriptedLines(body).filter((line) => TOLD_TO_CALL_BACK.test(line));
    expect(toldToCallBack).toEqual([]);
    expect(body).not.toContain("I'm having trouble hearing you");
    // What the agent says instead, to a caller who may not hear it.
    expect(body).toContain('"I\'m here. Can you hear me?"');
    expect(body).toContain('never tell them to call back');
  });

  it('names a heard caller as not a ghost, "Hello?" included', async () => {
    const body = await grokBody('CA0000000000000000000000000000beef');
    expect(body).toContain('Anyone who said anything, even one word or "Hello?", is never a ghost');
    // The heard-caller rule follows the ghost script, and the restriction
    // the ghost-call tool enforces is stated beside both.
    const ghost = body.indexOf('Ghost — no caller transcript');
    const heard = body.indexOf('is never a ghost');
    expect(ghost).toBeGreaterThan(-1);
    expect(heard).toBeGreaterThan(ghost);
    expect(body.indexOf(GHOST_CALL_RESTRICTION)).toBeGreaterThan(heard);
  });

  it('asks "Can you hear me?" only when the caller may not hear the agent', async () => {
    // #513 review: a caller who has stated a request is answered, not asked
    // whether they can hear us. The check is gated on a repeated "Hello?"
    // or no request at all, and comes after that condition.
    const body = await grokBody('CA0000000000000000000000000000beef');
    const gate = body.indexOf('If they repeat "Hello?" or make no request, they may not hear you');
    const check = body.indexOf('"I\'m here. Can you hear me?"');
    expect(gate).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(gate);
  });

  it('repeats its last question after the check, so a caller mid-intake is not asked their request again', async () => {
    // #513 review, round 2: a caller mid-intake who repeats "Hello?" while
    // waiting is not asked for their request again. After the check the agent
    // repeats the question it last asked: the intake step it was on, or, for a
    // caller who has made no request, the greeting's "how can I help you?".
    const body = await grokBody('CA0000000000000000000000000000beef');
    expect(body).toContain('"I\'m here. Can you hear me?" once, then repeat your last question;');
    expect(body).not.toContain('or ask what they need');
    const check = body.indexOf('"I\'m here. Can you hear me?"');
    const repeat = body.indexOf('then repeat your last question', check);
    const never = body.indexOf('never tell them to call back', check);
    expect(repeat).toBeGreaterThan(check);
    expect(never).toBeGreaterThan(repeat);
  });

  it('still ends a true ghost and a robot, and still never escalates for either', async () => {
    const body = await grokBody('CA0000000000000000000000000000beef');
    expect(body).toContain('"What can I help you with today?", then "Take care, goodbye." and call terminate_call with reason "ghost_call"');
    expect(body).toContain('terminate_call with reason "robot_call"');
    // #513 review: "press 1" does not cover "For English, press 2".
    expect(body).toContain('"press 1", "leave a message after the tone", "your call is important to us", "for English press"');
    expect(body).toContain('NEVER escalate to a human, including at 1 AM');
    expect(body).toContain('never for a ghost, a robot or a failed tool');
    expect(body).toContain('A need_identity result is not a transfer.');
  });
});
