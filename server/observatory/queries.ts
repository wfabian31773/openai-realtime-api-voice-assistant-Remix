/**
 * Observatory OBS-A1 — the named query layer (docs/observatory/01-data-contracts.md).
 *
 * Design law 1: every widget maps 1:1 to a named export here; a widget that
 * can't point at its query doesn't ship. All reads; no writes anywhere.
 *
 * Two data planes:
 *  - opsHub*  → this app's own pool (the four voice agents)
 *  - sage*    → the read-only 5Star connection (fivestarDb.ts)
 */
import { pool } from '../db';
import { fivestarQuery } from './fivestarDb';

// ────────────────────────────────────────────────────────────────────────
// Ops Hub agents — six-pillar scorecards
// ────────────────────────────────────────────────────────────────────────

export interface OpsHubScorecard {
  agentId: string;
  agentName: string;
  calls: number;
  calls7d: number;
  /** Hallucinating*: share of graded calls with >=1 critical grader failure (grader-inferred; contract notes the caveat). */
  criticalFailureRate: number | null;
  avgQualityScore: number | null;
  longCalls: number; // > 45 turns
  avgInterruptions: number | null;
  telephonyErrors: number;
  outcomes: Record<string, number>;
  avgDurationSec: number | null;
}

export async function opsHubAgentScorecards(days = 30): Promise<OpsHubScorecard[]> {
  const { rows } = await pool.query(
    `
    SELECT a.id AS agent_id,
           a.name AS agent_name,
           COUNT(cl.id)::int AS calls,
           COUNT(cl.id) FILTER (WHERE cl.created_at >= NOW() - INTERVAL '7 days')::int AS calls_7d,
           ROUND(AVG(CASE WHEN cl.grader_results IS NOT NULL
             THEN CASE WHEN COALESCE(((cl.grader_results::jsonb)->'summary'->>'criticalFailures')::int, 0) > 0 THEN 1 ELSE 0 END
           END)::numeric, 4) AS critical_failure_rate,
           ROUND(AVG(cl.quality_score)::numeric, 2) AS avg_quality,
           COUNT(cl.id) FILTER (WHERE cl.total_turns > 45)::int AS long_calls,
           ROUND(AVG(cl.interruption_count)::numeric, 2) AS avg_interruptions,
           COUNT(cl.id) FILTER (WHERE cl.twilio_error_code IS NOT NULL)::int AS telephony_errors,
           ROUND(AVG(cl.duration)::numeric, 0) AS avg_duration_sec
    FROM agents a
    LEFT JOIN call_logs cl
      ON cl.agent_id = a.id AND cl.created_at >= NOW() - make_interval(days => $1::int)
    GROUP BY a.id, a.name
    ORDER BY calls DESC
    `,
    [days],
  );
  const outcomes = await pool.query(
    `
    SELECT agent_id, COALESCE(agent_outcome::text, '(none)') AS outcome, COUNT(*)::int AS n
    FROM call_logs
    WHERE created_at >= NOW() - make_interval(days => $1::int) AND agent_id IS NOT NULL
    GROUP BY 1, 2
    `,
    [days],
  );
  const outcomeMap = new Map<string, Record<string, number>>();
  for (const r of outcomes.rows) {
    const m = outcomeMap.get(r.agent_id) ?? {};
    m[r.outcome] = r.n;
    outcomeMap.set(r.agent_id, m);
  }
  return rows.map((r: any) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    calls: r.calls,
    calls7d: r.calls_7d,
    criticalFailureRate: r.critical_failure_rate === null ? null : Number(r.critical_failure_rate),
    avgQualityScore: r.avg_quality === null ? null : Number(r.avg_quality),
    longCalls: r.long_calls,
    avgInterruptions: r.avg_interruptions === null ? null : Number(r.avg_interruptions),
    telephonyErrors: r.telephony_errors,
    outcomes: outcomeMap.get(r.agent_id) ?? {},
    avgDurationSec: r.avg_duration_sec === null ? null : Number(r.avg_duration_sec),
  }));
}

// ────────────────────────────────────────────────────────────────────────
// SAGE (5Star) — six-pillar scorecard
// ────────────────────────────────────────────────────────────────────────

export interface SageScorecard {
  calls: number;
  calls7d: number;
  hallucinationHits: number;
  bookingCriticalWarnings: number;
  openaiErrorCallRate: number | null;
  avgResponseLatencyMs: number | null;
  maxResponseLatencyMs: number | null;
  reviewsAvgScore: number | null;
  outcomes: Record<string, number>;
  /** Director health: handoff reasons in the window (reasoning_timeout etc.). */
  directorHandoffReasons: Record<string, number>;
  inboundScheduledRate: number | null;
  outboundScheduledRate: number | null;
}

export async function sageScorecard(days = 30): Promise<SageScorecard> {
  const core = await fivestarQuery<any>(
    `
    SELECT
      (SELECT COUNT(*) FROM call_logs WHERE created_at >= NOW() - make_interval(days => $1::int) AND COALESCE(simulated,false)=false)::int AS calls,
      (SELECT COUNT(*) FROM call_logs WHERE created_at >= NOW() - INTERVAL '7 days' AND COALESCE(simulated,false)=false)::int AS calls_7d,
      (SELECT COUNT(*) FROM sage_hallucination_incidents WHERE created_at >= NOW() - make_interval(days => $1::int))::int AS halluc,
      (SELECT COUNT(*) FROM sage_booking_validation_warnings WHERE created_at >= NOW() - make_interval(days => $1::int) AND warning_reason IS NOT NULL)::int AS booking_warns,
      (SELECT ROUND(AVG(CASE WHEN openai_error_count > 0 THEN 1 ELSE 0 END)::numeric, 4)
         FROM sage_voice_call_telemetry WHERE started_at >= NOW() - make_interval(days => $1::int)) AS oai_err_rate,
      (SELECT ROUND((SUM(response_latency_total_ms)::numeric / NULLIF(SUM(response_latency_sample_count),0)), 0)
         FROM sage_voice_call_telemetry WHERE started_at >= NOW() - make_interval(days => $1::int)) AS avg_latency,
      (SELECT MAX(response_latency_max_ms)
         FROM sage_voice_call_telemetry WHERE started_at >= NOW() - make_interval(days => $1::int)) AS max_latency,
      (SELECT ROUND(AVG(reviewer_score)::numeric, 2)
         FROM sage_voice_call_telemetry WHERE started_at >= NOW() - make_interval(days => $1::int) AND reviewer_score IS NOT NULL) AS reviews_avg
    `,
    [days],
  );
  const outcomes = await fivestarQuery<any>(
    `
    SELECT COALESCE(outcome::text, '(none)') AS outcome, COUNT(*)::int AS n
    FROM call_logs
    WHERE created_at >= NOW() - make_interval(days => $1::int) AND COALESCE(simulated,false)=false
    GROUP BY 1
    `,
    [days],
  );
  const director = await fivestarQuery<any>(
    `
    SELECT CASE
             WHEN reason ILIKE 'reasoning_timeout%' THEN 'reasoning_timeout'
             WHEN reason ILIKE 'safety_validation_failed%' THEN 'safety_validation_failed'
             WHEN reason ILIKE 'invalid_structured_reasoning%' THEN 'invalid_structured_reasoning'
             WHEN reason ILIKE '%loop%' THEN 'loop_detected'
             ELSE 'caller_request_or_other'
           END AS reason_class,
           COUNT(*)::int AS n
    FROM handoff_attempts
    WHERE initiated_at >= NOW() - make_interval(days => $1::int)
    GROUP BY 1
    `,
    [days],
  );
  const kpi = await fivestarQuery<any>(
    `
    SELECT
      ROUND(AVG(CASE WHEN c.direction='inbound' AND c.outcome::text IN ('scheduled','scheduled_with_drift','rescheduled') THEN 1
                     WHEN c.direction='inbound' THEN 0 END)::numeric, 4) AS inbound_sched,
      ROUND(AVG(CASE WHEN c.direction='outbound' AND c.outcome::text IN ('scheduled','scheduled_with_drift','rescheduled') THEN 1
                     WHEN c.direction='outbound' THEN 0 END)::numeric, 4) AS outbound_sched
    FROM call_logs c
    WHERE c.created_at >= NOW() - make_interval(days => $1::int)
      AND COALESCE(c.simulated,false)=false
      AND c.outcome IS NOT NULL
      AND c.outcome::text NOT IN ('voicemail','no_answer','wrong_number','patient_unavailable','abandoned')
    `,
    [days],
  );
  const c = core.rows[0];
  return {
    calls: c.calls,
    calls7d: c.calls_7d,
    hallucinationHits: c.halluc,
    bookingCriticalWarnings: c.booking_warns,
    openaiErrorCallRate: c.oai_err_rate === null ? null : Number(c.oai_err_rate),
    avgResponseLatencyMs: c.avg_latency === null ? null : Number(c.avg_latency),
    maxResponseLatencyMs: c.max_latency === null ? null : Number(c.max_latency),
    reviewsAvgScore: c.reviews_avg === null ? null : Number(c.reviews_avg),
    outcomes: Object.fromEntries(outcomes.rows.map((r: any) => [r.outcome, r.n])),
    directorHandoffReasons: Object.fromEntries(director.rows.map((r: any) => [r.reason_class, r.n])),
    inboundScheduledRate: kpi.rows[0].inbound_sched === null ? null : Number(kpi.rows[0].inbound_sched),
    outboundScheduledRate: kpi.rows[0].outbound_sched === null ? null : Number(kpi.rows[0].outbound_sched),
  };
}

// ────────────────────────────────────────────────────────────────────────
// SAGE funnel — reached → engaged → booked → entered → materialized → kept
// (reference implementation; verified against the 2026-08 forensics)
// ────────────────────────────────────────────────────────────────────────

export interface SageFunnelWeek {
  weekStart: string;
  reachedCalls: number;
  reachedSmsDelivered: number;
  engagedCalls: number;
  smsClicks: number;
  booked: number;
  entered: number;
  materialized: number;
  kept: number;
  cancelled: number;
  noShow: number;
  pendingReview: number;
}

export async function sageFunnelWeekly(weeks = 12): Promise<SageFunnelWeek[]> {
  const { rows } = await fivestarQuery<any>(
    `
    WITH weeks AS (
      SELECT generate_series(
        date_trunc('week', NOW() - make_interval(weeks => $1::int)),
        date_trunc('week', NOW()),
        '1 week'
      )::date AS wk
    )
    SELECT w.wk::text AS week_start,
      (SELECT COUNT(*) FROM call_logs c WHERE COALESCE(c.simulated,false)=false
        AND date_trunc('week', c.created_at)::date = w.wk)::int AS reached_calls,
      (SELECT COUNT(*) FROM sms_logs s WHERE s.direction='outbound' AND s.purpose='outreach'
        AND s.delivered_at IS NOT NULL AND date_trunc('week', s.created_at)::date = w.wk)::int AS reached_sms,
      (SELECT COUNT(*) FROM call_logs c WHERE COALESCE(c.simulated,false)=false
        AND c.outcome IS NOT NULL
        AND c.outcome::text NOT IN ('voicemail','no_answer','wrong_number','patient_unavailable','abandoned')
        AND date_trunc('week', c.created_at)::date = w.wk)::int AS engaged_calls,
      (SELECT COUNT(*) FROM sms_logs s WHERE s.direction='outbound' AND s.purpose='outreach'
        AND s.link_clicked_at IS NOT NULL AND date_trunc('week', s.created_at)::date = w.wk)::int AS sms_clicks,
      (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
        AND date_trunc('week', ib.created_at)::date = w.wk)::int AS booked,
      (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
        AND ib.status::text IN ('entered_in_nextgen','completed','no_show')
        AND date_trunc('week', ib.created_at)::date = w.wk)::int AS entered,
      (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
        AND ib.nextgen_appointment_id IS NOT NULL
        AND date_trunc('week', ib.created_at)::date = w.wk)::int AS materialized,
      (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
        AND ib.status::text = 'completed'
        AND date_trunc('week', ib.created_at)::date = w.wk)::int AS kept,
      (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
        AND ib.status::text = 'cancelled'
        AND date_trunc('week', ib.created_at)::date = w.wk)::int AS cancelled,
      (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
        AND ib.status::text = 'no_show'
        AND date_trunc('week', ib.created_at)::date = w.wk)::int AS no_show,
      (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
        AND ib.status::text = 'pending_orphan_review'
        AND date_trunc('week', ib.created_at)::date = w.wk)::int AS pending_review
    FROM weeks w
    ORDER BY w.wk
    `,
    [weeks],
  );
  return rows.map((r: any) => ({
    weekStart: r.week_start,
    reachedCalls: r.reached_calls,
    reachedSmsDelivered: r.reached_sms,
    engagedCalls: r.engaged_calls,
    smsClicks: r.sms_clicks,
    booked: r.booked,
    entered: r.entered,
    materialized: r.materialized,
    kept: r.kept,
    cancelled: r.cancelled,
    noShow: r.no_show,
    pendingReview: r.pending_review,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Openings — what each agent ACTUALLY says first, vs its configured
// greeting (Wayne 2026-08-06: greetings drifting/improvised; adherence
// must be observable). "Up to the verify point": the first three assistant
// turns are sampled so the whole opening ramp is reviewable.
// ────────────────────────────────────────────────────────────────────────

export interface AgentOpenings {
  agentSlug: string;
  agentName: string;
  configuredGreeting: string | null;
  callsSampled: number;
  /** Share of calls whose first assistant turn starts with the configured greeting (first 24 chars, case/space-insensitive). */
  greetingAdherence: number | null;
  topOpenings: Array<{ opening: string; n: number }>;
  sampleOpeningSequences: Array<{ callLogId: string; turns: string[] }>;
}

export async function agentOpenings(days = 7): Promise<AgentOpenings[]> {
  const { rows } = await pool.query(
    `
    WITH firsts AS (
      SELECT ct.agent_slug, ct.call_log_id,
             COALESCE(ct.final_transcript, ct.raw_transcript) AS text,
             ROW_NUMBER() OVER (PARTITION BY ct.call_log_id ORDER BY ct.turn_index) AS rn
      FROM call_turns ct
      WHERE ct.role IN ('assistant','agent','ai')
        AND ct.created_at >= NOW() - make_interval(days => $1::int)
    ),
    first_only AS (SELECT * FROM firsts WHERE rn = 1 AND text IS NOT NULL AND LENGTH(text) > 12)
    SELECT a.slug AS agent_slug, a.name AS agent_name, a.welcome_greeting,
           COUNT(f.call_log_id)::int AS calls_sampled,
           ROUND(AVG(CASE WHEN a.welcome_greeting IS NOT NULL AND
             LOWER(REGEXP_REPLACE(f.text, '\\s+', ' ', 'g')) LIKE
             LOWER(REGEXP_REPLACE(LEFT(a.welcome_greeting, 24), '\\s+', ' ', 'g')) || '%'
           THEN 1 ELSE 0 END)::numeric, 3) AS adherence
    FROM agents a
    LEFT JOIN first_only f ON f.agent_slug = a.slug
    WHERE a.status = 'active'
    GROUP BY a.slug, a.name, a.welcome_greeting
    ORDER BY calls_sampled DESC
    `,
    [days],
  );
  const tops = await pool.query(
    `
    WITH firsts AS (
      SELECT ct.agent_slug, ct.call_log_id,
             LEFT(COALESCE(ct.final_transcript, ct.raw_transcript), 120) AS opening,
             ROW_NUMBER() OVER (PARTITION BY ct.call_log_id ORDER BY ct.turn_index) AS rn
      FROM call_turns ct
      WHERE ct.role IN ('assistant','agent','ai')
        AND ct.created_at >= NOW() - make_interval(days => $1::int)
    )
    SELECT agent_slug, opening, COUNT(*)::int AS n
    FROM firsts WHERE rn = 1 AND opening IS NOT NULL AND LENGTH(opening) > 12
    GROUP BY 1, 2
    ORDER BY agent_slug, n DESC
    `,
    [days],
  );
  const seqs = await pool.query(
    `
    WITH recent_calls AS (
      SELECT DISTINCT ON (ct.agent_slug) ct.agent_slug, ct.call_log_id
      FROM call_turns ct
      WHERE ct.created_at >= NOW() - make_interval(days => $1::int)
      ORDER BY ct.agent_slug, ct.created_at DESC
    )
    SELECT rc.agent_slug, rc.call_log_id,
           ARRAY(
             SELECT LEFT(COALESCE(t.final_transcript, t.raw_transcript), 160)
             FROM call_turns t
             WHERE t.call_log_id = rc.call_log_id AND t.role IN ('assistant','agent','ai')
             ORDER BY t.turn_index LIMIT 3
           ) AS turns
    FROM recent_calls rc
    `,
    [days],
  );
  const topMap = new Map<string, Array<{ opening: string; n: number }>>();
  for (const r of tops.rows) {
    const arr = topMap.get(r.agent_slug) ?? [];
    if (arr.length < 6) arr.push({ opening: r.opening, n: r.n });
    topMap.set(r.agent_slug, arr);
  }
  const seqMap = new Map<string, Array<{ callLogId: string; turns: string[] }>>();
  for (const r of seqs.rows) {
    const arr = seqMap.get(r.agent_slug) ?? [];
    arr.push({ callLogId: r.call_log_id, turns: r.turns ?? [] });
    seqMap.set(r.agent_slug, arr);
  }
  return rows.map((r: any) => ({
    agentSlug: r.agent_slug,
    agentName: r.agent_name,
    configuredGreeting: r.welcome_greeting,
    callsSampled: r.calls_sampled,
    greetingAdherence: r.adherence === null ? null : Number(r.adherence),
    topOpenings: topMap.get(r.agent_slug) ?? [],
    sampleOpeningSequences: seqMap.get(r.agent_slug) ?? [],
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Agent change trail — the DB-trigger audit log (migration
// agent_change_log_global_versioning, 2026-08-06). Every INSERT/UPDATE/
// DELETE on agents / agent_prompts / agent_prompt_versions / agent_tools,
// no matter who wrote it. Timestamp-only touches are filtered at the
// trigger, so every row here is a REAL change.
// ────────────────────────────────────────────────────────────────────────

export interface AgentChange {
  id: number;
  changedAt: string;
  tableName: string;
  operation: string;
  agentRef: string | null;
  dbUser: string;
  changedFields: Record<string, unknown> | null;
}

export async function agentChangeTrail(limit = 100): Promise<AgentChange[]> {
  const { rows } = await pool.query(
    `
    SELECT id, changed_at, table_name, operation, agent_ref, db_user, changed_fields
    FROM agent_change_log
    ORDER BY id DESC
    LIMIT $1::int
    `,
    [Math.min(500, Math.max(1, limit))],
  );
  return rows.map((r: any) => ({
    id: r.id,
    changedAt: r.changed_at,
    tableName: r.table_name,
    operation: r.operation,
    agentRef: r.agent_ref,
    dbUser: r.db_user,
    changedFields: r.changed_fields,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Drill-downs — the nuts and bolts behind every tile (Wayne 2026-08-06:
// "this tells me nothing about WHY they are breaking"). Card-anatomy law:
// every red number opens into the guard that fired, the check that
// failed, and the transcript of the call where it happened.
// ────────────────────────────────────────────────────────────────────────

export interface GraderCheckStat {
  grader: string;
  total: number;
  fails: number;
  criticalFails: number;
  avgScore: number | null;
  /** Latest human-written fail reasons from the grader itself. */
  sampleReasons: string[];
}

export interface OpsHubWorstCall {
  id: string;
  createdAt: string;
  durationSec: number | null;
  outcome: string | null;
  qualityScore: number | null;
  criticalFailures: number;
  failing: Array<{ grader: string; reason: string; severity: string | null }>;
}

export interface OpsHubAgentDetail {
  graderChecks: GraderCheckStat[];
  worstCalls: OpsHubWorstCall[];
}

export async function opsHubAgentDetail(agentId: string, days = 7): Promise<OpsHubAgentDetail> {
  const checks = await pool.query(
    `
    SELECT g->>'grader' AS grader,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE (g->>'pass')::boolean = false)::int AS fails,
           COUNT(*) FILTER (WHERE (g->>'pass')::boolean = false AND g->>'severity' = 'critical')::int AS critical_fails,
           ROUND(AVG((g->>'score')::numeric), 3) AS avg_score
    FROM call_logs cl,
         jsonb_array_elements((cl.grader_results::jsonb)->'graders') g
    WHERE cl.agent_id = $1
      AND cl.created_at >= NOW() - make_interval(days => $2::int)
      AND cl.grader_results IS NOT NULL
    GROUP BY 1
    ORDER BY critical_fails DESC, fails DESC, 1
    `,
    [agentId, days],
  );
  const reasons = await pool.query(
    `
    SELECT g->>'grader' AS grader, g->>'reason' AS reason
    FROM call_logs cl,
         jsonb_array_elements((cl.grader_results::jsonb)->'graders') g
    WHERE cl.agent_id = $1
      AND cl.created_at >= NOW() - make_interval(days => $2::int)
      AND cl.grader_results IS NOT NULL
      AND (g->>'pass')::boolean = false
    ORDER BY cl.created_at DESC
    LIMIT 60
    `,
    [agentId, days],
  );
  const reasonMap = new Map<string, string[]>();
  for (const r of reasons.rows) {
    const arr = reasonMap.get(r.grader) ?? [];
    if (arr.length < 3 && r.reason && !arr.includes(r.reason)) arr.push(r.reason);
    reasonMap.set(r.grader, arr);
  }
  const worst = await pool.query(
    `
    SELECT cl.id, cl.created_at, cl.duration, cl.agent_outcome::text AS outcome, cl.quality_score,
           COALESCE(((cl.grader_results::jsonb)->'summary'->>'criticalFailures')::int, 0) AS critical_failures,
           (SELECT jsonb_agg(jsonb_build_object(
              'grader', g->>'grader', 'reason', g->>'reason', 'severity', g->>'severity'))
            FROM jsonb_array_elements((cl.grader_results::jsonb)->'graders') g
            WHERE (g->>'pass')::boolean = false) AS failing
    FROM call_logs cl
    WHERE cl.agent_id = $1
      AND cl.created_at >= NOW() - make_interval(days => $2::int)
      AND cl.grader_results IS NOT NULL
      AND COALESCE(((cl.grader_results::jsonb)->'summary'->>'criticalFailures')::int, 0) > 0
    ORDER BY cl.created_at DESC
    LIMIT 20
    `,
    [agentId, days],
  );
  return {
    graderChecks: checks.rows.map((r: any) => ({
      grader: r.grader,
      total: r.total,
      fails: r.fails,
      criticalFails: r.critical_fails,
      avgScore: r.avg_score === null ? null : Number(r.avg_score),
      sampleReasons: reasonMap.get(r.grader) ?? [],
    })),
    worstCalls: worst.rows.map((r: any) => ({
      id: r.id,
      createdAt: r.created_at,
      durationSec: r.duration,
      outcome: r.outcome,
      qualityScore: r.quality_score === null ? null : Number(r.quality_score),
      criticalFailures: r.critical_failures,
      failing: r.failing ?? [],
    })),
  };
}

export interface SageHallucinationIncident {
  id: string;
  createdAt: string;
  guard: string | null;
  detectedLanguage: string | null;
  slotsOfferedSummary: string | null;
  transcript: string | null;
  callSid: string | null;
}

export interface SageDirectorEvent {
  initiatedAt: string;
  reason: string | null;
  outcome: string | null;
  answered: boolean;
  bridgeSeconds: number | null;
  resultedInAppointment: boolean | null;
  callLogId: string | null;
  notes: string | null;
}

export interface SageToolErrorStat {
  toolName: string;
  calls: number;
  errors: number;
  avgDurationMs: number | null;
  sampleErrors: string[];
}

export interface SageWorstTelemetryCall {
  callLogId: string | null;
  callSid: string | null;
  startedAt: string;
  direction: string | null;
  outcome: string | null;
  maxLatencyMs: number | null;
  greetingLatencyMs: number | null;
  openaiErrors: number;
  toolErrors: number;
  reconnects: number;
  terminationReason: string | null;
}

export interface SageDetail {
  hallucinations: SageHallucinationIncident[];
  hallucinationsByGuard: Record<string, number>;
  directorFeed: SageDirectorEvent[];
  toolErrors: SageToolErrorStat[];
  worstTelemetry: SageWorstTelemetryCall[];
}

export async function sageDetail(days = 7): Promise<SageDetail> {
  const halluc = await fivestarQuery<any>(
    `
    SELECT id, created_at, guard, detected_language, slots_offered_summary,
           LEFT(transcript, 6000) AS transcript, call_sid
    FROM sage_hallucination_incidents
    WHERE created_at >= NOW() - make_interval(days => $1::int)
    ORDER BY created_at DESC
    LIMIT 25
    `,
    [days],
  );
  const byGuard = await fivestarQuery<any>(
    `
    SELECT COALESCE(guard, '(unlabelled)') AS guard, COUNT(*)::int AS n
    FROM sage_hallucination_incidents
    WHERE created_at >= NOW() - make_interval(days => $1::int)
    GROUP BY 1 ORDER BY n DESC
    `,
    [days],
  );
  const director = await fivestarQuery<any>(
    `
    SELECT initiated_at, reason, outcome::text AS outcome,
           (answered_at IS NOT NULL) AS answered,
           bridge_duration_seconds, resulted_in_appointment, call_log_id,
           LEFT(notes, 300) AS notes
    FROM handoff_attempts
    WHERE initiated_at >= NOW() - make_interval(days => $1::int)
    ORDER BY initiated_at DESC
    LIMIT 40
    `,
    [days],
  );
  const tools = await fivestarQuery<any>(
    `
    SELECT tool_name,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE outcome <> 'success' OR error_message IS NOT NULL)::int AS errors,
           ROUND(AVG(duration_ms), 0) AS avg_ms
    FROM sage_tool_calls
    WHERE created_at >= NOW() - make_interval(days => $1::int)
    GROUP BY 1
    ORDER BY errors DESC, calls DESC
    `,
    [days],
  );
  const toolErrSamples = await fivestarQuery<any>(
    `
    SELECT tool_name, LEFT(error_message, 200) AS err
    FROM sage_tool_calls
    WHERE created_at >= NOW() - make_interval(days => $1::int) AND error_message IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 60
    `,
    [days],
  );
  const errMap = new Map<string, string[]>();
  for (const r of toolErrSamples.rows) {
    const arr = errMap.get(r.tool_name) ?? [];
    if (arr.length < 3 && r.err && !arr.includes(r.err)) arr.push(r.err);
    errMap.set(r.tool_name, arr);
  }
  const telem = await fivestarQuery<any>(
    `
    SELECT call_log_id, call_sid, started_at, direction, outcome::text AS outcome,
           response_latency_max_ms, greeting_latency_ms,
           openai_error_count, tool_error_count, reconnect_count, termination_reason
    FROM sage_voice_call_telemetry
    WHERE started_at >= NOW() - make_interval(days => $1::int)
      AND (openai_error_count > 0 OR tool_error_count > 0 OR reconnect_count > 0
           OR response_latency_max_ms > 6000)
    ORDER BY started_at DESC
    LIMIT 25
    `,
    [days],
  );
  return {
    hallucinations: halluc.rows.map((r: any) => ({
      id: r.id,
      createdAt: r.created_at,
      guard: r.guard,
      detectedLanguage: r.detected_language,
      slotsOfferedSummary: r.slots_offered_summary,
      transcript: r.transcript,
      callSid: r.call_sid,
    })),
    hallucinationsByGuard: Object.fromEntries(byGuard.rows.map((r: any) => [r.guard, r.n])),
    directorFeed: director.rows.map((r: any) => ({
      initiatedAt: r.initiated_at,
      reason: r.reason,
      outcome: r.outcome,
      answered: r.answered,
      bridgeSeconds: r.bridge_duration_seconds,
      resultedInAppointment: r.resulted_in_appointment,
      callLogId: r.call_log_id,
      notes: r.notes,
    })),
    toolErrors: tools.rows.map((r: any) => ({
      toolName: r.tool_name,
      calls: r.calls,
      errors: r.errors,
      avgDurationMs: r.avg_ms === null ? null : Number(r.avg_ms),
      sampleErrors: errMap.get(r.tool_name) ?? [],
    })),
    worstTelemetry: telem.rows.map((r: any) => ({
      callLogId: r.call_log_id,
      callSid: r.call_sid,
      startedAt: r.started_at,
      direction: r.direction,
      outcome: r.outcome,
      maxLatencyMs: r.response_latency_max_ms,
      greetingLatencyMs: r.greeting_latency_ms,
      openaiErrors: r.openai_error_count ?? 0,
      toolErrors: r.tool_error_count ?? 0,
      reconnects: r.reconnect_count ?? 0,
      terminationReason: r.termination_reason,
    })),
  };
}

/** Full transcript of one SAGE call — the click-through from any drill-down row. */
export async function sageCallTranscript(callLogId: string): Promise<{
  id: string;
  createdAt: string;
  direction: string | null;
  outcome: string | null;
  transcript: string | null;
} | null> {
  const { rows } = await fivestarQuery<any>(
    `
    SELECT id, created_at, direction, outcome::text AS outcome, transcript
    FROM call_logs WHERE id = $1 LIMIT 1
    `,
    [callLogId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r.id, createdAt: r.created_at, direction: r.direction, outcome: r.outcome, transcript: r.transcript };
}
