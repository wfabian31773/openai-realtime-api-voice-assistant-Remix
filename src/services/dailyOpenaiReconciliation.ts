import { storage } from '../../server/storage';
import { db } from '../../server/db';
import { dailyReconciliation } from '../../shared/schema';
import { eq, sql } from 'drizzle-orm';

interface OpenAIDailyCost {
  date: string;
  totalCostDollars: number;
  realtimeCostDollars: number;
  otherCostDollars: number;
  rawData?: any;
}

export class DailyOpenaiReconciliationService {
  static readonly RECONCILIATION_VERSION = 2;
  private adminApiKey: string | undefined;
  
  constructor() {
    this.adminApiKey = process.env.OPENAI_ADMIN_API_KEY;
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private getYesterday(): string {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return this.formatDate(yesterday);
  }

  async fetchOpenAIDailyCost(dateStr: string): Promise<OpenAIDailyCost | null> {
    if (!this.adminApiKey) {
      console.error('[DAILY RECONCILE] No OPENAI_ADMIN_API_KEY available');
      return null;
    }

    try {
      const date = new Date(dateStr + 'T00:00:00Z');
      const startTime = Math.floor(date.getTime() / 1000);
      const endTime = startTime + 86400;

      const params = new URLSearchParams({
        start_time: startTime.toString(),
        end_time: endTime.toString(),
        bucket_width: '1d',
        group_by: 'line_item',
      });

      console.info(`[DAILY RECONCILE] Fetching OpenAI costs for ${dateStr}...`);

      const response = await fetch(
        `https://api.openai.com/v1/organization/costs?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.adminApiKey}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[DAILY RECONCILE] OpenAI API error ${response.status}: ${errorText}`);
        return null;
      }

      const data = await response.json();
      
      let totalCostDollars = 0;
      let realtimeCostDollars = 0;
      let otherCostDollars = 0;

      for (const bucket of data.data || []) {
        for (const result of bucket.results || []) {
          const lineItem = result.line_item || '';
          const costDollars = Number(result.amount?.value) || 0;
          
          totalCostDollars += costDollars;
          
          const lineItemLower = lineItem.toLowerCase();
          const isRealtimeModel = lineItemLower.includes('realtime') || 
              lineItemLower.includes('audio') || 
              lineItemLower.includes('whisper') ||
              lineItemLower.includes('transcri') ||
              lineItemLower.includes('speech') ||
              lineItemLower.includes('tts') ||
              lineItemLower.includes('stt');
          
          if (isRealtimeModel) {
            realtimeCostDollars += costDollars;
          } else {
            otherCostDollars += costDollars;
          }
        }
      }

      console.info(`[DAILY RECONCILE] ${dateStr}: $${totalCostDollars.toFixed(2)} total ($${realtimeCostDollars.toFixed(2)} realtime, $${otherCostDollars.toFixed(2)} other)`);

      return {
        date: dateStr,
        totalCostDollars,
        realtimeCostDollars,
        otherCostDollars,
        rawData: data,
      };
    } catch (error) {
      console.error(`[DAILY RECONCILE] Error fetching OpenAI costs for ${dateStr}:`, error);
      return null;
    }
  }

  async reconcileDate(dateStr: string, reconciledBy: string = 'auto', forceReprocess: boolean = false): Promise<{
    success: boolean;
    date: string;
    actualCostCents?: number;
    estimatedCostCents?: number;
    discrepancyCents?: number;
    discrepancyPercent?: number;
    skipped?: boolean;
    error?: string;
  }> {
    try {
      if (!forceReprocess) {
        const [existing] = await db.select({ processedVersion: dailyReconciliation.processedVersion })
          .from(dailyReconciliation)
          .where(eq(dailyReconciliation.dateUtc, dateStr))
          .limit(1);
        
        if (existing && existing.processedVersion >= DailyOpenaiReconciliationService.RECONCILIATION_VERSION) {
          console.info(`[DAILY RECONCILE] Skipping ${dateStr}: already reconciled at version ${existing.processedVersion} (current: ${DailyOpenaiReconciliationService.RECONCILIATION_VERSION})`);
          return { success: true, date: dateStr, skipped: true };
        }
      }

      const openaiCost = await this.fetchOpenAIDailyCost(dateStr);
      if (!openaiCost) {
        return {
          success: false,
          date: dateStr,
          error: 'Failed to fetch OpenAI costs from API',
        };
      }

      const estimatedCostCents = await storage.getEstimatedOpenaiCostForDate(dateStr);
      
      // actualCostCents = realtime API costs only (voice agents)
      // This is intentional - the Ops Hub only tracks voice agent costs, not GPT-4 grading etc.
      const actualCostCents = Math.round(openaiCost.realtimeCostDollars * 100);
      const realtimeCostCents = Math.round(openaiCost.realtimeCostDollars * 100);
      const otherCostCents = Math.round(openaiCost.otherCostDollars * 100);
      
      const discrepancyCents = actualCostCents - estimatedCostCents;
      const discrepancyPercent = estimatedCostCents > 0 
        ? ((discrepancyCents / estimatedCostCents) * 100)
        : (actualCostCents > 0 ? 100 : 0);

      await storage.upsertDailyOpenaiCost({
        date: dateStr,
        actualCostCents,
        estimatedCostCents,
        realtimeCostCents,
        otherCostCents,
        discrepancyCents,
        discrepancyPercent: discrepancyPercent.toFixed(2),
        reconciledBy,
        rawApiResponse: openaiCost.rawData,
      });

      console.info(`[DAILY RECONCILE] Saved ${dateStr}: actual=${actualCostCents}c, estimated=${estimatedCostCents}c, discrepancy=${discrepancyCents}c (${discrepancyPercent.toFixed(1)}%)`);

      return {
        success: true,
        date: dateStr,
        actualCostCents,
        estimatedCostCents,
        discrepancyCents,
        discrepancyPercent,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[DAILY RECONCILE] Error reconciling ${dateStr}:`, errorMsg);
      return {
        success: false,
        date: dateStr,
        error: errorMsg,
      };
    }
  }

  async reconcileYesterday(): Promise<{
    success: boolean;
    date: string;
    actualCostCents?: number;
    estimatedCostCents?: number;
    discrepancyCents?: number;
    error?: string;
  }> {
    const yesterday = this.getYesterday();
    console.info(`[DAILY RECONCILE] Running morning reconciliation for ${yesterday}`);
    return this.reconcileDate(yesterday, 'auto');
  }

  async reconcileDateRange(startDate: string, endDate: string, reconciledBy: string = 'manual'): Promise<{
    success: boolean;
    results: Array<{
      date: string;
      actualCostCents?: number;
      estimatedCostCents?: number;
      discrepancyCents?: number;
      error?: string;
    }>;
    totalReconciled: number;
    totalFailed: number;
    error?: string;
  }> {
    const results: Array<any> = [];
    let totalReconciled = 0;
    let totalFailed = 0;

    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return {
        success: false,
        results: [],
        totalReconciled: 0,
        totalFailed: 0,
        error: 'Invalid date format. Use YYYY-MM-DD',
      };
    }
    
    if (start > end) {
      return {
        success: false,
        results: [],
        totalReconciled: 0,
        totalFailed: 0,
        error: 'Start date must be before end date',
      };
    }
    
    const maxDays = 90;
    const dayCount = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    if (dayCount > maxDays) {
      return {
        success: false,
        results: [],
        totalReconciled: 0,
        totalFailed: 0,
        error: `Date range too large. Maximum ${maxDays} days allowed.`,
      };
    }
    
    const dates: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(this.formatDate(d));
    }

    console.info(`[DAILY RECONCILE] Reconciling ${dates.length} days from ${startDate} to ${endDate}`);

    for (const dateStr of dates) {
      const result = await this.reconcileDate(dateStr, reconciledBy);
      results.push(result);
      
      if (result.success) {
        totalReconciled++;
      } else {
        totalFailed++;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return {
      success: totalFailed === 0,
      results,
      totalReconciled,
      totalFailed,
    };
  }

  startDailySchedule(): void {
    const runReconciliation = async () => {
      const now = new Date();
      const hour = now.getHours();
      
      if (hour === 6) {
        console.info('[DAILY RECONCILE] Running scheduled morning reconciliation');
        const result = await this.reconcileYesterday();
        if (result.success) {
          console.info(`[DAILY RECONCILE] Scheduled reconciliation complete: ${result.date} = ${result.actualCostCents}c actual`);
        } else {
          console.error(`[DAILY RECONCILE] Scheduled reconciliation failed: ${result.error}`);
        }
      }
    };

    setInterval(runReconciliation, 60 * 60 * 1000);
    
    console.info('[DAILY RECONCILE] Daily reconciliation scheduler started (runs at 6:00 AM)');
  }
}

export const dailyOpenaiReconciliation = new DailyOpenaiReconciliationService();
