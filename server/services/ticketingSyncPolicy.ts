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

/** The subset of reconcileTwilioCallData's result that decides the outcome. */
export interface TwilioReconcileResult {
  success: boolean;
  actualDuration?: number;
  skipped?: boolean;
}

/**
 * Decide what a Twilio reconcile actually did to a call's duration.
 *
 * `success: true` on its own does not mean anything changed. reconcileTwilioCallData
 * has an "already reconciled" early exit that returns the row's *stored* duration
 * and sets no `skipped` flag, so a caller checking only `success && !skipped`
 * counts untouched rows as fixes — which is how the duration sweep came to log
 * `Fixed <id>: 597s → 597s` every cycle and recalculate costs that had not moved.
 * Comparing against the duration we started with is the only reliable signal.
 */
export function classifyDurationReconcile(
  previousDuration: number | null,
  result: TwilioReconcileResult
): "fixed" | "already-correct" | "no-data" {
  if (!result.success || result.skipped || !result.actualDuration) return "no-data";
  return result.actualDuration === previousDuration ? "already-correct" : "fixed";
}
