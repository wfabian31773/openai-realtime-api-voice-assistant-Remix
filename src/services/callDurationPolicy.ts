/**
 * CALL DURATION POLICY — the max-duration ceilings, and nothing else.
 *
 * Split out of callLifecycleCoordinator so these values can be read without
 * importing it. That module constructs its singleton at import time, and the
 * constructor starts a stale-call detector and a database reconciler that
 * WRITES to call_logs — so a read-only consumer (an audit script, a test)
 * that just wanted a number would silently start mutating production rows.
 *
 * Everything here is pure: constants and one lookup, no I/O, no timers.
 */

/**
 * Max call duration by agent type.
 *
 * These are a COST BACKSTOP against orphaned sessions, not a conversation
 * budget. When one fires, Twilio hangs up on whoever is mid-sentence — there
 * is no warning to the caller and no graceful wrap-up.
 *
 * Raised 2026-07-27 after staff reported calls dropping mid-call. Durations
 * were piling up against the old 10-minute ceiling — 601, 601, 601, 602, 602,
 * 602, 602, 605, 609 seconds — and the no-ivr calls cut at 602s all recorded
 * `agent_outcome: inconclusive` with no transfer, i.e. a real caller was
 * dropped with their business unfinished. azul-scheduling averages 272s, so
 * 10 minutes was only ~2x the mean: far too tight for a distribution with a
 * long tail (identity checks, elderly callers, interpreter-paced calls).
 *
 * Note the old per-agent values were not actually taking effect. An
 * answering-service call ran 609s against a nominal 420s cap, which means
 * agentSlug did not reach scheduleMaxDurationTimeout and it fell through to
 * DEFAULT. Every agent was really running on the 10-minute default. Every
 * agent now has an explicit entry and DEFAULT is aligned, so a missing slug
 * degrades to a sane ceiling rather than a surprise one.
 */
export const AGENT_MAX_DURATION_MS: Record<string, number> = {
  'appointment-confirmation': 3 * 60 * 1000,  // 3 min — outbound, completes in 60-90s; unchanged
  'after-hours':             15 * 60 * 1000,  // 15 min — triage, can involve on-call escalation
  'answering-service':       15 * 60 * 1000,  // 15 min — was nominally 7, never actually applied
  'no-ivr':                  15 * 60 * 1000,  // 15 min — explicit; previously fell through to DEFAULT
  'azul-scheduling':         20 * 60 * 1000,  // 20 min — identity + search + book, longest tail of any agent
  'pcp':                     15 * 60 * 1000,  // 15 min — professional intake + possible live handoff
};
export const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000; // 15 min — unknown/new agents

/**
 * Absolute ceiling for the startup sweep and the DB reconciler, both of which
 * force-terminate calls older than this REGARDLESS of the per-agent cap.
 *
 * Derived rather than hardcoded, because it silently overrides everything
 * above it. It sat at a literal 10 minutes while azul-scheduling was nominally
 * allowed 10 — so the reconciler could cut a call at the exact moment the
 * agent was still entitled to run, and raising the per-agent value alone would
 * have changed nothing. Keeping it a function of the map means the two cannot
 * drift apart again.
 */
export const ABSOLUTE_MAX_CALL_DURATION_MS =
  Math.max(DEFAULT_MAX_DURATION_MS, ...Object.values(AGENT_MAX_DURATION_MS)) + 5 * 60 * 1000;

export function getMaxDurationMs(agentSlug?: string): number {
  if (agentSlug && agentSlug in AGENT_MAX_DURATION_MS) {
    return AGENT_MAX_DURATION_MS[agentSlug];
  }
  return DEFAULT_MAX_DURATION_MS;
}
