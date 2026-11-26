/**
 * What the Operations Monitor shows, decided here so it can be tested without
 * a browser. The rule that matters: a number the server did not give is shown
 * as "—" (unavailable), never as 0 or 100%. The old page fell back to `|| 0`
 * and `?? 100` and read "0 critical fails" and "100% handoff success" in green
 * when its feed did not exist.
 */

export type OpsStatus = 'healthy' | 'degraded' | 'critical' | 'no_calls'

export interface OperationsReport {
  windowHours: number
  generatedAt: string
  status: OpsStatus
  statusReasons: string[]
  thresholds: { droppedDegradedPct: number; droppedCriticalPct: number; deadAirDegradedPct: number; minCallsForRates: number }
  calls: {
    total: number
    live: number
    stuck: number
    dropped: number
    failedOther: number
    deadAir: number
    callerSilent: number
    transferred: number
    withTicket: number
    graded: number
    oldCore: number
    lastCallAt: string | null
  }
  rates: { droppedPct: number | null; deadAirPct: number | null }
  reconnects: { drops: number; reconnected: number; ended: number; byResult: Record<string, number> } | null
  lanes: Array<{ lane: string; calls: number; dropped: number; deadAir: number; transferred: number; withTicket: number; avgSeconds: number | null }>
  recentProblems: Array<{ id: string; callSid: string | null; lane: string; outcome: string; seconds: number | null; at: string }>
}

export const STATUS_LABEL: Record<OpsStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  critical: 'Critical',
  no_calls: 'No calls',
}

export const STATUS_CLASS: Record<OpsStatus, string> = {
  healthy: 'text-green-700 bg-green-100',
  degraded: 'text-yellow-700 bg-yellow-100',
  critical: 'text-red-700 bg-red-100',
  no_calls: 'text-gray-700 bg-gray-100',
}

/** "1.5%" or "—" when the share was not judged. */
export function pctText(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v}%`
}

/** A share of the window's calls computed on the page, "—" when there are no calls. */
export function shareText(part: number, whole: number): string {
  if (!whole) return '—'
  return `${Math.round((part / whole) * 1000) / 10}%`
}

/** The plain-words outcome a call ended with. Unknown values are shown as they are. */
export function outcomeLabel(outcome: string): string {
  const map: Record<string, string> = {
    provider_failure: 'Dropped by the voice provider',
    dead_air: 'Dead air (agent went silent)',
    caller_silent: 'Caller never spoke',
    max_duration: 'Hit the 10-minute limit',
    failed: 'Never connected',
    in_progress: 'Still "in progress" (end never written)',
  }
  return map[outcome] ?? outcome
}

export const RECONNECT_RESULT_LABEL: Record<string, string> = {
  reconnected: 'reconnected, call carried on',
  limit: 'ended: too many drops on one call',
  redropped: 'ended: dropped again within 30 s',
  budget_spent: 'ended: reconnect took too long',
  connect_failed: 'ended: could not reconnect',
  closed_before_configured: 'ended: new connection closed at once',
  call_ended: 'caller hung up during the reconnect',
}

export function durationText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "3 min ago", "2 h ago", or the date for anything older than a day. */
export function agoText(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const mins = Math.floor((now.getTime() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} h ago`
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** A time shown on the page, always Pacific, which is the day the practice works in. */
export function pacificTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT'
}

export const WINDOWS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: 'Last hour' },
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last 7 days' },
]
