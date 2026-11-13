/**
 * EVERY TICKET A CALL CREATED, for the Observatory's call log (v223).
 *
 * Operator, 2026-11-13: "ensure any call on the observatory log has its
 * corresponding ticket number if one was created."
 *
 * `call_logs.ticket_number` is ONE column, and it already carries every
 * ticket filed under the call's own SID (426 of 426 tickets on 2026-11-11,
 * 493 of 493 calls 2026-11-12 08:00 UTC to 11-13 14:00 UTC). What it cannot
 * carry is a SECOND ticket: 15 calls in the 14 days to 2026-11-13 had two,
 * and the log showed one. Two shapes:
 *
 *   - PCP calls with a VA ticket and a PCP ticket (or two PCP tickets, one
 *     per patient, v98). The second number is already in the call's own
 *     `tool_timeline`, because the PCP filing tools report `ticketNumber`.
 *   - after-hours calls where the urgent transfer record was filed BESIDE the
 *     caller's request (`secondTicketOnThisCall`). That filing is not a tool
 *     and does not write back, so it was nowhere on the row until v223 put a
 *     `second_ticket_filed` event on the timeline (toolTimeline.ts).
 *
 * So the call's tickets are: the row's number first, then every
 * ticket-number-shaped value a filing reported in the timeline, in order,
 * each once.
 *
 * NOT FILTERED ON `success`, DELIBERATELY. Measured on the Hub, 14 days to
 * 2026-11-13: 198 `handoff_to_pcp` events answer `success: false` WITH a
 * ticket number (a failed or refused transfer that filed its pre-dial ticket
 * or fallback task), and 18 `escalate_to_human` events do the same (a refused
 * escalation that filed, v80). Those tickets exist; dropping them would hide
 * the very second tickets this is for. No event in the window carried a
 * top-level ticket number for a ticket that was not filed on the call.
 *
 * ONE TOOL IS EXCLUDED BY NAME: `check_open_tickets` READS tickets an earlier
 * call opened. Today it reports them nested (`open_tickets[]`), which the
 * timeline does not keep, so it never carries a top-level number — the
 * exclusion is there so a future change to its answer cannot make a ticket
 * this call did not create read as one it did.
 *
 * Pure and total: any shape in, an array out, never a throw — it runs on
 * every row the call-log API returns.
 */

/** A ticket number: the ticketing app's prefix, a hyphen, digits (VA-84162, PCP-78999, T-78690). */
export const TICKET_NUMBER = /^[A-Z]+-\d+$/;

/** Tools that report tickets they did not create. */
const READS_TICKETS = new Set(['check_open_tickets']);

/** The timeline as stored: a jsonb object, or (from some readers) its JSON text. */
function timelineEvents(raw: unknown): unknown[] {
  let tl: unknown = raw;
  if (typeof tl === 'string') {
    try {
      tl = JSON.parse(tl);
    } catch {
      return [];
    }
  }
  if (!tl || typeof tl !== 'object') return [];
  const events = (tl as { events?: unknown }).events;
  return Array.isArray(events) ? events : [];
}

function asTicket(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return TICKET_NUMBER.test(t) ? t : null;
}

export function ticketNumbersForCall(log: Record<string, unknown> | null | undefined): string[] {
  if (!log || typeof log !== 'object') return [];
  const out: string[] = [];
  const add = (t: string | null) => {
    if (t && !out.includes(t)) out.push(t);
  };

  // The row's own number first, whatever its shape: it is the call's ticket
  // of record, and the column has always been shown as written.
  const row = log.ticketNumber ?? log.ticket_number;
  if (typeof row === 'string' && row.trim()) add(row.trim());

  for (const event of timelineEvents(log.toolTimeline ?? log.tool_timeline)) {
    if (!event || typeof event !== 'object') continue;
    const { tool, outcome } = event as { tool?: unknown; outcome?: unknown };
    if (typeof tool === 'string' && READS_TICKETS.has(tool)) continue;
    if (!outcome || typeof outcome !== 'object') continue;
    const o = outcome as Record<string, unknown>;
    add(asTicket(o.ticket_number));
    add(asTicket(o.ticketNumber));
  }
  return out;
}

/**
 * A search term that is a whole ticket number, upper-cased, or null.
 *
 * The call-log search widens to the timeline ONLY for such a term, so an
 * ordinary name or phone search costs exactly what it did before.
 */
export function ticketSearchTerm(term: string | null | undefined): string | null {
  if (typeof term !== 'string') return null;
  const t = term.trim().toUpperCase();
  return TICKET_NUMBER.test(t) ? t : null;
}
