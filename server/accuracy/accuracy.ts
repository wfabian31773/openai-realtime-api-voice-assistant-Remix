/**
 * server/accuracy/accuracy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The accuracy check's wiring: the history table, the route the Observatory's
 * Accuracy tab reads, and the hourly run. The comparison rules are in
 * accuracy.logic.ts; the checks themselves are in checks.ts.
 *
 *   GET  /api/observatory/accuracy          the latest report (run when stale)
 *   GET  /api/observatory/accuracy?refresh=1  run now (at most once a minute)
 *
 * The history table `accuracy_check_results` is created on first write
 * (CREATE TABLE IF NOT EXISTS, the call_events pattern; documented in
 * migrations/add_accuracy_check_results.sql). One row per check per run:
 * the status, the two numbers and the sentence. No patient data is in any
 * check, so none is in the table. Rows older than 90 days are deleted by the
 * run that writes new ones.
 *
 * The hourly run is on unless ACCURACY_CHECKS_SCHEDULE is "off": it is on
 * by default because a check nobody runs is no check. Each run takes a
 * lease lock (distributed_locks) so two processes do not both write a run.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Express, RequestHandler } from 'express';
import { createAccuracyRunner, safeError, type AccuracyReport, type CheckResult } from './accuracy.logic';
import { buildChecks, type AccuracyDeps, type Queryable } from './checks';

export const ACCURACY_API = '/api/observatory/accuracy';
const RETENTION_DAYS = 90;
const SCHEDULE_MS = 60 * 60_000;
/** The lock that keeps two processes from writing one hourly run. */
export interface RunLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export const RUN_LOCK_NAME = 'accuracy-check-run';
const RUN_LOCK_HOLDER = 'accuracy-check';
/** Longer than a run (20 s timeout); the lock service refreshes it while held. */
const RUN_LOCK_TTL_SECONDS = 120;

/**
 * The app's lease lock (distributed_locks, src/services/distributedLock.ts),
 * the one the filing-quality worker and the outbound dialler use. It is a row
 * with an expiry, so it works through Supabase's PgBouncer in transaction
 * mode, where a session advisory lock can be taken on one backend and
 * "released" on another (Codex review of #525), and it frees itself if a
 * process dies holding it. Both calls import the same module from this file,
 * so the release reaches the instance that holds the refresh timer.
 */
export function leaseRunLock(): RunLock {
  return {
    async acquire() {
      const { distributedLockService } = await import('../../src/services/distributedLock');
      const r = await distributedLockService.acquireLock({
        lockName: RUN_LOCK_NAME,
        holderId: RUN_LOCK_HOLDER,
        ttlSeconds: RUN_LOCK_TTL_SECONDS,
      });
      return r.acquired;
    },
    async release() {
      const { distributedLockService } = await import('../../src/services/distributedLock');
      await distributedLockService.releaseLock(RUN_LOCK_NAME, RUN_LOCK_HOLDER);
    },
  };
}

/** One hourly run, only when this process holds the lock; the lock is always released. */
export async function runUnderLock(lock: RunLock, run: () => Promise<unknown>): Promise<boolean> {
  let got = false;
  try {
    got = await lock.acquire();
  } catch (err) {
    console.warn(`[ACCURACY] hourly run skipped, the run lock could not be read: ${safeError(err)}`);
    return false;
  }
  if (!got) return false;
  try {
    await run();
    return true;
  } catch (err) {
    console.warn(`[ACCURACY] hourly run failed: ${safeError(err)}`);
    return false;
  } finally {
    await lock.release().catch((err) => {
      console.warn(`[ACCURACY] the run lock was not released (it expires on its own): ${safeError(err)}`);
    });
  }
}

export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS accuracy_check_results (
  id            BIGSERIAL PRIMARY KEY,
  ran_at        TIMESTAMPTZ NOT NULL,
  check_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  screen_value  DOUBLE PRECISION,
  truth_value   DOUBLE PRECISION,
  note          TEXT
)`;
export const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS accuracy_check_results_check_ran
  ON accuracy_check_results (check_id, ran_at DESC)`;

/**
 * One fixed statement for the whole run: the rows travel as one jsonb
 * parameter. A statement whose text changes with the row count fills
 * pg_stat_statements (the 2026-10-01 disk-IO lesson); this one never changes.
 */
export const INSERT_SQL = `
INSERT INTO accuracy_check_results (ran_at, check_id, status, screen_value, truth_value, note)
SELECT $1::timestamptz, x.id, x.status, x.screen, x.truth, x.note
  FROM jsonb_to_recordset($2::jsonb) AS x(id text, status text, screen double precision, truth double precision, note text)`;

export const PURGE_SQL = `DELETE FROM accuracy_check_results WHERE ran_at < now() - make_interval(days => $1::int)`;

/**
 * For each check, when its current run of failures began: the earliest
 * failing run after its latest passing run. An unknown run neither breaks
 * nor starts a streak. Only runs at or before the shown report count ($2):
 * another server may store a newer run while this one serves a cached
 * report, and "failing since" must never be later than the time shown
 * (Codex review of #525).
 */
export const FAILING_SINCE_SQL = `
WITH last_pass AS (
  SELECT check_id, max(ran_at) AS t
    FROM accuracy_check_results
   WHERE status = 'pass' AND check_id = ANY($1::text[]) AND ran_at <= $2::timestamptz
   GROUP BY check_id
)
SELECT r.check_id, min(r.ran_at) AS since
  FROM accuracy_check_results r
  LEFT JOIN last_pass p ON p.check_id = r.check_id
 WHERE r.status = 'fail'
   AND r.check_id = ANY($1::text[])
   AND r.ran_at <= $2::timestamptz
   AND (p.t IS NULL OR r.ran_at > p.t)
 GROUP BY r.check_id`;

/** The previous run's status per check, to say which checks just started failing. */
export const PREVIOUS_STATUS_SQL = `
SELECT DISTINCT ON (check_id) check_id, status
  FROM accuracy_check_results
 WHERE check_id = ANY($1::text[]) AND ran_at < $2::timestamptz
 ORDER BY check_id, ran_at DESC`;

/**
 * Whether this clock hour (UTC) already has a stored run. Each server's hourly
 * timer starts at its own boot, and the lease is released after each run, so
 * two servers a few minutes apart would each write an hourly sample; the
 * first to write takes the hour and the others skip it (Codex review of #525).
 */
export const HOUR_TAKEN_SQL = `
SELECT EXISTS (
  SELECT 1 FROM accuracy_check_results
   WHERE ran_at >= date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
) AS taken`;

/** True when another server already recorded a run in this clock hour. */
export async function hourAlreadyRecorded(q: Queryable): Promise<boolean> {
  await ensureTable(q);
  const res = await q.query(HOUR_TAKEN_SQL);
  return res.rows[0]?.taken === true;
}

export interface StoredResult extends CheckResult {
  /** When this check's current run of failures began; null unless failing. */
  failingSince: string | null;
}

export interface AccuracyResponse extends Omit<AccuracyReport, 'results'> {
  results: StoredResult[];
  /** False when the history table could not be read (the report is still shown). */
  historyAvailable: boolean;
}

let tableReady: Promise<void> | null = null;
async function ensureTable(q: Queryable): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await q.query(CREATE_TABLE_SQL);
      await q.query(CREATE_INDEX_SQL);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

/** Write one run and purge old rows. Returns the checks that were not failing on the run before. */
export async function storeReport(q: Queryable, report: AccuracyReport): Promise<string[]> {
  await ensureTable(q);
  const ids = report.results.map((r) => r.id);
  const prev = await q.query(PREVIOUS_STATUS_SQL, [ids, report.ranAt]);
  const before = new Map(prev.rows.map((r) => [String(r.check_id), String(r.status)]));
  const rows = report.results.map((r) => ({
    id: r.id,
    status: r.status,
    screen: r.screenValue,
    truth: r.truthValue,
    note: r.note,
  }));
  await q.query(INSERT_SQL, [report.ranAt, JSON.stringify(rows)]);
  await q.query(PURGE_SQL, [RETENTION_DAYS]);
  return report.results.filter((r) => r.status === 'fail' && before.get(r.id) !== 'fail').map((r) => r.id);
}

/** Attach each failing check's "failing since". A history that cannot be read leaves them null. */
export async function withHistory(q: Queryable, report: AccuracyReport): Promise<AccuracyResponse> {
  const failing = report.results.filter((r) => r.status === 'fail').map((r) => r.id);
  let since = new Map<string, string>();
  let historyAvailable = true;
  if (failing.length) {
    try {
      await ensureTable(q);
      const res = await q.query(FAILING_SINCE_SQL, [failing, report.ranAt]);
      since = new Map(
        res.rows.map((r) => [String(r.check_id), new Date(r.since as string | Date).toISOString()]),
      );
    } catch (err) {
      historyAvailable = false;
      console.warn(`[ACCURACY] history unreadable: ${safeError(err)}`);
    }
  }
  return {
    ...report,
    historyAvailable,
    results: report.results.map((r) => ({
      ...r,
      failingSince: r.status === 'fail' ? (since.get(r.id) ?? report.ranAt) : null,
    })),
  };
}

export interface AccuracyMountDeps {
  authenticate: RequestHandler;
  /** The Hub pool (the app's own database), read live per request. */
  hub: () => Queryable;
  /** The hourly run's lock; the app's lease lock unless a test supplies one. */
  runLock?: RunLock;
  /** Everything the checks read; built per run so pools that fail over are re-read. */
  checkDeps: () => AccuracyDeps;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function mountAccuracyCheck(app: Express, deps: AccuracyMountDeps) {
  const now = deps.now ?? (() => new Date());
  const runner = createAccuracyRunner<AccuracyDeps>({
    checks: () => buildChecks(),
    deps: deps.checkDeps,
    now,
    ttlMs: 15 * 60_000,
    minRefreshMs: 60_000,
    timeoutMs: 20_000,
    concurrency: 3,
  });

  /**
   * Only the hourly run, under the lease, writes history. A page load or
   * "Check now" runs the checks and shows them but stores nothing: the cache
   * and the refresh throttle are per process, so requests reaching two
   * replicas would otherwise both write the same run (Codex review of #525).
   */
  const persist = async (report: AccuracyReport) => {
    const newly = await storeReport(deps.hub(), report);
    const { pass, fail, unknown } = report.counts;
    console.log(
      `[ACCURACY] ${report.results.length} checks: ${pass} pass, ${fail} fail, ${unknown} unknown` +
        (newly.length ? `; newly failing: ${newly.join(', ')}` : ''),
    );
  };

  app.get(ACCURACY_API, deps.authenticate, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const report = await runner.report(req.query.refresh === '1');
      res.json(await withHistory(deps.hub(), report));
    } catch (err) {
      console.error(`[ACCURACY] run failed: ${safeError(err)}`);
      res.status(500).json({ error: 'The accuracy checks could not be run.' });
    }
  });

  return {
    runner,
    /** The hourly run. Off when ACCURACY_CHECKS_SCHEDULE=off. Returns a stop function. */
    startSchedule(): () => void {
      if ((deps.env.ACCURACY_CHECKS_SCHEDULE ?? '').trim().toLowerCase() === 'off') {
        console.log('[ACCURACY] hourly run is off (ACCURACY_CHECKS_SCHEDULE=off)');
        return () => {};
      }
      const lock = deps.runLock ?? leaseRunLock();
      const tick = async () => {
        await runUnderLock(lock, async () => {
          if (await hourAlreadyRecorded(deps.hub())) {
            console.log('[ACCURACY] this hour already has a stored run (another server); skipped');
            return;
          }
          await persist(await runner.report(true));
        });
      };
      console.log('[ACCURACY] hourly run on: every screen number read twice, results in accuracy_check_results');
      const first = setTimeout(() => void tick(), 2 * 60_000);
      const every = setInterval(() => void tick(), SCHEDULE_MS);
      first.unref?.();
      every.unref?.();
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    },
  };
}
