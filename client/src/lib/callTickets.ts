/**
 * Every ticket a call created, as the call-log API reports it (v223).
 *
 * The server sends `ticketNumbers` — the row's own ticket first, then any
 * second ticket a filing reported on the call's tool timeline (see
 * server/callTicketNumbers.ts). A server older than v223 sends only
 * `ticketNumber`, so that is the fallback, and the page reads the same as it
 * always did against it.
 */
export function ticketNumbersOf(
  log: { ticketNumbers?: unknown; ticketNumber?: unknown } | null | undefined,
): string[] {
  if (!log) return []
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v !== 'string') return
    const t = v.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  if (Array.isArray(log.ticketNumbers)) {
    log.ticketNumbers.forEach(add)
    if (out.length > 0) return out
  }
  add(log.ticketNumber)
  return out
}
