/**
 * Pure helpers for the Observatory Daily Brief day picker — kept out of the
 * page so the arrow and notice rules can be tested without a DOM.
 */

/** The stored days either side of `selected` in an ascending list; null at the ends. */
export function briefNeighbours(
  availableDates: string[],
  selected: string,
): { prev: string | null; next: string | null } {
  const i = availableDates.indexOf(selected)
  if (i === -1) {
    // A day not in the list (should not happen): step to the nearest stored days.
    const prev = [...availableDates].reverse().find((d) => d < selected) ?? null
    const next = availableDates.find((d) => d > selected) ?? null
    return { prev, next }
  }
  return {
    prev: i > 0 ? availableDates[i - 1] : null,
    next: i < availableDates.length - 1 ? availableDates[i + 1] : null,
  }
}

export interface BriefCorrectionNotice {
  label: string
  correctedAt: string | null
}

/**
 * The amber notice for a backfilled/corrected day, or null when the payload
 * carries no correction. Reads only label / reason / correctedAt — never the
 * originals a backfill keeps beside them.
 */
export function briefCorrectionNotice(correction: unknown): BriefCorrectionNotice | null {
  if (correction == null || correction === false) return null
  if (typeof correction !== 'object') return { label: 'This day was backfilled or corrected after the fact.', correctedAt: null }
  const c = correction as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    label: text(c.label) ?? text(c.reason) ?? 'This day was backfilled or corrected after the fact.',
    correctedAt: text(c.correctedAt),
  }
}
