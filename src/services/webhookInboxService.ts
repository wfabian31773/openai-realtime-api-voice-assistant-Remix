import { db } from '../../server/db';
import { webhookEvents } from '../../shared/schema';
import { eq, sql, and, lte } from 'drizzle-orm';

class WebhookInboxService {
  async recordEvent(
    source: string,
    idempotencyKey: string,
    eventType: string | null,
    payload: any
  ): Promise<{ isNew: boolean; eventId: string }> {
    const result = await db
      .insert(webhookEvents)
      .values({
        source,
        idempotencyKey,
        eventType,
        payload,
        status: 'received',
      })
      .onConflictDoNothing({
        target: [webhookEvents.source, webhookEvents.idempotencyKey],
      })
      .returning({ id: webhookEvents.id });

    if (result.length > 0) {
      return { isNew: true, eventId: result[0].id };
    }

    const [existing] = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.source, source),
          eq(webhookEvents.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);

    return { isNew: false, eventId: existing?.id || '' };
  }

  async markProcessing(eventId: string): Promise<void> {
    await db
      .update(webhookEvents)
      .set({
        status: 'processing',
        updatedAt: new Date(),
      })
      .where(eq(webhookEvents.id, eventId));
  }

  async markCompleted(eventId: string): Promise<void> {
    await db
      .update(webhookEvents)
      .set({
        status: 'completed',
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(webhookEvents.id, eventId));
  }

  async markFailed(eventId: string, error: string): Promise<void> {
    const [event] = await db
      .select({
        retryCount: webhookEvents.retryCount,
        maxRetries: webhookEvents.maxRetries,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
      .limit(1);

    if (!event) return;

    const newRetryCount = event.retryCount + 1;
    const isDeadLetter = newRetryCount >= event.maxRetries;
    const backoffSeconds = Math.min(30 * Math.pow(2, event.retryCount), 900);
    const nextRetryAt = isDeadLetter
      ? null
      : new Date(Date.now() + backoffSeconds * 1000);

    await db
      .update(webhookEvents)
      .set({
        status: isDeadLetter ? 'dead_letter' : 'failed',
        retryCount: newRetryCount,
        lastError: error.substring(0, 2000),
        nextRetryAt,
        updatedAt: new Date(),
      })
      .where(eq(webhookEvents.id, eventId));
  }

  async getRetryableEvents() {
    return db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.status, 'failed'),
          lte(webhookEvents.nextRetryAt, new Date())
        )
      )
      .orderBy(webhookEvents.createdAt)
      .limit(50);
  }

  async getDeadLetterEvents(limit: number = 50) {
    return db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.status, 'dead_letter'))
      .orderBy(sql`${webhookEvents.createdAt} DESC`)
      .limit(limit);
  }

  async cleanupOldEvents(olderThanHours: number = 72): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const result = await db
      .delete(webhookEvents)
      .where(
        and(
          eq(webhookEvents.status, 'completed'),
          lte(webhookEvents.createdAt, cutoff)
        )
      )
      .returning({ id: webhookEvents.id });

    return result.length;
  }
}

export const webhookInboxService = new WebhookInboxService();
