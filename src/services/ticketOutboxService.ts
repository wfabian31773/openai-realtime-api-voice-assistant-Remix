import { db } from '../../server/db';
import { ticketOutbox } from '../../shared/schema';
import { eq, and, lte, or, isNull, sql, inArray } from 'drizzle-orm';
import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';
import { getValidatedTicketIds } from '../config/answeringServiceTicketing';
import type { SyncAgentTicketParams } from './syncAgentService';
import { storage } from '../../server/storage';

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
import { isTerminalRefusal } from './terminalRefusal';

export const CREATE_TICKET_PAYLOAD_KIND = 'create_ticket_v1';

export interface CreateTicketOutboxPayload {
  kind: typeof CREATE_TICKET_PAYLOAD_KIND;
  params: CreateTicketParams;
}

export type OutboxPayload = SyncAgentTicketParams | CreateTicketOutboxPayload;

export function wrapCreateTicketPayload(params: CreateTicketParams): CreateTicketOutboxPayload {
  return { kind: CREATE_TICKET_PAYLOAD_KIND, params };
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
}

interface OutboxSendResult {
  success: boolean;
  ticketNumber?: string;
  error?: string;
  outboxId: string;
}

export class TicketOutboxService {
  private static workerTimer: ReturnType<typeof setInterval> | null = null;

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

  static async attemptSend(outboxId: string): Promise<OutboxSendResult> {
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
        return { success: false, error: 'Entry moved to dead letter', outboxId };
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
        await db
          .update(ticketOutbox)
          .set({
            status: 'sent',
            ticketNumber: response.ticketNumber,
            externalTicketId: response.ticketId ?? null,
            sentAt: now,
            updatedAt: now,
          })
          .where(eq(ticketOutbox.id, outboxId));

        console.info(`[TICKET OUTBOX] ✓ Sent: ${outboxId} → ${response.ticketNumber}`);

        // Update call log ticketing_synced flag
        const callSidForSync = entry.callSid;
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

        return { success: true, ticketNumber: response.ticketNumber, outboxId };
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
        console.error(
          `[TICKET OUTBOX] ☠ REFUSED (HTTP ${response.statusCode}) — dead-lettering ${outboxId} ` +
            `without retrying: ${error}`,
        );
        return await TicketOutboxService.markFailed(outboxId, entry.retryCount, error, true);
      }
      return await TicketOutboxService.markFailed(outboxId, entry.retryCount, error);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[TICKET OUTBOX] ✗ Send failed for ${outboxId}:`, error);
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
              `filing unrouted. Cause: ${lookupResult.error ?? 'unknown'}`,
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
  ): Promise<OutboxSendResult> {
    const newRetryCount = currentRetryCount + 1;
    const isDeadLetter = terminal || newRetryCount >= MAX_RETRIES;
    const nextRetryAt = isDeadLetter
      ? null
      : new Date(
          Date.now() +
            Math.min(RETRY_BACKOFF_BASE_MS * Math.pow(2, newRetryCount - 1), RETRY_BACKOFF_CAP_MS),
        );

    await db
      .update(ticketOutbox)
      .set({
        status: isDeadLetter ? 'dead_letter' : 'failed',
        retryCount: newRetryCount,
        lastError: error,
        nextRetryAt,
        updatedAt: new Date(),
      })
      .where(eq(ticketOutbox.id, outboxId));

    if (isDeadLetter && !terminal) {
      console.error(`[TICKET OUTBOX] ☠ Dead letter after ${MAX_RETRIES} retries: ${outboxId} - ${error}`);
    } else if (isDeadLetter) {
      // The refusal was already logged with its status at the call site.
    } else {
      console.warn(`[TICKET OUTBOX] Retry ${newRetryCount}/${MAX_RETRIES} scheduled for ${outboxId} at ${nextRetryAt?.toISOString()}`);
    }

    return { success: false, error, outboxId };
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
        `${RETRY_BACKOFF_CAP_MS / 60_000}m; queue payloads re-sent verbatim)`,
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
