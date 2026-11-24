/**
 * Pure helpers for the After-Hours On-Call page (/on-call). Every time on the
 * page is shown in Pacific time and says so: the rotation is defined in
 * Pacific (a week runs Tuesday 5:00 PM to the next Tuesday 8:00 AM PT).
 */

export const PACIFIC = 'America/Los_Angeles'

const FULL = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})

const DAY = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })

/** "Fri, Dec 4, 2026, 10:00 PM PT", or a dash. */
export function fmtPacific(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : `${FULL.format(d)} PT`
}

/** "10:00:05 PM" (Pacific), for a timeline row inside one call. */
export function fmtPacificTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : TIME.format(d)
}

/** A YYYY-MM-DD week start as "Tue, Dec 1, 2026". */
export function fmtWeek(week: string): string {
  return DAY.format(new Date(`${week}T20:00:00Z`))
}

/** The value a datetime-local input wants, in Pacific: "2026-12-04T22:00". */
export function toPacificInput(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
}

/**
 * Midnight Pacific at the start of a YYYY-MM-DD day, as an ISO instant,
 * whatever the browser's time zone. Midnight is PST (UTC-8) or PDT (UTC-7);
 * Los Angeles changes clocks at 2 AM, so midnight always exists once.
 * Returns null for anything that is not a real date.
 */
export function pacificMidnightIso(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  for (const offsetHours of [8, 7]) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], offsetHours))
    if (toPacificInput(d) === `${day}T00:00`) return d.toISOString()
  }
  return null
}

/** Midnight Pacific at the start of the day AFTER a YYYY-MM-DD day: the exclusive end of that day. */
export function pacificNextMidnightIso(day: string): string | null {
  const start = pacificMidnightIso(day)
  if (!start) return null
  // 26 hours after midnight is always inside the next Pacific day (days run 23 to 25 hours).
  const next = toPacificInput(new Date(new Date(start).getTime() + 26 * 3_600_000)).slice(0, 10)
  return pacificMidnightIso(next)
}

/** "4d 3h 12m" until go-live; "live date passed" at zero. */
export function countdown(ms: number): string {
  if (ms <= 0) return 'go-live date passed'
  const m = Math.floor(ms / 60_000)
  const days = Math.floor(m / 1440)
  const hours = Math.floor((m % 1440) / 60)
  const mins = m % 60
  return [days ? `${days}d` : null, days || hours ? `${hours}h` : null, `${mins}m`].filter(Boolean).join(' ')
}

/** "2m 05s" for a duration in seconds. */
export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || Number.isNaN(s)) return '—'
  const m = Math.floor(s / 60)
  const r = Math.abs(s % 60)
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`
}

/** The server's refusal text, or a generic line. */
export function apiError(e: unknown): string {
  const any = e as { response?: { data?: { error?: string; message?: string } }; message?: string }
  return any?.response?.data?.message ?? any?.response?.data?.error ?? any?.message ?? 'Something went wrong.'
}

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info'

export function chainStatusVariant(status: string | null | undefined): BadgeVariant {
  switch (status) {
    case 'accepted':
      return 'success'
    case 'active':
      return 'info'
    case 'exhausted':
    case 'failed':
      return 'destructive'
    case 'cancelled':
      return 'warning'
    default:
      return 'secondary'
  }
}

export function timelineVariant(status: string | null | undefined): BadgeVariant {
  switch (status) {
    case 'ok':
      return 'success'
    case 'fail':
      return 'destructive'
    case 'warn':
      return 'warning'
    default:
      return 'secondary'
  }
}

export const SOURCE_LABELS: Record<string, string> = {
  call_logs: 'call log',
  transcript: 'transcript',
  tool: 'agent tool',
  call_events: 'call event',
  escalation: 'on-call chain',
  attempt: 'chain attempt',
  ticket: 'ticket',
  on_call_call_events: 'extra event',
}

export const WINDOW_LABELS: Record<string, string> = {
  off_hours: 'After hours (on call)',
  holiday_daytime: 'Holiday daytime (on call)',
  weekday_daytime: 'Weekday daytime — NOT covered by the rotation (fixed number)',
}

export const ROLE_LABELS: Record<string, string> = {
  on_call: 'On-call provider',
  surgeon: 'Surgeon',
  region_director: 'Region director',
  final: 'Final director',
  operations_fallback: 'Operations fallback (Wayne)',
}

/**
 * The operations fallback (Wayne) as the page states it: the last four digits
 * when ON_CALL_FINAL_FALLBACK_NUMBER is set and usable, why not when it is set
 * and unusable, and "not configured" otherwise.
 */
export function finalFallbackText(c: { finalFallbackLast4?: string | null; finalFallbackProblem?: string | null }): string {
  if (c.finalFallbackLast4) return `Operations fallback (Wayne) ${c.finalFallbackLast4}, rung after the final director`
  if (c.finalFallbackProblem) return `not configured: ${c.finalFallbackProblem}`
  return 'not configured: an exhausted chain only texts the urgent notification number'
}

export interface CoverDraft {
  startsAt: string
  endsAt: string
  providerId: number | ''
  confirmOverlap: boolean
  /** The override ids the last overlap warning named; the confirmation covers these and no others. */
  overlapIds: number[]
}

/**
 * A cover-dialog edit. Changing the window or the provider withdraws a
 * confirmed overlap, because the conflict that was confirmed may no longer be
 * the one the next save would supersede; `clearWarning` says the shown overlap
 * warning is stale too.
 */
export function editCover(cover: CoverDraft, patch: Partial<CoverDraft>): { cover: CoverDraft; clearWarning: boolean } {
  const changed = (['startsAt', 'endsAt', 'providerId'] as const).some((k) => k in patch && patch[k] !== cover[k])
  const next = { ...cover, ...patch }
  if (changed) {
    next.confirmOverlap = false
    next.overlapIds = []
  }
  return { cover: next, clearWarning: changed }
}

/**
 * The cover dialog after the server named the current overlaps: the warning
 * shows these ids, and any earlier confirmation is withdrawn, because it was
 * for a set that is no longer the one the save would supersede.
 */
export function warnCoverOverlap(cover: CoverDraft, overlapIds: number[]): CoverDraft {
  return { ...cover, confirmOverlap: false, overlapIds: [...overlapIds] }
}

/** The save body: the confirmed overlap ids are sent only when the box is ticked. */
export function coverBody(cover: CoverDraft, reason: string) {
  return {
    startsAt: cover.startsAt,
    endsAt: cover.endsAt,
    providerId: cover.providerId,
    confirmedOverlapIds: cover.confirmOverlap ? cover.overlapIds : [],
    reason,
  }
}

export interface ExtendPreview {
  /** The week count this preview was requested for. */
  count: number
  weeks: Array<{ week: string; providerId: number; providerName: string | null }>
  refusal: string | null
}

/** The previewed weeks the confirm sends back, so the server writes only what the admin saw. */
export function extendPlan(preview: ExtendPreview): Array<{ week: string; providerId: number }> {
  return preview.weeks.map((w) => ({ week: w.week, providerId: w.providerId }))
}

/** The server refused the confirm because the schedule changed since the preview (a fresh preview is needed). */
export function isExtendPlanChanged(e: unknown): boolean {
  const r = (e as { response?: { status?: number; data?: { planChanged?: boolean } } })?.response
  return r?.status === 409 && r.data?.planChanged === true
}

/** A preview response is kept only if it answers the count currently entered. */
export function acceptExtendPreview(currentCount: number, preview: ExtendPreview): boolean {
  return preview.count === currentCount
}

/** "Add these weeks" is allowed only once the preview for the current count is in and was not refused. */
export function extendPreviewReady(preview: ExtendPreview | null, currentCount: number): boolean {
  return preview !== null && preview.count === currentCount && preview.refusal === null
}

/** The tab a section of the per-call view says it came from, wired or not. */
export function sectionBadge(s: { wired: boolean; present: boolean }): { label: string; variant: BadgeVariant } {
  if (!s.wired) return { label: 'placeholder', variant: 'outline' }
  return s.present ? { label: 'wired', variant: 'success' } : { label: 'wired · none on this call', variant: 'secondary' }
}
