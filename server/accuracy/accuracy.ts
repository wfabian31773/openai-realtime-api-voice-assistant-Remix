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
 * The hourly run is OFF unless ACCURACY_CHECKS_SCHEDULE is not "off": it is on
 * by default because a check nobody runs is no check. Each run takes a
 * session advisory lock so two processes do not both write a run.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Express, RequestHandler } from 'express';
import { createAccuracyRunner, safeError, type AccuracyReport, type CheckResult } from './accuracy.logic';
import { buildChecks, type AccuracyDeps, type Queryable } from './checks';

export const ACCURACY_API = '/api/observatory/accuracy';
const RETENTION_DAYS = 90;
const SCHEDULE_MS = 60 * 60_000;
/** pg_try_advisory_lock key: hashtext('accuracy_check_run'), fixed so every process agrees. */
const LOCK_SQL = `SELECT pg_try_advisory_lock(hashtext('accuracy_check_run')) AS got`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext('accuracy_check_run'))`;

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
 * nor starts a streak.
 */
export const FAILING_SINCE_SQL = `
WITH last_pass AS (
  SELECT check_id, max(ran_at) AS t
    FROM accuracy_check_results
   WHERE status = 'pass' AND check_id = ANY($1::text[])
   GROUP BY check_id
)
SELECT r.check_id, min(r.ran_at) AS since
  FROM accuracy_check_results r
  LEFT JOIN last_pass p ON p.check_id = r.check_id
 WHERE r.status = 'fail'
   AND r.check_id = ANY($1::text[])
   AND (p.t IS NULL OR r.ran_at > p.t)
 GROUP BY r.check_id`;

/** The previous run's status per check, to say which checks just started failing. */
export const PREVIOUS_STATUS_SQL = `
SELECT DISTINCT ON (check_id) check_id, status
  FROM accuracy_check_results
 WHERE check_id = ANY($1::text[]) AND ran_at < $2::timestamptz
 ORDER BY check_id, ran_at DESC`;

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
      const res = await q.query(FAILING_SINCE_SQL, [failing]);
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
    onReport: async (report) => {
      const newly = await storeReport(deps.hub(), report);
      const { pass, fail, unknown } = report.counts;
      console.log(
        `[ACCURACY] ${report.results.length} checks: ${pass} pass, ${fail} fail, ${unknown} unknown` +
          (newly.length ? `; newly failing: ${newly.join(', ')}` : ''),
      );
    },
  });

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
      const tick = async () => {
        const q = deps.hub();
        let got = false;
        try {
          const lock = await q.query(LOCK_SQL);
          got = lock.rows[0]?.got === true;
          if (!got) return;
          await runner.report(true);
        } catch (err) {
          console.warn(`[ACCURACY] hourly run failed: ${safeError(err)}`);
        } finally {
          if (got) await q.query(UNLOCK_SQL).catch(() => {});
        }
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
