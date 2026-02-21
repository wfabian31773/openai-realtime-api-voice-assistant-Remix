import { db } from '../../server/db';
import { sql } from 'drizzle-orm';

interface SLOThresholds {
  transcriptCoverageMinPercent: number;
  reconciliationMaxLagHours: number;
  graderCompletionMaxLagMinutes: number;
  webhookProcessingMaxLatencyMs: number;
}

interface SLOMetric {
  name: string;
  value: number;
  unit: string;
  threshold: number;
  passing: boolean;
  details?: string;
}

interface SLOReport {
  timestamp: string;
  window: string;
  metrics: SLOMetric[];
  overallPassing: boolean;
  failingCount: number;
}

const DEFAULT_THRESHOLDS: SLOThresholds = {
  transcriptCoverageMinPercent: 95,
  reconciliationMaxLagHours: 36,
  graderCompletionMaxLagMinutes: 30,
  webhookProcessingMaxLatencyMs: 5000,
};

class DataQualitySloService {
  private thresholds: SLOThresholds;
  private monitorInterval: NodeJS.Timeout | null = null;
  private lastReport: SLOReport | null = null;

  constructor(thresholds: Partial<SLOThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  async measureTranscriptCoverage(windowHours: number = 24): Promise<SLOMetric> {
    try {
      const result = await db.execute(sql`
        SELECT 
          COUNT(*)::int as total,
          COUNT(CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 1 END)::int as with_transcript
        FROM call_logs
        WHERE created_at > NOW() - INTERVAL '1 hour' * ${windowHours}
        AND status = 'completed'
        AND direction = 'inbound'
      `);
      
      const row = result.rows[0] as any;
      const total = row?.total || 0;
      const withTranscript = row?.with_transcript || 0;
      const coverage = total > 0 ? Math.round((withTranscript / total) * 10000) / 100 : 100;
      
      return {
        name: 'transcript_coverage',
        value: coverage,
        unit: '%',
        threshold: this.thresholds.transcriptCoverageMinPercent,
        passing: coverage >= this.thresholds.transcriptCoverageMinPercent,
        details: `${withTranscript}/${total} completed inbound calls have transcripts`,
      };
    } catch (error) {
      console.error('[SLO] Error measuring transcript coverage:', error);
      return {
        name: 'transcript_coverage',
        value: -1,
        unit: '%',
        threshold: this.thresholds.transcriptCoverageMinPercent,
        passing: false,
        details: 'Measurement failed',
      };
    }
  }

  async measureReconciliationLag(): Promise<SLOMetric> {
    try {
      const result = await db.execute(sql`
        SELECT 
          EXTRACT(EPOCH FROM (NOW() - MAX(reconciled_at))) / 3600 as lag_hours
        FROM daily_reconciliation
      `);
      
      const lagHours = parseFloat((result.rows[0] as any)?.lag_hours) || 999;
      
      return {
        name: 'reconciliation_lag',
        value: Math.round(lagHours * 10) / 10,
        unit: 'hours',
        threshold: this.thresholds.reconciliationMaxLagHours,
        passing: lagHours <= this.thresholds.reconciliationMaxLagHours,
        details: `Last reconciliation was ${Math.round(lagHours)} hours ago`,
      };
    } catch (error) {
      console.error('[SLO] Error measuring reconciliation lag:', error);
      return {
        name: 'reconciliation_lag',
        value: -1,
        unit: 'hours',
        threshold: this.thresholds.reconciliationMaxLagHours,
        passing: false,
        details: 'Measurement failed',
      };
    }
  }

  async measureGraderCompletionLag(windowHours: number = 24): Promise<SLOMetric> {
    try {
      const result = await db.execute(sql`
        SELECT 
          COUNT(*)::int as total_completed,
          COUNT(CASE WHEN grader_results IS NOT NULL THEN 1 END)::int as graded,
          AVG(
            CASE WHEN grader_results IS NOT NULL AND graded_at IS NOT NULL 
            THEN EXTRACT(EPOCH FROM (graded_at - created_at)) / 60 
            END
          ) as avg_lag_minutes
        FROM call_logs
        WHERE created_at > NOW() - INTERVAL '1 hour' * ${windowHours}
        AND status = 'completed'
      `);
      
      const row = result.rows[0] as any;
      const total = row?.total_completed || 0;
      const graded = row?.graded || 0;
      const avgLag = parseFloat(row?.avg_lag_minutes) || 0;
      const ungradedCount = total - graded;
      
      return {
        name: 'grader_completion_lag',
        value: Math.round(avgLag * 10) / 10,
        unit: 'minutes',
        threshold: this.thresholds.graderCompletionMaxLagMinutes,
        passing: avgLag <= this.thresholds.graderCompletionMaxLagMinutes && ungradedCount < total * 0.05,
        details: `${graded}/${total} graded, avg lag ${Math.round(avgLag)}min, ${ungradedCount} ungraded`,
      };
    } catch (error) {
      console.error('[SLO] Error measuring grader lag:', error);
      return {
        name: 'grader_completion_lag',
        value: -1,
        unit: 'minutes',
        threshold: this.thresholds.graderCompletionMaxLagMinutes,
        passing: false,
        details: 'Measurement failed',
      };
    }
  }

  async measureWebhookProcessingLatency(windowHours: number = 24): Promise<SLOMetric> {
    try {
      const result = await db.execute(sql`
        SELECT 
          COUNT(*)::int as total,
          AVG(EXTRACT(EPOCH FROM (processed_at - created_at)) * 1000)::int as avg_latency_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (processed_at - created_at)) * 1000
          )::int as p95_latency_ms
        FROM webhook_events
        WHERE created_at > NOW() - INTERVAL '1 hour' * ${windowHours}
        AND processed_at IS NOT NULL
      `);
      
      const row = result.rows[0] as any;
      const total = row?.total || 0;
      const avgLatency = row?.avg_latency_ms || 0;
      const p95Latency = row?.p95_latency_ms || 0;
      
      return {
        name: 'webhook_processing_latency',
        value: p95Latency,
        unit: 'ms (p95)',
        threshold: this.thresholds.webhookProcessingMaxLatencyMs,
        passing: p95Latency <= this.thresholds.webhookProcessingMaxLatencyMs,
        details: `${total} events processed, avg=${avgLatency}ms, p95=${p95Latency}ms`,
      };
    } catch (error) {
      console.error('[SLO] Error measuring webhook latency:', error);
      return {
        name: 'webhook_processing_latency',
        value: -1,
        unit: 'ms (p95)',
        threshold: this.thresholds.webhookProcessingMaxLatencyMs,
        passing: false,
        details: 'Measurement failed',
      };
    }
  }

  async generateReport(windowHours: number = 24): Promise<SLOReport> {
    const metrics = await Promise.all([
      this.measureTranscriptCoverage(windowHours),
      this.measureReconciliationLag(),
      this.measureGraderCompletionLag(windowHours),
      this.measureWebhookProcessingLatency(windowHours),
    ]);
    
    const failingCount = metrics.filter(m => !m.passing).length;
    
    const report: SLOReport = {
      timestamp: new Date().toISOString(),
      window: `${windowHours}h`,
      metrics,
      overallPassing: failingCount === 0,
      failingCount,
    };
    
    this.lastReport = report;
    
    if (failingCount > 0) {
      const failingNames = metrics.filter(m => !m.passing).map(m => m.name).join(', ');
      console.warn(`[SLO] ${failingCount} SLO(s) failing: ${failingNames}`);
    } else {
      console.info('[SLO] All SLOs passing');
    }
    
    return report;
  }

  async getWeeklyTrend(): Promise<any> {
    try {
      const result = await db.execute(sql`
        WITH daily_stats AS (
          SELECT 
            date_trunc('day', created_at) as day,
            COUNT(*)::int as total_calls,
            COUNT(CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 1 END)::int as calls_with_transcript,
            COUNT(CASE WHEN grader_results IS NOT NULL THEN 1 END)::int as calls_graded
          FROM call_logs
          WHERE created_at > NOW() - INTERVAL '7 days'
          AND status = 'completed'
          GROUP BY date_trunc('day', created_at)
          ORDER BY day
        )
        SELECT 
          day::date as date,
          total_calls,
          calls_with_transcript,
          calls_graded,
          CASE WHEN total_calls > 0 
            THEN ROUND((calls_with_transcript::numeric / total_calls) * 100, 1)
            ELSE 100 
          END as transcript_coverage_pct,
          CASE WHEN total_calls > 0 
            THEN ROUND((calls_graded::numeric / total_calls) * 100, 1)
            ELSE 100 
          END as grader_coverage_pct
        FROM daily_stats
      `);
      
      return {
        period: '7d',
        days: result.rows,
      };
    } catch (error) {
      console.error('[SLO] Error getting weekly trend:', error);
      return { period: '7d', days: [], error: 'Failed to generate trend' };
    }
  }

  startMonitoring(intervalMinutes: number = 60): void {
    this.monitorInterval = setInterval(async () => {
      try {
        await this.generateReport();
      } catch (error) {
        console.error('[SLO] Monitoring check failed:', error);
      }
    }, intervalMinutes * 60 * 1000);
    
    console.info(`[SLO] Data quality SLO monitoring started (checking every ${intervalMinutes}min)`);
  }

  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  getLastReport(): SLOReport | null {
    return this.lastReport;
  }
}

export const dataQualitySloService = new DataQualitySloService();
