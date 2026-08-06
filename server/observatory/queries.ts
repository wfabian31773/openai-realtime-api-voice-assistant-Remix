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
    SELECT agent_id, COALESCE(agent_outcome, '(none)') AS outcome, COUNT(*)::int AS n
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
