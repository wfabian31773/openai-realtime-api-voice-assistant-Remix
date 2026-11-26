/**
 * The Live Calls "Cleanup Stale" button can never end a call that is still
 * going (2026-11-26, the screen accuracy audit of voice #525).
 *
 * Before: any signed-in user; rows older than 5 minutes; a call Twilio still
 * reported live after 10 minutes was hung up. Measured 2026-11-26 (Hub
 * call_logs, 30 days): 840 runtime calls ran 5 to 10 minutes, 440 ran past 10
 * minutes at Twilio, 403 of them PCP queue transfers that stayed live a median
 * 871 s (up to 3,447 s) after our side let go; 0 rows were open at the time
 * of measuring and 0 were reaped as stale in 90 days.
 *
 * Synthetic CallSids and ids only.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Express, RequestHandler } from 'express';

// A recording stand-in for the Hub's drizzle handle: the production close is
// read back as SQL, and nothing reaches a database.
const dbCalls: { set?: Record<string, unknown>; where?: unknown }[] = [];
const dbSelects: { fields?: Record<string, unknown>; where?: unknown; orderBy?: unknown[]; limit?: number }[] = [];
let returningRows: { id: string }[] = [{ id: 'row-1' }];
vi.mock('./db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      const call: { fields?: Record<string, unknown>; where?: unknown; orderBy?: unknown[]; limit?: number } = { fields };
      dbSelects.push(call);
      const chain = {
        from() { return chain; },
        where(w: unknown) { call.where = w; return chain; },
        orderBy(...o: unknown[]) { call.orderBy = o; return chain; },
        limit: async (n: number) => { call.limit = n; return []; },
      };
      return chain;
    },
    update: () => {
      const call: { set?: Record<string, unknown>; where?: unknown } = {};
      dbCalls.push(call);
      const chain = {
        set(v: Record<string, unknown>) { call.set = v; return chain; },
        where(w: unknown) { call.where = w; return chain; },
        returning: async () => returningRows,
      };
      return chain;
    },
  },
  pool: {},
}));

const { mountStaleCallCleanup, cleanupMessage, MANUAL_CLEANUP_OPTIONS, STALE_CLEANUP_PATH } = await import('./staleCallCleanup');
const { sweepStaleCalls, productionSweepDeps, LIVE_CALL_STATUSES } = await import('./services/staleCallSweeper');
const { MANUAL_CLEANUP_MIN_AGE_MS, STALE_CALL_CEILING_MS, STALE_SWEEP_DISPOSITION } = await import('./services/staleCallSweep.logic');
const { requireAuth, requireRole } = await import('./auth');
const { DEFAULT_MAX_CALL_MS } = await import('../src/runtime/mediaStreamBridge');
const { STALE_CALL_AFTER_MINUTES } = await import('../client/src/lib/staleCallLine');

type Sweep = Parameters<typeof mountStaleCallCleanup>[1]['sweep'];

const NOW = new Date('2026-11-26T18:00:00.000Z');
const SID = (n: number) => `CA${String(n).padStart(32, '0')}`;

/** A Twilio stand-in. `update` exists so a test can prove nothing ever calls it. */
function fakeTwilio(calls: Record<string, () => Promise<any>>) {
  const update = vi.fn(async () => ({ status: 'completed' }));
  const fetched: string[] = [];
  const client = {
    calls(sid: string) {
      return {
        fetch: () => { fetched.push(sid); return (calls[sid] ?? (async () => { throw Object.assign(new Error('not found'), { status: 404, code: 20404 }); }))(); },
        update,
      };
    },
  };
  return { client, update, fetched };
}

type FakeRow = { id: string; callSid: string | null; ageMinutes: number; startedMinutesAgo?: number };

/** Reads the way the production query does: by start time (else creation), oldest first, a page after the cursor. */
function fakeDeps(rows: FakeRow[], twilio: ReturnType<typeof fakeTwilio> | null, opts: { closeReturns?: boolean } = {}) {
  const closed: { id: string; patch: any }[] = [];
  const cutoffs: Date[] = [];
  const pages: string[][] = [];
  const cursors: ({ createdAtKey: string; id: string } | null)[] = [];
  const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60000);
  // What Postgres's created_at::text gives: microseconds a Date cannot hold.
  const keyOf = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '') + '456';
  return {
    closed,
    cutoffs,
    pages,
    cursors,
    deps: {
      async findStaleRows(cutoff: Date, limit: number, after: { createdAtKey: string; id: string } | null) {
        cutoffs.push(cutoff);
        cursors.push(after);
        const page = rows
          .map((r) => ({ id: r.id, callSid: r.callSid, status: 'in_progress', createdAt: at(r.ageMinutes), createdAtKey: keyOf(at(r.ageMinutes)), startTime: at(r.startedMinutesAgo ?? r.ageMinutes) }))
          .filter((r) => r.startTime < cutoff)
          .sort((a, b) => a.createdAtKey.localeCompare(b.createdAtKey) || a.id.localeCompare(b.id))
          .filter((r) => !after || r.createdAtKey > after.createdAtKey || (r.createdAtKey === after.createdAtKey && r.id > after.id))
          .slice(0, limit)
          .map(({ startTime: _s, ...r }) => r);
        pages.push(page.map((r) => r.id));
        return page;
      },
      async closeRow(id: string, patch: any) { closed.push({ id, patch }); return opts.closeReturns ?? true; },
      async twilioClient() { return twilio ? twilio.client : null; },
      now: () => NOW,
    },
  };
}

function boot(sweep: Sweep) {
  const routes: Record<string, RequestHandler[]> = {};
  const app = { post: (path: string, ...handlers: RequestHandler[]) => { routes[`POST ${path}`] = handlers; } } as unknown as Express;
  // The production middleware, not stand-ins: requireRole('admin') is what routes.ts passes.
  mountStaleCallCleanup(app, { authenticate: requireAuth, admin: requireRole('admin'), sweep });
  async function press(role?: string) {
    const req = { session: role ? { userId: 'staff-id', userRole: role } : {}, headers: {} };
    const result = { status: 200, body: undefined as any };
    const res = { status(code: number) { result.status = code; return res; }, json(v: unknown) { result.body = v; return res; } };
    async function run(i: number): Promise<void> {
      const h = routes[`POST ${STALE_CLEANUP_PATH}`][i];
      if (!h) return;
      let next: Promise<void> | undefined;
      await h(req as never, res as never, () => { next = run(i + 1); });
      await next;
    }
    await run(0);
    return result;
  }
  return { press };
}

beforeEach(() => { dbCalls.length = 0; dbSelects.length = 0; returningRows = [{ id: 'row-1' }]; vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('who may press it', () => {
  it('a non-admin gets 403 and nothing is swept', async () => {
    const sweep = vi.fn(async () => ({ examined: 0, closedFromTwilioTruth: 0, closedUnresolvable: 0, stillLiveAtTwilio: 0, errors: 0 }));
    const h = boot(sweep);
    for (const role of ['user', 'manager', 'staff']) {
      expect((await h.press(role)).status).toBe(403);
    }
    expect((await h.press()).status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('an admin runs the sweep with the manual rules: 15 minutes, close only what Twilio says ended', async () => {
    const sweep = vi.fn(async () => ({ examined: 0, closedFromTwilioTruth: 0, closedUnresolvable: 0, stillLiveAtTwilio: 0, errors: 0 }));
    const out = await boot(sweep).press('admin');
    expect(out.status).toBe(200);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith({ minAgeMs: 15 * 60 * 1000, closeUnverified: false });
    expect(out.body.message).toBe('No call rows have been open longer than 15 minutes.');
  });

  it('a sweep that throws answers 500 and claims nothing', async () => {
    const out = await boot(async () => { throw new Error('db down'); }).press('admin');
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ message: 'Failed to clean up stale calls' });
  });
});

describe('the age line', () => {
  it('is above the runtime ceiling, and the button sweeps with it', () => {
    expect(MANUAL_CLEANUP_MIN_AGE_MS).toBeGreaterThan(DEFAULT_MAX_CALL_MS);
    expect(MANUAL_CLEANUP_OPTIONS).toEqual({ minAgeMs: MANUAL_CLEANUP_MIN_AGE_MS, closeUnverified: false });
  });

  it('only rows older than the line are read', async () => {
    const t = fakeTwilio({});
    const f = fakeDeps([{ id: 'young', callSid: SID(1), ageMinutes: 14 }], t);
    const s = await sweepStaleCalls(MANUAL_CLEANUP_OPTIONS, f.deps);
    expect(f.cutoffs[0].toISOString()).toBe(new Date(NOW.getTime() - 15 * 60000).toISOString());
    expect(s.examined).toBe(0);
    expect(t.fetched).toEqual([]);
  });

  it('the line is read off the call\'s start time, as the board reads it (Codex on #529)', async () => {
    const t = fakeTwilio({ [SID(20)]: async () => ({ status: 'completed', duration: '30' }) });
    // created 20 minutes ago, but the call began 10 minutes ago: not 15 minutes old yet
    const f = fakeDeps([{ id: 'late-start', callSid: SID(20), ageMinutes: 20, startedMinutesAgo: 10 }], t);
    const s = await sweepStaleCalls(MANUAL_CLEANUP_OPTIONS, f.deps);
    expect(s.examined).toBe(0);
    expect(f.closed).toEqual([]);
  });

  it('the board shades a row as stale at the same line the button uses', () => {
    expect(STALE_CALL_AFTER_MINUTES * 60000).toBe(MANUAL_CLEANUP_MIN_AGE_MS);
  });
});

describe('a call that is still going is never ended', () => {
  for (const twilioStatus of ['in-progress', 'ringing', 'queued', 'initiated', 'some-new-status']) {
    it(`Twilio "${twilioStatus}" at 40 minutes: not hung up, row not touched`, async () => {
      const t = fakeTwilio({ [SID(2)]: async () => ({ status: twilioStatus }) });
      const f = fakeDeps([{ id: 'live', callSid: SID(2), ageMinutes: 40 }], t);
      const s = await sweepStaleCalls(MANUAL_CLEANUP_OPTIONS, f.deps);
      expect(t.fetched).toEqual([SID(2)]); // Twilio was asked first
      expect(t.update).not.toHaveBeenCalled();
      expect(f.closed).toEqual([]);
      expect(s.stillLiveAtTwilio).toBe(1);
    });
  }

  it('through the button: a PCP call live in the queue for 57 minutes is reported, not ended', async () => {
    const t = fakeTwilio({ [SID(3)]: async () => ({ status: 'in-progress' }) });
    const f = fakeDeps([{ id: 'queue-leg', callSid: SID(3), ageMinutes: 57 }], t);
    const out = await boot((o) => sweepStaleCalls(o, f.deps)).press('admin');
    expect(out.status).toBe(200);
    expect(t.update).not.toHaveBeenCalled();
    expect(f.closed).toEqual([]);
    expect(out.body.cleaned).toBe(0);
    expect(out.body.stillLiveAtTwilio).toBe(1);
    expect(out.body.message).toContain('1 call is still live at Twilio and was not touched.');
  });

  it('the automatic sweep, too, never hangs up a live call', async () => {
    const t = fakeTwilio({ [SID(4)]: async () => ({ status: 'in-progress' }) });
    const f = fakeDeps([{ id: 'live', callSid: SID(4), ageMinutes: 45 }], t);
    await sweepStaleCalls({}, f.deps);
    expect(t.update).not.toHaveBeenCalled();
    expect(f.closed).toEqual([]);
  });
});

describe('a call that has ended: its row is closed, in the database only', () => {
  it('Twilio "completed": Twilio\'s duration and end time, the stale disposition', async () => {
    const end = '2026-11-26T17:30:12.000Z';
    const t = fakeTwilio({ [SID(5)]: async () => ({ status: 'completed', duration: '742', endTime: end }) });
    const f = fakeDeps([{ id: 'ended', callSid: SID(5), ageMinutes: 45 }], t);
    const out = await boot((o) => sweepStaleCalls(o, f.deps)).press('admin');
    expect(t.update).not.toHaveBeenCalled();
    expect(f.closed).toEqual([{ id: 'ended', patch: { status: 'completed', duration: 742, endTime: new Date(end), twilioStatus: 'completed', callDisposition: STALE_SWEEP_DISPOSITION } }]);
    expect(out.body.cleaned).toBe(1);
    expect(out.body.message).toBe('Closed 1 row whose call Twilio says has ended.');
  });

  it('busy, no-answer and canceled close as what Twilio says', async () => {
    const t = fakeTwilio({
      [SID(6)]: async () => ({ status: 'busy' }),
      [SID(7)]: async () => ({ status: 'no-answer' }),
      [SID(8)]: async () => ({ status: 'canceled' }),
    });
    const f = fakeDeps([6, 7, 8].map((n) => ({ id: `r${n}`, callSid: SID(n), ageMinutes: 20 })), t);
    await sweepStaleCalls(MANUAL_CLEANUP_OPTIONS, f.deps);
    expect(f.closed.map((c) => c.patch.status)).toEqual(['busy', 'no_answer', 'failed']);
    expect(f.closed.map((c) => c.patch.duration)).toEqual([null, null, null]); // never invented
    expect(t.update).not.toHaveBeenCalled();
  });

  it('a row the call\'s own teardown closed first is not counted as cleaned', async () => {
    const t = fakeTwilio({ [SID(9)]: async () => ({ status: 'completed', duration: '61' }) });
    const f = fakeDeps([{ id: 'raced', callSid: SID(9), ageMinutes: 16 }], t, { closeReturns: false });
    const out = await boot((o) => sweepStaleCalls(o, f.deps)).press('admin');
    expect(out.body.cleaned).toBe(0);
    expect(out.body.alreadyClosed).toBe(1);
    expect(out.body.message).toContain('1 row was already closed.');
  });
});

describe('a row Twilio cannot account for is left by the button', () => {
  it('not found, no CallSid, no Twilio credentials: all left open by the button', async () => {
    const t = fakeTwilio({});
    const f = fakeDeps([{ id: 'nf', callSid: SID(10), ageMinutes: 20 }, { id: 'nosid', callSid: null, ageMinutes: 20 }], t);
    const out = await boot((o) => sweepStaleCalls(o, f.deps)).press('admin');
    expect(f.closed).toEqual([]);
    expect(out.body.leftUnverified).toBe(2);
    expect(out.body.message).toContain('2 rows Twilio could not confirm were left open for the automatic sweep at 30 minutes.');

    const noCreds = fakeDeps([{ id: 'x', callSid: SID(11), ageMinutes: 20 }], null);
    const s = await sweepStaleCalls(MANUAL_CLEANUP_OPTIONS, noCreds.deps);
    expect(noCreds.closed).toEqual([]);
    expect(s.leftUnverified).toBe(1);
  });

  it('a Twilio error changes nothing', async () => {
    const t = fakeTwilio({ [SID(12)]: async () => { throw Object.assign(new Error('503 upstream'), { status: 503 }); } });
    const f = fakeDeps([{ id: 'err', callSid: SID(12), ageMinutes: 20 }], t);
    const out = await boot((o) => sweepStaleCalls(o, f.deps)).press('admin');
    expect(f.closed).toEqual([]);
    expect(out.body.errors).toBe(1);
    expect(out.body.message).toContain('1 Twilio lookup failed; nothing was changed for it.');
  });

  it('the automatic sweep keeps its 2026-08-26 rule: at 30 minutes an unaccountable row closes as failed', async () => {
    expect(STALE_CALL_CEILING_MS).toBe(30 * 60 * 1000);
    const t = fakeTwilio({});
    const f = fakeDeps([{ id: 'nf', callSid: SID(13), ageMinutes: 31 }], t);
    await sweepStaleCalls({}, f.deps);
    expect(f.closed).toEqual([{ id: 'nf', patch: expect.objectContaining({ status: 'failed', duration: null, callDisposition: STALE_SWEEP_DISPOSITION }) }]);
    expect(t.update).not.toHaveBeenCalled();
  });
});

describe('rows the sweep must leave cannot hide the rows behind them (Codex on #529)', () => {
  it('a page of live calls is passed over and the ended call behind it is closed', async () => {
    const t = fakeTwilio({
      [SID(21)]: async () => ({ status: 'in-progress' }),
      [SID(22)]: async () => ({ status: 'in-progress' }),
      [SID(23)]: async () => ({ status: 'completed', duration: '90' }),
    });
    const f = fakeDeps([
      { id: 'a-live', callSid: SID(21), ageMinutes: 50 },
      { id: 'b-live', callSid: SID(22), ageMinutes: 45 },
      { id: 'c-ended', callSid: SID(23), ageMinutes: 20 },
    ], t);
    const s = await sweepStaleCalls({ ...MANUAL_CLEANUP_OPTIONS, limit: 2 }, f.deps);
    expect(f.pages).toEqual([['a-live', 'b-live'], ['c-ended']]);
    expect(f.closed.map((c) => c.id)).toEqual(['c-ended']);
    expect(s.examined).toBe(3);
    expect(s.stillLiveAtTwilio).toBe(2);
    expect(t.update).not.toHaveBeenCalled();
  });

  it('one run reads at most the page cap, and five pages by default', async () => {
    const t = fakeTwilio({ [SID(24)]: async () => ({ status: 'completed' }), [SID(25)]: async () => ({ status: 'completed' }), [SID(26)]: async () => ({ status: 'completed' }) });
    const f = fakeDeps([24, 25, 26].map((n) => ({ id: `r${n}`, callSid: SID(n), ageMinutes: 60 - n })), t);
    await sweepStaleCalls({ ...MANUAL_CLEANUP_OPTIONS, limit: 1, maxPages: 2 }, f.deps);
    expect(f.pages.length).toBe(2);
    expect(f.closed.length).toBe(2);

    const g = fakeDeps(Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, callSid: null, ageMinutes: 20 + i })), fakeTwilio({}));
    await sweepStaleCalls({ ...MANUAL_CLEANUP_OPTIONS, limit: 1 }, g.deps);
    expect(g.pages.length).toBe(5);
  });

  it('the production read is oldest first, after an exact cursor, on the start time alone', async () => {
    const dialect = new PgDialect();
    await productionSweepDeps.findStaleRows(NOW, 200, { createdAtKey: '2026-11-26 17:00:00.123456', id: 'row-9' });
    const q = dialect.sqlToQuery(dbSelects[0].where as any);
    expect(q.sql).toBe(
      '("call_logs"."status" in ($1, $2, $3) and coalesce("call_logs"."start_time", "call_logs"."created_at") < $4 ' +
      'and ("call_logs"."created_at", "call_logs"."id") > ($5::timestamp, $6::varchar))',
    );
    // the cursor travels as the database's own text, microseconds and all
    expect(q.params).toEqual([...LIVE_CALL_STATUSES, NOW, '2026-11-26 17:00:00.123456', 'row-9']);
    const order = (dbSelects[0].orderBy ?? []).map((o) => dialect.sqlToQuery(o as any).sql);
    expect(order).toEqual(['"call_logs"."created_at" asc', '"call_logs"."id" asc']);
    expect(dbSelects[0].limit).toBe(200);
    // the key the next cursor is built from is Postgres's own text, not a Date
    expect(dialect.sqlToQuery(dbSelects[0].fields!.createdAtKey as any).sql).toBe('"call_logs"."created_at"::text');

    await productionSweepDeps.findStaleRows(NOW, 200, null);
    expect(dialect.sqlToQuery(dbSelects[1].where as any).sql).not.toContain('"call_logs"."id")');
  });

  it('the next page starts after the exact key of the row the last page ended on (Codex on #529, round 2)', async () => {
    const t = fakeTwilio({ [SID(27)]: async () => ({ status: 'in-progress' }), [SID(28)]: async () => ({ status: 'in-progress' }), [SID(29)]: async () => ({ status: 'completed' }) });
    const f = fakeDeps([
      { id: 'a', callSid: SID(27), ageMinutes: 50 },
      { id: 'b', callSid: SID(28), ageMinutes: 45 },
      { id: 'c', callSid: SID(29), ageMinutes: 20 },
    ], t);
    const s = await sweepStaleCalls({ ...MANUAL_CLEANUP_OPTIONS, limit: 1 }, f.deps);
    expect(f.cursors[0]).toBeNull();
    expect(f.cursors[1]).toEqual({ createdAtKey: new Date(NOW.getTime() - 50 * 60000).toISOString().replace('T', ' ').replace('Z', '') + '456', id: 'a' });
    expect(f.pages).toEqual([['a'], ['b'], ['c'], []]);
    expect(s.examined).toBe(3); // no row read twice
  });
});

describe('the production close lands only on a row still open', () => {
  it('guards the UPDATE on the row id and a live status', async () => {
    const dialect = new PgDialect();
    const ok = await productionSweepDeps.closeRow('row-1', { status: 'completed', duration: 742, endTime: NOW, twilioStatus: 'completed', callDisposition: STALE_SWEEP_DISPOSITION });
    expect(ok).toBe(true);
    const q = dialect.sqlToQuery(dbCalls[0].where as any);
    expect(q.sql).toContain('"call_logs"."id" = $1');
    expect(q.sql).toContain('"call_logs"."status" in ($2, $3, $4)');
    expect(q.params).toEqual(['row-1', ...LIVE_CALL_STATUSES]);
    expect(dbCalls[0].set).toMatchObject({ status: 'completed', callDisposition: STALE_SWEEP_DISPOSITION });

    returningRows = [];
    expect(await productionSweepDeps.closeRow('row-2', { status: 'failed', duration: null, endTime: NOW, twilioStatus: null, callDisposition: STALE_SWEEP_DISPOSITION })).toBe(false);
  });
});

describe('wiring', () => {
  const routes = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
  it('routes.ts mounts the button admin-only and carries no other handler for it', () => {
    expect(routes).toContain("mountStaleCallCleanup(app, { authenticate: isAuthenticated, admin: requireRole('admin') });");
    expect(routes).not.toContain("'/api/call-logs/cleanup-stale'");
  });

  it('no cleanup path can hang up a call', () => {
    for (const file of ['./staleCallCleanup.ts', './services/staleCallSweeper.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(src).not.toMatch(/\.update\(\s*\{\s*status:\s*['"]completed['"]/);
      expect(src).not.toMatch(/\.calls\([^)]*\)\.update\(/);
    }
  });

  it('the cleanup message reports every number the sweep produced', () => {
    expect(cleanupMessage({ examined: 5, closedFromTwilioTruth: 2, closedUnresolvable: 0, stillLiveAtTwilio: 1, errors: 1, leftUnverified: 1, alreadyClosed: 0 }))
      .toBe('Closed 2 rows whose call Twilio says has ended. 1 call is still live at Twilio and was not touched. 1 row Twilio could not confirm was left open for the automatic sweep at 30 minutes. 1 Twilio lookup failed; nothing was changed for it.');
  });
});
