/**
 * A failed attempt must give the lock back.
 *
 * `submitSimplifiedTicket` takes a 60-second lock on the call before it files,
 * so two processes cannot open two tickets for one call. It released that lock
 * on success only. Every failure return left it set — and the retry the failure
 * invites then ran straight into it.
 *
 * The recoverable failure is the one that hurts. When the ticketing API answers
 * with missingFields, the agent is TOLD to collect them and try again. The
 * caller answers in ten or twenty seconds, well inside the lease, and the
 * second attempt is refused with "Concurrent ticket creation in progress" and a
 * three-second wait — with the caller on the line. Observed 2026-08-12 23:38:
 * four create attempts on one call, no ticket at the end of it.
 *
 * This is the after-hours path. Operator, 2026-08-13: "all overnight volume is
 * on the no ivr agent which i use as the after hours agent" — and noIvrAgent's
 * create_ticket files through this exact method.
 *
 * The tests that matter most here are the ones about NOT releasing. A release
 * that fires when we never held the lock hands away a lock another process is
 * holding, which is the duplicate ticket this mechanism exists to prevent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { SyncAgentService } from './syncAgentService';

const CALL_SID = 'CA-overnight-0001';

const params = {
  patientFullName: 'Ruth Alvarez',
  patientDOB: '1948-03-02',
  reasonForCalling: 'Needs a refill of her glaucoma drops',
  preferredContactMethod: 'phone' as const,
  patientPhone: '9095551234',
  callSid: CALL_SID,
};

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: clear leaves queued mockResolvedValueOnce
  // values in place, so one test's unconsumed "once" answer becomes the next
  // test's first answer. That leak made a failing test pass here.
  vi.resetAllMocks();
  h.claimTicketCreation.mockResolvedValue({ claimed: true });
  h.releaseTicketCreationLock.mockResolvedValue(undefined);
  h.getCallLogBySid.mockResolvedValue({ callSid: CALL_SID });
  h.resolveTicketLookupFields.mockResolvedValue({});
});

/** Released with no ticket number — a lock handed back, not a ticket recorded. */
function releasedWithoutTicket(): boolean {
  return h.releaseTicketCreationLock.mock.calls.some(
    (c) => c[0] === CALL_SID && c[1] === undefined,
  );
}

describe('the lock is given back after a failed attempt', () => {
  it('releases when the API asks for missing fields', async () => {
    h.submitTicket.mockResolvedValue({
      success: false,
      missingFields: ['patientDOB'],
    });

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/missing required information/i);
    expect(releasedWithoutTicket()).toBe(true);
  });

  it('releases on an ordinary API failure', async () => {
    h.submitTicket.mockResolvedValue({ success: false, error: 'upstream 503' });

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(releasedWithoutTicket()).toBe(true);
  });

  it('releases when the submit throws', async () => {
    h.submitTicket.mockRejectedValue(new Error('socket hang up'));

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(releasedWithoutTicket()).toBe(true);
  });

  it('releases when the provider lookup throws', async () => {
    // This one ran BETWEEN the claim and the only release, and outside the try.
    // A throw here left the lock set with no release on any path.
    h.resolveTicketLookupFields.mockRejectedValue(new Error('schedule db timeout'));

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(releasedWithoutTicket()).toBe(true);
    expect(h.submitTicket).not.toHaveBeenCalled();
  });

  it('does not throw out of the method when the release itself fails', async () => {
    // A stuck lock expires on its own in 60s. Losing the real error would cost
    // the agent the sentence it needs to say next.
    h.submitTicket.mockResolvedValue({ success: false, error: 'upstream 503' });
    h.releaseTicketCreationLock.mockRejectedValue(new Error('db down'));

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(r.error).toBe('upstream 503');
  });
});

/**
 * The regression itself, against a lock that behaves like the real one.
 *
 * Mocking claimTicketCreation as "always granted" would let this pass with the
 * bug still in place — the second attempt only fails when the lock actually
 * remembers that the first one took it. So this fake holds the same state the
 * `call_logs` row does: a pending timestamp and a ticket number, with the same
 * compare-and-set rule as server/storage.ts.
 */
describe('the retry that failure invites now gets through', () => {
  /** Mirrors DatabaseStorage.claimTicketCreation / releaseTicketCreationLock. */
  function installRealisticLock() {
    const row: { pendingAtMs: number | null; ticketNumber: string | null } = {
      pendingAtMs: null,
      ticketNumber: null,
    };
    let clockMs = 0;

    h.claimTicketCreation.mockImplementation(async (_sid: string, timeoutMs = 60000) => {
      if (row.ticketNumber) return { claimed: false, existingTicket: row.ticketNumber };
      const held = row.pendingAtMs !== null && clockMs - row.pendingAtMs < timeoutMs;
      if (held) return { claimed: false };
      row.pendingAtMs = clockMs;
      return { claimed: true };
    });
    h.releaseTicketCreationLock.mockImplementation(async (_sid: string, ticketNumber?: string) => {
      row.pendingAtMs = null;
      if (ticketNumber) row.ticketNumber = ticketNumber;
    });
    h.getCallLogBySid.mockImplementation(async () => ({
      callSid: CALL_SID,
      ticketNumber: row.ticketNumber ?? undefined,
    }));

    return { advanceSeconds: (s: number) => { clockMs += s * 1000; } };
  }

  it('files on the second attempt after a missing-field refusal', async () => {
    // The whole point, and the shape of the 23:38 call. Attempt one is refused
    // for a missing date of birth. The caller supplies it fifteen seconds
    // later — well inside the sixty-second lease — and attempt two must land.
    const { advanceSeconds } = installRealisticLock();

    h.submitTicket.mockResolvedValueOnce({ success: false, missingFields: ['patientDOB'] });
    const first = await SyncAgentService.submitSimplifiedTicket({ ...params, patientDOB: '' });
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/missing required information/i);

    advanceSeconds(15);

    h.submitTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-51200' });
    const second = await SyncAgentService.submitSimplifiedTicket(params);

    expect(second.success).toBe(true);
    expect(second.ticketNumber).toBe('VA-51200');
    // Success releases WITH the ticket number, which is what marks it synced.
    expect(h.releaseTicketCreationLock).toHaveBeenLastCalledWith(CALL_SID, 'VA-51200');
  });

  it('still refuses a genuine second filing once the ticket exists', async () => {
    // Releasing must not cost us the deduplication. Once a ticket is recorded
    // against the call, a further attempt returns THAT ticket and files nothing.
    const { advanceSeconds } = installRealisticLock();

    h.submitTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-51201' });
    await SyncAgentService.submitSimplifiedTicket(params);

    advanceSeconds(120); // lease long expired — the ticket, not the lock, is the guard
    h.submitTicket.mockClear();

    const again = await SyncAgentService.submitSimplifiedTicket(params);

    expect(again.success).toBe(true);
    expect(again.ticketNumber).toBe('VA-51201');
    expect(h.submitTicket).not.toHaveBeenCalled();
  });
});

describe('it does not hand away a lock it never held', () => {
  it('stays silent when another process holds the lock', async () => {
    // claimed:false with a call log present is the genuine race. Releasing here
    // would clear the OTHER process's lock and produce the duplicate ticket the
    // lock exists to prevent.
    h.claimTicketCreation.mockResolvedValue({ claimed: false });
    h.getCallLogBySid.mockResolvedValue({ callSid: CALL_SID }); // exists, no ticket

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/concurrent/i);
    expect(h.releaseTicketCreationLock).not.toHaveBeenCalled();
  }, 10_000);

  it('stays silent when the claim itself errored', async () => {
    // The claim threw, so we do not know who holds it. The method proceeds
    // anyway — deliberately, a caller is worth more than a perfect lock — but
    // it must not release what it cannot prove is its own.
    h.claimTicketCreation.mockRejectedValue(new Error('db down'));
    h.submitTicket.mockResolvedValue({ success: false, error: 'upstream 503' });

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(h.releaseTicketCreationLock).not.toHaveBeenCalled();
  });

  it('returns the existing ticket rather than filing a second', async () => {
    h.claimTicketCreation.mockResolvedValue({ claimed: false, existingTicket: 'VA-51199' });

    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(true);
    expect(r.ticketNumber).toBe('VA-51199');
    expect(h.submitTicket).not.toHaveBeenCalled();
    expect(h.releaseTicketCreationLock).not.toHaveBeenCalled();
  });
});
