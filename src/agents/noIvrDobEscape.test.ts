/**
 * THE AFTER-HOURS LINE ASKS FOR A DATE OF BIRTH ONCE. THEN IT FILES ANYWAY.
 *
 * MEASURED 2026-09-16, substantive calls: the agent asked for a date of birth
 * two or more times on 73 calls fleet-wide, and **no-ivr was the worst lane by
 * a mile — 19 of the 20 calls that asked at all, eleven of them three or more
 * times, and one call FIFTEEN times.** The operator named this shape himself
 * on 2026-09-16: *"one that asks somebody something seven times, like that
 * shouldn't be possible, right?"*
 *
 * WHY THIS LANE AND NOT THE OTHERS. The four queue lanes route every filing
 * through `src/tools/registry.ts`, where `decideDobEscape` (`dobEscape.ts`)
 * has bounded the date-of-birth refusal at ONE per call since 2026-09-04 —
 * the operator's own ruling: *"If it doesn't work that way, then I say you
 * file it anyway. But when you file it, where date of birth would be, you just
 * put unavailable or unmatched."* Measured the day it shipped: the gate with
 * the escape recovered 9 of 11, the gate without it recovered 0 of 23.
 *
 * no-ivr builds its `create_ticket` BY HAND (`recordedTool` in
 * `noIvrAgent.ts`) and never reaches the registry. Its own DOB validation at
 * the top of the handler had **no counter, no key and no escape** — it could
 * return the same refusal on every invocation for the life of the call. That
 * is the fifteen-ask loop, and nothing else in the repo could see it:
 * `toolCeiling` is runtime-only, `conversationLoopGuard` only nudges (and
 * `src/director/director.ts:11` records the model ignoring it), and the PCP
 * ask budget is imported by `pcpAgent.ts` alone.
 *
 * THE DECISION THAT BLOCKED THIS WAS SETTLED BY THE LOGS, NOT BY A RULING.
 * The worry was that the after-hours ticket API might refuse a payload with
 * no date of birth — the 2026-09-14 shape (17 requests → HTTP 400) pointed at
 * the busiest overnight lane. `voice_agent_api_logs`, 14 days: **347 of 347
 * accepted no-ivr POSTs to /submit-ticket carried a `patientDOB` value, and
 * the B2B path already sends the literal `'Unknown'` there; the 10 rejections
 * were for `patientFullName` and `surgeon`, none for a date of birth.** So the
 * placeholder this escape sends is a value the API has been accepting all
 * along.
 *
 * WHAT THIS DRIVES: the REAL agent. `createNoIvrAgent` is constructed with the
 * same mock preamble other suites use, and `create_ticket` is invoked the way
 * the SDK invokes it. A unit test on `decideDobEscape` alone would prove the
 * helper works, which it already does on four lanes — the defect was that
 * this lane never called it (failure mode 10: test the source, not the sink).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({
    success: true,
    ticketNumber: 'VA-TEST',
  })),
  lookupByNameAndDOB: vi.fn(async () => ({
    patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
  })),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: (p: Record<string, unknown>) => h.submitSimplifiedTicket(p),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    lookupByNameAndDOB: (...a: unknown[]) => h.lookupByNameAndDOB(...(a as [])),
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: {
    getCallerMemory: async () => null,
    buildContextForPrompt: () => '',
  },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { resetDobHistory } = await import('../tools/dobEscape');

/** The SDK hands tools `(context, argsJson)` and may return an object or a
 *  JSON string depending on version — normalise both. */
async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
/** A canonical Twilio SID per test — the escape is keyed on it, and every
 *  one of the 299 substantive no-ivr calls of 09-10..09-16 carried one. */
const freshSid = () => `CA${(++n).toString(16).padStart(32, '0')}`;

async function agentFor(callSid: string) {
  // No callerPhone: skips the schedule/memory lookups at construction and the
  // open-ticket check inside the tool, which are not what is under test.
  return createNoIvrAgent(async () => {}, { callId: `call-${callSid}`, callSid });
}

/** A complete request whose only defect is the date of birth. Synthetic —
 *  RULE THREE: real SIDs and shapes in the repo, real words on disk. */
const request = (date_of_birth: string) => ({
  first_name: 'Test',
  last_name: 'Caller',
  date_of_birth,
  callback_number: '5551234567',
  request_category: 'general_question',
  request_summary: 'Wants to know whether the drops were called in to the pharmacy.',
});

/** The shape from the corpus: day, month and a two-digit year with a Spanish
 *  "del" between them, which this lane's parser cannot read. */
const UNREADABLE = '7 2 del 61';

beforeEach(() => {
  resetDobHistory();
  h.submitSimplifiedTicket.mockClear();
  h.lookupByNameAndDOB.mockClear();
});

describe('no-ivr create_ticket: an unreadable date of birth is asked for ONCE', () => {
  it('the first attempt still refuses, with the same wording as before', async () => {
    const sid = freshSid();
    const agent = await agentFor(sid);
    const r = await call(agent, 'create_ticket', request(UNREADABLE));
    expect(r.success).toBe(false);
    expect(r.validation_errors).toEqual(['complete date of birth (month, day, and year)']);
    expect(r.message).toMatch(/Missing required information: complete date of birth/);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  /**
   * THE FIX. Today the second attempt refuses identically, and the third, and
   * the fifteenth. After it, the second attempt files the request with the
   * date of birth marked UNMATCHED for the staffer — the same escape and the
   * same wording the queue lanes have carried since 2026-09-04.
   */
  it('the second attempt on the SAME call files anyway, marked unmatched', async () => {
    const sid = freshSid();
    const agent = await agentFor(sid);
    await call(agent, 'create_ticket', request(UNREADABLE));
    const r = await call(agent, 'create_ticket', request(UNREADABLE));

    expect(r.success, 'second refusal — this is the fifteen-ask loop').toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    // The value the API has accepted on 347 of 347 POSTs; never the caller's
    // unreadable words in a date field.
    expect(sent.patientDOB).toBe('Unknown');
    expect(sent.patientFullName).toBe('Test Caller');
    // The status the staffer reads, above the request. UNMATCHED, because the
    // caller DID say something — the recording has it.
    expect(String(sent.additionalDetails)).toMatch(/DATE OF BIRTH UNMATCHED/);
    expect(String(sent.additionalDetails)).toMatch(/call recording/i);
    // And never the unreadable string itself in the note — that is PHI and
    // belongs in the recording.
    expect(String(sent.additionalDetails)).not.toContain(UNREADABLE);
    // A partial parse must not be handed to the name+DOB schedule lookup —
    // before the escape existed the early return kept it out, and the escape
    // must not open that door.
    expect(h.lookupByNameAndDOB).not.toHaveBeenCalled();
  });

  it('whitespace is "sent nothing", so the second attempt is marked UNAVAILABLE', async () => {
    const sid = freshSid();
    const agent = await agentFor(sid);
    await call(agent, 'create_ticket', request('   '));
    const r = await call(agent, 'create_ticket', request('   '));
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.patientDOB).toBe('Unknown');
    expect(String(sent.additionalDetails)).toMatch(/DATE OF BIRTH UNAVAILABLE/);
  });

  it('the escape is PER CALL — a different call is asked again', async () => {
    const a = await agentFor(freshSid());
    const b = await agentFor(freshSid());
    await call(a, 'create_ticket', request(UNREADABLE));
    const r = await call(b, 'create_ticket', request(UNREADABLE));
    expect(r.success, 'one caller\'s refusal counted for another\'s').toBe(false);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('the existing appointment note survives beside the status note', async () => {
    const sid = freshSid();
    const agent = await agentFor(sid);
    const withAppt = { ...request(UNREADABLE), appointment_time: 'Tuesday at 8' };
    await call(agent, 'create_ticket', withAppt);
    await call(agent, 'create_ticket', withAppt);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(String(sent.additionalDetails)).toMatch(/DATE OF BIRTH UNMATCHED/);
    expect(String(sent.additionalDetails)).toMatch(/Appointment: Tuesday at 8/);
  });
});

describe('what does NOT change', () => {
  it('a readable date of birth files on the first attempt, with the date, no note', async () => {
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request('01/04/1958'));
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.patientDOB).toBe('01/04/1958');
    expect(sent.additionalDetails ?? '').not.toMatch(/DATE OF BIRTH/);
    // The readable date still reaches the name+DOB lookup, as before.
    expect(h.lookupByNameAndDOB).toHaveBeenCalledTimes(1);
  });

  it('the B2B placeholder still files on the first attempt, exactly as before', async () => {
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request('DOB not available'));
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.patientDOB).toBe('Unknown');
    expect(sent.additionalDetails ?? '').not.toMatch(/DATE OF BIRTH/);
  });
});
