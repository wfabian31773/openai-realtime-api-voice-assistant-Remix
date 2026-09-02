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
// One-way edge: the registry does not import this module, the tools import both.
import { getTool } from '../tools/registry';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';

export interface DurableCreateResult extends CreateTicketResponse {
  /** The POST failed and the payload is now persisted; the worker owns it. */
  queued?: boolean;
  outboxId?: string;
  /** The server read the payload and refused it. Retrying changes nothing. */
  terminal?: boolean;
  /**
   * The field the server named, in the SERVER's vocabulary ("surgeon",
   * "office"). Translated to the invoking tool's own name in
   * `postFailureToolResult`, which is where the schema that decides is known.
   */
  missingField?: string;
}

/**
 * A REFUSAL IS NOT AN OUTAGE, and putting one in the outbox would be the worse
 * half of this module: it would fill with requests that can never send, trip
 * the filing alarm's outbox plane continuously, and tell the caller their
 * request was recorded when the server had refused it.
 *
 * The rule itself now lives in `./terminalRefusal`, because the outbox worker
 * re-sends these same payloads and needs the identical classification — see
 * that file.
 */
import { isTerminalRefusal } from './terminalRefusal';

/**
 * The ticketing app's hard-requires, mapped to whatever the INVOKING TOOL
 * actually calls that field.
 *
 * Found by Codex on PR #244, and production had already done it: `detectCrossQueue`
 * routes a request from optical, tech or records into Surgery, the API refuses it
 * with `Missing required information: surgeon` — and only `file_surgery_ticket`
 * has a `surgeon` property. The other three call the same person `provider`, and
 * every filing tool sets `additionalProperties: false`, so an agent told to
 * collect `surgeon` cannot put it anywhere. The caller answers the question and
 * the request still cannot be filed.
 *
 * It is not hypothetical: in the 14 days to 2026-09-01 optical took that refusal
 * on 2 calls (16 POSTs) and tech on 1.
 *
 * Candidates are in preference order and resolved against the tool's own schema.
 * `office` needs no alternatives — all four call it `location` — but it is listed
 * the same way so the next queue to be added is a data change, not a code change.
 */
const REMOTE_FIELD_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  surgeon: ['surgeon', 'provider'],
  office: ['location', 'office'],
  location: ['location', 'office'],
};

/**
 * The name THIS tool would accept for a field the server named, or undefined
 * when it has none — in which case the refusal stays a plain refusal rather
 * than sending the agent after something it cannot submit.
 */
function toolFieldFor(toolName: string | undefined, remoteField: string): string | undefined {
  if (!toolName) return undefined;
  const properties = getTool(toolName)?.input_schema.properties;
  if (!properties) return undefined;
  for (const candidate of REMOTE_FIELD_CANDIDATES[remoteField] ?? [remoteField]) {
    if (candidate in properties) return candidate;
  }
  return undefined;
}

/**
 * The tool's own wording for asking after a field.
 *
 * Read from the registry rather than copied, so the sentence the caller hears
 * when the ticketing app refuses is the same one they hear when our own gate
 * refuses. Returns undefined if the tool or field is unknown — a caller that
 * cannot be asked properly is better asked plainly than not at all.
 */
function askAsFor(toolName: string, field: string): string | undefined {
  const prop = getTool(toolName)?.input_schema.properties[field] as { askAs?: string } | undefined;
  return prop?.askAs;
}

/**
 * The field the SERVER named, in the server's own vocabulary. Translating it
 * happens later, in `postFailureToolResult`, because that is where the tool
 * whose schema decides the answer is known.
 */
export function missingFieldFromError(error?: string): string | undefined {
  const m = /missing required information:\s*([a-z_]+)/i.exec(error ?? '');
  if (!m) return undefined;
  const remote = m[1].toLowerCase();
  return remote in REMOTE_FIELD_CANDIDATES ? remote : undefined;
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

  if (isTerminalRefusal(res.statusCode)) {
    const missingField = missingFieldFromError(res.error);
    console.warn(
      `[TICKET FILING] ${agent}: create-ticket REFUSED the payload (HTTP ${res.statusCode}) — ` +
        `${res.error ?? 'no reason given'}. Not queued: retrying cannot change a refusal.`,
    );
    return { ...res, queued: false, terminal: true, missingField };
  }

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
export function postFailureToolResult(res: DurableCreateResult, toolName?: string) {
  /**
   * A refusal becomes a QUESTION, not a retry.
   *
   * The ticketing app enforces its own hard-requires — a surgery ticket needs
   * a surgeon, an optical ticket needs an office — and until now the agent was
   * told `retryable: true` and sent the same payload again. 602 POSTs across
   * 181 surgery calls in a fortnight, all identical, all refused.
   *
   * The wording comes from the tool's own `askAs`, so what the caller hears is
   * the sentence the library already teaches for that field rather than a
   * second one written here. Standing instruction 10 is why the fallback still
   * asks rather than deferring the caller.
   */
  if (res.terminal) {
    // The server's word for the field, translated into this tool's own — see
    // toolFieldFor. A field the tool has no property for is not askable, so it
    // falls through to the plain refusal below rather than sending the agent
    // after something `additionalProperties: false` will reject.
    const field = res.missingField ? toolFieldFor(toolName, res.missingField) : undefined;
    if (field) {
      const asked = askAsFor(toolName!, field);
      return {
        success: false as const,
        missingFields: [field],
        message: asked ?? `Can you tell me the ${field}?`,
      };
    }
    return {
      success: false as const,
      error: res.error ?? 'the ticketing system refused this request',
      // Deliberately NOT retryable: the server read it and said no.
      retryable: false,
    };
  }

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
