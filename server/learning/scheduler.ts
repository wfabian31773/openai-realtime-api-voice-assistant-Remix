/**
 * Stage C, step 3 — the nightly schedule and the export.
 *
 * NOTHING RUNS unless LEARNING_RUNNER_ENABLED=1. When enabled, once a day
 * after 03:30 Pacific it measures yesterday and re-reads the two days before
 * it (the 5Star mirror lags staff entry, so a day settles over a few nights).
 *
 * The export (GET /api/learning/export) serves what the runs wrote — counts,
 * lane slugs, build markers, metric ids and definitions — behind a bearer
 * token (LEARNING_EXPORT_TOKEN). With no token configured it answers 503 and
 * serves nothing. It never serves a call SID, a name or a phone.
 */
import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import type { Express, Request, Response } from "express";
import { pool as hubPool } from "../db";
import { consoleQuery, isConsoleConfigured } from "../observatory/consoleDb";
import { fivestarQuery, isFivestarConfigured } from "../observatory/fivestarDb";
import { DEFINITIONS_HASH, METHOD_VERSION, METRICS, PACIFIC } from "./definitions";
import { runLearningDay, type RunnerDeps } from "./runner";
import type { Query } from "./compute";
import { detectCandidates, type StoredValue } from "./candidates";

export const RUN_AFTER_PACIFIC_MINUTES = 3 * 60 + 30;
export const SETTLING_DAYS = 3;
const TICK_MS = 30 * 60_000;

export function isLearningRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEARNING_RUNNER_ENABLED === "1";
}

/** The Pacific calendar day and minute-of-day of an instant. */
export function pacificClock(now: Date): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** The days a run at `now` measures, newest first, or [] when it is not time. */
export function daysDue(now: Date, lastRunFor: string | null): string[] {
  const { day, minutes } = pacificClock(now);
  if (minutes < RUN_AFTER_PACIFIC_MINUTES || lastRunFor === day) return [];
  return Array.from({ length: SETTLING_DAYS }, (_, i) => shiftDay(day, -(i + 1)));
}

let supportPool: pg.Pool | null = null;
function supportCenterQuery(env: NodeJS.ProcessEnv): Query | undefined {
  const url = env.LEARNING_SUPPORT_CENTER_DATABASE_URL;
  if (!url) return undefined;
  if (!supportPool) {
    supportPool = new pg.Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
      options: "-c default_transaction_read_only=on -c statement_timeout=15000",
    });
    supportPool.on("error", (err) => console.error("[learning] Support Center pool error:", err.message));
  }
  const p = supportPool;
  return (text, params) => p.query(text, params);
}

export function productionDeps(env: NodeJS.ProcessEnv = process.env): RunnerDeps {
  return {
    hub: (text, params) => hubPool.query(text, params),
    connectHub: async () => {
      const c = await hubPool.connect();
      return { query: (text, params) => c.query(text, params), release: () => c.release() };
    },
    supportCenter: supportCenterQuery(env),
    fivestar: isFivestarConfigured() ? (text, params) => fivestarQuery(text, params ?? []) : undefined,
    console: isConsoleConfigured() ? (text, params) => consoleQuery(text, params ?? []) : undefined,
  };
}

let timer: NodeJS.Timeout | null = null;
let lastRunFor: string | null = null;
let running = false;

export async function learningTick(deps: RunnerDeps, now: Date = new Date()): Promise<string[]> {
  if (running) return [];
  const days = daysDue(now, lastRunFor);
  if (!days.length) return [];
  running = true;
  const done: string[] = [];
  let failed = false;
  try {
    for (const day of days) {
      try {
        const out = await runLearningDay(day, deps);
        if (out.status === "skipped") {
          console.warn(`[learning] ${day}: nothing written — ${out.reason}`);
          break;
        }
        if (out.status === "locked") {
          // Nothing was written by THIS run, so the night is not finished: the
          // next tick tries the day again (Codex, #365).
          failed = true;
          console.info(`[learning] ${day}: another run holds the day; tried again next tick`);
          continue;
        }
        if (out.status === "kept") {
          // A source failed and the day already holds a run: the earlier
          // values stand, and the next tick reads the day again (Codex, #365).
          failed = true;
          console.warn(`[learning] ${day}: a source failed, earlier values kept; tried again next tick — ${out.reason}`);
          continue;
        }
        console.info(`[learning] ${day}: ${out.status} run ${out.runId}, ${out.values.length} values, hash ${out.hash}`);
        done.push(day);
        // A source that is set up but failed to answer is a blip, not a fact:
        // keep the night open so the day is read again (Codex, #365). An
        // unconfigured source stays partial and does not hold the night.
        if (out.readFailed) failed = true;
      } catch (e) {
        failed = true;
        console.error(`[learning] ${day}: run failed — ${(e as Error).message}`);
      }
    }
    // A failed day is tried again on the next tick; a finished night is not.
    if (!failed) lastRunFor = pacificClock(now).day;
  } finally {
    running = false;
  }
  return done;
}

export function _resetLearningSchedulerForTests(): void {
  lastRunFor = null;
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

export function startLearningRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isLearningRunnerEnabled(env)) {
    console.info("[learning] measurement engine OFF (LEARNING_RUNNER_ENABLED is not 1)");
    return false;
  }
  if (timer) return true;
  const deps = productionDeps(env);
  console.info(`[learning] measurement engine ON (${METHOD_VERSION}); runs after 03:30 Pacific for the last ${SETTLING_DAYS} days`);
  const tick = () => void learningTick(deps).catch((e) => console.error("[learning] tick failed:", (e as Error).message));
  timer = setInterval(tick, TICK_MS);
  tick();
  return true;
}

// ---------------------------------------------------------------------------
// Export

export const EXPORT_RUNS_SQL = `
SELECT id, to_char(run_date, 'YYYY-MM-DD') AS run_date, status, method_version, started_at, finished_at, notes
FROM learning_runs WHERE run_date >= $1::date ORDER BY run_date, method_version`;
export const EXPORT_VALUES_SQL = `
SELECT v.run_id, to_char(r.run_date, 'YYYY-MM-DD') AS run_date, r.method_version, v.metric_id, v.repo, v.lane,
       v.runtime_marker, v.numerator, v.denominator, v.unknown_count
FROM learning_metric_values v JOIN learning_runs r ON r.id = v.run_id
WHERE r.run_date >= $1::date ORDER BY r.run_date, v.metric_id, v.lane, v.runtime_marker`;

export const MAX_EXPORT_DAYS = 120;

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A real calendar day in YYYY-MM-DD, not merely that shape (Codex, #365: 2026-99-99). */
export function isCalendarDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function learningExportHandler(hub: Query, env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()) {
  return async (req: Request, res: Response) => {
    const expected = env.LEARNING_EXPORT_TOKEN;
    if (!expected) return res.status(503).json({ error: "export not configured" });
    const auth = String(req.headers.authorization ?? "");
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!given || !tokenMatches(given, expected)) return res.status(401).json({ error: "unauthorized" });

    const today = pacificClock(now()).day;
    const floor = shiftDay(today, -MAX_EXPORT_DAYS);
    const asked = isCalendarDay(req.query.since) ? req.query.since : shiftDay(today, -14);
    const since = asked < floor ? floor : asked;
    try {
      const runs = (await hub(EXPORT_RUNS_SQL, [since])).rows;
      const values = (await hub(EXPORT_VALUES_SQL, [since])).rows as StoredValue[];
      res.json({
        methodVersion: METHOD_VERSION,
        definitionsHash: DEFINITIONS_HASH,
        since,
        metrics: METRICS,
        runs: runs.map((r) => ({ ...r, notes: safeNotes(r.notes) })),
        values,
        candidates: detectCandidates(values),
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (/learning_runs|learning_metric_values/.test(msg) && /does not exist/.test(msg)) {
        return res.status(404).json({ error: "learning tables absent" });
      }
      res.status(500).json({ error: "export failed" });
    }
  };
}

function safeNotes(notes: unknown): unknown {
  try {
    return typeof notes === "string" ? JSON.parse(notes) : notes;
  } catch {
    return null;
  }
}

export function registerLearningExport(app: Express): void {
  app.get("/api/learning/export", learningExportHandler((text, params) => hubPool.query(text, params)));
}
