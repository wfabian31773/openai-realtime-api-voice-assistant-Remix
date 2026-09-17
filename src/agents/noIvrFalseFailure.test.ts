/**
 * THE AFTER-HOURS LINE MUST NOT TELL A CALLER THEIR FILING FAILED WHEN IT DID NOT.
 *
 * Two calls on 2026-09-16, one shape, two roads — diagnosed from
 * `tool_timeline` and `tickets`, not from the transcript:
 *
 *   CA…11e362485f  the model fired create_ticket TWICE, overlapping. Attempt A
 *                  (9.3s) filed VA-60434 at 14:56:48.66 and returned success at
 *                  14:56:50.67. Attempt B started while A held the per-call
 *                  lock, waited the fixed 3s, found no ticket number written
 *                  back yet, and returned "Concurrent ticket creation in
 *                  progress" at 14:56:50.24 — 0.4s BEFORE A's success.
 *   CA…7074e29c0c  create_ticket hit the 15,000ms client timeout while the
 *                  server finished the insert at the same instant. VA-60429
 *                  exists. The corpus note calling it unfiled was wrong.
 *
 * In both, the handler's catch-all mapped a non-validation failure to the
 * "technical system error… apologize… end the call" copy, so the caller heard
 * a failure for a filing that succeeded. On the second call the caller was 20
 * minutes late for an 8:00 appointment; the ticket that would have told the
 * office existed and she was told it did not.
 *
 * 14-day before-arm, no-ivr `tool_timeline`: 3 contention refusals (every one
 * of them on a call that also holds a successful create_ticket and a ticket)
 * and 1 timeout (ticket exists). Small — and every one is a caller told a
 * filing failed when it did not, which is the operator's own definition of a
 * mistake: "did they give them a ticket number? Was the ticket generated?"
 *
 * TWO REFUSALS ARE NOT FAILURES AND MUST NOT SPEAK AS ONE:
 *
 *   contention — another attempt on THIS call is in flight and its result is
 *                on its way. Say nothing, do not retry, wait for it.
 *   timeout    — the server may have finished. `submitSimplifiedTicket` sends
 *                `idempotencyKey: call-<sid>` and the ticketing app returns the
 *                cached result for a key it has seen, so ONE retry cannot open
 *                a second ticket and usually returns the number. Bounded to one
 *                per call through gateAttempts; a SECOND timeout is a real
 *                outage and gets the apology as before.
 *
 * Everything else — a validation failure, an ordinary API error — is untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({
    success: true,
    ticketNumber: 'VA-TEST',
    message: 'VA-TEST',
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
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { resetGateAttempts } = await import('../tools/gateAttempts');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
const freshSid = () => `CA${(++n).toString(16).padStart(32, '0')}`;
const agentFor = (callSid: string) =>
  createNoIvrAgent(async () => {}, { callId: `call-${callSid}`, callSid });

/** A complete, readable request — nothing here should refuse. Synthetic. */
const request = {
  first_name: 'Test',
  last_name: 'Caller',
  date_of_birth: '01/04/1958',
  callback_number: '5551234567',
  request_category: 'general_question',
  request_summary: 'Running late for the 8:00 appointment, wants the office told.',
};

const CONTENTION = {
  success: false,
  error: 'Concurrent ticket creation in progress',
  message: 'Please wait a moment and try again.',
};
const TIMEOUT = {
  success: false,
  error: 'Ticketing API timeout after 15000ms - please try again',
  message: 'There was a technical issue. Please try again.',
};
const ORDINARY_FAILURE = {
  success: false,
  error: 'Validation failed',
  message: 'There was a problem creating your request. Please try again.',
};

/** The sentence that reached both callers. */
const APOLOGY = /technical (system )?(error|issue)/i;

beforeEach(() => {
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
});

describe('a concurrent duplicate attempt is not a failure', () => {
  it('does not speak the apology, tells the model to wait, and forbids another call', async () => {
    h.submitSimplifiedTicket.mockResolvedValueOnce(CONTENTION as any);
    const r = await call(await agentFor(freshSid()), 'create_ticket', request);
    expect(r.success).toBe(false);
    expect(r.message, 'the contention branch spoke the failure line').not.toMatch(APOLOGY);
    // The instruction may SAY 'do not apologise'; what must be absent is the apology itself.
    expect(r.message).not.toMatch(/apologize sincerely|I'm sorry/i);
    expect(r.message).toMatch(/already in progress/i);
    expect(r.message).toMatch(/do not call create_ticket again/i);
    expect(r.message).toMatch(/nothing has failed/i);
  });
});

describe('a client timeout is retried once, because the server may have filed', () => {
  it('the first timeout asks for ONE more attempt and does not speak the apology', async () => {
    h.submitSimplifiedTicket.mockResolvedValueOnce(TIMEOUT as any);
    const r = await call(await agentFor(freshSid()), 'create_ticket', request);
    expect(r.success).toBe(false);
    expect(r.message).not.toMatch(APOLOGY);
    expect(r.message).toMatch(/once more/i);
    expect(r.message).toMatch(/not open a second ticket|will not create a duplicate/i);
  });

  it('the retry that succeeds is an ordinary success', async () => {
    const agent = await agentFor(freshSid());
    h.submitSimplifiedTicket.mockResolvedValueOnce(TIMEOUT as any);
    await call(agent, 'create_ticket', request);
    const r = await call(agent, 'create_ticket', request);
    expect(r.success).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(2);
  });

  it('a SECOND timeout on the same call is a real outage and gets the apology', async () => {
    const agent = await agentFor(freshSid());
    h.submitSimplifiedTicket.mockResolvedValueOnce(TIMEOUT as any);
    h.submitSimplifiedTicket.mockResolvedValueOnce(TIMEOUT as any);
    await call(agent, 'create_ticket', request);
    const r = await call(agent, 'create_ticket', request);
    expect(r.success).toBe(false);
    expect(r.message, 'a second timeout must still be spoken as a failure').toMatch(APOLOGY);
  });

  it('the retry budget is PER CALL — a different call gets its own single retry', async () => {
    h.submitSimplifiedTicket.mockResolvedValueOnce(TIMEOUT as any);
    await call(await agentFor(freshSid()), 'create_ticket', request);
    h.submitSimplifiedTicket.mockResolvedValueOnce(TIMEOUT as any);
    const r = await call(await agentFor(freshSid()), 'create_ticket', request);
    expect(r.message).toMatch(/once more/i);
    expect(r.message).not.toMatch(APOLOGY);
  });
});

describe('what does NOT change', () => {
  it('an ordinary API failure still speaks the apology and ends the call', async () => {
    h.submitSimplifiedTicket.mockResolvedValueOnce(ORDINARY_FAILURE as any);
    const r = await call(await agentFor(freshSid()), 'create_ticket', request);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(APOLOGY);
    expect(r.message).toMatch(/end the call/i);
  });

  it('a success still reads the number back', async () => {
    const r = await call(await agentFor(freshSid()), 'create_ticket', request);
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/submitted successfully/i);
  });
});
