/**
 * Pure decision logic for the database keep-alive's self-heal escalation.
 *
 * Kept import-free so it can be unit-tested without DATABASE_URL — the same
 * extraction pattern as agents/azulSchedulingPrompt.ts (see
 * .agents/memory/measurement-traps.md, "Import-time database connections
 * make code impossible to LOOK AT").
 *
 * Why this exists (2026-08-24 incident): Supabase restarted Postgres at
 * 20:19:49 UTC. The voice-agent process's pool never recovered; its
 * keep-alive pinged, failed, logged, and did nothing else — every 2 minutes
 * for 52+ hours. Call logging, the lifecycle reconciler and cost estimation
 * were all dead while calls kept being served (OpenAI billed a normal
 * $174.26 on Aug 25 against our $0.00 estimate). The keep-alive now
 * escalates: after RECYCLE_AFTER_CONSECUTIVE_FAILURES consecutive failed
 * pings it asks db.ts to rebuild the pool, and repeats on every further
 * multiple so a long outage keeps retrying instead of giving up.
 */

/** Consecutive failed pings (each ping already retries 3x internally) before
 * the pool is rebuilt. At the 2-minute production ping interval this is ~6
 * minutes of sustained outage — a transient blip of one failed ping never
 * triggers a recycle. */
export const RECYCLE_AFTER_CONSECUTIVE_FAILURES = 3;

/** Deploy marker — grep the deployment logs for this exact string to confirm
 * the self-healing build is live. */
export const DB_SELF_HEAL_MARKER =
  '[DB KEEP-ALIVE] self-heal armed (build 2026-08-27): pool is rebuilt after 3 consecutive failed pings';

export type SelfHealAction = 'none' | 'recycle';

/**
 * Decide what to do after a ping just failed, given the updated consecutive
 * failure count. Recycles on failure #3, #6, #9, … so a wedge that survives
 * one rebuild keeps being retried for as long as the outage lasts.
 */
export function selfHealAction(consecutiveFailures: number): SelfHealAction {
  if (
    consecutiveFailures >= RECYCLE_AFTER_CONSECUTIVE_FAILURES &&
    consecutiveFailures % RECYCLE_AFTER_CONSECUTIVE_FAILURES === 0
  ) {
    return 'recycle';
  }
  return 'none';
}
