/**
 * WHAT HAPPENS TO A REQUEST WHEN THE POST FAILS.
 *
 * Until now: nothing. The four queue tools — optical, surgery, tech, records —
 * called `createTicket`, and on a failure returned `{ success: false,
 * retryable: true }`. The payload existed only in that closure, so the moment
 * the tool returned, the request the caller had just spent four minutes giving
 * us was gone. The agent apologised, or retried into the same outage, and
 * nothing anywhere held the ticket.
 *
 * That is not hypothetical. On 2026-08-31 the n8n gateway hit its monthly
 * execution cap at 20:16 UTC and answered every create-ticket with a 200 and a
 * non-JSON body until the URL was flipped the next morning. 286 filing attempts
 * were rejected; 107 distinct requests had to be reconstructed by hand from
 * call transcripts, and 24 of them still cannot be filed.
 *
 * `TicketOutboxService` already existed and already did the durable half of
 * this — it was written for the answering-service path and the queue tools were
 * never wired into it. This is that wiring, and it is deliberately thin: the
 * payload the tool built goes into the outbox exactly as it was going to be
 * POSTed, and comes back out exactly the same (see CREATE_TICKET_PAYLOAD_KIND).
 *
 * TWO THINGS THIS DOES NOT COVER, so nobody reads more into it than it does:
 *
 *  - A caller who hangs up before the filing tool runs at all. Nothing has the
 *    payload in that case, because it was never built. That is the teardown
 *    sweep, and it is a separate piece of work.
 *  - A dead letter. After twelve attempts over ~3.5 hours the entry stops
 *    retrying. The payload is still there and still replayable, but nothing
 *    pages anyone — that is #46, the "tickets filed = 0" alarm, and until it
 *    exists a long outage is still found by a human noticing.
 */
import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';

export interface DurableCreateResult extends CreateTicketResponse {
  /** The POST failed and the payload is now persisted; the worker owns it. */
  queued?: boolean;
  outboxId?: string;
}

/**
 * POST the ticket; if that fails, persist it verbatim before returning.
 *
 * Never throws — a filing tool that throws is a call that ends badly, and the
 * whole point of this function is to be the thing that does not lose the
 * request.
 */
export async function createTicketDurable(params: CreateTicketParams): Promise<DurableCreateResult> {
  const res = await ticketingApiClient.createTicket(params);
  if (res.success && res.ticketNumber) return res;

  const agent = params.callData?.agentUsed ?? 'unknown';

  /**
   * The outbox key IS the API idempotency key, deliberately.
   *
   * The tools set `idempotencyKey: call-<sid>` only when the sid is a real
   * Twilio CallSid — `isTwilioCallSid` refuses the sentinels ("unknown",
   * "latest") that a retry can carry. Deriving the outbox key from the same
   * field rather than from `callData.callSid` inherits that guard: a sentinel
   * would produce the key `call-unknown`, which is unique across the whole
   * table, so the SECOND caller to fail on a sentinel sid would hit
   * onConflictDoNothing and have their request silently dropped — this
   * function's exact failure mode, reintroduced by its own de-duplication.
   *
   * No key means an unkeyed row, which is right: it is still persisted, still
   * retried, and simply not deduplicated.
   */
  const keyedCallSid = params.idempotencyKey?.startsWith('call-')
    ? params.idempotencyKey.slice('call-'.length)
    : undefined;

  console.error(
    `[TICKET OUTBOX] ✗ create-ticket FAILED for ${agent} ` +
      `(dept ${params.departmentId}/${params.requestTypeId ?? 'none'}/${params.requestReasonId ?? 'none'}) — ` +
      `capturing the request. Cause: ${res.error ?? 'no ticket number returned'}`,
  );

  try {
    // Imported here, not at the top: this module is on the tool path, and the
    // outbox pulls in the database. Tests that never fail a POST must not need
    // a DATABASE_URL to file a ticket.
    const { TicketOutboxService, wrapCreateTicketPayload } = await import('./ticketOutboxService');
    const write = await TicketOutboxService.writeToOutbox(wrapCreateTicketPayload(params), keyedCallSid);

    // An earlier attempt on this same call may already have gone out — the
    // worker retries every 60s, and a caller repeating themselves can drive a
    // second tool call. Give the caller the number rather than a second ticket.
    if (write.alreadyExists && write.status === 'sent' && write.ticketNumber) {
      console.info(
        `[TICKET OUTBOX] ✓ ${agent} request ${write.outboxId} was already sent as ${write.ticketNumber}`,
      );
      return { success: true, ticketNumber: write.ticketNumber };
    }

    console.info(
      `[TICKET OUTBOX] ✓ CAPTURED ${agent} request as ${write.outboxId}` +
        `${write.alreadyExists ? ` (already held, status ${write.status})` : ''} — the worker will retry it`,
    );
    return { ...res, queued: true, outboxId: write.outboxId };
  } catch (err) {
    // Both the ticketing API and our own database are unreachable. There is
    // nowhere left to put this, and the only honest thing is to say so loudly
    // and let the tool refuse.
    console.error(
      `[TICKET OUTBOX] ✗✗ CAPTURE FAILED for ${agent} — the request is NOT persisted anywhere:`,
      err,
    );
    return { ...res, queued: false };
  }
}

/**
 * What the agent is told when the POST failed.
 *
 * Two outcomes, and the caller hears a different sentence for each, because
 * they are genuinely different situations.
 *
 * Standing instruction 10 — *"Nobody is told to call back"* — is why the queued
 * message does not offer that as the remedy. The request is taken; the ticket
 * number is the only thing missing, and it is not the caller's problem.
 *
 * There is no ticket number to read back, so the message says so explicitly.
 * A model handed "recorded" with no number will invent one if nothing stops it.
 */
export function postFailureToolResult(res: DurableCreateResult) {
  if (res.queued) {
    return {
      success: true as const,
      filed_pending: true,
      message:
        'Their request has been recorded and our team will follow up. Say that. ' +
        'There is no ticket number yet — do not read one back, do not invent one, ' +
        'and do not ask them to call back.',
    };
  }
  return {
    success: false as const,
    error: res.error ?? 'ticket creation failed',
    retryable: true,
  };
}
