/**
 * server/services/ticketFilingPulse.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The last moment a ticket was ACTUALLY filed, recorded by the code that
 * filed it.
 *
 * WHY THIS EXISTS — 2026-09-03 18:24:56 UTC, the alarm emailed the operator
 * "TICKET FILING HAS STOPPED: 12 queue calls in a row have filed no ticket".
 * VA-57240's create-ticket POST had returned 200 at 18:24:15. The alarm
 * announced that filing had stopped forty-one seconds after a ticket was
 * filed.
 *
 * It was not lying about what it could see. `readTicketFilingSnapshot` reads
 * `call_logs.ticket_number`, and the write that sets it is deliberately
 * fire-and-forget:
 *
 *     void import('../storage').then(({ storage }) =>
 *       storage.releaseTicketCreationLock(sidForWriteback, response.ticketNumber))
 *
 * — a comment in `ticketingApiClient.createTicket` explains why, and it is
 * right: bookkeeping must never delay a filed ticket. But it means
 * `call_logs.ticket_number` lags the filing by an unbounded amount, and the
 * snapshot's `status = 'completed'` filter (correct on its own terms: a call
 * still on the line cannot have filed yet) hides the filing for as long as the
 * call runs. VA-57240 was filed mid-call by a call that did not end until
 * 18:24:57.
 *
 * So the alarm was inferring a system-wide negative — "filing has stopped" —
 * from one lagging, partial view, and it had no way to be told otherwise. This
 * module is the other way: a POSITIVE signal, written by the filing path at the
 * moment the API answers, that the alarm can weigh against its inference.
 *
 * DELIBERATELY IN MEMORY, not a table. The alarm and the API client run in the
 * same process, so a module-level timestamp is enough, and it cannot fail,
 * time out or need a migration. A restart clears it, and that degrades in the
 * safe direction: with no pulse the alarm behaves exactly as it does today and
 * still fires. It can suppress a real alarm only by being TOO RECENT, which
 * requires a ticket to have genuinely been filed.
 *
 * It records only that SOMETHING filed, never what. No call SID, no ticket
 * number, no patient — nothing here is PHI and nothing here should become PHI.
 */

let lastFiledAtMs: number | null = null;

/**
 * Called by every path that files a ticket, at the moment the ticketing API
 * confirms it. Cheap and synchronous by design: this runs on the filing path.
 */
export function noteTicketFiled(atMs: number = Date.now()): void {
  // Monotonic: a late-arriving older stamp must never walk the pulse
  // backwards, or a slow path could make filing look staler than it is.
  if (lastFiledAtMs === null || atMs > lastFiledAtMs) {
    lastFiledAtMs = atMs;
  }
}

/** The last confirmed filing, or null when none has happened in this process. */
export function lastTicketFiledAtMs(): number | null {
  return lastFiledAtMs;
}

/** Tests only. Never call this from the running system. */
export function resetTicketFilingPulse(): void {
  lastFiledAtMs = null;
}
