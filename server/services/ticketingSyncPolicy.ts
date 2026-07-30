// A 404 "No ticket found" from update-call-data is deterministic: the call
// never created a ticket (info-only calls, hangups, abandoned intakes), so
// retrying can never succeed. Before 2026-07-30 every such call burned all 3
// retries and landed in the error state (~372 calls/day, >1000 doomed API
// calls) — drowning out the real failures. The grace window below covers the
// one legitimate race: outbox-based ticket creation finishing after call end.
export const NO_TICKET_GRACE_MS = 15 * 60 * 1000;
export const NO_TICKET_TERMINAL_PREFIX = "NO_TICKET (terminal, not retried)";

export function isNoTicketError(errorMsg: string): boolean {
  return /no ticket found with (callsid|ticketnumber)/i.test(errorMsg);
}

/**
 * Decide how to handle a 404 no-ticket response for a call. Calls with an
 * unknown end time are treated as past the grace window — they are old rows
 * being re-swept, not fresh completions.
 */
export function classifyNoTicketOutcome(
  callEndedAt: Date | null,
  now: number = Date.now()
): "terminal" | "grace" {
  if (!callEndedAt) return "terminal";
  return now - callEndedAt.getTime() > NO_TICKET_GRACE_MS ? "terminal" : "grace";
}
