/**
 * Azul scheduling agent — grade regression watch (Phase 7).
 *
 * Once a day, compares the last 24h of azul call grades against the
 * trailing 7 days. A meaningful average-score drop OR any critical
 * rubric failure in the last 24h raises a HIGH-priority ticket in the
 * default location queue — a regression must be an alert someone owns,
 * never a dashboard curve nobody looked at. Side-effect module: imported
 * once at boot (voiceAgentRoutes), checks ~30min after start and then
 * every 24h.
 */

import { db } from '../../server/db';
import { callLogs } from '../../shared/schema';
import { and, eq, gte, lt, isNotNull } from 'drizzle-orm';

const TICKETING_URL = process.env.TICKETING_ENRICHMENT_URL || process.env.TICKETING_SYSTEM_URL || '';
const TICKETING_KEY = process.env.TICKETING_API_KEY || '';
const DEFAULT_QUEUE_LOCATION = process.env.AZUL_DEFAULT_QUEUE_LOCATION || 'Encinitas';
const SCORE_DROP_THRESHOLD = 0.15; // 15-point avg drop (0..1 scale) = regression

interface GraderSummary { avgScore?: number; criticalFailures?: number; failed?: number; total?: number }

async function summarize(from: Date, to: Date): Promise<{ calls: number; avg: number; criticals: number; criticalGraders: string[] }> {
  const rows = await db
    .select({ graderResults: callLogs.graderResults })
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
  }
  return { calls: rows.length, avg: scored ? scoreSum / scored : NaN, criticals, criticalGraders: [...new Set(criticalGraders)] };
}

async function fileRegressionTicket(description: string): Promise<void> {
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
      problems.push(`${recent.criticals} CRITICAL grader failure(s) in the last 24h: ${recent.criticalGraders.join(', ')}`);
    }
    if (baseline.calls >= 3 && Number.isFinite(recent.avg) && Number.isFinite(baseline.avg) && baseline.avg - recent.avg > SCORE_DROP_THRESHOLD) {
      problems.push(`Average grade dropped ${((baseline.avg - recent.avg) * 100).toFixed(0)} points (24h avg ${(recent.avg * 100).toFixed(0)} vs 7d avg ${(baseline.avg * 100).toFixed(0)})`);
    }
    if (problems.length === 0) {
      console.log(`[REGRESSION-WATCH] healthy — ${recent.calls} call(s), avg ${(recent.avg * 100).toFixed(0)}, 0 criticals`);
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
