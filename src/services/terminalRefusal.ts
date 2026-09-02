/**
 * A REFUSAL IS NOT AN OUTAGE, wherever the POST happened to be made from.
 *
 * Measured over the 14 days to 2026-09-01, create-ticket answered 400 to 664
 * POSTs from the queue lines — a fifth of everything they sent. 602 of those
 * were one message, "Missing required information: surgeon", across 181
 * surgery calls: roughly three identical doomed POSTs per call, because the
 * tool reported `retryable: true` for every failure and the model obliged.
 *
 * The server read the payload and said no. Sending the identical bytes again
 * cannot change that answer, so a 4xx stops rather than retries.
 *
 * 408 and 429 are the exceptions and are treated as transport: the server is
 * saying "not now", which is precisely what retrying is for.
 *
 * WHY THIS IS ITS OWN MODULE. It was defined inside `durableTicketFiling`,
 * which meant the outbox worker — the OTHER place that sends the very same
 * payloads — had no notion of terminal at all and scheduled all twelve
 * retries against a permanent refusal. Codex found that on PR #244: a payload
 * queued during a transport outage, whose refusal only becomes visible once
 * the far side recovers, would burn ~3.5 hours of retries before
 * dead-lettering, and with fewer than three rows held it would delay the
 * filing alarm for exactly that long. Two senders, one rule.
 */
export function isTerminalRefusal(status?: number): boolean {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
