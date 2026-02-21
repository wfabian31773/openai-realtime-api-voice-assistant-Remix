import { db } from '../../server/db';
import { sql } from 'drizzle-orm';

interface RetentionConfig {
  transcriptRetentionDays: number;
  graderEvidenceRetentionDays: number;
  webhookEventRetentionDays: number;
  purgeIntervalHours: number;
  batchSize: number;
}

const DEFAULT_RETENTION: RetentionConfig = {
  transcriptRetentionDays: 365,
  graderEvidenceRetentionDays: 180,
  webhookEventRetentionDays: 30,
  purgeIntervalHours: 24,
  batchSize: 100,
};

class RetentionPolicyService {
  private config: RetentionConfig;
  private purgeInterval: NodeJS.Timeout | null = null;
  private lastPurgeTime: Date | null = null;

  constructor(config: Partial<RetentionConfig> = {}) {
    this.config = { ...DEFAULT_RETENTION, ...config };
  }

  async purgeExpiredTranscripts(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.transcriptRetentionDays);

    const result = await db.execute(sql`
      UPDATE call_logs 
      SET transcript = NULL, updated_at = NOW()
      WHERE id IN (
        SELECT id FROM call_logs
        WHERE created_at < ${cutoff}
        AND transcript IS NOT NULL
        LIMIT ${this.config.batchSize}
      )
    `);

    const count = (result as any).rowCount || 0;
    if (count > 0) {
      console.info(`[RETENTION] Purged ${count} expired transcripts (older than ${this.config.transcriptRetentionDays} days)`);
    }
    return count;
  }

  async purgeExpiredGraderEvidence(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.graderEvidenceRetentionDays);

    const result = await db.execute(sql`
      UPDATE call_logs 
      SET grader_results = jsonb_set(
        grader_results,
        '{graders}',
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'grader', g->>'grader',
              'pass', (g->>'pass')::boolean,
              'score', (g->>'score')::numeric,
              'severity', g->>'severity'
            )
          )
          FROM jsonb_array_elements(grader_results->'graders') AS g
        )
      ),
      updated_at = NOW()
      WHERE id IN (
        SELECT id FROM call_logs
        WHERE created_at < ${cutoff}
        AND grader_results IS NOT NULL
        AND grader_results->'graders' IS NOT NULL
        AND jsonb_array_length(grader_results->'graders') > 0
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(grader_results->'graders') AS g
          WHERE g ? 'reason' OR g ? 'metadata'
        )
        LIMIT ${this.config.batchSize}
      )
    `);

    const count = (result as any).rowCount || 0;
    if (count > 0) {
      console.info(`[RETENTION] Stripped evidence from ${count} grader results (older than ${this.config.graderEvidenceRetentionDays} days)`);
    }
    return count;
  }

  async purgeExpiredWebhookEvents(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.webhookEventRetentionDays);

    const result = await db.execute(sql`
      DELETE FROM webhook_events 
      WHERE id IN (
        SELECT id FROM webhook_events
        WHERE created_at < ${cutoff}
        AND status IN ('completed', 'dead_letter')
        LIMIT ${this.config.batchSize}
      )
    `);

    const count = (result as any).rowCount || 0;
    if (count > 0) {
      console.info(`[RETENTION] Purged ${count} expired webhook events (older than ${this.config.webhookEventRetentionDays} days)`);
    }
    return count;
  }

  async runFullPurge(): Promise<{ transcripts: number; evidence: number; webhooks: number }> {
    console.info('[RETENTION] Starting scheduled data retention purge...');

    const transcripts = await this.purgeExpiredTranscripts();
    const evidence = await this.purgeExpiredGraderEvidence();
    const webhooks = await this.purgeExpiredWebhookEvents();

    this.lastPurgeTime = new Date();

    console.info(`[RETENTION] Purge complete: ${transcripts} transcripts, ${evidence} evidence records, ${webhooks} webhook events`);
    return { transcripts, evidence, webhooks };
  }

  startSchedule(): void {
    const intervalMs = this.config.purgeIntervalHours * 60 * 60 * 1000;
    this.purgeInterval = setInterval(() => {
      this.runFullPurge().catch(err => {
        console.error('[RETENTION] Scheduled purge failed:', err);
      });
    }, intervalMs);
    console.info(`[RETENTION] Retention policy scheduler started (runs every ${this.config.purgeIntervalHours}h)`);
  }

  stop(): void {
    if (this.purgeInterval) {
      clearInterval(this.purgeInterval);
      this.purgeInterval = null;
    }
  }

  getStatus(): { lastPurge: string | null; config: RetentionConfig } {
    return {
      lastPurge: this.lastPurgeTime?.toISOString() || null,
      config: this.config,
    };
  }
}

export const retentionPolicyService = new RetentionPolicyService();
