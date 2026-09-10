/**
 * The referee list every replay comparison shares — which graders may be
 * compared between a stored call and a replayed one, and what counts as a
 * critical failure among them.
 *
 * In its own module, with no imports, for one load-bearing reason: the full
 * `CallGradingService` opens the database at module load. Anything that only
 * needs the LIST — the runtime regression harness, a test — must be able to
 * import it without a database, or it inherits the p0Hardening failure mode:
 * a suite that cannot import runs zero tests and reports it as red, or worse,
 * a mutation check counts the import failure as a caught mutation.
 *
 * Moved here from `src/core/replay/` on 2026-09-01 when that pipeline was
 * deleted. The runtime regression harness is now its only consumer.
 *
 * Audio-plumbing graders (latency, interruption_rate, transcript_coverage,
 * duration_mismatch) are deliberately absent: a text replay has no audio on
 * either side, so comparing them would score the harness, not the agent.
 *
 * `greeting_replayed` is absent for the SAME reason, and it is the one worth
 * spelling out. The harness builds its transcript starting from the first
 * CALLER turn, so the replayed side never plays a greeting at all. A stored
 * call that really did greet twice would fail that check on the old side and
 * pass on the new one every single time — a free "improvement" that is purely
 * an artefact of how the replay is constructed. It is never critical, so it
 * could not have moved a verdict, but it would have made the compared lists
 * lie. (Codex asked for the new graders here, PR #278; this one earns its
 * exclusion.)
 */
export interface ComparableGraderResult {
  grader: string;
  pass: boolean;
  metadata?: unknown;
}

export const COMPARABLE = new Set([
  'handoff_expected_vs_actual',
  'ticket_required_vs_created',
  'question_repetition',
  'human_request_deflection',
  'language_config_fault',
  'emergency_handling',
  'medical_advice_guardrail',
  'provider_must_escalate',
  'actionable_request_needs_ticket',
  'callback_fields_completeness',
  'tail_safety',
  // The repetition counters, added 2026-09-09 with the graders themselves.
  // `refiled_repeatedly` is the one that matters: it is the only new grader
  // that can be CRITICAL, and the harness sets `ticketNumber` from the
  // replay's own writes ("SIM-1" when a filing tool ran, null when none did),
  // so a replay that announces filing repeatedly and writes nothing is
  // exactly the failure it names. Without it here, `criticalsOf` dropped that
  // result and the run could report `same` or `better` on a replay that got
  // measurably worse — the harness blind to the very defect just instrumented.
  'refiled_repeatedly',
  'agent_line_repeated',
]);

export function criticalsOf(graders: ComparableGraderResult[] | undefined | null): string[] {
  return (graders ?? [])
    .filter((g) => COMPARABLE.has(g.grader))
    .filter(
      (g) =>
        g.pass === false &&
        ((g as { severity?: string }).severity === 'critical' ||
          (g.metadata as { critical?: boolean } | undefined)?.critical === true),
    )
    .map((g) => g.grader);
}
