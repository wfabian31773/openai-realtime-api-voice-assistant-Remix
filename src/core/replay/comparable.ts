/**
 * The referee list every replay comparison shares — which graders may be
 * compared between a stored call and a replayed one, and what counts as a
 * critical failure among them.
 *
 * In its own module, with no imports, for one load-bearing reason: the full
 * `CallGradingService` (and `replayCall`, which value-imports it) opens the
 * database at module load. Anything that only needs the LIST — the runtime
 * regression harness, a test — must be able to import it without a database,
 * or it inherits the p0Hardening failure mode: a suite that cannot import
 * runs zero tests and reports it as red, or worse, a mutation check counts
 * the import failure as a caught mutation.
 *
 * Audio-plumbing graders (latency, interruption_rate, transcript_coverage,
 * duration_mismatch) are deliberately absent: a text replay has no audio on
 * either side, so comparing them would score the harness, not the agent.
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
