/**
 * EACH TERMINAL ROW IS EMAILED ONCE, ACROSS RESTARTS.
 *
 * Eligibility is the persisted refusal_status_code. last_error text is
 * never the discriminator — a 2026-09-25 row with "surgeon" and a NULL
 * status stays a transport dead letter until Wayne resolves it.
 *
 * The send goes through emailService.sendEmail, not sendAlert: that path's
 * 5-minute cooldown and 10/hour cap would throttle a row away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const updateResults: unknown[] = [];
const selectResults: unknown[] = [];
const setPayloads: Record<string, unknown>[] = [];
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
  for (const m of ['from', 'limit', 'values', 'returning', 'groupBy', 'orderBy']) {
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

vi.mock('../db', () => ({
  db: {
    update: () => chain(() => updateResults.shift() ?? []),
    select: () => chain(() => selectResults.shift() ?? []),
  },
}));

const sendEmail = vi.fn();
vi.mock('./emailService', () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

const { isFollowupEligible, notifyTerminalRefusals } = await import('./ticketFollowupNotice');
const { TICKET_NEEDS_FOLLOWUP } = await import('./ticketFollowupEmail');

const CREATED = new Date('2026-09-25T18:11:00.000Z');

function pending(over: Record<string, unknown> = {}) {
  return {
    id: 'ob-1',
    callSid: 'CAf1c375ee5dc57dd6d705939a7f15cee7',
    createdAt: CREATED,
    lastError: 'Missing required information: office',
    refusalStatusCode: 400,
    payload: {
      kind: 'create_ticket_v1',
      params: { departmentId: 1, callData: { agentUsed: 'optical' } },
    },
    followupNotifiedAt: null,
    resolvedAt: null,
    status: 'dead_letter',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateResults.length = 0;
  selectResults.length = 0;
  setPayloads.length = 0;
  whereCols.length = 0;
  sendEmail.mockResolvedValue(true);
});

describe('isFollowupEligible', () => {
  it('accepts an unresolved, un-notified 400', () => {
    expect(
      isFollowupEligible({
        refusalStatusCode: 400,
        followupNotifiedAt: null,
        resolvedAt: null,
        status: 'dead_letter',
      }),
    ).toBe(true);
  });

  it('accepts a 422 the same way', () => {
    expect(
      isFollowupEligible({
        refusalStatusCode: 422,
        followupNotifiedAt: null,
        resolvedAt: null,
        status: 'dead_letter',
      }),
    ).toBe(true);
  });

  it('refuses a row that has already been notified — that is the once-only lock', () => {
    expect(
      isFollowupEligible({
        refusalStatusCode: 400,
        followupNotifiedAt: new Date(),
        resolvedAt: null,
        status: 'dead_letter',
      }),
    ).toBe(false);
  });

  it('refuses a resolved row', () => {
    expect(
      isFollowupEligible({
        refusalStatusCode: 400,
        followupNotifiedAt: null,
        resolvedAt: new Date(),
        status: 'dead_letter',
      }),
    ).toBe(false);
  });

  it('refuses a NULL status even when last_error names a field — never infer from text', () => {
    // The three 2026-09-25 rows. Their last_error is "surgeon" / "office".
    // Treating that as terminal would email them as follow-up AND stop the
    // stall, without a persisted status. Wayne resolves those by hand.
    expect(
      isFollowupEligible({
        refusalStatusCode: null,
        followupNotifiedAt: null,
        resolvedAt: null,
        status: 'dead_letter',
      }),
    ).toBe(false);
  });

  it.each([401, 403, 408, 429, 500])('refuses HTTP %i — that is not a payload refusal', (code) => {
    expect(
      isFollowupEligible({
        refusalStatusCode: code,
        followupNotifiedAt: null,
        resolvedAt: null,
        status: 'dead_letter',
      }),
    ).toBe(false);
  });

  it('refuses a row that is still retrying', () => {
    expect(
      isFollowupEligible({
        refusalStatusCode: 400,
        followupNotifiedAt: null,
        resolvedAt: null,
        status: 'failed',
      }),
    ).toBe(false);
  });
});

describe('notifyTerminalRefusals', () => {
  it('claims, sends once, and keeps the claim', async () => {
    const row = pending();
    selectResults.push([row]);
    updateResults.push([row]);

    const res = await notifyTerminalRefusals();

    expect(res).toEqual({ notified: 1 });
    expect(sendEmail).toHaveBeenCalledOnce();
    const mail = sendEmail.mock.calls[0][0] as { subject: string; html: string };
    expect(mail.subject).toContain('CAf1c375ee5dc57dd6d705939a7f15cee7');
    expect(mail.html).toContain(TICKET_NEEDS_FOLLOWUP);
    expect(setPayloads[0]?.followupNotifiedAt).toBeInstanceOf(Date);
    // A successful send does not write a second SET that would clear it.
    expect(setPayloads).toHaveLength(1);
  });

  it('unclaims when the send fails so the next cycle can retry', async () => {
    const row = pending();
    selectResults.push([row]);
    updateResults.push([row], undefined);
    sendEmail.mockResolvedValue(false);

    const res = await notifyTerminalRefusals();

    expect(res).toEqual({ notified: 0 });
    expect(setPayloads[0]?.followupNotifiedAt).toBeInstanceOf(Date);
    expect(setPayloads[1]?.followupNotifiedAt).toBeNull();
  });

  it('sends nothing when the store is empty', async () => {
    selectResults.push([]);
    const res = await notifyTerminalRefusals();
    expect(res).toEqual({ notified: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(setPayloads).toHaveLength(0);
  });

  it('does not email a selected row whose status is no longer a payload refusal', async () => {
    // Belt: the SQL already excludes these. If a future query widens, the
    // filter still refuses to claim.
    selectResults.push([pending({ refusalStatusCode: null })]);
    const res = await notifyTerminalRefusals();
    expect(res).toEqual({ notified: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('batches every claimed row into one send', async () => {
    const a = pending();
    const b = pending({
      id: 'ob-2',
      callSid: 'CA4707e391198147df5032f2e72884e998',
      lastError: 'Missing required information: surgeon',
      payload: {
        kind: 'create_ticket_v1',
        params: { departmentId: 2, callData: { agentUsed: 'surgery' } },
      },
    });
    selectResults.push([a, b]);
    updateResults.push([a, b]);

    const res = await notifyTerminalRefusals();
    expect(res).toEqual({ notified: 2 });
    expect(sendEmail).toHaveBeenCalledOnce();
    const mail = sendEmail.mock.calls[0][0] as { subject: string };
    expect(mail.subject).toContain('2 tickets need follow-up');
  });
});

/**
 * THE WIRING, READ AS SOURCE — the fake db never evaluates WHERE, so a
 * behavioural test cannot see the claim predicate. Mutating the SELECT or
 * the unclaim to drop a column has to go red here.
 */
describe('the notice is wired so a row cannot be throttled or inferred', () => {
  const source = readFileSync(new URL('./ticketFollowupNotice.ts', import.meta.url), 'utf8');

  it('sends through emailService, never sendAlert', () => {
    // The header names sendAlert as the path we do NOT take. The import
    // and the call are what a mutation would change.
    expect(source).toMatch(/import \{ sendEmail \} from '\.\/emailService'/);
    expect(source).toMatch(/await sendEmail\(buildFollowupEmail/);
    expect(source).not.toMatch(/import .*sendAlert/);
    expect(source).not.toMatch(/await sendAlert|this\.sendAlert/);
    expect(source).not.toMatch(/shouldEmailAlert/);
  });

  it('selects on the persisted status, not last_error', () => {
    // lastError is the DISPLAY reason on the email. The WHERE that decides
    // who gets one must not read it — that is how a 2026-09-25 NULL-status
    // row would have been emailed as a terminal refusal.
    const where = source.slice(source.indexOf('.where('), source.indexOf('const eligible'));
    expect(where).toMatch(/inArray\(ticketOutbox\.refusalStatusCode/);
    expect(where).toMatch(/PAYLOAD_REFUSAL_STATUSES/);
    expect(where).not.toMatch(/lastError|last_error/);
    const eligible = source.slice(
      source.indexOf('export function isFollowupEligible'),
      source.indexOf('export async function notifyTerminalRefusals'),
    );
    expect(eligible).toMatch(/isTerminalRefusal\(row\.refusalStatusCode/);
    expect(eligible).not.toMatch(/lastError|last_error/);
  });

  it('claims only a row nobody has notified and nobody has resolved', () => {
    const claim = source.slice(source.indexOf('const claimed'), source.indexOf('if (claimed.length'));
    expect(claim).toMatch(/isNull\(ticketOutbox\.followupNotifiedAt\)/);
    expect(claim).toMatch(/isNull\(ticketOutbox\.resolvedAt\)/);
    expect(claim).toMatch(/followupNotifiedAt: now/);
  });

  it('clears the claim when the send fails', () => {
    const fail = source.slice(source.indexOf('if (!sent)'), source.indexOf('console.info'));
    expect(fail).toMatch(/followupNotifiedAt: null/);
  });
});
