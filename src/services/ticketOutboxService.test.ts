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
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- fake db --
// A chainable stand-in for drizzle's builder. Every method returns the builder;
// the builder is thenable, and resolves to the next queued result. Results are
// queued per statement so one test can drive the claim and the write that
// follows it.
const updateResults: unknown[] = [];
const selectResults: unknown[] = [];
const insertResults: unknown[] = [];
const setPayloads: Record<string, unknown>[] = [];
/**
 * The columns each `.where(...)` was built from, in call order.
 *
 * The fake db cannot evaluate a drizzle condition, so a test that only queues a
 * result proves nothing about the WHERE that asked for it — which is how the
 * reopen's concurrency guard survived its own mutation. Recording the columns
 * makes the guard observable: a reopen keyed on the id ALONE and one keyed on
 * the id AND the status are different statements, and only the second is safe.
 */
const whereCols: string[][] = [];

function columnsOf(node: unknown, out: string[] = []): string[] {
  const n = node as { name?: unknown; table?: unknown; queryChunks?: unknown[] } | null;
  if (!n || typeof n !== 'object') return out;
  if (typeof n.name === 'string' && 'table' in n) out.push(n.name);
  for (const chunk of n.queryChunks ?? []) columnsOf(chunk, out);
  return out;
}

function chain(next: () => unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['from', 'limit', 'values', 'onConflictDoNothing', 'returning', 'groupBy']) {
    self[m] = () => self;
  }
  self.where = (condition: unknown) => {
    whereCols.push(columnsOf(condition));
    return self;
  };
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
  whereCols.length = 0;
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


/**
 * THE WORKER HAS NEVER RE-SENT ANYTHING — found by Codex on PR #244.
 *
 * `processRetries` used to mark every due row `sending` with a fresh
 * `updatedAt` and then call `attemptSend`, whose own claim accepts only
 * `pending`, `failed`, or a `sending` row whose two-minute lease has expired.
 * A row just marked `sending` matched none of them, so every entry came back
 * "already being processed by another worker", and the next tick refreshed the
 * lease and repeated it. Rows sat in `sending` for ever.
 *
 * The production table agrees: 36 rows, all `sent`, newest 2026-08-22, every
 * one sent by syncAgentService calling `attemptSend` directly on a fresh row.
 * Nothing has ever left through the worker.
 *
 * Harmless while the answering-service path sent inline. Not harmless now the
 * queue tools depend on this to send what a failed POST left behind.
 */
describe('the retry worker', () => {
  it('actually sends a row that is due', async () => {
    // db.select() -> the due ids; then attemptSend's own claim, then its
    // mark-sent write.
    selectResults.push([{ id: 'ob-1' }]);
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER)), undefined);

    const sent = await TicketOutboxService.processRetries();

    expect(sent).toBe(1);
    expect(createTicket).toHaveBeenCalledOnce();
    expect(setPayloads.find((p) => p.status === 'sent')?.ticketNumber).toBe('VA-52100');
  });

  it('does not claim the row before attemptSend does', async () => {
    // The regression itself: any write here puts the row into a state
    // attemptSend refuses, and one claimer is the whole reason two workers are
    // safe. Exactly one `sending` write should happen per entry — attemptSend's.
    selectResults.push([{ id: 'ob-1' }]);
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER)), undefined);

    await TicketOutboxService.processRetries();

    expect(setPayloads.filter((p) => p.status === 'sending')).toHaveLength(1);
  });

  it('does nothing when nothing is due', async () => {
    selectResults.push([]);
    expect(await TicketOutboxService.processRetries()).toBe(0);
    expect(createTicket).not.toHaveBeenCalled();
  });
});

/**
 * THE OUTBOX MUST NOT SPEND TWELVE RETRIES ON A "NO" — Codex, PR #244.
 *
 * `createTicketDurable` already refuses to QUEUE a 4xx. But a payload can be
 * holding a permanent refusal all the same: it was captured during a transport
 * outage, when there was no status at all, and only once the far side recovers
 * does it answer "Missing required information: surgeon". Identical bytes,
 * identical answer, twelve times.
 *
 * Two costs, and the second is the one that matters. The row sits ~3.5 hours
 * before dead-lettering; and while fewer than three rows are held the filing
 * alarm's outbox plane stays quiet for exactly that long, so the signal that
 * would have named the problem arrives after the outage it exists to catch.
 *
 * 408 and 429 stay retryable — the server is saying "not now", which is what
 * retrying is for.
 */
describe('a refusal from the far side is not retried', () => {
  it('dead-letters a 400 immediately instead of scheduling a retry', async () => {
    createTicket.mockResolvedValue({
      success: false,
      statusCode: 400,
      error: 'Missing required information: surgeon',
    });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 0 }), undefined);

    await TicketOutboxService.attemptSend('ob-1');

    const written = setPayloads.find((p) => p.status === 'dead_letter' || p.status === 'failed');
    expect(written?.status).toBe('dead_letter');
    // No next attempt is scheduled: there is nothing to wait for.
    expect(written?.nextRetryAt).toBeNull();
  });

  it('leaves the payload intact so it can be replayed by hand', async () => {
    createTicket.mockResolvedValue({ success: false, statusCode: 400, error: 'Missing required information: office' });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 0 }), undefined);

    await TicketOutboxService.attemptSend('ob-1');

    const written = setPayloads.find((p) => p.status === 'dead_letter');
    expect(written).toBeTruthy();
    // A dead letter is a request that still needs filing, not a discarded one.
    expect(written!.payload).toBeUndefined(); // the write never touches it
  });

  it.each([408, 429])('still retries %i — that one means "not now"', async (status) => {
    createTicket.mockResolvedValue({ success: false, statusCode: status, error: 'slow down' });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 0 }), undefined);

    await TicketOutboxService.attemptSend('ob-1');

    const written = setPayloads.find((p) => p.status === 'failed' || p.status === 'dead_letter');
    expect(written?.status).toBe('failed');
    expect(written?.nextRetryAt).toBeInstanceOf(Date);
  });

  it('still retries a transport failure that carries no status at all', async () => {
    // The 08-31 shape: HTTP 200 with a body that is not JSON. No statusCode,
    // so nothing is known about whether the far side read the payload.
    createTicket.mockResolvedValue({ success: false, error: 'Invalid JSON response: 200' });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 0 }), undefined);

    await TicketOutboxService.attemptSend('ob-1');

    const written = setPayloads.find((p) => p.status === 'failed' || p.status === 'dead_letter');
    expect(written?.status).toBe('failed');
  });
});

/**
 * THE BACKOFF HAS TO BE PART OF THE CLAIM — Codex, PR #244, round seven.
 *
 * `processRetries` SELECTs the due rows and then sends them one at a time, so
 * the batch is a snapshot. By the time the loop reaches the fifth row, another
 * worker — or the previous interval, still running — may already have failed
 * it and pushed `nextRetryAt` half an hour out. The claim accepted any
 * `failed` row, so the stale selection posted again immediately and burned a
 * retry the backoff had just bought.
 *
 * Twelve attempts is the entire budget between a transport outage and a dead
 * letter. Spending them in the first minute is the difference between
 * surviving an outage and giving up during it.
 *
 * Asserted as source text, deliberately: the fake db above returns queued
 * results and never evaluates a WHERE clause, so a behavioural test here would
 * pass whether or not the predicate exists — which is exactly the kind of test
 * that has already fooled me twice on this branch.
 */
describe('what the atomic claim is allowed to pick up', () => {
  const source = readFileSync(new URL('./ticketOutboxService.ts', import.meta.url), 'utf8');
  const claim = source.slice(source.indexOf('static async attemptSend'), source.indexOf('.returning();'));

  it('only claims a row whose backoff has elapsed', () => {
    expect(claim).toMatch(/dueNow/);
    expect(claim).toMatch(/lte\(ticketOutbox\.nextRetryAt, now\)/);
  });

  it('applies it to both retryable states, not just one', () => {
    expect(claim).toMatch(/eq\(ticketOutbox\.status, 'pending'\), dueNow/);
    expect(claim).toMatch(/eq\(ticketOutbox\.status, 'failed'\), dueNow/);
  });

  it('still claims a pending row that has never failed and so has no due time', () => {
    // A first send carries no nextRetryAt at all; requiring one would strand
    // every newly captured request.
    expect(claim).toMatch(/isNull\(ticketOutbox\.nextRetryAt\)/);
  });

  it('leaves the stale-lease recovery alone', () => {
    // A 'sending' row whose lease expired is recovered on the LEASE, not the
    // backoff — its nextRetryAt belongs to the attempt that died holding it.
    expect(claim).toMatch(/SENDING_LEASE_TIMEOUT_MS/);
    // Anchored on the STATUS arm, not the `.set({ status: 'sending' })` at the
    // top of the claim — the first version of this sliced from there and so
    // covered the whole clause, which made it assert nothing.
    const sendingArm = claim.slice(claim.indexOf("eq(ticketOutbox.status, 'sending')"));
    expect(sendingArm).not.toMatch(/dueNow/);
  });
});

/**
 * A REFUSAL MUST REACH THE CALLER WHO IS STILL ON THE LINE — Codex, PR #244.
 *
 * `attemptSend` dead-letters a 400/422 immediately and nothing retries it. But
 * it returned the same generic failed result as a transport failure, so
 * `SyncAgentService` could not tell them apart and answered both with "your
 * request has been recorded and will be processed shortly" — a promise nothing
 * can keep, on the path that carries the answering service, no-IVR and
 * after-hours.
 *
 * The verdict now travels with the result. What the caller HEARS is asserted in
 * syncAgentService's own tests; this pins that the fact gets out of here.
 */
describe('the terminal verdict leaves the outbox with the result', () => {
  it('marks a refusal terminal and carries its status', async () => {
    createTicket.mockResolvedValue({
      success: false,
      statusCode: 400,
      error: 'Missing required information: surgeon',
    });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 0 }), undefined);

    const res = await TicketOutboxService.attemptSend('ob-1');

    expect(res.success).toBe(false);
    expect(res.terminal).toBe(true);
    expect(res.statusCode).toBe(400);
  });

  it('leaves a transport failure UNmarked, so it is still reported as retrying', async () => {
    // The 08-31 shape: HTTP 200 with a non-JSON body, no status at all. This
    // one genuinely is retried, and the caller genuinely can be told it was
    // recorded — so `terminal` must stay absent.
    createTicket.mockResolvedValue({ success: false, error: 'Invalid JSON response: 200' });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 0 }), undefined);

    const res = await TicketOutboxService.attemptSend('ob-1');

    expect(res.success).toBe(false);
    expect(res.terminal).toBeUndefined();
  });

  it('does not mark an exhausted-retry dead letter as terminal', async () => {
    // Twelve failed attempts and a refusal are both dead letters, and they are
    // NOT the same fact: nobody is still on the line for the twelfth retry, and
    // that row was never refused — it was never answered.
    createTicket.mockResolvedValue({ success: false, error: 'Invalid JSON response: 200' });
    updateResults.push(entry(wrapCreateTicketPayload(OPTICAL_OTHER), { retryCount: 11 }), undefined);

    const res = await TicketOutboxService.attemptSend('ob-1');

    expect(setPayloads.find((p) => p.status === 'dead_letter')).toBeTruthy();
    expect(res.terminal).toBeUndefined();
  });
});

/**
 * A DEAD LETTER MUST NOT HOLD THE KEY ITS OWN CORRECTION NEEDS.
 *
 * Codex, PR #244 round twelve, and a consequence of round eleven's fix. That
 * round made a terminal refusal honest: instead of "recorded and will be
 * processed shortly", the caller is now asked for the field the API named. The
 * caller answers, the agent files again — and on the SAME CallSid.
 *
 * `writeToOutbox` keys on `call-<CallSid>` with `onConflictDoNothing`, so the
 * second write found the refused row, kept its stale payload, and returned it.
 * `attemptSend` then declined to claim a `dead_letter` row and returned a
 * result with no `terminal` flag, which fell through to the retryable branch —
 * and the caller who had just supplied the missing surgeon was told their
 * request was recorded. Nothing was going to send it.
 *
 * So the invitation to correct has to reach the row the retry will send. A
 * dead letter filed NOTHING, which is exactly why it is safe to replace: there
 * is no ticket to duplicate. A `sent` row is the opposite and must never be
 * touched — that one really is the duplicate the key exists to stop.
 */
describe('a dead letter must not hold the key its own correction needs', () => {
  it('replaces the refused payload and reopens the row', async () => {
    insertResults.push([]); // the conflict: nothing inserted
    selectResults.push([{ id: 'ob-1', ticketNumber: null, status: 'dead_letter' }]);
    updateResults.push([{ id: 'ob-1' }]); // the reopen won the race

    const corrected = { ...OPTICAL_OTHER, description: 'Dr. Nguyen is the surgeon' };
    const res = await TicketOutboxService.writeToOutbox(
      wrapCreateTicketPayload(corrected as never) as never,
      'CA0001',
    );

    expect(res.outboxId).toBe('ob-1');
    expect(res.status).toBe('pending');

    const reopen = setPayloads.find((p) => p.status === 'pending' && 'payload' in p);
    expect(reopen).toBeTruthy();
    expect(reopen!.retryCount).toBe(0);
    // The CORRECTED words, not the ones the API refused.
    expect((reopen!.payload as { params: { description: string } }).params.description).toBe(
      'Dr. Nguyen is the surgeon',
    );
  });

  it('leaves a sent row alone — that one really is the duplicate', async () => {
    insertResults.push([]);
    selectResults.push([{ id: 'ob-1', ticketNumber: 'VA-52100', status: 'sent' }]);

    const res = await TicketOutboxService.writeToOutbox(
      wrapCreateTicketPayload(OPTICAL_OTHER as never) as never,
      'CA0001',
    );

    expect(res.status).toBe('sent');
    expect(res.ticketNumber).toBe('VA-52100');
    expect(setPayloads.some((p) => p.status === 'pending')).toBe(false);
  });

  it('leaves a row still in flight alone', async () => {
    // `failed` is between retries: the worker still owns it and its payload was
    // never refused — only undelivered. Reopening it would reset a backoff that
    // is doing its job.
    insertResults.push([]);
    selectResults.push([{ id: 'ob-1', ticketNumber: null, status: 'failed' }]);

    const res = await TicketOutboxService.writeToOutbox(
      wrapCreateTicketPayload(OPTICAL_OTHER as never) as never,
      'CA0001',
    );

    expect(res.status).toBe('failed');
    expect(setPayloads.some((p) => p.status === 'pending')).toBe(false);
  });

  it('falls back to reporting the row when another writer reopened it first', async () => {
    // The reopen update is guarded on `status = 'dead_letter'`, so a concurrent
    // writer can win it. Losing that race must not throw and must not report a
    // reopen that this call did not perform.
    insertResults.push([]);
    selectResults.push([{ id: 'ob-1', ticketNumber: null, status: 'dead_letter' }]);
    updateResults.push([]); // the guarded update matched nothing

    const res = await TicketOutboxService.writeToOutbox(
      wrapCreateTicketPayload(OPTICAL_OTHER as never) as never,
      'CA0001',
    );

    expect(res.outboxId).toBe('ob-1');
    expect(res.status).toBe('dead_letter');

    // And the reason losing is possible at all: the reopen is guarded on the
    // status it read, not on the id alone. Without that guard two writers both
    // "win", and the second can reset a row the first has already claimed and
    // is mid-send — which is a duplicate ticket, not a lost one.
    const reopenWhere = whereCols[whereCols.length - 1];
    expect(reopenWhere).toContain('id');
    expect(reopenWhere).toContain('status');
  });

  it('reports a row that is ALREADY dead-lettered as terminal, not as retrying', async () => {
    // The backstop. Even if a dead letter reaches attemptSend by some other
    // route, nothing will send it, so it must never be reported as retrying.
    updateResults.push([]); // the claim matches nothing
    selectResults.push([{ status: 'dead_letter', ticketNumber: null }]);

    const res = await TicketOutboxService.attemptSend('ob-1');

    expect(res.success).toBe(false);
    expect(res.terminal).toBe(true);
  });
});
