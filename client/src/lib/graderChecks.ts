/**
 * The checks a graded call carries, whatever shape it was stored in.
 *
 * The grader has stored `{ gradedAt, graders: [...], summary }` on every graded
 * call (3,941 of 3,941 in the 7 days to 2026-11-26). The call page read only
 * the older `deterministic` / `results` keys, so its Analysis tab said "This
 * call has not been graded yet" on every graded call, including 312 with a
 * critical failure.
 */
export interface GraderCheck {
  grader: string
  pass: boolean
  score: number
  reason: string
  severity?: string
  metadata?: Record<string, unknown>
}

export function checksOf(graderResults: unknown): GraderCheck[] {
  if (!graderResults) return []
  if (Array.isArray(graderResults)) return graderResults as GraderCheck[]
  if (typeof graderResults !== 'object') return []
  const gr = graderResults as Record<string, unknown>
  for (const key of ['graders', 'deterministic', 'results']) {
    if (Array.isArray(gr[key])) return gr[key] as GraderCheck[]
  }
  return []
}
