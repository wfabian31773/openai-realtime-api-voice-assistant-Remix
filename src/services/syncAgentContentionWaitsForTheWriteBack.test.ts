/**
 * A DUPLICATE FILING ATTEMPT WAITS FOR THE REAL ONE, INSTEAD OF REFUSING AT 3s.
 *
 * CA…11e362485f, no-ivr, 2026-09-16 14:54 — read from `tool_timeline`:
 *
 *   attempt A  started 14:56:41.3, filed VA-60434 at 14:56:48.66, wrote the
 *              number back and returned success at 14:56:50.67   (9,312ms)
 *   attempt B  started 14:56:46.8 while A held the lock, waited a FIXED 3s,
 *              rechecked once — nothing written back yet — and returned
 *              "Concurrent ticket creation in progress" at 14:56:50.24,
 *              0.4s BEFORE A's success                            (3,422ms)
 *
 * The agent spoke B's refusal as "I'm experiencing a technical issue" to a
 * caller whose ticket was in the queue. The 3s wait was simply shorter than
 * the attempt it was waiting for.
 *
 * Now B polls for A's write-back for up to CONTENTION_WAIT_MS, and in the
 * common case returns the SAME ticket number. The refusal survives only when
 * the in-flight attempt outlasts the wait, and the agent-side copy for that
 * case no longer claims a failure (noIvrFalseFailure.test.ts).
 *
 * Same mock preamble as syncAgentService.lock.test.ts; the clock is faked so a
 * ten-second wait costs the suite nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  claimTicketCreation: vi.fn(),
  releaseTicketCreationLock: vi.fn(),
  getCallLogBySid: vi.fn(),
  submitTicket: vi.fn(),
  resolveTicketLookupFields: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    claimTicketCreation: h.claimTicketCreation,
    releaseTicketCreationLock: h.releaseTicketCreationLock,
    getCallLogBySid: h.getCallLogBySid,
  },
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { submitTicket: h.submitTicket },
}));
vi.mock('./ticketFieldSanitizers', () => ({
  resolveTicketLookupFields: h.resolveTicketLookupFields,
  sanitizeTicketLookupFields: vi.fn((x: unknown) => x),
}));

import { SyncAgentService, CONTENTION_WAIT_MS } from './syncAgentService';

const CALL_SID = 'CA-overnight-0002';
const params = {
  patientFullName: 'Test Caller',
  patientDOB: '1958-01-04',
  reasonForCalling: 'Running late for the 8:00 appointment',
  preferredContactMethod: 'phone' as const,
  patientPhone: '5551234567',
  callSid: CALL_SID,
};

/**
 * The other attempt, simulated: the lock is held, and the ticket number
 * appears on the call log `writeBackAtMs` after the duplicate starts polling.
 */
function otherAttemptWritesBackAt(writeBackAtMs: number | null, ticket = 'VA-60434') {
  const startedAt = Date.now();
  h.claimTicketCreation.mockResolvedValue({ claimed: false });
  h.getCallLogBySid.mockImplementation(async () => ({
    callSid: CALL_SID,
    ticketNumber: writeBackAtMs !== null && Date.now() - startedAt >= writeBackAtMs ? ticket : undefined,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  h.releaseTicketCreationLock.mockResolvedValue(undefined);
  h.resolveTicketLookupFields.mockResolvedValue({});
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a duplicate attempt that loses the lock', () => {
  it('returns the ticket the in-flight attempt wrote back, and files nothing itself', async () => {
    otherAttemptWritesBackAt(4_000);
    const pending = SyncAgentService.submitSimplifiedTicket(params);
    await vi.advanceTimersByTimeAsync(6_000);
    const r = await pending;

    expect(r.success).toBe(true);
    expect(r.ticketNumber).toBe('VA-60434');
    expect(h.submitTicket, 'the duplicate must never POST').not.toHaveBeenCalled();
    expect(h.releaseTicketCreationLock, 'it never held the lock, so it must not release it').not.toHaveBeenCalled();
  });

  /** The call that found this: 9.3s to file. A 3s wait could not see it. */
  it('keeps waiting past the old three-second recheck', async () => {
    otherAttemptWritesBackAt(9_300);
    const pending = SyncAgentService.submitSimplifiedTicket(params);
    await vi.advanceTimersByTimeAsync(CONTENTION_WAIT_MS);
    const r = await pending;

    expect(r.success, 'refused at 3s — the fifteen-ask shape of 11e362485f').toBe(true);
    expect(r.ticketNumber).toBe('VA-60434');
  });

  it('polls, rather than rechecking once', async () => {
    otherAttemptWritesBackAt(null);
    const pending = SyncAgentService.submitSimplifiedTicket(params);
    await vi.advanceTimersByTimeAsync(CONTENTION_WAIT_MS + 1_000);
    await pending;
    // One recheck per second for the whole wait, not one recheck ever.
    expect(h.getCallLogBySid.mock.calls.length).toBeGreaterThanOrEqual(CONTENTION_WAIT_MS / 1_000);
  });

  it('still refuses when nothing is written back inside the wait — a duplicate is worse', async () => {
    otherAttemptWritesBackAt(null);
    const pending = SyncAgentService.submitSimplifiedTicket(params);
    await vi.advanceTimersByTimeAsync(CONTENTION_WAIT_MS + 1_000);
    const r = await pending;

    expect(r.success).toBe(false);
    expect(r.error).toBe('Concurrent ticket creation in progress');
    expect(h.submitTicket).not.toHaveBeenCalled();
  });

  it('bounds the wait — it does not sit on the caller forever', async () => {
    otherAttemptWritesBackAt(null);
    let settled = false;
    const pending = SyncAgentService.submitSimplifiedTicket(params).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(CONTENTION_WAIT_MS - 1_000);
    expect(settled, 'gave up before the wait was over').toBe(false);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled, 'still waiting after the deadline').toBe(true);
    await pending;
  });
});

describe('what does NOT change', () => {
  it('an attempt that holds the lock files immediately and never polls', async () => {
    h.claimTicketCreation.mockResolvedValue({ claimed: true });
    h.getCallLogBySid.mockResolvedValue({ callSid: CALL_SID });
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-1' });

    const pending = SyncAgentService.submitSimplifiedTicket(params);
    await vi.advanceTimersByTimeAsync(0);
    const r = await pending;

    expect(r.success).toBe(true);
    expect(r.ticketNumber).toBe('VA-1');
    expect(h.getCallLogBySid).not.toHaveBeenCalled();
  });
});
