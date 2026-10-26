/**
 * Auth and log shape for /api/campaigns/ticket-resolved.
 *
 * The compare is constant-time. The log is ticket id, ticket number and
 * contact method only — no names, phones, emails or notes.
 */

import { ticketResolvedLogFields } from "./phi";
import { timingSafeEqualSecret } from "./timingSafe";

export function ticketResolvedAuthorized(
  provided: unknown,
  expected: string | undefined,
): boolean {
  const header = Array.isArray(provided) ? provided[0] : provided;
  return timingSafeEqualSecret(header, expected);
}

export function ticketResolvedLogPayload(input: {
  ticketId?: unknown;
  ticketNumber?: unknown;
  preferredContactMethod?: unknown;
}): Record<string, unknown> {
  return ticketResolvedLogFields(input);
}
