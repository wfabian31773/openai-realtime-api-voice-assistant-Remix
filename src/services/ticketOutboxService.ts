import { db } from '../../server/db';
import { ticketOutbox } from '../../shared/schema';
import { eq, and, lte, or, isNull, sql, inArray } from 'drizzle-orm';
import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import { getValidatedTicketIds } from '../config/answeringServiceTicketing';
import type { SyncAgentTicketParams } from './syncAgentService';

const RETRY_BACKOFF_BASE_MS = 30_000;
const MAX_RETRIES = 5;
const WORKER_INTERVAL_MS = 60_000;
const SENDING_LEASE_TIMEOUT_MS = 120_000;

interface OutboxWriteResult {
  outboxId: string;
  idempotencyKey?: string;
  alreadyExists: boolean;
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
    params: SyncAgentTicketParams,
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
          return { outboxId: existing[0].id, idempotencyKey, alreadyExists: true };
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
    const claimed = await db
      .update(ticketOutbox)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(
        and(
          eq(ticketOutbox.id, outboxId),
          or(
            eq(ticketOutbox.status, 'pending'),
            eq(ticketOutbox.status, 'failed'),
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
    const params = entry.payload as SyncAgentTicketParams;

    try {
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
          if (lookupResult.success) {
            resolvedProviderId = lookupResult.providerId ?? undefined;
            resolvedLocationId = lookupResult.locationId ?? undefined;
          }
        } catch (lookupErr) {
          console.warn(`[TICKET OUTBOX] Provider/location lookup failed for ${outboxId}:`, lookupErr);
        }
      }

      const response = await ticketingApiClient.createTicket({
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

      if (response.success && response.ticketNumber) {
        await db
          .update(ticketOutbox)
          .set({
            status: 'sent',
            ticketNumber: response.ticketNumber,
            externalTicketId: response.ticketId ?? null,
            sentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(ticketOutbox.id, outboxId));

        console.info(`[TICKET OUTBOX] ✓ Sent: ${outboxId} → ${response.ticketNumber}`);
        return { success: true, ticketNumber: response.ticketNumber, outboxId };
      }

      const error = response.error || 'API returned success=false with no ticket number';
      return await TicketOutboxService.markFailed(outboxId, entry.retryCount, error);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[TICKET OUTBOX] ✗ Send failed for ${outboxId}:`, error);
      return await TicketOutboxService.markFailed(outboxId, entry.retryCount, error);
    }
  }

  private static async markFailed(
    outboxId: string,
    currentRetryCount: number,
    error: string,
  ): Promise<OutboxSendResult> {
    const newRetryCount = currentRetryCount + 1;
    const isDeadLetter = newRetryCount >= MAX_RETRIES;
    const nextRetryAt = isDeadLetter
      ? null
      : new Date(Date.now() + RETRY_BACKOFF_BASE_MS * Math.pow(2, newRetryCount - 1));

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

    if (isDeadLetter) {
      console.error(`[TICKET OUTBOX] ☠ Dead letter after ${MAX_RETRIES} retries: ${outboxId} - ${error}`);
    } else {
      console.warn(`[TICKET OUTBOX] Retry ${newRetryCount}/${MAX_RETRIES} scheduled for ${outboxId} at ${nextRetryAt?.toISOString()}`);
    }

    return { success: false, error, outboxId };
  }

  static async processRetries(): Promise<number> {
    const now = new Date();
    const leaseExpiry = new Date(Date.now() - SENDING_LEASE_TIMEOUT_MS);

    const claimed = await db
      .update(ticketOutbox)
      .set({ status: 'sending', updatedAt: now })
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
      )
      .returning({ id: ticketOutbox.id, retryCount: ticketOutbox.retryCount, payload: ticketOutbox.payload });

    if (claimed.length === 0) return 0;

    console.info(`[TICKET OUTBOX] Claimed ${claimed.length} entries for retry`);
    let successCount = 0;

    for (const entry of claimed) {
      const result = await TicketOutboxService.attemptSend(entry.id);
      if (result.success) successCount++;
    }

    console.info(`[TICKET OUTBOX] Retry batch complete: ${successCount}/${claimed.length} succeeded`);
    return successCount;
  }

  static startWorker(): void {
    if (TicketOutboxService.workerTimer) {
      console.info('[TICKET OUTBOX] Worker already running');
      return;
    }

    console.info(`[TICKET OUTBOX] Starting retry worker (every ${WORKER_INTERVAL_MS / 1000}s)`);
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
