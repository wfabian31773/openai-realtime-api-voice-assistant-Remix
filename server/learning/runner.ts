/**
 * Stage C, step 3 — the nightly run.
 *
 * Reads only (every source pool is read-only; the Hub is read for the fleet's
 * calls), computes one Pacific day's metrics, and writes ONE row to
 * learning_runs and its values to learning_metric_values, in one transaction
 * under a per-day advisory lock. Re-running a day replaces that day's values
 * for the same method_version (the table's own UNIQUE (run_date,
 * method_version)), which is how a 5Star day settles as the mirror catches up:
 * the run notes carry the read time, so a reader always knows how late a
 * number was read.
 *
 * OFF unless LEARNING_RUNNER_ENABLED=1 (scheduler.ts). With the A6 tables
 * absent it writes nothing and says so once.
 */
import { createHash } from "node:crypto";
import { computeFivestar, computeRemix, sortValues, type DayResult, type MetricValue, type Query, type Sources } from "./compute";
import { DEFINITIONS_HASH, METHOD_VERSION, METRICS } from "./definitions";

export interface TxClient {
  query: Query;
  release: () => void;
}

export interface RunnerDeps {
  hub: Query;
  connectHub: () => Promise<TxClient>;
  supportCenter?: Query;
  fivestar?: Query;
  console?: Query;
  now?: () => Date;
}

export type RunOutcome =
  | { status: "skipped"; reason: string }
  | { status: "locked" }
  | {
      status: "ok" | "partial";
      runId: number;
      hash: string;
      values: MetricValue[];
      unavailable: Record<string, string>;
      /** A configured source failed to answer (not merely unconfigured): the night retries the day. */
      readFailed: boolean;
    };

/** A reason written by a source that is configured but failed, as against one that is not set up. */
export function isReadFailure(reason: string): boolean {
  return /read failed/.test(reason);
}

export const TABLES_SQL = `SELECT to_regclass('public.learning_runs') IS NOT NULL AS runs, to_regclass('public.learning_metric_values') IS NOT NULL AS vals`;
export const COLUMN_SQL = `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs' AND column_name = $1::text`;

export const UPSERT_RUN_SQL = `
INSERT INTO learning_runs (run_date, status, method_version, notes, started_at, finished_at)
VALUES ($1::date, $2::text, $3::text, $4::text, now(), now())
ON CONFLICT (run_date, method_version)
DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at
RETURNING id`;

export const DELETE_VALUES_SQL = `DELETE FROM learning_metric_values WHERE run_id = $1::bigint`;

/** One fixed statement whatever the row count (the 2026-10-01 pg_stat_statements lesson). */
export const INSERT_VALUES_SQL = `
INSERT INTO learning_metric_values (run_id, metric_id, repo, lane, runtime_marker, numerator, denominator, unknown_count)
SELECT $1::bigint, v.metric_id, v.repo, v.lane, v.runtime_marker, v.numerator, v.denominator, v.unknown_count
FROM jsonb_to_recordset($2::jsonb) AS v(metric_id text, repo text, lane text, runtime_marker text, numerator int, denominator int, unknown_count int)`;

export const DAY_LOCK_SQL = `SELECT pg_try_advisory_xact_lock(hashtext('learning_runs:' || $1::text)) AS locked`;

export function outputHash(values: MetricValue[]): string {
  return createHash("sha256").update(JSON.stringify(sortValues(values))).digest("hex").slice(0, 16);
}

async function columnExists(q: Query | undefined, column: string): Promise<boolean> {
  if (!q) return false;
  try {
    const { rows } = await q(COLUMN_SQL, [column]);
    return Number(rows[0]?.n) > 0;
  } catch {
    return false;
  }
}

function allUnavailable(repo: "Remix" | "5Star", why: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of METRICS) if (m.repo === repo) out[m.id] = why;
  return out;
}

export async function runLearningDay(day: string, deps: RunnerDeps): Promise<RunOutcome> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`[learning] not a day: ${day}`);
  const tables = (await deps.hub(TABLES_SQL)).rows[0];
  if (!tables?.runs || !tables?.vals) {
    return { status: "skipped", reason: "learning tables absent (the A6 migration has not been applied)" };
  }

  const client = await deps.connectHub();
  try {
    await client.query("BEGIN");
    const locked = (await client.query(DAY_LOCK_SQL, [day])).rows[0]?.locked;
    if (!locked) {
      await client.query("ROLLBACK");
      return { status: "locked" };
    }
    // The day is held BEFORE anything is read, so an older read can never
    // replace a newer one (Codex, #365): whoever holds the lock reads and writes.
    const src: Sources = {
      hub: deps.hub,
      supportCenter: deps.supportCenter,
      fivestar: deps.fivestar,
      console: deps.console,
      hubHasRuntimeMarker: await columnExists(deps.hub, "runtime_marker"),
      fivestarHasBuildId: await columnExists(deps.fivestar, "build_id"),
    };

    const parts: DayResult[] = [];
    try {
      parts.push(await computeRemix(day, src));
    } catch (e) {
      parts.push({ values: [], unavailable: allUnavailable("Remix", `fleet read failed: ${(e as Error).message}`) });
    }
    try {
      parts.push(await computeFivestar(day, src));
    } catch (e) {
      parts.push({ values: [], unavailable: allUnavailable("5Star", `5Star read failed: ${(e as Error).message}`) });
    }
    const values = sortValues(parts.flatMap((p) => p.values));
    const unavailable = Object.assign({}, ...parts.map((p) => p.unavailable)) as Record<string, string>;
    const hash = outputHash(values);
    const status = Object.keys(unavailable).length ? "partial" : "ok";
    const notes = JSON.stringify({
      readAt: (deps.now?.() ?? new Date()).toISOString(),
      outputHash: hash,
      definitionsHash: DEFINITIONS_HASH,
      buildSplit: { remix: src.hubHasRuntimeMarker, fivestar: src.fivestarHasBuildId },
      unavailable,
    });

    const runId = Number((await client.query(UPSERT_RUN_SQL, [day, status, METHOD_VERSION, notes])).rows[0].id);
    await client.query(DELETE_VALUES_SQL, [runId]);
    if (values.length) {
      await client.query(INSERT_VALUES_SQL, [
        runId,
        JSON.stringify(
          values.map((v) => ({
            metric_id: v.metricId,
            repo: v.repo,
            lane: v.lane,
            runtime_marker: v.runtimeMarker,
            numerator: v.numerator,
            denominator: v.denominator,
            unknown_count: v.unknownCount,
          })),
        ),
      ]);
    }
    await client.query("COMMIT");
    return { status, runId, hash, values, unavailable, readFailed: Object.values(unavailable).some(isReadFailure) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
