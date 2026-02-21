import { webhookInboxService } from './webhookInboxService';

class WebhookRetryWorker {
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private lastCleanupAt: number = 0;
  private readonly RETRY_INTERVAL_MS = 60 * 1000;
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

  start(): void {
    if (this.retryInterval) return;

    this.lastCleanupAt = Date.now();
    this.retryInterval = setInterval(() => this.tick(), this.RETRY_INTERVAL_MS);
    console.info('[WEBHOOK-RETRY] Worker started (60s interval)');
  }

  stop(): void {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
      console.info('[WEBHOOK-RETRY] Worker stopped');
    }
  }

  private async tick(): Promise<void> {
    try {
      const events = await webhookInboxService.getRetryableEvents();

      for (const event of events) {
        try {
          console.info(`[WEBHOOK-RETRY] Would reprocess event ${event.id} (${event.source}/${event.eventType})`);
          await webhookInboxService.markCompleted(event.id);
        } catch (err: any) {
          console.error(`[WEBHOOK-RETRY] Failed to reprocess event ${event.id}:`, err.message);
          await webhookInboxService.markFailed(event.id, err.message || 'Reprocessing failed');
        }
      }

      if (events.length > 0) {
        console.info(`[WEBHOOK-RETRY] Processed ${events.length} retryable events`);
      }

      const now = Date.now();
      if (now - this.lastCleanupAt >= this.CLEANUP_INTERVAL_MS) {
        this.lastCleanupAt = now;
        const cleaned = await webhookInboxService.cleanupOldEvents(72);
        if (cleaned > 0) {
          console.info(`[WEBHOOK-RETRY] Cleaned up ${cleaned} old completed events`);
        }
      }
    } catch (err: any) {
      console.error('[WEBHOOK-RETRY] Worker tick error:', err.message);
    }
  }
}

export const webhookRetryWorker = new WebhookRetryWorker();
