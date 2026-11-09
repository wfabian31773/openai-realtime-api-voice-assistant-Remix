/**
 * THE WORKER THAT WRITES DOWN WHAT EACH CALL SHOULD HAVE FILED — v191.
 *
 * Every five minutes, under one distributed lock so only one process does it,
 * it takes up to 25 recent calls that have no expectation yet, reads each
 * transcript with `filingExpectation.ts`, and stores the answer in the Hub's
 * `filing_expectations` table. The Daybook then compares those rows with the
 * tickets in the Support Center (`filingQuality.ts`, `scripts/filing-quality.ts`).
 *
 * It looks back 72 hours, so a deploy or an outage does not leave a day
 * unmeasured; newest first, so today's Daybook is filled before old rows.
 *
 * Off without OPENAI_API_KEY or with FILING_QUALITY_DISABLED=1. It writes one
 * table it owns and nothing else: no call row, no ticket, no gate.
 *
 * PHI: a log line carries a call SID, a count or an error KIND. Never a
 * transcript, a name, a date of birth or a phone number.
 */
import {
  extractFilingExpectation,
  FILING_EXPECTATION_MODEL,
  FILING_EXPECTATION_PROMPT_VERSION,
  type ExpectationAsker,
  type FilingExpectation,
} from "./filingExpectation";

export const FILING_QUALITY_INTERVAL_MS = 5 * 60_000;
export const FILING_QUALITY_BATCH = 25;
export const FILING_QUALITY_CONCURRENCY = 3;
export const FILING_QUALITY_LOOKBACK_HOURS = 72;
/** One bad row cannot be read for ever: three tries per process, then it is left alone. */
export const FILING_QUALITY_MAX_ATTEMPTS = 3;
export const FILING_QUALITY_LOCK_NAME = "filing-quality-expectations";
const LOCK_TTL_SECONDS = 240;
const HOLDER = "filing-quality";

/**
 * The operator's test line (Grok Bot's dialer, ai-bridge PR #32) is not fleet
 * traffic — the fleet watch's own rule (2026-10-29). Last four digits only.
 */
export const TEST_LINE_SUFFIX = "2660";

export interface ExpectationCandidate {
  callSid: string;
  agentUsed: string | null;
  startedAt: Date | null;
  transcript: string;
}

export interface FilingQualityStore {
  ensureTable(): Promise<void>;
  candidates(limit: number, skip: string[]): Promise<ExpectationCandidate[]>;
  insert(row: { callSid: string; agentUsed: string | null; startedAt: Date | null; expectation: FilingExpectation | null; skipped: string | null }): Promise<void>;
}

export interface FilingQualityLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS filing_expectations (
    call_sid TEXT PRIMARY KEY,
    agent_used TEXT,
    call_started_at TIMESTAMPTZ,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    expectation JSONB,
    skipped_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

/** The Daybook reads a day at a time by call start. */
export const ENSURE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_filing_expectations_started ON filing_expectations (call_started_at)`;

/**
 * Substantive, finished, real calls with no expectation yet. No transcript
 * filter here: a call with no caller line is stored as skipped
 * (`no_caller_line`) by the worker without asking the model, so once the
 * window is caught up this walks the created_at index and probes the primary
 * key, and never reads a transcript it has already judged (review of #440:
 * a LIKE on the transcript ran before the anti-join and re-read every
 * transcript in the window each cycle). `created_at` is
 * a timestamp without time zone holding UTC, so NOW() is read in UTC. The
 * created_at range uses idx_call_logs_created (checked with EXPLAIN on the
 * Hub, 2026-11-09).
 */
export const CANDIDATES_SQL = `
  SELECT c.call_sid, c.agent_used, coalesce(c.start_time, c.created_at) AS started_at, c.transcript
  FROM call_logs c
  WHERE c.created_at >= (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $2::int)
    AND coalesce(c.end_time, c.created_at) <= (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 minutes'
    AND c.duration >= 30
    AND c.call_sid ~* '^CA[0-9a-f]{32}$'
    AND coalesce(c.agent_used, '') <> 'wayne-operator'
    AND coalesce(c."from", '') NOT LIKE ('%' || $3::text)
    AND coalesce(c."to", '') NOT LIKE ('%' || $3::text)
    AND coalesce(c.dialed_number, '') NOT LIKE ('%' || $3::text)
    AND NOT EXISTS (SELECT 1 FROM filing_expectations f WHERE f.call_sid = c.call_sid)
    AND NOT (c.call_sid = ANY($4::text[]))
  ORDER BY c.created_at DESC
  LIMIT $1::int`;

export const INSERT_SQL = `
  INSERT INTO filing_expectations (call_sid, agent_used, call_started_at, model, prompt_version, expectation, skipped_reason)
  VALUES ($1::text, $2::text, $3::timestamptz, $4::text, $5::text, $6::jsonb, $7::text)
  ON CONFLICT (call_sid) DO NOTHING`;

/** The production store: the Hub pool, imported lazily so importing this module opens nothing. */
export const hubFilingQualityStore: FilingQualityStore = {
  async ensureTable() {
    const { pool } = await import("../../server/db");
    await pool.query(ENSURE_TABLE_SQL);
    await pool.query(ENSURE_INDEX_SQL);
  },
  async candidates(limit, skip) {
    const { pool } = await import("../../server/db");
    const res = await pool.query(CANDIDATES_SQL, [limit, FILING_QUALITY_LOOKBACK_HOURS, TEST_LINE_SUFFIX, skip]);
    return (res.rows as Array<{ call_sid: string; agent_used: string | null; started_at: Date | string | null; transcript: string }>).map((r) => ({
      callSid: r.call_sid,
      agentUsed: r.agent_used,
      startedAt: r.started_at ? new Date(r.started_at as string) : null,
      transcript: r.transcript,
    }));
  },
  async insert(row) {
    const { pool } = await import("../../server/db");
    await pool.query(INSERT_SQL, [
      row.callSid,
      row.agentUsed,
      row.startedAt ? row.startedAt.toISOString() : null,
      FILING_EXPECTATION_MODEL,
      FILING_EXPECTATION_PROMPT_VERSION,
      row.expectation ? JSON.stringify(row.expectation) : null,
      row.skipped,
    ]);
  },
};

let held = false;
export const defaultFilingQualityLock: FilingQualityLock = {
  async acquire() {
    if (held) return false;
    const { distributedLockService } = await import("./distributedLock");
    const result = await distributedLockService.acquireLock({ lockName: FILING_QUALITY_LOCK_NAME, holderId: HOLDER, ttlSeconds: LOCK_TTL_SECONDS });
    held = result.acquired;
    return result.acquired;
  },
  async release() {
    const { distributedLockService } = await import("./distributedLock");
    try {
      await distributedLockService.releaseLock(FILING_QUALITY_LOCK_NAME, HOLDER);
    } finally {
      held = false;
    }
  },
};

/** The kind of a failure, for the log: never its message, which can echo request content. */
export function failureKind(err: unknown): string {
  if (err instanceof SyntaxError) return "unreadable_answer";
  const e = err as { name?: unknown; status?: unknown; message?: unknown } | null;
  if (e && typeof e.status === "number") return `http_${e.status}`;
  if (e && e.message === "no_api_key") return "no_api_key";
  const name = e && typeof e.name === "string" ? e.name : "";
  if (/timeout/i.test(name)) return "timeout";
  if (/abort/i.test(name)) return "aborted";
  if (/connection/i.test(name)) return "connection";
  return "error";
}

export interface CycleDeps {
  store: FilingQualityStore;
  lock: FilingQualityLock;
  ask?: ExpectationAsker;
  log?: Pick<Console, "info" | "warn">;
  /** Per-process attempt counts, keyed on call SID. */
  attempts?: Map<string, number>;
}

export interface CycleResult {
  ran: boolean;
  read: number;
  stored: number;
  skipped: number;
  failed: number;
}

const processAttempts = new Map<string, number>();
/** Stores whose table this process has already ensured. */
const readyStores = new WeakSet<FilingQualityStore>();

/** Run `work` over `items` with at most `n` in flight. */
async function inPool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(lanes);
}

export async function runFilingQualityCycle(deps: CycleDeps): Promise<CycleResult> {
  const log = deps.log ?? console;
  const attempts = deps.attempts ?? processAttempts;
  const result: CycleResult = { ran: false, read: 0, stored: 0, skipped: 0, failed: 0 };
  if (!(await deps.lock.acquire())) return result;
  result.ran = true;
  try {
    if (!readyStores.has(deps.store)) {
      await deps.store.ensureTable();
      readyStores.add(deps.store);
    }
    const givenUp = [...attempts.entries()].filter(([, n]) => n >= FILING_QUALITY_MAX_ATTEMPTS).map(([sid]) => sid);
    const rows = await deps.store.candidates(FILING_QUALITY_BATCH, givenUp);
    result.read = rows.length;
    await inPool(rows, FILING_QUALITY_CONCURRENCY, async (row) => {
      if (!row.transcript || !row.transcript.includes("CALLER:")) {
        // Never heard: nothing for the model to read, and no request to file.
        try {
          await deps.store.insert({ callSid: row.callSid, agentUsed: row.agentUsed, startedAt: row.startedAt, expectation: null, skipped: "no_caller_line" });
          result.skipped++;
        } catch (err) {
          result.failed++;
          log.warn(`[FILING QUALITY] ${row.callSid}: not stored (${failureKind(err)})`);
        }
        return;
      }
      try {
        const expectation = await extractFilingExpectation(
          { transcript: row.transcript, lane: row.agentUsed, callStartedAt: row.startedAt },
          deps.ask,
        );
        // An unusable answer is stored as skipped, so the row is not read again
        // and the Daybook can count how often the reader failed to answer.
        await deps.store.insert({
          callSid: row.callSid,
          agentUsed: row.agentUsed,
          startedAt: row.startedAt,
          expectation,
          skipped: expectation ? null : "no_usable_answer",
        });
        if (expectation) result.stored++;
        else result.skipped++;
        attempts.delete(row.callSid);
      } catch (err) {
        result.failed++;
        const n = (attempts.get(row.callSid) ?? 0) + 1;
        attempts.set(row.callSid, n);
        log.warn(`[FILING QUALITY] ${row.callSid}: not read (${failureKind(err)}), attempt ${n} of ${FILING_QUALITY_MAX_ATTEMPTS}`);
        // Given up: stored as skipped so the Daybook counts it as unreadable
        // rather than the call silently leaving the denominator (review of #440).
        if (n >= FILING_QUALITY_MAX_ATTEMPTS) {
          try {
            await deps.store.insert({ callSid: row.callSid, agentUsed: row.agentUsed, startedAt: row.startedAt, expectation: null, skipped: `model_failed:${failureKind(err)}` });
            attempts.delete(row.callSid);
          } catch {
            // Left in the per-process skip list; the next process tries again.
          }
        }
      }
    });
    if (result.read > 0) {
      log.info(`[FILING QUALITY] cycle: ${result.read} call(s) read, ${result.stored} stored, ${result.skipped} with no usable answer, ${result.failed} failed`);
    }
    return result;
  } finally {
    await deps.lock.release();
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** True when the worker would run in this process. */
export function filingQualityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY) && env.FILING_QUALITY_DISABLED !== "1";
}

export function startFilingQualityWorker(env: NodeJS.ProcessEnv = process.env): void {
  if (timer) return;
  if (!filingQualityEnabled(env)) {
    console.info("[FILING QUALITY] Transcript expectation worker off (no OPENAI_API_KEY, or FILING_QUALITY_DISABLED=1)");
    return;
  }
  console.info(
    `[FILING QUALITY] Starting transcript expectation worker (every ${FILING_QUALITY_INTERVAL_MS / 60_000} minutes; ${FILING_QUALITY_LOOKBACK_HOURS}h lookback)`,
  );
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runFilingQualityCycle({ store: hubFilingQualityStore, lock: defaultFilingQualityLock });
    } catch (err) {
      console.warn(`[FILING QUALITY] cycle failed (${failureKind(err)})`);
    } finally {
      running = false;
    }
  }, FILING_QUALITY_INTERVAL_MS);
}

export function stopFilingQualityWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
