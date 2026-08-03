/**
 * Azul scheduling agent — grade regression watch (Phase 7).
 *
 * Once a day, compares the last 24h of azul call grades against the
 * trailing 7 days. A meaningful average-score drop, a critical rubric failure
 * on a large enough sample, or a purpose-vs-result gap raises an alert.
 *
 * As of 2026-08-03 that alert is a LOG LINE, not a ticket. It used to file a
 * HIGH-priority ticket into the default location queue as a fake patient
 * ("SYSTEM Grade Regression"), which put an engineering signal in front of the
 * schedulers, competing with real callers. Set REGRESSION_WATCH_TICKETS=true
 * to restore ticket filing once there is an internal queue to route it to.
 *
 * Side-effect module: imported once at boot (voiceAgentRoutes), checks ~30min
 * after start and then every 24h.
 */

import { db } from '../../server/db';
import { callLogs } from '../../shared/schema';
import { and, eq, gte, lt, isNotNull } from 'drizzle-orm';

const TICKETING_URL = process.env.TICKETING_ENRICHMENT_URL || process.env.TICKETING_SYSTEM_URL || '';
const TICKETING_KEY = process.env.TICKETING_API_KEY || '';
const DEFAULT_QUEUE_LOCATION = process.env.AZUL_DEFAULT_QUEUE_LOCATION || 'Encinitas';
const SCORE_DROP_THRESHOLD = 0.15; // 15-point avg drop (0..1 scale) = regression

/**
 * Minimum graded calls in the 24h window before a critical-failure count is
 * allowed to raise anything.
 *
 * 2026-08-03: VA-47707 was filed off `Last 24h: 1 graded call(s). Baseline 7d:
 * 304` — a single operator test call with one critical rubric failure raised a
 * HIGH ticket in the Encinitas patient queue. One call is not a trend, and a
 * morning of test calls will trip this every time. A score DROP already
 * requires a baseline; criticals had no sample floor at all.
 */
const MIN_SAMPLE_FOR_CRITICALS = 5;

/**
 * Whether a regression may file a ticket in the patient queue.
 *
 * Default OFF as of 2026-08-03. The original reasoning still stands — "a
 * regression must be an alert someone owns, never a dashboard curve nobody
 * looked at" — but the patient work queue is the wrong place to own it: these
 * land as a fake patient ("SYSTEM Grade Regression"), assigned to a location,
 * competing with real callers for staff attention. Until there is an internal
 * queue to route them to, the regression is logged at error level and shows up
 * in the deploy log, not in front of the schedulers.
 */
const TICKETS_ENABLED = process.env.REGRESSION_WATCH_TICKETS === 'true';

interface GraderSummary { avgScore?: number; criticalFailures?: number; failed?: number; total?: number }

/** Operator principle (2026-07-24, first live night): "when the purpose
 *  doesn't match the result, we need to understand why — that's what leads
 *  to productivity." Purpose/result pairs come from the call timeline. */
const INTENT_FULFILLMENT: Array<{ purpose: string; fulfilledPrefix: string[] }> = [
  { purpose: 'Schedule appointment', fulfilledPrefix: ['Booked'] },
  { purpose: 'Cancel appointment', fulfilledPrefix: ['Cancelled'] },
  { purpose: 'New patient registration', fulfilledPrefix: ['Registered'] },
];

async function summarize(from: Date, to: Date): Promise<{ calls: number; avg: number; criticals: number; criticalGraders: string[]; intentTotal: number; intentFulfilled: number; unfulfilled: string[] }> {
  const rows = await db
    .select({ graderResults: callLogs.graderResults, toolTimeline: callLogs.toolTimeline })
    .from(callLogs)
    .where(and(
      eq(callLogs.agentUsed, 'azul-scheduling'),
      gte(callLogs.startTime, from),
      lt(callLogs.startTime, to),
      isNotNull(callLogs.graderResults),
    ));
  let scoreSum = 0;
  let scored = 0;
  let criticals = 0;
  let intentTotal = 0;
  let intentFulfilled = 0;
  const unfulfilled: string[] = [];
  const criticalGraders: string[] = [];
  for (const r of rows) {
    const payload = r.graderResults as { summary?: GraderSummary; graders?: Array<{ grader: string; pass: boolean; severity: string }> } | null;
    const s = payload?.summary;
    if (s?.avgScore != null) { scoreSum += s.avgScore; scored += 1; }
    if (s?.criticalFailures) {
      criticals += s.criticalFailures;
      for (const g of payload?.graders ?? []) {
        if (!g.pass && g.severity === 'critical') criticalGraders.push(g.grader);
      }
    }
    const tl = r.toolTimeline as { purpose?: string; result?: string } | null;
    const rule = tl?.purpose ? INTENT_FULFILLMENT.find((x) => tl.purpose!.startsWith(x.purpose)) : undefined;
    if (rule) {
      intentTotal += 1;
      const ok = rule.fulfilledPrefix.some((p) => (tl?.result ?? '').startsWith(p));
      if (ok) intentFulfilled += 1;
      else unfulfilled.push(`${tl?.purpose} → ${tl?.result ?? 'no result'}`);
    }
  }
  return { calls: rows.length, avg: scored ? scoreSum / scored : NaN, criticals, criticalGraders: [...new Set(criticalGraders)], intentTotal, intentFulfilled, unfulfilled };
}

async function fileRegressionTicket(description: string): Promise<void> {
  if (!TICKETS_ENABLED) {
    console.error(
      '[REGRESSION-WATCH] regression detected — NOT ticketed (REGRESSION_WATCH_TICKETS is off; ' +
        'the patient queue is not where a system alert belongs):\n' + description,
    );
    return;
  }
  if (!TICKETING_URL || !TICKETING_KEY) {
    console.error('[REGRESSION-WATCH] ticketing env missing — regression NOT ticketed:', description.slice(0, 200));
    return;
  }
  try {
    const r = await fetch(`${TICKETING_URL}/api/voice-agent/create-ticket`, {
      method: 'POST',
      headers: { 'X-API-Key': TICKETING_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queue: 'location',
        locationName: DEFAULT_QUEUE_LOCATION,
        idempotencyKey: `azul-regression-${new Date().toISOString().slice(0, 10)}`,
        patientFirstName: 'SYSTEM',
        patientLastName: 'Grade Regression',
        patientPhone: 'n/a',
        description,
        priority: 'high',
        confirmationType: 'phone',
        callData: { agentUsed: 'azul-scheduling-regression-watch' },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`[REGRESSION-WATCH] regression ticket ${r.ok ? 'filed' : `FAILED ${r.status}`}`);
  } catch (e) {
    console.error('[REGRESSION-WATCH] ticket filing failed:', e);
  }
}

export async function runRegressionCheck(): Promise<void> {
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
    const weekAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
    const recent = await summarize(dayAgo, now);
    const baseline = await summarize(weekAgo, dayAgo);
    if (recent.calls === 0) {
      console.log('[REGRESSION-WATCH] no graded azul calls in the last 24h — nothing to compare');
      return;
    }
    const problems: string[] = [];
    if (recent.criticals > 0) {
      // A sample floor, so a morning of operator test calls cannot raise an
      // alert on its own (VA-47707: one graded call, one critical, HIGH ticket).
      if (recent.calls >= MIN_SAMPLE_FOR_CRITICALS) {
        problems.push(`${recent.criticals} CRITICAL grader failure(s) in the last 24h: ${recent.criticalGraders.join(', ')}`);
      } else {
        console.warn(
          `[REGRESSION-WATCH] ${recent.criticals} critical failure(s) (${recent.criticalGraders.join(', ')}) ` +
            `but only ${recent.calls} graded call(s) — below the ${MIN_SAMPLE_FOR_CRITICALS}-call floor, not alerting`,
        );
      }
    }
    if (baseline.calls >= 3 && Number.isFinite(recent.avg) && Number.isFinite(baseline.avg) && baseline.avg - recent.avg > SCORE_DROP_THRESHOLD) {
      problems.push(`Average grade dropped ${((baseline.avg - recent.avg) * 100).toFixed(0)} points (24h avg ${(recent.avg * 100).toFixed(0)} vs 7d avg ${(baseline.avg * 100).toFixed(0)})`);
    }
    // Purpose ≠ result is the operator's productivity metric: below 50%
    // fulfillment on a meaningful sample is an owned alert, with the actual
    // mismatches listed so 'understand why' starts from evidence.
    if (recent.intentTotal >= 5 && recent.intentFulfilled / recent.intentTotal < 0.5) {
      problems.push(
        `Purpose≠result: only ${recent.intentFulfilled}/${recent.intentTotal} intent calls fulfilled. Mismatches: ${recent.unfulfilled.slice(0, 8).join(' | ')}`,
      );
    }
    if (problems.length === 0) {
      console.log(`[REGRESSION-WATCH] healthy — ${recent.calls} call(s), avg ${(recent.avg * 100).toFixed(0)}, 0 criticals, intent fulfillment ${recent.intentFulfilled}/${recent.intentTotal}`);
      return;
    }
    const description = [
      'AZUL VOICE AGENT — GRADE REGRESSION DETECTED (automatic)',
      ...problems,
      `Last 24h: ${recent.calls} graded call(s). Baseline 7d: ${baseline.calls} call(s).`,
      'Review the SD Pilot dashboard call grades and the most recent transcripts.',
    ].join('\n');
    console.error(`[REGRESSION-WATCH] ⚠️ ${problems.join(' | ')}`);
    await fileRegressionTicket(description);
  } catch (e) {
    console.error('[REGRESSION-WATCH] check failed:', e);
  }
}

// First check ~30min after boot (lets post-deploy calls accumulate grades),
// then daily. unref so the timers never hold the process open.
setTimeout(() => { void runRegressionCheck(); }, 30 * 60 * 1000).unref?.();
setInterval(() => { void runRegressionCheck(); }, 24 * 60 * 60 * 1000).unref?.();
