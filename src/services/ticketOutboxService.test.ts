/**
 * WHAT GOES INTO THE OUTBOX HAS TO COME BACK OUT UNCHANGED.
 *
 * The outbox was built for the answering-service path, whose payload is
 * unvalidated when it is written — so `attemptSend` validates it on the way
 * out, through `getValidatedTicketIds`.
 *
 * A queue payload is the opposite: optical, surgery, tech and records each
 * resolve the office, the provider and the triple with the caller on the line,
 * against their own department's taxonomy, and `getValidatedTicketIds` does not
 * know that taxonomy. Run one through it and the ticket changes on the way out.
 * The catch-all triple below is the proof case, and the second test here is the
 * measurement of it rather than a claim about it.
 *
 * There were no tests for this file at all before 2026-09-01.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------- fake db --
// A chainable stand-in for drizzle's builder. Every method returns the builder;
// the builder is thenable, and resolves to the next queued result. Results are
// queued per statement so one test can drive the claim and the write that
// follows it.
const updateResults: unknown[] = [];
const selectResults: unknown[] = [];
const insertResults: unknown[] = [];
const setPayloads: Record<string, unknown>[] = [];

function chain(next: () => unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['where', 'from', 'limit', 'values', 'onConflictDoNothing', 'returning', 'groupBy']) {
    self[m] = () => self;
  }
  self.set = (v: Record<string, unknown>) => {
    setPayloads.push(v);
    return self;
  };
  self.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
    Promise.resolve(next()).then(ok, err);
  return self;
}

vi.mock('../../server/db', () => ({
  db: {
    update: () => chain(() => updateResults.shift()),
    select: () => chain(() => selectResults.shift() ?? []),
    insert: () => chain(() => insertResults.shift() ?? []),
  },
}));

vi.mock('../../server/storage', () => ({
  storage: { releaseTicketCreationLock: vi.fn(), updateCallLog: vi.fn() },
}));

const createTicket = vi.fn();
const lookupProviderAndLocation = vi.fn();
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: {
    createTicket: (...a: unknown[]) => createTicket(...a),
    lookupProviderAndLocation: (...a: unknown[]) => lookupProviderAndLocation(...a),
  },
  lookupWasUnavailable: (r: { outcome?: string; success?: boolean } | null | undefined) =>
    r?.outcome === 'unavailable' || r?.success === false,
}));

const { TicketOutboxService, wrapCreateTicketPayload } = await import('./ticketOutboxService');

/**
 * Optical's "Other - See Description": department 1, type 66, reason 536.
 *
 * Wayne created these per-department catch-alls on 2026-08-12 precisely so an
 * unclassifiable request could keep the caller's own words instead of being
 * given a category it never claimed. `getValidatedTicketIds` has never heard of
 * type 66 or reason 536 — they postdate its tables — so it derives department
 * 1's default type (1, Frame Selection) and that type's default reason (1, New
 * Rx - Frame Selection).
 */
const OPTICAL_OTHER = {
  departmentId: 1,
  requestTypeId: 66,
  requestReasonId: 536,
  patientFirstName: 'Wayne',
  patientLastName: 'Fabian',
  patientPhone: '7605551234',
  locationId: 12,
  providerId: 44,
  description: 'The arm snapped off my frames.',
  priority: 'high' as const,
  callData: { agentUsed: 'optical', callSid: 'CA0001' },
  idempotencyKey: 'call-CA0001',
};

function entry(payload: unknown, extra: Record<string, unknown> = {}) {
  return [{
    id: 'ob-1',
    callSid: 'CA0001',
    callLogId: null,
    payload,
    retryCount: 0,
    ...extra,
  }];
}

beforeEach(() => {
  vi.clearAllMocks();
  updateResults.length = 0;
  selectResults.length = 0;
  insertResults.length = 0;
  setPayloads.length = 0;
  createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-52100', ticketId: 9001 });
  lookupProviderAndLocation.mockResolvedValue({ success: true, outcome: 'matched', locationId: null });
});

describe('a queue payload is re-sent exactly as the tool built it', () => {
  it('keeps the whole triple, the ids and the caller\'s words', async () => {
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER)), undefined);

    const res = await TicketOutboxService.attemptSend('ob-1');

    expect(res.success).toBe(true);
    expect(createTicket).toHaveBeenCalledOnce();
    expect(createTicket.mock.calls[0][0]).toEqual(OPTICAL_OTHER);
    // Never re-derived: the office and provider the tool resolved with the
    // caller on the line are on the payload, and looking them up again 40
    // minutes later can return something different.
    expect(lookupProviderAndLocation).not.toHaveBeenCalled();
  });

  it('is why the legacy path could not simply be reused', async () => {
    // THE CONTROL. Same triple, stored in the OLD unmarked shape, so it takes
    // the validating branch. This is not a bug being asserted — it is correct
    // for an answering-service payload, and it is exactly what would happen to
    // every queue ticket if the verbatim branch above did not exist.
    updateResults.push(entry({ ...OPTICAL_OTHER, callData: undefined }), undefined);

    await TicketOutboxService.attemptSend('ob-1');

    const sent = createTicket.mock.calls[0][0];
    expect(sent.departmentId).toBe(1);
    expect(sent.requestTypeId).not.toBe(66);
    expect(sent.requestReasonId).not.toBe(536);
    expect(sent.requestTypeId).toBe(1); // Frame Selection
    expect(sent.requestReasonId).toBe(1); // New Rx - Frame Selection
  });

  it('marks the entry sent with the number the API gave back', async () => {
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER)), undefined);

    await TicketOutboxService.attemptSend('ob-1');

    const marked = setPayloads.find((p) => p.status === 'sent');
    expect(marked?.ticketNumber).toBe('VA-52100');
    expect(marked?.externalTicketId).toBe(9001);
  });
});

describe('the retry window has to outlast an outage', () => {
  it('backs off towards a 30-minute ceiling instead of doubling forever', async () => {
    createTicket.mockResolvedValue({ success: false, error: 'Invalid JSON response: 200' });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 8 }), undefined);

    const before = Date.now();
    await TicketOutboxService.attemptSend('ob-1');

    const failed = setPayloads.find((p) => p.status === 'failed');
    expect(failed).toBeTruthy();
    const waitMs = (failed!.nextRetryAt as Date).getTime() - before;
    // Uncapped this would be 30s * 2^8 = 128 minutes, and growing.
    expect(waitMs).toBeGreaterThan(29 * 60_000);
    expect(waitMs).toBeLessThanOrEqual(30 * 60_000 + 1_000);
  });

  it('still dead-letters, and the payload is still there when it does', async () => {
    createTicket.mockResolvedValue({ success: false, error: 'Invalid JSON response: 200' });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 11 }), undefined);

    await TicketOutboxService.attemptSend('ob-1');

    const dead = setPayloads.find((p) => p.status === 'dead_letter');
    expect(dead).toBeTruthy();
    expect(dead!.nextRetryAt).toBeNull();
    // Nothing clears `payload`, so a dead letter is a request a human can still
    // file. That is the whole reason it is worth writing before sending.
    expect(dead!.lastError).toMatch(/Invalid JSON/);
  });
});
