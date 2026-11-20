/**
 * Ticket priorities, ranked the way the ticketing app ranks them
 * (`TICKET_PRIORITIES`): an incoming priority only ever raises a ticket's
 * (`appendContactEntry`). Its own module, with no imports, so the suites that
 * replace the filing layer with a fake keep the real ranking.
 */
import type { CreateTicketParams } from '../../server/services/ticketingApiClient';

export type TicketPriority = NonNullable<CreateTicketParams['priority']>;

const PRIORITY_RANK: Record<TicketPriority, number> = { low: 0, normal: 1, medium: 1, high: 2, urgent: 3 };

/** The higher of two priorities; undefined only when both are. */
export function higherPriority(
  a: TicketPriority | undefined,
  b: TicketPriority | undefined,
): TicketPriority | undefined {
  if (!a) return b;
  if (!b) return a;
  return PRIORITY_RANK[b] > PRIORITY_RANK[a] ? b : a;
}
