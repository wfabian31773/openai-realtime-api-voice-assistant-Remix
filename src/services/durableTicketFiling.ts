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
import { loggableTicketingError } from './loggableTicketingError';
// One-way edge: the registry does not import this module, the tools import both.
import { getTool } from '../tools/registry';
import { createHash } from 'node:crypto';
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
  /** This call had already filed this ticket; the answer names that ticket. */
  alreadyFiled?: boolean;
  /** What happened to what the repeat carried — see `forwardRepeatFiling`. */
  addition?: RepeatAddition;
}

/**
 * - `added`: the ticketing app put this filing's details on the ticket.
 * - `nothing_new`: the same request as before, or an addition already sent.
 * - `not_confirmed`: sent or queued, and the app did not say it landed.
 */
export type RepeatAddition = 'added' | 'nothing_new' | 'not_confirmed';

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
 * A LATER FILING ON THE SAME CALL CARRIES SOMETHING, AND IT USED TO BE DROPPED.
 *
 * The outbox row for a call's key is `sent` once its ticket exists, and every
 * later filing on that call was answered from it — the first ticket's number,
 * with no POST — so whatever the later filing carried reached nobody. Measured
 * on the runtime, 2026-10-20..28, optical + surgery + tech + records: 254 calls
 * ran a second successful filing, 218 of them after the caller spoke again,
 * and in eight sampled calls the agent had told the caller it was adding
 * something (a second callback number, a pharmacy change, the doctor's name,
 * "can they also text?"). On the operator's pack-01 A1 test call
 * (`CAe121c3c176d626e8a679536788e58d63`) it was the office.
 *
 * Now a later filing that differs from what the row holds is sent on, through
 * the outbox under its own row (`<key>-add-<fingerprint>`, so a repeat of the
 * same addition is one row) but with the call's own idempotency key on the
 * payload, which is what makes the ticketing app treat it as the same
 * request: it adds the details to the ticket (ticketing-app #414) and says so
 * in `detailsAdded`. The same request again sends nothing.
 *
 * Never throws: the caller is told about the ticket that exists either way.
 */
export function filingFingerprint(p: CreateTicketParams): string {
  const canonical = JSON.stringify([
    (p.description ?? '').trim().replace(/\s+/g, ' '),
    (p.patientPhone ?? '').replace(/\D/g, '').slice(-10),
    p.priority ?? '',
    p.locationId ?? null,
    p.providerId ?? null,
    (p.locationOfLastVisit ?? '').trim().toLowerCase(),
    (p.lastProviderSeen ?? '').trim().toLowerCase(),
    p.preferredContactMethod ?? '',
    (p.patientEmail ?? '').trim().toLowerCase(),
    // Who the request is about, so a later filing that only adds a name or a
    // date of birth (the records lane can file unnamed first) is sent on, not
    // read as the same request (Codex P1 on #404).
    (p.patientFirstName ?? '').trim().toLowerCase(),
    (p.patientLastName ?? '').trim().toLowerCase(),
    [p.patientBirthYear, p.patientBirthMonth, p.patientBirthDay].map((x) => (x ?? '').trim()).join('-'),
    p.requestorType ?? '',
    p.requestPathway ?? '',
    p.capClockApplies ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

async function forwardRepeatFiling(
  params: CreateTicketParams,
  outboxKey: string,
  firstOutboxId: string,
): Promise<RepeatAddition> {
  try {
    const { TicketOutboxService, wrapCreateTicketPayload } = await import('./ticketOutboxService');
    const first = await TicketOutboxService.storedCreateParams(firstOutboxId);
    const fingerprint = filingFingerprint(params);
    if (first && filingFingerprint(first) === fingerprint) return 'nothing_new';

    const write = await TicketOutboxService.writeToOutbox(
      wrapCreateTicketPayload(params),
      `${outboxKey}-add-${fingerprint}`,
    );
    if (write.alreadyExists && write.status === 'sent') return 'nothing_new';

    const sent = await TicketOutboxService.attemptSend(write.outboxId, { liveCaller: true });
    if (sent.success && sent.detailsAdded === true) return 'added';
    if (sent.success && sent.cached === true && sent.detailsAdded === false) return 'nothing_new';
    console.info(
      `[TICKET OUTBOX] a later filing on this call was ${sent.success ? 'sent' : 'queued'} ` +
        'and the ticketing app did not confirm it reached the ticket',
    );
    return 'not_confirmed';
  } catch {
    console.error('[TICKET OUTBOX] a later filing on this call could not be persisted');
    return 'not_confirmed';
  }
}

/**
 * What a filing tool tells the model when the call had already filed. One
 * copy for the four queue tools. Spread LAST over the tool's success result,
 * so its `message` replaces the "read the ticket number back" line: the A1
 * agent, handed that line a second time, told the caller "that's the same
 * ticket" out loud.
 */
export function repeatFilingFields(res: DurableCreateResult, extraFix?: string): Record<string, unknown> {
  if (!res.alreadyFiled) return {};
  const fields = repeatFilingCopy(res);
  return extraFix ? { ...fields, fix: `${String(fields.fix)} ${extraFix}` } : fields;
}

/** The repeat-filing copy itself; `extraFix` is the calling tool's own addition. */
function repeatFilingCopy(res: DurableCreateResult): Record<string, unknown> {
  const n = res.ticketNumber;
  if (res.addition === 'added') {
    return {
      already_filed: true,
      details_added: true,
      message: `Added to ${n}.`,
      fix:
        `This was added to the request already filed on this call as ${n}. Tell the caller it is ` +
        'added to that same request. It is not a new ticket: do not read the number again unless ' +
        'they ask, and do not call it a second or new ticket.',
    };
  }
  if (res.addition === 'not_confirmed') {
    return {
      already_filed: true,
      details_added: false,
      message: `Already filed as ${n}.`,
      fix:
        `The request is filed as ${n}, but the ticket system did not confirm this addition reached ` +
        'the ticket. Do not say it was added to the ticket. You may say the team will see it in the ' +
        'record of this call. Do not file again.',
    };
  }
  return {
    already_filed: true,
    details_added: false,
    message: `Already filed as ${n}.`,
    fix:
      `This request was already filed on this call as ${n}, and the ticket system found nothing in ` +
      'this filing to add to it. Do not file ' +
      'it again, and do not tell the caller it is the same or a second ticket. If they have not ' +
      'heard the number yet, read it once; otherwise carry on with the call.',
  };
}

/**
 * Persist keyed filings before posting so the staff-only note can be restored
 * even if the process stops before call finalization. Unkeyed filings retain
 * the existing POST-first path because they cannot safely be deduplicated.
 *
 * Never throws — a filing tool that throws is a call that ends badly, and the
 * whole point of this function is to be the thing that does not lose the
 * request.
 */
export async function createTicketDurable(params: CreateTicketParams): Promise<DurableCreateResult> {
  const sid = params.callData?.callSid;
  const key = params.idempotencyKey;
  const scoped = sid && key && new RegExp(`^call-${sid}-p\\d{1,3}$`).test(key);
  if (sid && /^CA[0-9a-f]{32}$/i.test(sid) && key && (scoped || key === `call-${sid}`)) {
    let outboxId: string | undefined;
    try {
      const { TicketOutboxService, wrapCreateTicketPayload } = await import('./ticketOutboxService');
      const write = await TicketOutboxService.writeToOutbox(wrapCreateTicketPayload(params), key.slice(5));
      outboxId = write.outboxId;
      if (write.alreadyExists && write.status === 'sent' && write.ticketNumber) {
        const addition = await forwardRepeatFiling(params, key.slice(5), write.outboxId);
        return { success: true, ticketNumber: write.ticketNumber, alreadyFiled: true, addition };
      }
      const sent = await TicketOutboxService.attemptSend(write.outboxId, { liveCaller: true });
      if (sent.success && sent.ticketNumber) return sent;
      if (sent.terminal) return { ...sent, queued: false, missingField: missingFieldFromError(sent.error) };
      console.error(
        `[TICKET OUTBOX] Immediate filing failed: ${loggableTicketingError(sent.error, sent.statusCode)} — ` +
          'the persisted filing will be retried',
      );
      return { ...sent, queued: true };
    } catch {
      if (outboxId) {
        // The worker can reclaim a failed or interrupted send using this key.
        console.error('[TICKET OUTBOX] Immediate send failed; the persisted filing will be retried');
        return { success: false, queued: true, outboxId, error: 'ticket send unavailable' };
      }
      console.error('[TICKET OUTBOX] Could not persist the ticket before filing');
      return { success: false, queued: false, error: 'ticket persistence unavailable' };
    }
  }
  const res = await ticketingApiClient.createTicket(params);
  if (res.success && res.ticketNumber) {
    return res;
  }

  const agent = params.callData?.agentUsed ?? 'unknown';

  if (isTerminalRefusal(res.statusCode)) {
    const missingField = missingFieldFromError(res.error);
    // The app's refusal text is NOT printed: it can name the office on the
    // patient's record (`Location "<office>" not found`, v116 — Codex thread
    // PRRT_kwDORVukLs6vzaiN on #371). A missing FIELD name is safe and is the
    // part the console line is read for.
    const reason = missingField
      ? `missing ${missingField}`
      : res.error ? 'reason withheld (the app\'s text can name the patient\'s office)' : 'no reason given';
    console.warn(
      `[TICKET FILING] ${agent}: create-ticket REFUSED the payload (HTTP ${res.statusCode}) — ` +
        `${reason}. Not queued: retrying cannot change a refusal.`,
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
      `capturing the request. Cause: ${loggableTicketingError(res.error, res.statusCode)}`,
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
      // Never the app's own text: a tool result's `error` is printed by the
      // adapter (`[TOOLS] ← … error:`) and persisted by `tool_timeline`, and
      // the app's text can name the office on the patient's record
      // (v116 — Codex thread PRRT_kwDORVukLs6vzltO on #371).
      error: res.error
        ? loggableTicketingError(res.error, res.statusCode)
        : 'the ticketing system refused this request',
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
    // Same rule as the refusal above: the far side's text never becomes a
    // tool result.
    error: res.error ? loggableTicketingError(res.error, res.statusCode) : 'ticket creation failed',
    retryable: true,
  };
}
