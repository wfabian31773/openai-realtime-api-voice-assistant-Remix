/**
 * Observatory Daily Brief — "an overview and proposal with a baseline that
 * we track daily; inch by inch we will get to stability" (Wayne 2026-08-07).
 *
 * One snapshot per business day (America/Los_Angeles), stored in
 * observatory_daily_briefs. The EARLIEST row is the baseline; every
 * morning's brief shows each metric against yesterday AND the baseline,
 * and carries a categorized study of the day's critical failures — each
 * category has a stable id (agent:check), the grader's own fail reasons,
 * example calls, and a concrete proposed fix, so specific problems can be
 * watched shrinking day over day.
 */
import { pool } from '../db';
import { fivestarQuery } from './fivestarDb';

// ── Proposal library: known failing checks → concrete remediations. ──────
// Written once, referenced by stable category key; the brief tracks the
// numbers, these say what we intend to DO about each category.
const PROPOSALS: Record<string, string> = {
  callback_fields_completeness:
    'Enforce at the tool layer: create_ticket rejects filings missing callback number or reason, and the agent prompt collects both BEFORE offering to file. Grader-aligned validation, not model goodwill.',
  question_repetition:
    'Session-level asked-questions memory injected into the prompt after each turn ("you already have the caller\'s name — do not ask again"), plus the loop guard escalating to a human after the second repeat.',
  human_request_deflection:
    'Hard rule: second explicit human request → transfer_to_office/callback flow immediately, no third deflection. Add a grader-aligned counter to the prompt and verify in transcripts.',
  handoff_expected_vs_actual:
    'Wire handoff outcome feedback into the session (answered vs failed) so the model stops recording answered transfers as callbacks; already documented in the voice-lane findings.',
  actionable_request_needs_ticket:
    'Post-call sweep: calls where the grader flags an unfiled actionable request get an auto-drafted ticket for staff review, and the prompt gets an explicit "file before goodbye" checklist step.',
  emergency_handling:
    'Zero-tolerance check: reinforce the 911 script as the FIRST line of the emergency branch and add a regression test call to the weekly persona suite.',
  medical_advice_guardrail:
    'Tighten the guardrail lexicon and add the flagged transcripts to the grader lexicon test suite so the exact phrasing that slipped through is caught next time.',
  provider_must_escalate:
    'Provider-detection cues (office names, "I\'m calling from Dr…") force the escalation branch; sample transcripts show which cues were missed — add them to the prompt.',
  transcript_coverage:
    'Usually a telephony/transcription symptom, not agent behavior — correlate with the Telemetry tab (reconnects, one-sided audio) before prompting changes.',
  interruption_rate:
    'Tune VAD/turn-taking settings for the affected line; verify against the interruption counts in Telemetry rather than prompt changes.',
  latency: 'Latency is measured infrastructure-side — see Telemetry tab; no prompt action.',
  tail_safety: 'Verify tail-duration data capture; usually a data-availability gap, not behavior.',
  duration_mismatch: 'Data-availability gap (Twilio insights lag); no agent action.',
  ticket_required_vs_created:
    'Same fix family as actionable_request_needs_ticket — tool-layer enforcement plus post-call sweep.',
  // SAGE-side categories
  'sage:reasoning_timeout':
    'Director circuit breaker: after N consecutive reasoning timeouts, bypass the director for M minutes instead of dumping every caller to coordinators (documented in voice-lane findings 14).',
  'sage:tool_errors':
    'Retry-once on eyecare service timeouts; alert when any tool\'s daily error rate exceeds 10% (the July 401 outage ran four days unseen).',
  'sage:hallucination':
    'Every guard hit gets its transcript reviewed in the Guards tab; recurring guard → tighten the specific slot/claim validation that fired.',
};

function proposalFor(key: string): string {
  return (
    PROPOSALS[key] ??
    'Study the sample transcripts in Guards & Failures, classify the failure mode, then draft the fix — this category has no canned remediation yet.'
  );
}

export interface BriefAgentMetric {
  agentId: string;
  agentSlug: string;
  agentName: string;
  calls: number;
  criticalCalls: number;
  criticalRate: number | null;
  quality: number | null;
}

export interface BriefCategory {
  /** Stable id: `${agentSlug}:${grader}` or `sage:<class>` — the unit we track to zero. */
  key: string;
  agentName: string;
  grader: string;
  fails: number;
  totalGraded: number;
  failRate: number | null;
  sampleReasons: string[];
  exampleCallIds: string[];
  proposal: string;
}

export interface DailyBriefPayload {
  briefDate: string;
  generatedAt: string;
  agents: BriefAgentMetric[];
  categories: BriefCategory[];
  sage: {
    calls: number;
    booked: number;
    entered: number;
    directorReasons: Record<string, number>;
    toolErrorRates: Array<{ tool: string; errors: number; calls: number }>;
    hallucinations: number;
  } | { error: string };
  syncReds: Array<{ name: string; ageHours: number | null; detail: string | null }>;
}

/** The LA business day that "yesterday's brief" covers. */
function priorBusinessDayLA(): string {
  const laNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  laNow.setDate(laNow.getDate() - 1);
  return laNow.toISOString().slice(0, 10);
}

export async function generateDailyBrief(briefDate?: string): Promise<DailyBriefPayload> {
  const date = briefDate ?? priorBusinessDayLA();

  const agents = await pool.query(
    `
    SELECT a.id AS agent_id, a.slug, a.name,
           COUNT(cl.id)::int AS calls,
           COUNT(cl.id) FILTER (WHERE COALESCE(((cl.grader_results::jsonb)->'summary'->>'criticalFailures')::int,0) > 0)::int AS critical_calls,
           ROUND(AVG(cl.quality_score)::numeric, 2) AS quality
    FROM agents a
    LEFT JOIN call_logs cl ON cl.agent_id = a.id
      AND ((cl.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date = $1::date
    WHERE a.status = 'active'
    GROUP BY a.id, a.slug, a.name
    `,
    [date],
  );

  const checks = await pool.query(
    `
    SELECT a.slug, a.name AS agent_name, g->>'grader' AS grader,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE (g->>'pass')::boolean = false AND g->>'severity' = 'critical')::int AS fails,
           (ARRAY_AGG(g->>'reason' ORDER BY cl.created_at DESC)
              FILTER (WHERE (g->>'pass')::boolean = false))[1:3] AS reasons,
           (ARRAY_AGG(cl.id ORDER BY cl.created_at DESC)
              FILTER (WHERE (g->>'pass')::boolean = false AND g->>'severity' = 'critical'))[1:3] AS examples
    FROM call_logs cl
    JOIN agents a ON a.id = cl.agent_id
    CROSS JOIN LATERAL jsonb_array_elements((cl.grader_results::jsonb)->'graders') g
    WHERE ((cl.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date = $1::date
      AND cl.grader_results IS NOT NULL
    GROUP BY a.slug, a.name, g->>'grader'
    HAVING COUNT(*) FILTER (WHERE (g->>'pass')::boolean = false AND g->>'severity' = 'critical') > 0
    ORDER BY fails DESC
    `,
    [date],
  );

  let sage: DailyBriefPayload['sage'];
  try {
    const core = await fivestarQuery<any>(
      `
      SELECT
        (SELECT COUNT(*) FROM call_logs c WHERE COALESCE(c.simulated,false)=false
          AND ((c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date=$1::date)::int AS calls,
        (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
          AND ((ib.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date=$1::date)::int AS booked,
        (SELECT COUNT(*) FROM internal_bookings ib WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
          AND ib.status::text IN ('entered_in_nextgen','completed','no_show')
          AND ((ib.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date=$1::date)::int AS entered,
        (SELECT COUNT(*) FROM sage_hallucination_incidents h
          WHERE ((h.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date=$1::date)::int AS halluc
      `,
      [date],
    );
    const director = await fivestarQuery<any>(
      `
      SELECT CASE
               WHEN reason ILIKE 'reasoning_timeout%' THEN 'reasoning_timeout'
               WHEN reason ILIKE 'safety_validation_failed%' THEN 'safety_validation_failed'
               WHEN reason ILIKE 'invalid_structured_reasoning%' THEN 'invalid_structured_reasoning'
               WHEN reason ILIKE '%loop%' THEN 'loop_detected'
               ELSE 'caller_request_or_other'
             END AS klass, COUNT(*)::int AS n
      FROM handoff_attempts
      WHERE ((initiated_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date=$1::date
      GROUP BY 1
      `,
      [date],
    );
    const tools = await fivestarQuery<any>(
      `
      SELECT tool_name, COUNT(*)::int AS calls,
             COUNT(*) FILTER (WHERE outcome <> 'success' OR error_message IS NOT NULL)::int AS errors
      FROM sage_tool_calls
      WHERE ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date=$1::date
      GROUP BY 1 HAVING COUNT(*) FILTER (WHERE outcome <> 'success' OR error_message IS NOT NULL) > 0
      ORDER BY 3 DESC LIMIT 8
      `,
      [date],
    );
    const c = core.rows[0];
    sage = {
      calls: c.calls,
      booked: c.booked,
      entered: c.entered,
      hallucinations: c.halluc,
      directorReasons: Object.fromEntries(director.rows.map((r: any) => [r.klass, r.n])),
      toolErrorRates: tools.rows.map((r: any) => ({ tool: r.tool_name, errors: r.errors, calls: r.calls })),
    };
  } catch (err) {
    sage = { error: err instanceof Error ? err.message : String(err) };
  }

  // Sync health at generation time (reds only — the morning to-do list).
  let syncReds: DailyBriefPayload['syncReds'] = [];
  try {
    const { syncsOverview } = await import('./queries');
    const s = await syncsOverview();
    syncReds = s.feeds
      .filter((f) => f.status === 'stale' || f.status === 'error')
      .map((f) => ({ name: `${f.app}: ${f.name}`, ageHours: f.ageHours, detail: f.detail }));
  } catch {
    /* syncs section is best-effort in the brief */
  }

  const categories: BriefCategory[] = checks.rows.map((r: any) => ({
    key: `${r.slug}:${r.grader}`,
    agentName: r.agent_name,
    grader: r.grader,
    fails: r.fails,
    totalGraded: r.total,
    failRate: r.total ? Math.round((r.fails / r.total) * 1000) / 1000 : null,
    sampleReasons: (r.reasons ?? []).filter(Boolean),
    exampleCallIds: (r.examples ?? []).filter(Boolean),
    proposal: proposalFor(r.grader),
  }));

  // SAGE categories join the same tracker.
  if (!('error' in sage)) {
    const timeouts = sage.directorReasons['reasoning_timeout'] ?? 0;
    if (timeouts > 0) {
      categories.push({
        key: 'sage:reasoning_timeout',
        agentName: 'SAGE',
        grader: 'director reasoning_timeout',
        fails: timeouts,
        totalGraded: sage.calls,
        failRate: sage.calls ? Math.round((timeouts / sage.calls) * 1000) / 1000 : null,
        sampleReasons: [],
        exampleCallIds: [],
        proposal: proposalFor('sage:reasoning_timeout'),
      });
    }
    const toolErrs = sage.toolErrorRates.reduce((a, t) => a + t.errors, 0);
    if (toolErrs > 0) {
      categories.push({
        key: 'sage:tool_errors',
        agentName: 'SAGE',
        grader: 'tool errors',
        fails: toolErrs,
        totalGraded: sage.toolErrorRates.reduce((a, t) => a + t.calls, 0),
        failRate: null,
        sampleReasons: sage.toolErrorRates.map((t) => `${t.tool}: ${t.errors}/${t.calls}`),
        exampleCallIds: [],
        proposal: proposalFor('sage:tool_errors'),
      });
    }
    if (sage.hallucinations > 0) {
      categories.push({
        key: 'sage:hallucination',
        agentName: 'SAGE',
        grader: 'hallucination guard hits',
        fails: sage.hallucinations,
        totalGraded: sage.calls,
        failRate: null,
        sampleReasons: [],
        exampleCallIds: [],
        proposal: proposalFor('sage:hallucination'),
      });
    }
  }

  const payload: DailyBriefPayload = {
    briefDate: date,
    generatedAt: new Date().toISOString(),
    agents: agents.rows.map((r: any) => ({
      agentId: r.agent_id,
      agentSlug: r.slug,
      agentName: r.name,
      calls: r.calls,
      criticalCalls: r.critical_calls,
      criticalRate: r.calls ? Math.round((r.critical_calls / r.calls) * 1000) / 1000 : null,
      quality: r.quality === null ? null : Number(r.quality),
    })),
    categories: categories.sort((a, b) => b.fails - a.fails),
    sage,
    syncReds,
  };

  await pool.query(
    `INSERT INTO observatory_daily_briefs (brief_date, payload)
     VALUES ($1::date, $2::jsonb)
     ON CONFLICT (brief_date) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
    [date, JSON.stringify(payload)],
  );
  return payload;
}

export interface BriefBundle {
  today: DailyBriefPayload;
  yesterday: DailyBriefPayload | null;
  baseline: DailyBriefPayload | null;
  baselineDate: string | null;
  daysTracked: number;
  history: Array<{ briefDate: string; totalCriticalCalls: number; totalCalls: number }>;
}

/** Latest brief (generating it if today's prior business day has none), plus baseline + history. */
export async function getBriefBundle(): Promise<BriefBundle> {
  const wantDate = priorBusinessDayLA();
  const existing = await pool.query(
    `SELECT payload FROM observatory_daily_briefs WHERE brief_date = $1::date`,
    [wantDate],
  );
  const today: DailyBriefPayload = existing.rows.length
    ? existing.rows[0].payload
    : await generateDailyBrief(wantDate);

  const rows = await pool.query(
    `SELECT brief_date::text AS d, payload FROM observatory_daily_briefs ORDER BY brief_date ASC`,
  );
  const all = rows.rows as Array<{ d: string; payload: DailyBriefPayload }>;
  const baselineRow = all[0] ?? null;
  const yesterdayRow = all.filter((r) => r.d < wantDate).pop() ?? null;

  return {
    today,
    yesterday: yesterdayRow?.payload ?? null,
    baseline: baselineRow?.payload ?? null,
    baselineDate: baselineRow?.d ?? null,
    daysTracked: all.length,
    history: all.map((r) => ({
      briefDate: r.d,
      totalCriticalCalls: (r.payload.agents ?? []).reduce((a, x) => a + (x.criticalCalls ?? 0), 0),
      totalCalls: (r.payload.agents ?? []).reduce((a, x) => a + (x.calls ?? 0), 0),
    })),
  };
}

// ── Morning cron: write the brief by ~06:15 ET without waiting for a visit. ──
let briefCronStarted = false;
export function scheduleDailyBriefCron(): void {
  if (briefCronStarted) return;
  briefCronStarted = true;
  const tick = async () => {
    try {
      const etHour = Number(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()),
      );
      if (etHour < 6) return;
      const wantDate = priorBusinessDayLA();
      const { rows } = await pool.query(
        `SELECT 1 FROM observatory_daily_briefs WHERE brief_date = $1::date`,
        [wantDate],
      );
      if (!rows.length) {
        console.info(`[observatory] Daily brief cron generating brief for ${wantDate}`);
        await generateDailyBrief(wantDate);
      }
    } catch (err) {
      console.warn('[observatory] Daily brief cron failed:', err instanceof Error ? err.message : err);
    }
  };
  const timer = setInterval(tick, 15 * 60 * 1000);
  (timer as unknown as { unref?: () => void }).unref?.();
  setTimeout(() => void tick(), 30_000).unref?.();
}
