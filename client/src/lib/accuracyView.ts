/**
 * What the Observatory's Accuracy tab shows (GET /api/observatory/accuracy),
 * decided here so it can be tested without a browser.
 *
 * Each check reads one number the way a screen reads it and the same number
 * from the call records directly, and says whether they agree. A check whose
 * truth could not be read is "unknown", never "pass": an unread number is not
 * a correct one.
 */

export type CheckStatus = 'pass' | 'fail' | 'unknown'
export type Unit = 'count' | 'percent' | 'dollars' | 'minutes' | 'seconds'

export interface AccuracyResult {
  id: string
  screen: string
  widget: string
  claim: string
  truthSource: string
  unit: Unit
  status: CheckStatus
  screenValue: number | null
  truthValue: number | null
  difference: number | null
  allowed: number | null
  note: string
  ms: number
  failingSince: string | null
}

export interface AccuracyResponse {
  ranAt: string
  durationMs: number
  counts: Record<CheckStatus, number>
  results: AccuracyResult[]
  historyAvailable: boolean
}

export const STATUS_TEXT: Record<CheckStatus, string> = {
  pass: 'Matches',
  fail: 'Wrong',
  unknown: 'Could not check',
}

export const STATUS_CLASS: Record<CheckStatus, string> = {
  pass: 'bg-green-100 text-green-800',
  fail: 'bg-red-100 text-red-800',
  unknown: 'bg-gray-100 text-gray-700',
}

/** The same rendering the server uses for its sentence (accuracy.logic.ts formatValue). */
export function valueText(v: number | null | undefined, unit: Unit): string {
  if (v === null || v === undefined) return '—'
  if (!Number.isFinite(v)) return String(v)
  switch (unit) {
    case 'percent':
      return `${(v * 100).toFixed(1)}%`
    case 'dollars':
      return `$${v.toFixed(2)}`
    case 'minutes':
      return `${v.toFixed(1)} min`
    case 'seconds':
      return `${v.toFixed(1)} s`
    default:
      return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2)
  }
}

/** The headline: how many checks are wrong, and whether any could not be checked. */
export function headline(r: Pick<AccuracyResponse, 'counts' | 'results'>): { tone: 'good' | 'bad' | 'unsure'; text: string } {
  const total = r.results.length
  const { fail, unknown } = r.counts
  if (total === 0) return { tone: 'unsure', text: 'No checks ran.' }
  if (fail > 0) {
    return {
      tone: 'bad',
      text: `${fail} of ${total} numbers on screen are wrong${unknown ? `, and ${unknown} could not be checked` : ''}.`,
    }
  }
  if (unknown > 0) return { tone: 'unsure', text: `No number was wrong, but ${unknown} of ${total} could not be checked.` }
  return { tone: 'good', text: `All ${total} numbers checked match the call records.` }
}

/** Wrong first, then could-not-check, then matching; by screen within each. */
export function orderResults(results: AccuracyResult[]): AccuracyResult[] {
  const rank: Record<CheckStatus, number> = { fail: 0, unknown: 1, pass: 2 }
  return [...results].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.screen.localeCompare(b.screen) || a.id.localeCompare(b.id),
  )
}

/** "since Nov 25, 7:00 PM PT", or null when the check is not failing. */
export function failingSinceText(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  return `since ${d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })} PT`
}

/** What "Check now" says when the fresh run fails; the last report stays on screen. */
export function refreshFailureText(err: unknown): string {
  const e = err as { response?: { data?: { error?: unknown } }; message?: unknown } | null
  const why = typeof e?.response?.data?.error === 'string' ? e.response.data.error : 'the request failed'
  return `Check now did not finish (${why}). The results below are from the last run.`
}
