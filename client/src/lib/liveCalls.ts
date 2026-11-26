/**
 * Which call rows the Observatory shows under "Live now".
 *
 * Until 2026-11-26 a row counted only if Twilio also reported a CONFERENCE for
 * its CallSid. Only the retired old core runs calls through a conference; the
 * runtime streams the call (Media Streams) and has none, so "Live now" read 0
 * on every runtime call, all day, while hundreds were taken.
 *
 * A call is now live when its row is still open (in_progress, ringing or
 * initiated) and it started less than LIVE_WINDOW_MINUTES ago. The runtime
 * ends every call at 10 minutes (DEFAULT_MAX_CALL_MS), so an open row older
 * than that is a row whose end was never written, not a call; the Operations
 * Monitor counts those as "End never written", on the same 15-minute line.
 */
export const LIVE_WINDOW_MINUTES = 15

const OPEN = new Set(['in_progress', 'ringing', 'initiated'])

export interface LiveRow {
  status: string
  startTime?: string | null
  createdAt: string
}

export function isLive(row: LiveRow, now: Date = new Date()): boolean {
  if (!OPEN.has(row.status)) return false
  const started = new Date(row.startTime ?? row.createdAt).getTime()
  if (!Number.isFinite(started)) return false
  const age = now.getTime() - started
  return age >= -60_000 && age < LIVE_WINDOW_MINUTES * 60_000
}

export function liveCalls<T extends LiveRow>(rows: T[], now: Date = new Date()): T[] {
  return rows.filter((r) => isLive(r, now))
}
