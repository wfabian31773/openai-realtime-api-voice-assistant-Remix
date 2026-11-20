/**
 * Ticket priorities, ranked the way the ticketing app ranks them
 * (`TICKET_PRIORITIES`): an incoming priority only ever raises a ticket's
 * (`appendContactEntry`). Its own module, with no imports, so the suites that
 * replace the filing layer with a fake keep the real ranking.
 */
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';

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

/**
 * A BARE REPLAY SAYS NOTHING ABOUT PRIORITY (github-actions P1 on #504, head
 * `e84d94b7`). `cached: true` without `detailsAdded` is the app handing back a
 * ticket an earlier POST on the same key filed, and this payload's priority
 * never reached it. That earlier POST is usually this same payload (a timed-out
 * send that committed), but not always, so a bare replay reports no priority
 * and the caller is not told "urgent" on the strength of it. With
 * `detailsAdded` the app added this payload as a contact entry and raised the
 * ticket in the same transaction, so the payload is a floor again.
 *
 * Here, not in the filing layer, because the outbox records the same verdict
 * on the row it sends (`priorityUnconfirmed`), and a later filing on the call
 * reads it back from there (github-actions P1 on #504, head `5065f2d4`).
 */
export function bareReplay(res: Pick<CreateTicketResponse, 'cached' | 'detailsAdded'>): boolean {
  return res.cached === true && res.detailsAdded !== true;
}
