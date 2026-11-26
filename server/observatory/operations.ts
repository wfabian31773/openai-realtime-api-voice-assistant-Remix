/**
 * server/observatory/operations.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OPERATIONS MONITOR, rebuilt on what actually records a call.
 *
 *   GET /api/observatory/operations?hours=24
 *
 * WHY: until 2026-11-26 the Operations Monitor read /api/voice/diagnostics, an
 * in-memory trace store that only the old SIP core fills. That pipeline took 1
 * call in the 30 days to 2026-11-26 against about 20,000 on the Grok runtime,
 * so the page read 0 calls and "HEALTHY" while 662 calls had been taken in the
 * last 24 hours, 10 of them dropped by the voice provider. One of its four
 * feeds (/voice/diagnostics/grader-stats) did not exist at all, and the cards
 * fell back to "0 critical fails" and "Handoff Success 100%" in green.
 *
 * Every number here is a count over call_logs (one row per call, both
 * pipelines) or the runtime's own call_events rows. Nothing is a default: a
 * number the database could not give is null, and the page shows it as
 * unavailable, never as 0 or 100%.
 *
 * WHAT NEVER LEAVES THE DATABASE: no name, phone number, date of birth or
 * transcript is selected. The recent-problems list carries the call's id and
 * CallSid (which the call page already shows) and its lane, outcome and length.
 *
 * Timestamps: call_logs.created_at and call_events.created_at are `timestamp
 * WITHOUT time zone` holding UTC, so they are read AT TIME ZONE 'UTC' to come
 * back as instants.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Express, RequestHandler } from 'express';

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A call still `in_progress` this long after it opened never had its teardown written. */
export const STUCK_AFTER_MINUTES = 15;

/** The thresholds the status reads, shown on the page so nobody has to guess them. */
export const THRESHOLDS = {
  /** Calls the voice provider dropped, as a share of all calls in the window. */
  droppedDegradedPct: 3,
  droppedCriticalPct: 8,
  /** Calls that went silent on the agent's side (dead air), as a share. */
  deadAirDegradedPct: 3,
  /** Fewer calls than this and a share is too small to judge. */
  minCallsForRates: 20,
} as const;

export const TOTALS_SQL = `
SELECT
  count(*)::int                                                                   AS total,
  count(*) FILTER (WHERE status = 'in_progress'
                     AND created_at >= (now() AT TIME ZONE 'UTC') - make_interval(mins => $2::int))::int AS live,
  count(*) FILTER (WHERE status = 'in_progress'
                     AND created_at <  (now() AT TIME ZONE 'UTC') - make_interval(mins => $2::int))::int AS stuck,
  count(*) FILTER (WHERE runtime_outcome = 'provider_failure')::int               AS dropped,
  count(*) FILTER (WHERE status = 'failed' AND runtime_outcome IS DISTINCT FROM 'provider_failure')::int AS failed_other,
  count(*) FILTER (WHERE runtime_outcome = 'dead_air')::int                       AS dead_air,
  count(*) FILTER (WHERE runtime_outcome = 'caller_silent')::int                  AS caller_silent,
  count(*) FILTER (WHERE runtime_outcome = 'transferred')::int                    AS transferred,
  count(*) FILTER (WHERE ticket_number IS NOT NULL)::int                          AS with_ticket,
  count(*) FILTER (WHERE graded_at IS NOT NULL)::int                              AS graded,
  count(*) FILTER (WHERE voice_provider IS DISTINCT FROM 'grok')::int             AS old_core,
  max(created_at) AT TIME ZONE 'UTC'                                              AS last_call_at
FROM call_logs
WHERE created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => $1::int)`;

export const LANES_SQL = `
SELECT coalesce(agent_used, '(no lane recorded)')                                AS lane,
       count(*)::int                                                              AS calls,
       count(*) FILTER (WHERE runtime_outcome = 'provider_failure')::int          AS dropped,
       count(*) FILTER (WHERE runtime_outcome = 'dead_air')::int                  AS dead_air,
       count(*) FILTER (WHERE runtime_outcome = 'transferred')::int               AS transferred,
       count(*) FILTER (WHERE ticket_number IS NOT NULL)::int                     AS with_ticket,
       round(avg(duration))::int                                                  AS avg_seconds
  FROM call_logs
 WHERE created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => $1::int)
 GROUP BY 1
 ORDER BY calls DESC`;

/** Every provider drop the reconnect wrapper saw (v263), by what came of it. */
export const RECONNECTS_SQL = `
SELECT coalesce(data->>'result', '(none)') AS result, count(*)::int AS n
  FROM call_events
 WHERE message = 'provider_reconnect'
   AND created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => $1::int)
 GROUP BY 1`;

export const PROBLEMS_SQL = `
SELECT id::text                                   AS id,
       call_sid,
       coalesce(agent_used, '(no lane recorded)') AS lane,
       coalesce(runtime_outcome, status::text)    AS outcome,
       duration                                   AS seconds,
       created_at AT TIME ZONE 'UTC'              AS at
  FROM call_logs
 WHERE created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => $1::int)
   AND (runtime_outcome IN ('provider_failure', 'dead_air', 'caller_silent', 'max_duration')
        OR status = 'failed'
        OR (status = 'in_progress' AND created_at < (now() AT TIME ZONE 'UTC') - make_interval(mins => $2::int)))
 ORDER BY created_at DESC
 LIMIT 25`;

export type OpsStatus = 'healthy' | 'degraded' | 'critical' | 'no_calls';

export interface OperationsReport {
  windowHours: number;
  generatedAt: string;
  status: OpsStatus;
  statusReasons: string[];
  thresholds: typeof THRESHOLDS;
  calls: {
    total: number;
    live: number;
    stuck: number;
    dropped: number;
    failedOther: number;
    deadAir: number;
    callerSilent: number;
    transferred: number;
    withTicket: number;
    graded: number;
    oldCore: number;
    lastCallAt: string | null;
  };
  /** Shares of all calls in the window, null when there are too few calls to judge. */
  rates: { droppedPct: number | null; deadAirPct: number | null };
  reconnects: { drops: number; reconnected: number; ended: number; byResult: Record<string, number> } | null;
  lanes: Array<{ lane: string; calls: number; dropped: number; deadAir: number; transferred: number; withTicket: number; avgSeconds: number | null }>;
  recentProblems: Array<{ id: string; callSid: string | null; lane: string; outcome: string; seconds: number | null; at: string }>;
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
const pct = (part: number, whole: number): number | null =>
  whole >= THRESHOLDS.minCallsForRates ? Math.round((part / whole) * 1000) / 10 : null;

/** The status and the plain sentences behind it. Pure, so the test can drive every arm. */
export function judge(calls: OperationsReport['calls'], rates: OperationsReport['rates']): { status: OpsStatus; reasons: string[] } {
  if (calls.total === 0) return { status: 'no_calls', reasons: ['No calls in this window, so there is nothing to judge.'] };
  const reasons: string[] = [];
  let status: OpsStatus = 'healthy';
  const worse = (s: OpsStatus) => {
    const rank = { healthy: 0, no_calls: 0, degraded: 1, critical: 2 } as const;
    if (rank[s] > rank[status]) status = s;
  };
  if (rates.droppedPct !== null) {
    if (rates.droppedPct > THRESHOLDS.droppedCriticalPct) {
      worse('critical');
      reasons.push(`${rates.droppedPct}% of calls were dropped by the voice provider (above ${THRESHOLDS.droppedCriticalPct}%).`);
    } else if (rates.droppedPct > THRESHOLDS.droppedDegradedPct) {
      worse('degraded');
      reasons.push(`${rates.droppedPct}% of calls were dropped by the voice provider (above ${THRESHOLDS.droppedDegradedPct}%).`);
    }
  }
  if (rates.deadAirPct !== null && rates.deadAirPct > THRESHOLDS.deadAirDegradedPct) {
    worse('degraded');
    reasons.push(`${rates.deadAirPct}% of calls ended in dead air (above ${THRESHOLDS.deadAirDegradedPct}%).`);
  }
  if (calls.stuck > 0) {
    worse('degraded');
    reasons.push(
      `${calls.stuck} call(s) still read "in progress" more than ${STUCK_AFTER_MINUTES} minutes after they started: their end was never written.`,
    );
  }
  if (rates.droppedPct === null) reasons.push(`Fewer than ${THRESHOLDS.minCallsForRates} calls, so the rates are not judged.`);
  if (status === 'healthy' && reasons.length === 0) reasons.push('Drops, dead air and unfinished calls are all inside the thresholds.');
  return { status, reasons };
}

export async function readOperations(q: Queryable, hours: number, now: Date = new Date()): Promise<OperationsReport> {
  const [totals, lanes, problems, reconnects] = await Promise.all([
    q.query(TOTALS_SQL, [hours, STUCK_AFTER_MINUTES]),
    q.query(LANES_SQL, [hours]),
    q.query(PROBLEMS_SQL, [hours, STUCK_AFTER_MINUTES]),
    // call_events is created lazily; a missing table means no reconnect data, not an error page.
    q.query(RECONNECTS_SQL, [hours]).catch(() => null),
  ]);
  const t = totals.rows[0] ?? {};
  const calls: OperationsReport['calls'] = {
    total: n(t.total),
    live: n(t.live),
    stuck: n(t.stuck),
    dropped: n(t.dropped),
    failedOther: n(t.failed_other),
    deadAir: n(t.dead_air),
    callerSilent: n(t.caller_silent),
    transferred: n(t.transferred),
    withTicket: n(t.with_ticket),
    graded: n(t.graded),
    oldCore: n(t.old_core),
    lastCallAt: iso(t.last_call_at),
  };
  const rates = { droppedPct: pct(calls.dropped, calls.total), deadAirPct: pct(calls.deadAir, calls.total) };
  const { status, reasons } = judge(calls, rates);
  let rc: OperationsReport['reconnects'] = null;
  if (reconnects) {
    const byResult: Record<string, number> = {};
    for (const r of reconnects.rows) byResult[String(r.result)] = n(r.n);
    const drops = Object.values(byResult).reduce((a, b) => a + b, 0);
    rc = { drops, reconnected: byResult.reconnected ?? 0, ended: drops - (byResult.reconnected ?? 0), byResult };
  }
  return {
    windowHours: hours,
    generatedAt: now.toISOString(),
    status,
    statusReasons: reasons,
    thresholds: THRESHOLDS,
    calls,
    rates,
    reconnects: rc,
    lanes: lanes.rows.map((r) => ({
      lane: String(r.lane),
      calls: n(r.calls),
      dropped: n(r.dropped),
      deadAir: n(r.dead_air),
      transferred: n(r.transferred),
      withTicket: n(r.with_ticket),
      avgSeconds: r.avg_seconds === null || r.avg_seconds === undefined ? null : Number(r.avg_seconds),
    })),
    recentProblems: problems.rows.map((r) => ({
      id: String(r.id),
      callSid: r.call_sid ? String(r.call_sid) : null,
      lane: String(r.lane),
      outcome: String(r.outcome),
      seconds: r.seconds === null || r.seconds === undefined ? null : Number(r.seconds),
      at: iso(r.at) ?? '',
    })),
  };
}

export const OPERATIONS_API = '/api/observatory/operations';
const ALLOWED_HOURS = new Set([1, 6, 24, 72, 168]);
const CACHE_MS = 30_000;

export function mountOperationsMonitor(app: Express, deps: { authenticate: RequestHandler; hub: () => Queryable; now?: () => Date }) {
  const cache = new Map<number, { at: number; report: OperationsReport }>();
  const now = deps.now ?? (() => new Date());
  app.get(OPERATIONS_API, deps.authenticate, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const asked = Number(req.query.hours ?? 24);
    const hours = ALLOWED_HOURS.has(asked) ? asked : 24;
    const hit = cache.get(hours);
    const t = now().getTime();
    if (hit && t - hit.at < CACHE_MS) return res.json(hit.report);
    try {
      const report = await readOperations(deps.hub(), hours, now());
      cache.set(hours, { at: t, report });
      res.json(report);
    } catch (err) {
      console.error(`[OPERATIONS] read failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
      res.status(503).json({ error: 'The call records could not be read just now.' });
    }
  });
}
