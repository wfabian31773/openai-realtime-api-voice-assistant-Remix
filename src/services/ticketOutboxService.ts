import { db } from '../../server/db';
import { callLogs, ticketOutbox } from '../../shared/schema';
import { eq, and, lte, or, isNull, sql, inArray } from 'drizzle-orm';
import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import { loggableTicketingError, loggableLookupError } from './loggableTicketingError';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';
import { getValidatedTicketIds } from '../config/answeringServiceTicketing';
import type { SyncAgentTicketParams } from './syncAgentService';
import { storage } from '../../server/storage';
import { bareReplay, type TicketPriority } from './ticketPriority';

const RETRY_BACKOFF_BASE_MS = 30_000;
/**
 * THE RETRY WINDOW HAS TO OUTLAST AN OUTAGE, or the outbox is just a log line.
 *
 * It was five retries on a pure doubling from 30s: 30s, 1m, 2m, 4m, 8m — dead
 * letter at 15 minutes. The outage on 2026-08-31 ran from 20:16 UTC until the
 * URL was flipped the next morning. Everything written during it would have
 * dead-lettered inside the first quarter hour and then sat there, which is the
 * same lost request with a row to prove it.
 *
 * Doubling to a 30-minute ceiling over twelve attempts covers about three and a
 * half hours unattended. That is not a whole night; a dead letter still holds
 * the full payload and is replayable by hand, and #46 (the "tickets filed = 0"
 * alarm) is what turns a long outage into a page rather than a discovery.
 */
const RETRY_BACKOFF_CAP_MS = 30 * 60_000;
const MAX_RETRIES = 12;
const WORKER_INTERVAL_MS = 60_000;
const SENDING_LEASE_TIMEOUT_MS = 120_000;

/**
 * WHAT THE OUTBOX HOLDS — two shapes, and the difference is load-bearing.
 *
 * - A bare `SyncAgentTicketParams`, which is every row written before
 *   2026-09-01. It is re-validated on the way out because the answering-service
 *   path never validated it on the way in.
 *
 * - `{ kind: 'create_ticket_v1', params }`, written by a queue tool whose
 *   payload was ALREADY validated against its own department's taxonomy. It is
 *   stored verbatim and sent verbatim.
 *
 * Re-validating the second shape would be actively wrong. `getValidatedTicketIds`
 * owns departments 1, 2, 3, 11 and 12 only, so an optical call that
 * `detectCrossQueue` routed to the HVA Hub (department 9) would go into the
 * outbox as a scheduling request and come out of it as a department 3
 * medication ticket — see the header of answeringServiceTicketing.test.ts.
 * The discriminator lives inside the jsonb payload rather than in a new column
 * so that no migration stands between this and a deploy.
 */
import { isTerminalRefusal, refusedFieldNamed } from './terminalRefusal';

export const CREATE_TICKET_PAYLOAD_KIND = 'create_ticket_v1';

/**
 * A DESCRIPTION TO SEND INSTEAD WHEN THE FAR SIDE REFUSES THE FIRST ONE.
 *
 * The teardown sweep files a request in the words read from the recording, and
 * when the app refuses that (a nameless records-line request whose sentence
 * reads as an appointment is routed out of Medical Records, and only Medical
 * Records takes a nameless request) the sweep files once more with the
 * placeholder, which the app never re-routes or re-refuses. That second try
 * runs only when the refusal comes back on the call's own POST. During an
 * outage the POST is held here instead, the recovered app refuses the replay,
 * and the row dead-lettered: the request was never filed (v205). So the
 * payload carries the description its filer would have tried next, and the
 * worker sends it once, on the same key, before giving up.
 *
 * It lives in the jsonb envelope, beside `params` and never inside it, so it
 * never reaches the wire and no migration stands between it and a deploy.
 */
export interface RefusalFallback {
  description?: string;
  /**
   * v279: an Optical or Surgery request held here may take the app's
   * unassigned exit if its replay is refused for the office or the surgeon.
   * See `routingFieldRefused`.
   */
  routingExit?: true;
}

/**
 * v279: A HELD OPTICAL OR SURGERY REQUEST REFUSED ON ITS REPLAY FOR THE OFFICE
 * OR THE SURGEON IS FILED UNASSIGNED, NOT LOST.
 *
 * The four queue tools persist their payload here before they POST it. When
 * that POST does not complete (a timeout, an outage, a 5xx), the tool tells the
 * caller the request is logged and the worker replays it later. Optical (1)
 * routes by office and Surgery (2) by surgeon, and create-ticket refuses either
 * with neither ("Missing required information: surgeon"). On the call that
 * refusal is a question the agent puts to the caller. On a replay nobody is
 * there to answer it, and the row dead-lettered with no ticket.
 *
 * MEASURED, Hub `ticket_outbox`, every row to 2026-11-26: 2 held requests were
 * refused on their replay for their routing field, both Surgery, both with no
 * ticket of any provenance (CAb7e38750f96288150a675729d1de0d57 on 2026-10-02,
 * CA9f2717c562f8f8d72675faf5e05a52ea on 2026-10-30). The other 5 dead letters
 * with a refusal status were refused on the call itself, where the tool asks.
 *
 * The exit is the app's own (`routingAskExhausted`, operator ruling
 * 2026-09-02, honoured for departments 1 and 2). The app still derives the
 * office or surgeon from the patient's record before it takes the exit, so the
 * flag can only turn this refusal into an unassigned ticket; it cannot cost a
 * routable ticket its routing. The teardown filers send the same flag for the
 * same reason (`TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS`, v92).
 *
 * Used only on the worker's replay, never on a send whose caller sees the
 * answer (`liveCaller`): there the refusal is the tool's ask (v81).
 */
export const ROUTING_FIELD_BY_DEPARTMENT: ReadonlyMap<number, { field: 'office' | 'surgeon'; refusedAs: readonly string[] }> =
  new Map([
    [1, { field: 'office', refusedAs: ['office', 'location'] }],
    [2, { field: 'surgeon', refusedAs: ['surgeon'] }],
  ]);

/** The routing field a refusal named, when it is this department's own. */
export function routingFieldRefused(departmentId: number | undefined, error?: string): 'office' | 'surgeon' | undefined {
  const routing = departmentId === undefined ? undefined : ROUTING_FIELD_BY_DEPARTMENT.get(departmentId);
  const named = refusedFieldNamed(error);
  return routing && named && routing.refusedAs.includes(named) ? routing.field : undefined;
}

/** Staff-only, on `callData.transcript`. Never the description, which is an SMS body. */
export function heldRoutingExitNote(field: 'office' | 'surgeon'): string {
  const which = field === 'surgeon' ? 'a surgeon' : 'an office';
  return (
    'HELD, THEN FILED UNASSIGNED: the ticket system did not take this request during the call ' +
    `(a timeout or an outage), so it was held and sent later. It was then refused for want of ${which}, ` +
    `and nobody was on the line to ask, so it was filed unassigned. Find the ${field} on the patient's ` +
    'chart or in the call recording.'
  );
}

/**
 * A first filing written by a build before v279 carries no
 * `refusalFallback.routingExit` (github-actions review of #533, on `5019b48`
 * and `1567c4a`). Only three writers put a `create_ticket_v1` row in the
 * outbox: `createTicketDurable`'s two first-filing paths, which since v279
 * always store the exit for a department that routes by a field, and
 * `forwardRepeatFiling`'s later additions (`<key>-add-<fingerprint>`), which
 * never take it. So a row whose key is not an addition's and which stored no
 * exit is a first filing from the build the deploy replaced, whenever it was
 * written: an old instance still running beside the new one during a deploy
 * included (github-actions review of #533, on `4fe1944`, which is why no
 * process-start cutoff is read). `afterRefusal` still needs everything else it
 * needs for the exit: a department that routes by a field, a payload that has
 * not taken it, a send nobody is on the line for, and a refusal naming that
 * field. Measured on the Hub: 0 rows pending, failed or sending at 13:48 and
 * 15:00 UTC on 2026-11-26.
 */
export function firstFilingWithoutTheExit(row: { payload?: unknown; idempotencyKey?: string | null }): boolean {
  if (!isCreateTicketPayload(row.payload)) return false;
  if (row.payload.refusalFallback?.routingExit === true) return false;
  return !(typeof row.idempotencyKey === 'string' && row.idempotencyKey.includes('-add-'));
}

/** A payload the routing exit can still help: its department routes by a field, and it has not taken the exit. */
function routingExitCanApply(params: CreateTicketParams): boolean {
  return ROUTING_FIELD_BY_DEPARTMENT.has(params.departmentId) && params.routingAskExhausted !== true;
}

function withRoutingExit(params: CreateTicketParams, field: 'office' | 'surgeon'): CreateTicketParams {
  const note = heldRoutingExitNote(field);
  const existing = params.callData?.transcript?.trim();
  return {
    ...params,
    routingAskExhausted: true,
    callData: { ...params.callData, transcript: existing ? `${existing}\n${note}` : note },
  };
}

export interface CreateTicketOutboxPayload {
  kind: typeof CREATE_TICKET_PAYLOAD_KIND;
  params: CreateTicketParams;
  refusalFallback?: RefusalFallback;
  /**
   * Written with `sent`: the app answered this row's send with a bare replay
   * (`bareReplay`), so the ticket is not known to hold `params.priority`. A
   * later filing on the call reads it through `storedFiling` (github-actions
   * P1 on #504, head `5065f2d4`). Absent on rows sent before v256, which read
   * as they always have.
   */
  priorityUnconfirmed?: boolean;
}

export type OutboxPayload = SyncAgentTicketParams | CreateTicketOutboxPayload;

export function wrapCreateTicketPayload(
  params: CreateTicketParams,
  refusalFallback?: { description?: string; routingExit?: boolean },
): CreateTicketOutboxPayload {
  const description = refusalFallback?.description?.trim() && refusalFallback.description !== params.description
    ? refusalFallback.description
    : undefined;
  const routingExit = refusalFallback?.routingExit === true && routingExitCanApply(params);
  const fallback: RefusalFallback = {
    ...(description ? { description } : {}),
    ...(routingExit ? { routingExit: true as const } : {}),
  };
  return { kind: CREATE_TICKET_PAYLOAD_KIND, params, ...(Object.keys(fallback).length ? { refusalFallback: fallback } : {}) };
}

/**
 * The payload to send after a refusal, when this one carries a fallback. One
 * more try at most: the payload returned carries no fallback, so a second
 * refusal dead-letters.
 */
export function afterRefusal(
  payload: unknown,
  refusal: { error?: string; liveCaller?: boolean; firstFilingWithoutTheExit?: boolean } = {},
): CreateTicketOutboxPayload | undefined {
  if (!isCreateTicketPayload(payload)) return undefined;
  const { params, refusalFallback } = payload;
  const routingExit = refusalFallback?.routingExit === true || refusal.firstFilingWithoutTheExit === true;
  if (routingExit && !refusal.liveCaller && routingExitCanApply(params)) {
    const field = routingFieldRefused(params.departmentId, refusal.error);
    if (field) return { kind: CREATE_TICKET_PAYLOAD_KIND, params: withRoutingExit(params, field) };
  }
  const description = refusalFallback?.description;
  if (!description?.trim() || description === params.description) return undefined;
  return { kind: CREATE_TICKET_PAYLOAD_KIND, params: { ...params, description } };
}

export function isCreateTicketPayload(payload: unknown): payload is CreateTicketOutboxPayload {
  const p = payload as CreateTicketOutboxPayload | null | undefined;
  return Boolean(p) && p?.kind === CREATE_TICKET_PAYLOAD_KIND && Boolean(p?.params);
}

interface OutboxWriteResult {
  outboxId: string;
  idempotencyKey?: string;
  alreadyExists: boolean;
  /** Set only on an idempotent hit, so a caller can tell a queued entry from one already sent. */
  status?: string;
  ticketNumber?: string;
  /**
   * This write REPLACED a dead-lettered payload and put the row back in the
   * queue. Only a dead letter is ever reopened — it filed nothing, so there is
   * no ticket to duplicate — and it is how a caller's correction reaches the
   * row the retry will actually send.
   */
  reopened?: boolean;
}

interface OutboxSendResult extends CreateTicketResponse {
  outboxId: string;
  /**
   * The far side READ the payload and refused it, so the row went straight to
   * dead_letter and NOTHING will retry it — found by Codex on PR #244.
   *
   * Without this the caller cannot tell a permanent refusal from a transport
   * failure, and `SyncAgentService` answered both with "your request has been
   * recorded and will be processed shortly". On a terminal refusal that is a
   * promise nothing can keep: no retry is scheduled and the identical payload
   * cannot succeed. That path carries the answering service, no-IVR and
   * after-hours — the line that takes every overnight call.
   */
  terminal?: boolean;
  /** The HTTP status behind a terminal refusal, for the caller's message. */
  statusCode?: number;
}

export class TicketOutboxService {
  private static workerTimer: ReturnType<typeof setInterval> | null = null;

  /** A terminal refusal proves the held payload did not file a ticket. */
  static async wasRefused(outboxId: string): Promise<boolean> {
    const [entry] = await db
      .select({ status: ticketOutbox.status, refusalStatusCode: ticketOutbox.refusalStatusCode })
      .from(ticketOutbox)
      .where(eq(ticketOutbox.id, outboxId))
      .limit(1);
    return entry?.status === 'dead_letter' && isTerminalRefusal(entry.refusalStatusCode ?? undefined);
  }

  static async writeToOutbox(
    params: OutboxPayload,
    callSid?: string,
    callLogId?: string,
  ): Promise<OutboxWriteResult> {
    const idempotencyKey = callSid ? `call-${callSid}` : undefined;

    if (idempotencyKey) {
      const [entry] = await db
        .insert(ticketOutbox)
        .values({
          callSid: callSid || null,
          callLogId: callLogId || null,
          idempotencyKey,
          payload: params as any,
          status: 'pending',
          maxRetries: MAX_RETRIES,
          nextRetryAt: new Date(),
        })
        .onConflictDoNothing({ target: ticketOutbox.idempotencyKey })
        .returning({ id: ticketOutbox.id });

      if (!entry) {
        const existing = await db
          .select({ id: ticketOutbox.id, ticketNumber: ticketOutbox.ticketNumber, status: ticketOutbox.status })
          .from(ticketOutbox)
          .where(eq(ticketOutbox.idempotencyKey, idempotencyKey))
          .limit(1);

        if (existing.length > 0) {
          /**
           * A DEAD LETTER MUST NOT HOLD THE KEY ITS OWN CORRECTION NEEDS —
           * Codex, PR #244 round twelve, and a consequence of round eleven.
           *
           * Round eleven made a terminal refusal honest: the caller is asked
           * for the field the API named instead of being told the request was
           * recorded. They answer, and the agent files again on the SAME
           * CallSid. That lands here — and `onConflictDoNothing` handed back
           * the refused row with its stale payload untouched. `attemptSend`
           * then declined to claim a `dead_letter` row and reported no
           * `terminal` flag, so the caller who had just supplied the missing
           * surgeon was told their request was recorded. Nothing was going to
           * send it.
           *
           * A dead letter filed NOTHING, which is exactly why replacing it is
           * safe: there is no ticket to duplicate. That is the whole difference
           * from a `sent` row, which must never be touched — that one really is
           * the duplicate this key exists to stop — and from `pending`,
           * `failed` and `sending`, which the worker still owns and whose
           * payload was never refused, only undelivered.
           *
           * The update is GUARDED on the status it read, so two writers cannot
           * both reopen: whoever loses falls through and reports the row as it
           * found it.
           */
          if (existing[0].status === 'dead_letter') {
            const reopenedAt = new Date();
            const reopened = await db
              .update(ticketOutbox)
              .set({
                payload: params as any,
                status: 'pending',
                retryCount: 0,
                lastError: null,
                refusalStatusCode: null,
                followupNotifiedAt: null,
                resolvedAt: null,
                resolvedBy: null,
                resolutionNote: null,
                nextRetryAt: reopenedAt,
                updatedAt: reopenedAt,
              })
              .where(
                and(eq(ticketOutbox.id, existing[0].id), eq(ticketOutbox.status, 'dead_letter')),
              )
              .returning({ id: ticketOutbox.id });

            if (reopened.length > 0) {
              console.info(
                `[TICKET OUTBOX] ↻ Reopened dead letter ${existing[0].id} with a corrected payload ` +
                  `(${idempotencyKey}) — the refused one filed nothing, so there is nothing to duplicate`,
              );
              return {
                outboxId: existing[0].id,
                idempotencyKey,
                alreadyExists: true,
                status: 'pending',
                reopened: true,
              };
            }
          }

          console.info(`[TICKET OUTBOX] Idempotent hit: ${idempotencyKey} → ${existing[0].id} (${existing[0].status})`);
          return {
            outboxId: existing[0].id,
            idempotencyKey,
            alreadyExists: true,
            status: existing[0].status,
            ticketNumber: existing[0].ticketNumber || undefined,
          };
        }
        throw new Error(`Conflict on idempotency key but entry not found: ${idempotencyKey}`);
      }

      console.info(`[TICKET OUTBOX] ✓ Persisted ticket payload: ${entry.id} (callSid=${callSid || 'none'})`);
      return { outboxId: entry.id, idempotencyKey, alreadyExists: false };
    }

    const [entry] = await db
      .insert(ticketOutbox)
      .values({
        callSid: callSid || null,
        callLogId: callLogId || null,
        idempotencyKey: null,
        payload: params as any,
        status: 'pending',
        maxRetries: MAX_RETRIES,
        nextRetryAt: new Date(),
      })
      .returning({ id: ticketOutbox.id });

    console.info(`[TICKET OUTBOX] ✓ Persisted ticket payload: ${entry.id} (no idempotency key)`);
    return { outboxId: entry.id, alreadyExists: false };
  }

  /**
   * The create-ticket parameters an outbox row holds, if it holds one, and the
   * priority the ticket is known to hold from it: the payload's own only when
   * the row's send was recorded as not a bare replay; none when it was, when
   * the row is not sent yet, or when it was sent before v256 and carries no
   * verdict.
   */
  static async storedFiling(
    outboxId: string,
  ): Promise<{ params?: CreateTicketParams; priority?: TicketPriority }> {
    const [row] = await db
      .select({ payload: ticketOutbox.payload })
      .from(ticketOutbox)
      .where(eq(ticketOutbox.id, outboxId))
      .limit(1);
    if (!row || !isCreateTicketPayload(row.payload)) return {};
    const { params, priorityUnconfirmed } = row.payload;
    // Only an explicit confirmation counts: a row sent before v256 carries no
    // flag, and its send may have been a bare replay (github-actions P2 on
    // #504, head `670eef2a`).
    return { params, priority: priorityUnconfirmed === false ? params.priority : undefined };
  }

  static async attemptSend(outboxId: string, options: { liveCaller?: boolean } = {}): Promise<OutboxSendResult> {
    /**
     * THE BACKOFF HAS TO BE PART OF THE CLAIM — Codex, PR #244.
     *
     * `processRetries` SELECTs the due rows and then sends them one at a time,
     * so the batch is a snapshot: by the time the loop reaches the fifth row,
     * another worker (or the previous interval, still running) may already
     * have failed it and pushed `nextRetryAt` half an hour out. This claim
     * accepted any `failed` row, so the stale selection posted again
     * immediately and burned a retry the backoff had just bought.
     *
     * Twelve attempts is the whole budget between a transport outage and a
     * dead letter. Spending them in the first minute is the difference between
     * surviving an outage and giving up during it.
     *
     * `isNull` is part of it: a `pending` row that has never failed carries no
     * `nextRetryAt` and must still be claimable.
     */
    const now = new Date();
    const dueNow = or(isNull(ticketOutbox.nextRetryAt), lte(ticketOutbox.nextRetryAt, now));

    const claimed = await db
      .update(ticketOutbox)
      .set({ status: 'sending', updatedAt: now })
      .where(
        and(
          eq(ticketOutbox.id, outboxId),
          or(
            and(eq(ticketOutbox.status, 'pending'), dueNow),
            and(eq(ticketOutbox.status, 'failed'), dueNow),
            and(
              eq(ticketOutbox.status, 'sending'),
              lte(ticketOutbox.updatedAt, new Date(Date.now() - SENDING_LEASE_TIMEOUT_MS)),
            ),
          ),
        ),
      )
      .returning();

    if (claimed.length === 0) {
      const [existing] = await db
        .select({ status: ticketOutbox.status, ticketNumber: ticketOutbox.ticketNumber })
        .from(ticketOutbox)
        .where(eq(ticketOutbox.id, outboxId))
        .limit(1);

      if (!existing) {
        return { success: false, error: 'Outbox entry not found', outboxId };
      }
      if (existing.status === 'sent') {
        return { success: true, ticketNumber: existing.ticketNumber || undefined, outboxId };
      }
      if (existing.status === 'dead_letter') {
        // Nothing will send this row, so it must never be reported as retrying —
        // that is precisely the false promise round eleven removed. The backstop
        // to the reopen in `writeToOutbox`, for any route that reaches a dead
        // letter anyway.
        return { success: false, error: 'Entry moved to dead letter', outboxId, terminal: true };
      }
      return { success: false, error: 'Entry already being processed by another worker', outboxId };
    }

    const entry = claimed[0];
    const stored = entry.payload as unknown;
    /**
     * Legacy payloads only. The verbatim shape is deliberately NOT coerced into
     * this type — nothing below may read a field off a queue payload, because
     * every one of those reads is a chance to rewrite a ticket its own queue
     * already got right.
     */
    const params = isCreateTicketPayload(stored) ? null : (stored as SyncAgentTicketParams);

    try {
      const response = isCreateTicketPayload(stored)
        ? await TicketOutboxService.sendVerbatim(stored, outboxId)
        : await TicketOutboxService.sendSyncAgentPayload(stored as SyncAgentTicketParams, outboxId);

      if (response.success && response.ticketNumber) {
        const now = new Date();
        const canonicalSid = isCreateTicketPayload(stored) ? stored.params.callData?.callSid : undefined;
        if (canonicalSid && /^CA[0-9a-f]{32}$/i.test(canonicalSid)) {
          // A retry can file after teardown and after an earlier sync. Make the
          // completed call eligible again before publishing the sent status.
          await db.update(callLogs).set({ callDataSynced: false, ticketingSyncRetries: 0 })
            .where(and(eq(callLogs.callSid, canonicalSid), eq(callLogs.status, 'completed')));
        }
        await db
          .update(ticketOutbox)
          .set({
            status: 'sent',
            ticketNumber: response.ticketNumber,
            externalTicketId: response.ticketId ?? null,
            ...(isCreateTicketPayload(stored)
              ? {
                  payload: {
                    ...stored,
                    consolidated: response.consolidated === true,
                    priorityUnconfirmed: bareReplay(response),
                  },
                }
              : {}),
            sentAt: now,
            updatedAt: now,
          })
          .where(eq(ticketOutbox.id, outboxId));

        console.info(`[TICKET OUTBOX] ✓ Sent: ${outboxId} → ${response.ticketNumber}`);

        // Update call log ticketing_synced flag
        const callSidForSync = canonicalSid || entry.callSid;
        const callLogIdForSync = entry.callLogId;
        const ticketNumberForSync = response.ticketNumber;
        setImmediate(async () => {
          try {
            if (callSidForSync) {
              await storage.releaseTicketCreationLock(callSidForSync, ticketNumberForSync);
              console.info(`[TICKET OUTBOX] ✓ ticketing_synced=true set for callSid ${callSidForSync}`);
            } else if (callLogIdForSync) {
              await storage.updateCallLog(callLogIdForSync, {
                ticketNumber: ticketNumberForSync,
                ticketingSynced: true,
                ticketingSyncedAt: now,
              });
              console.info(`[TICKET OUTBOX] ✓ ticketing_synced=true set for callLogId ${callLogIdForSync}`);
            } else {
              console.warn(`[TICKET OUTBOX] ⚠️ No callSid or callLogId — cannot update ticketing_synced for outboxId ${outboxId}`);
            }
          } catch (syncErr) {
            console.error(`[TICKET OUTBOX] ✗ Failed to update ticketing_synced for outboxId ${outboxId}:`, syncErr);
          }
        });

        // QVO ticket event — fire and forget, never blocks the outbox worker.
        //
        // Legacy payloads only, and that is not an oversight: emitTicketCreated
        // takes a SyncAgentTicketParams, and a queue ticket filed directly by
        // its tool emits no QVO event either. Emitting here and not there would
        // make the event stream a record of which POSTs happened to fail.
        const ticketNumForQvo = response.ticketNumber;
        const callLogIdForQvo = entry.callLogId;
        const paramsForQvo = params;
        if (paramsForQvo) {
          setImmediate(async () => {
            try {
              const { qvoEmitterService } = await import('./qvoEmitterService');
              await qvoEmitterService.emitTicketCreated(outboxId, callLogIdForQvo, paramsForQvo, ticketNumForQvo);
            } catch { /* never propagate */ }
          });
        }

        return { ...response, outboxId };
      }

      const error = response.error || 'API returned success=false with no ticket number';
      /**
       * THE FAR SIDE READ IT AND SAID NO — do not spend twelve retries on that.
       *
       * Found by Codex on PR #244. `createTicketDurable` already refuses to
       * queue a 4xx, but a payload can still be HOLDING a permanent refusal
       * here: it was captured during a transport outage (no status at all),
       * and only once the far side recovers does it answer "Missing required
       * information: surgeon". Retrying identical bytes cannot change that.
       *
       * Two costs, and the second is the one that matters. The row sat for
       * ~3.5 hours of backoff before dead-lettering; and while fewer than
       * three rows are held, the filing alarm's outbox plane stays quiet for
       * exactly that long — so the signal that would have named the problem
       * arrives after the outage it was built to catch.
       */
      if (isTerminalRefusal(response.statusCode)) {
        /**
         * ONE MORE TRY WITH THE FALLBACK, THEN THE DEAD LETTER (v205).
         *
         * Not a retry of the same bytes: the payload's own filer named the
         * description to send after a refusal (`RefusalFallback`), or, on an
         * Optical or Surgery request refused on the worker's replay for its
         * office or surgeon, the unassigned exit (v279). It replaces the stored
         * payload, which drops the fallback, so a second refusal dead-letters
         * as before. Guarded on `sending`, the claim this send holds. Same
         * idempotency key: the refusal stored none on the far side.
         */
        const next = afterRefusal(stored, {
          error,
          liveCaller: options.liveCaller,
          firstFilingWithoutTheExit: firstFilingWithoutTheExit(entry),
        });
        if (next) {
          // Field names only: the app's own text can name the patient's office (v116).
          const exit = next.params.routingAskExhausted === true && isCreateTicketPayload(stored)
            && stored.params.routingAskExhausted !== true
            ? routingFieldRefused(stored.params.departmentId, error)
            : undefined;
          console.warn(
            exit
              ? `[TICKET OUTBOX] ↻ REFUSED (HTTP ${response.statusCode}) for the ${exit} on a held request — ` +
                  `${outboxId} sending it once with the unassigned exit before dead-lettering (v279)`
              : `[TICKET OUTBOX] ↻ REFUSED (HTTP ${response.statusCode}) — ${outboxId} carries a fallback ` +
                  'description; sending it once with that before dead-lettering',
          );
          const reopened = await db
            .update(ticketOutbox)
            .set({ payload: next as any, status: 'pending', nextRetryAt: null, lastError: error, updatedAt: new Date() })
            .where(and(eq(ticketOutbox.id, outboxId), eq(ticketOutbox.status, 'sending')))
            .returning({ id: ticketOutbox.id });
          if (reopened.length > 0) return await TicketOutboxService.attemptSend(outboxId, options);
        }
        console.error(
          `[TICKET OUTBOX] ☠ REFUSED (HTTP ${response.statusCode}) — dead-lettering ${outboxId} ` +
            `without retrying: ${loggableTicketingError(error, response.statusCode)}`,
        );
        const refused = await TicketOutboxService.markFailed(
          outboxId,
          entry.retryCount,
          error,
          true,
          response.statusCode,
          options.liveCaller,
        );
        return { ...refused, statusCode: response.statusCode };
      }
      return await TicketOutboxService.markFailed(outboxId, entry.retryCount, error);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[TICKET OUTBOX] ✗ Send failed for ${outboxId}:`, loggableTicketingError(error));
      return await TicketOutboxService.markFailed(outboxId, entry.retryCount, error);
    }
  }

  /**
   * A QUEUE PAYLOAD GOES OUT EXACTLY AS IT CAME IN.
   *
   * No taxonomy validation, no provider/location lookup, no field mapping. The
   * tool that built this payload had the caller on the line, resolved the
   * office and the provider then, and picked the department — including a
   * cross-queue redirect. Re-deriving any of that here would file a different
   * ticket from the one the caller was promised.
   *
   * The idempotency key travels inside `params`, so a retry that lands after a
   * POST which actually succeeded is deduplicated by the ticketing app rather
   * than filed twice.
   */
  private static async sendVerbatim(
    payload: CreateTicketOutboxPayload,
    outboxId: string,
  ): Promise<CreateTicketResponse> {
    console.info(
      `[TICKET OUTBOX] Re-sending queue ticket verbatim: ${outboxId} ` +
        `(dept ${payload.params.departmentId}/${payload.params.requestTypeId ?? 'none'}/` +
        `${payload.params.requestReasonId ?? 'none'}, agent ${payload.params.callData?.agentUsed ?? 'unknown'})`,
    );
    return await ticketingApiClient.createTicket(payload.params);
  }

  /** The answering-service shape, which is validated and enriched on the way out. */
  private static async sendSyncAgentPayload(
    params: SyncAgentTicketParams,
    outboxId: string,
  ): Promise<CreateTicketResponse> {
    const validatedIds = getValidatedTicketIds(
      params.departmentId,
      params.requestTypeId,
      params.requestReasonId,
    );

    let resolvedProviderId: number | undefined;
    let resolvedLocationId: number | undefined;

    if (params.lastProviderSeen || params.locationOfLastVisit) {
      try {
        const lookupResult = await ticketingApiClient.lookupProviderAndLocation({
          providerName: params.lastProviderSeen || undefined,
          locationName: params.locationOfLastVisit || undefined,
        });
        // See syncAgentService's matching block. Skipping the ids is right;
        // doing it silently is not. On the outbox this matters more, not
        // less: a retry that lands during an outage files unrouted and the
        // entry is then marked sent, so nothing ever revisits it.
        const { lookupWasUnavailable } = await import('../../server/services/ticketingApiClient');
        if (lookupWasUnavailable(lookupResult)) {
          console.error(
            `[TICKET OUTBOX] ✗ PROVIDER/LOCATION LOOKUP UNAVAILABLE for ${outboxId} — ` +
              `filing unrouted. Cause: ${loggableLookupError(lookupResult)}`,
          );
        } else {
          resolvedProviderId = lookupResult.providerId ?? undefined;
          resolvedLocationId = lookupResult.locationId ?? undefined;
        }
      } catch (lookupErr) {
        console.warn(`[TICKET OUTBOX] Provider/location lookup failed for ${outboxId}:`, lookupErr);
      }
    }

    return await ticketingApiClient.createTicket({
      departmentId: validatedIds.departmentId,
      requestTypeId: validatedIds.requestTypeId,
      requestReasonId: validatedIds.requestReasonId,
      patientFirstName: params.patientFirstName,
      patientLastName: params.patientLastName,
      patientPhone: params.patientPhone,
      patientEmail: params.patientEmail ?? undefined,
      preferredContactMethod: params.preferredContactMethod ?? undefined,
      lastProviderSeen: params.lastProviderSeen ?? undefined,
      locationOfLastVisit: params.locationOfLastVisit ?? undefined,
      locationSource: params.locationSource,
      locationIdSource: params.locationSource,
      patientBirthMonth: params.patientBirthMonth ?? undefined,
      patientBirthDay: params.patientBirthDay ?? undefined,
      patientBirthYear: params.patientBirthYear ?? undefined,
      locationId: resolvedLocationId ?? undefined,
      providerId: resolvedProviderId ?? undefined,
      description: params.description,
      priority: params.priority ?? 'medium',
      callData: params.callData ? {
        callSid: params.callData.callSid,
        recordingUrl: params.callData.recordingUrl,
        transcript: params.callData.transcript,
        callerPhone: params.callData.callerPhone,
        dialedNumber: params.callData.dialedNumber,
        agentUsed: params.callData.agentUsed,
        callStartTime: params.callData.callStartTime,
        callEndTime: params.callData.callEndTime,
        callDurationSeconds: params.callData.callDurationSeconds,
        humanHandoffOccurred: params.callData.humanHandoffOccurred,
        qualityScore: params.callData.qualityScore,
        patientSentiment: params.callData.patientSentiment,
        agentOutcome: params.callData.agentOutcome,
      } : undefined,
    });

  }

  private static async markFailed(
    outboxId: string,
    currentRetryCount: number,
    error: string,
    /** The server refused the payload itself. Retrying cannot change that, so
     *  it goes straight to dead_letter regardless of attempts remaining. */
    terminal = false,
    /** HTTP status behind a terminal refusal. Persisted so the alarm can
     *  tell a 400 from a transport dead letter without reading last_error. */
    statusCode?: number,
    liveCaller = false,
  ): Promise<OutboxSendResult> {
    const newRetryCount = currentRetryCount + 1;
    const isDeadLetter = terminal || newRetryCount >= MAX_RETRIES;
    const nextRetryAt = isDeadLetter
      ? null
      : new Date(
          Date.now() +
            Math.min(RETRY_BACKOFF_BASE_MS * Math.pow(2, newRetryCount - 1), RETRY_BACKOFF_CAP_MS),
        );
    const persistedRefusal =
      terminal && isTerminalRefusal(statusCode) ? statusCode : undefined;

    await db
      .update(ticketOutbox)
      .set({
        status: isDeadLetter ? 'dead_letter' : 'failed',
        retryCount: newRetryCount,
        lastError: error,
        ...(persistedRefusal !== undefined ? { refusalStatusCode: persistedRefusal } : {}),
        // A live tool returns the refusal to the caller for correction. Only a
        // worker's unattended refusal needs a follow-up notice and alarm.
        ...(terminal && liveCaller ? { resolvedAt: new Date() } : {}),
        nextRetryAt,
        updatedAt: new Date(),
      })
      .where(eq(ticketOutbox.id, outboxId));

    if (isDeadLetter && !terminal) {
      console.error(`[TICKET OUTBOX] ☠ Dead letter after ${MAX_RETRIES} retries: ${outboxId} - ${loggableTicketingError(error)}`);
    } else if (isDeadLetter) {
      // The refusal was already logged with its status at the call site.
    } else {
      console.warn(`[TICKET OUTBOX] Retry ${newRetryCount}/${MAX_RETRIES} scheduled for ${outboxId} at ${nextRetryAt?.toISOString()}`);
    }

    // `terminal` travels with the result: a dead letter reached by refusal is a
    // different fact from one reached by exhausting twelve retries, and only
    // the caller still holding the line can act on it.
    return { success: false, error, outboxId, terminal: terminal || undefined };
  }

  static async processRetries(): Promise<number> {
    const now = new Date();
    const leaseExpiry = new Date(Date.now() - SENDING_LEASE_TIMEOUT_MS);

    /**
     * SELECT the due rows. Do NOT claim them here.
     *
     * Found by Codex on PR #244, and it means this worker has never re-sent
     * anything. It used to `update ... set status='sending', updatedAt=now`
     * and then call `attemptSend`, whose own claim takes only `pending`,
     * `failed`, or a `sending` row whose two-minute lease has expired. A row
     * this function had just marked `sending` with a fresh lease matched none
     * of those, so every entry came back "already being processed by another
     * worker" — and on the next tick this function refreshed the lease and did
     * it again. Rows sat in `sending` for ever.
     *
     * The production table agrees: 36 rows, all `sent`, newest 2026-08-22, and
     * every one of them was sent by syncAgentService calling `attemptSend`
     * directly on a fresh row. Nothing has ever left here through the worker.
     *
     * That was survivable while only the answering-service path wrote to the
     * outbox and sent inline. It is not survivable now the queue tools depend
     * on this worker to send what a failed POST left behind.
     *
     * `attemptSend` is the single atomic claimer and stays that way — its
     * UPDATE...WHERE is what makes two workers safe. This function's job is
     * only to say which rows are due.
     */
    const due = await db
      .select({ id: ticketOutbox.id })
      .from(ticketOutbox)
      .where(
        and(
          or(
            eq(ticketOutbox.status, 'pending'),
            eq(ticketOutbox.status, 'failed'),
            and(
              eq(ticketOutbox.status, 'sending'),
              lte(ticketOutbox.updatedAt, leaseExpiry),
            ),
          ),
          or(
            isNull(ticketOutbox.nextRetryAt),
            lte(ticketOutbox.nextRetryAt, now),
          ),
        ),
      );

    if (due.length === 0) return 0;

    console.info(`[TICKET OUTBOX] ${due.length} entr(ies) due for retry`);
    let successCount = 0;

    for (const entry of due) {
      const result = await TicketOutboxService.attemptSend(entry.id);
      if (result.success) successCount++;
    }

    console.info(`[TICKET OUTBOX] Retry batch complete: ${successCount}/${due.length} succeeded`);
    return successCount;
  }

  static startWorker(): void {
    if (TicketOutboxService.workerTimer) {
      console.info('[TICKET OUTBOX] Worker already running');
      return;
    }

    // DEPLOY MARKER. A failed pull looks exactly like a failed fix (CLAUDE.md),
    // and everything this build changed about the outbox is invisible until a
    // POST fails — which is rare, and not something to go and cause. This line
    // prints once at boot and names the policy, so "is the outbox build live?"
    // is answerable without waiting for an outage.
    console.info(
      `[TICKET OUTBOX] Starting retry worker (every ${WORKER_INTERVAL_MS / 1000}s; ` +
        `up to ${MAX_RETRIES} attempts, backoff ${RETRY_BACKOFF_BASE_MS / 1000}s → ` +
        `${RETRY_BACKOFF_CAP_MS / 60_000}m; queue payloads re-sent verbatim; ` +
        `a 400/422 writes refusal_status_code)`,
    );
    TicketOutboxService.workerTimer = setInterval(async () => {
      try {
        await TicketOutboxService.processRetries();
      } catch (err) {
        console.error('[TICKET OUTBOX] Worker error:', err);
      }
    }, WORKER_INTERVAL_MS);
  }

  static stopWorker(): void {
    if (TicketOutboxService.workerTimer) {
      clearInterval(TicketOutboxService.workerTimer);
      TicketOutboxService.workerTimer = null;
      console.info('[TICKET OUTBOX] Worker stopped');
    }
  }

  static async getStats(): Promise<{
    pending: number;
    sending: number;
    sent: number;
    failed: number;
    deadLetter: number;
  }> {
    const result = await db
      .select({
        status: ticketOutbox.status,
        count: sql<number>`count(*)::int`,
      })
      .from(ticketOutbox)
      .groupBy(ticketOutbox.status);

    const stats = { pending: 0, sending: 0, sent: 0, failed: 0, deadLetter: 0 };
    for (const row of result) {
      if (row.status === 'pending') stats.pending = row.count;
      else if (row.status === 'sending') stats.sending = row.count;
      else if (row.status === 'sent') stats.sent = row.count;
      else if (row.status === 'failed') stats.failed = row.count;
      else if (row.status === 'dead_letter') stats.deadLetter = row.count;
    }
    return stats;
  }
}
