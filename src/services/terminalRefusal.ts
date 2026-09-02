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
 * WHY THIS IS ITS OWN MODULE. It was defined inside `durableTicketFiling`,
 * which meant the outbox worker — the OTHER place that sends the very same
 * payloads — had no notion of terminal at all and scheduled all twelve
 * retries against a permanent refusal. Codex found that on PR #244: a payload
 * queued during a transport outage, whose refusal only becomes visible once
 * the far side recovers, would burn ~3.5 hours of retries before
 * dead-lettering, and with fewer than three rows held it would delay the
 * filing alarm for exactly that long. Two senders, one rule.
 *
 * NAMED STATUSES, NOT A 4xx SWEEP — Codex again, the round after, and the
 * sweep was mine. "Any 4xx except 408 and 429" reads as a reasonable
 * generalisation and quietly includes **401 and 403**, which are not payload
 * refusals at all: they are the credential being wrong, and the identical
 * bytes succeed the moment it is right.
 *
 * That is not hypothetical here. Rotating the ticketing API key is an OPEN
 * task on this project (#40, the operator's own note of 2026-08-13). Under
 * the sweep, rotating it would have made `createTicketDurable` decline to
 * persist every new request and the outbox dead-letter every held one — the
 * exact loss this whole module exists to prevent, triggered by routine
 * maintenance.
 *
 * So the terminal set is enumerated from what create-ticket actually answers
 * when it has read a payload and refused it: 400 (all 664 refusals measured
 * over the 14 days to 2026-09-01) and 422, the other validation status the
 * API can return. Everything else — 401, 403, 404, 409, 429, 5xx, no status
 * at all — is held and retried. The asymmetry is deliberate: retrying a
 * hopeless request costs twelve attempts and a dead letter, while
 * dead-lettering a recoverable one costs a patient their request until
 * somebody replays it by hand.
 */
const PAYLOAD_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 422]);

export function isTerminalRefusal(status?: number): boolean {
  return typeof status === 'number' && PAYLOAD_REFUSAL_STATUSES.has(status);
}
