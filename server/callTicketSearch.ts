/**
 * THE CALL-LOG SEARCH FINDS A CALL BY ITS SECOND TICKET (v223).
 *
 * The search box matched `call_logs.ticket_number` only, so a call whose
 * second ticket is the one a staffer holds (callTicketNumbers.ts) could not
 * be found by it. When the term is a whole ticket number, the search also
 * asks whether the call's tool timeline reports that number from a filing.
 *
 * KEPT CHEAP, DELIBERATELY: the condition is added only for a term shaped
 * like a ticket number, so a name or phone search runs the query it always
 * ran. It is an exact jsonb containment on one outcome field, never a text
 * scan of the timeline, so a term can only match a ticket number, never a
 * word inside some other field. It does not exclude `check_open_tickets`
 * as the display does, because that tool reports the tickets it reads nested
 * (`open_tickets[]`), which the timeline does not keep, so it cannot match.
 */
import { sql, type SQL } from 'drizzle-orm';
import { callLogs } from '../shared/schema';
import { ticketSearchTerm } from './callTicketNumbers';

export function timelineHoldsTicket(term: string | null | undefined): SQL | null {
  const ticket = ticketSearchTerm(term);
  if (!ticket) return null;
  const snake = JSON.stringify({ events: [{ outcome: { ticket_number: ticket } }] });
  const camel = JSON.stringify({ events: [{ outcome: { ticketNumber: ticket } }] });
  return sql`(${callLogs.toolTimeline} @> ${snake}::jsonb OR ${callLogs.toolTimeline} @> ${camel}::jsonb)`;
}
