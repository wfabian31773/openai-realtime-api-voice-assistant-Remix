import { db } from '../../server/db';
import { dailyOrgUsage, dailyReconciliation } from '../../shared/schema';
import { storage } from '../../server/storage';
import { eq } from 'drizzle-orm';

interface ModelPricing {
  audioInputPerM: number;
  audioInputCachedPerM: number;
  audioOutputPerM: number;
  textInputPerM: number;
  textInputCachedPerM: number;
  textOutputPerM: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-realtime': { audioInputPerM: 32, audioInputCachedPerM: 0.40, audioOutputPerM: 64, textInputPerM: 4, textInputCachedPerM: 0.40, textOutputPerM: 16 },
  'gpt-4o-realtime-preview': { audioInputPerM: 40, audioInputCachedPerM: 2.50, audioOutputPerM: 80, textInputPerM: 5, textInputCachedPerM: 2.50, textOutputPerM: 20 },
  'gpt-4o-mini-transcribe': { audioInputPerM: 3, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0, textInputCachedPerM: 0, textOutputPerM: 6 },
  'gpt-4o-transcribe': { audioInputPerM: 6, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0, textInputCachedPerM: 0, textOutputPerM: 6 },
  'gpt-4o-mini': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0.15, textInputCachedPerM: 0.075, textOutputPerM: 0.60 },
  'gpt-4o': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 2.50, textInputCachedPerM: 1.25, textOutputPerM: 10 },
  'gpt-4.1-mini': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0.40, textInputCachedPerM: 0.10, textOutputPerM: 1.60 },
  'gpt-5': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 1.25, textInputCachedPerM: 0.125, textOutputPerM: 10 },
};

function getModelPricing(model: string): ModelPricing {
  const prefixes = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) {
      return MODEL_PRICING[prefix];
    }
  }
  return MODEL_PRICING['gpt-realtime'];
}

interface OrgCostResult {
  totalCostDollars: number;
  lineItems: Array<{ lineItem: string; costDollars: number }>;
  rawData: any;
}

interface OrgUsageRow {
  model: string;
  numModelRequests: number;
  inputTokens: number;
  outputTokens: number;
  inputCachedTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  inputCachedTextTokens: number;
  inputAudioTokens: number;
  inputCachedAudioTokens: number;
  outputAudioTokens: number;
}

function calculateEstimatedCostCents(model: string, tokens: OrgUsageRow): number {
  const pricing = getModelPricing(model);

  const uncachedAudio = Math.max(0, tokens.inputAudioTokens - tokens.inputCachedAudioTokens);
  const cachedAudio = tokens.inputCachedAudioTokens;
  const uncachedText = Math.max(0, tokens.inputTextTokens - tokens.inputCachedTextTokens);
  const cachedText = tokens.inputCachedTextTokens;

  const costDollars =
    (uncachedAudio / 1_000_000) * pricing.audioInputPerM +
    (cachedAudio / 1_000_000) * pricing.audioInputCachedPerM +
    (tokens.outputAudioTokens / 1_000_000) * pricing.audioOutputPerM +
    (uncachedText / 1_000_000) * pricing.textInputPerM +
    (cachedText / 1_000_000) * pricing.textInputCachedPerM +
    (tokens.outputTextTokens / 1_000_000) * pricing.textOutputPerM;

  return Math.ceil(costDollars * 100);
}

export class OrgBillingLedgerService {
  private adminApiKey: string | undefined;

  constructor() {
    this.adminApiKey = process.env.OPENAI_ADMIN_API_KEY;
  }

  async fetchOrgCosts(dateStr: string): Promise<OrgCostResult | null> {
    if (!this.adminApiKey) {
      console.error('[ORG BILLING] No OPENAI_ADMIN_API_KEY available');
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

      console.info(`[ORG BILLING] Fetching org costs for ${dateStr}...`);

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
        console.error(`[ORG BILLING] Costs API error ${response.status}: ${errorText}`);
        return null;
      }

      const data = await response.json();
      let totalCostDollars = 0;
      const lineItems: Array<{ lineItem: string; costDollars: number }> = [];

      for (const bucket of data.data || []) {
        for (const result of bucket.results || []) {
          const lineItem = result.line_item || '';
          const costDollars = Number(result.amount?.value) || 0;
          totalCostDollars += costDollars;
          lineItems.push({ lineItem, costDollars });
        }
      }

      console.info(`[ORG BILLING] ${dateStr} costs: $${totalCostDollars.toFixed(4)} (${lineItems.length} line items)`);

      return { totalCostDollars, lineItems, rawData: data };
    } catch (error) {
      console.error(`[ORG BILLING] Error fetching org costs for ${dateStr}:`, error);
      return null;
    }
  }

  async fetchOrgUsage(dateStr: string): Promise<OrgUsageRow[] | null> {
    if (!this.adminApiKey) {
      console.error('[ORG BILLING] No OPENAI_ADMIN_API_KEY available');
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
        group_by: 'model',
      });

      console.info(`[ORG BILLING] Fetching org usage for ${dateStr}...`);

      const response = await fetch(
        `https://api.openai.com/v1/organization/usage/completions?${params.toString()}`,
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
        console.error(`[ORG BILLING] Usage API error ${response.status}: ${errorText}`);
        return null;
      }

      const data = await response.json();
      const rows: OrgUsageRow[] = [];

      for (const bucket of data.data || []) {
        for (const result of bucket.results || []) {
          rows.push({
            model: result.model || 'unknown',
            numModelRequests: result.num_model_requests || 0,
            inputTokens: result.input_tokens || 0,
            outputTokens: result.output_tokens || 0,
            inputCachedTokens: result.input_cached_tokens || 0,
            inputTextTokens: result.input_text_tokens || 0,
            outputTextTokens: result.output_text_tokens || 0,
            inputCachedTextTokens: result.input_cached_text_tokens || 0,
            inputAudioTokens: result.input_audio_tokens || 0,
            inputCachedAudioTokens: result.input_cached_audio_tokens || 0,
            outputAudioTokens: result.output_audio_tokens || 0,
          });
        }
      }

      console.info(`[ORG BILLING] ${dateStr} usage: ${rows.length} models`);

      return rows;
    } catch (error) {
      console.error(`[ORG BILLING] Error fetching org usage for ${dateStr}:`, error);
      return null;
    }
  }

  async storeOrgUsage(dateStr: string, usageRows: OrgUsageRow[]): Promise<void> {
    try {
      await db.delete(dailyOrgUsage).where(eq(dailyOrgUsage.dateUtc, dateStr));

      if (usageRows.length > 0) {
        const dbRows = usageRows.map((row) => ({
          dateUtc: dateStr,
          model: row.model,
          numModelRequests: row.numModelRequests,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          inputCachedTokens: row.inputCachedTokens,
          inputTextTokens: row.inputTextTokens,
          outputTextTokens: row.outputTextTokens,
          inputCachedTextTokens: row.inputCachedTextTokens,
          inputAudioTokens: row.inputAudioTokens,
          inputCachedAudioTokens: row.inputCachedAudioTokens,
          outputAudioTokens: row.outputAudioTokens,
          estimatedCostCents: calculateEstimatedCostCents(row.model, row),
          source: 'api' as const,
        }));

        await db.insert(dailyOrgUsage).values(dbRows);
      }

      console.info(`[ORG BILLING] Stored ${usageRows.length} usage rows for ${dateStr}`);
    } catch (error) {
      console.error(`[ORG BILLING] Error storing org usage for ${dateStr}:`, error);
      throw error;
    }
  }

  async reconcileDay(dateStr: string): Promise<{
    success: boolean;
    dateStr: string;
    actualUsd?: number;
    estimatedUsd?: number;
    deltaUsd?: number;
    deltaPercent?: number;
    error?: string;
  }> {
    try {
      console.info(`[ORG BILLING] Reconciling ${dateStr}...`);

      const orgCosts = await this.fetchOrgCosts(dateStr);
      if (!orgCosts) {
        return { success: false, dateStr, error: 'Failed to fetch org costs' };
      }

      const orgUsage = await this.fetchOrgUsage(dateStr);
      if (orgUsage) {
        await this.storeOrgUsage(dateStr, orgUsage);
      }

      const perCallSumCents = await storage.getEstimatedOpenaiCostForDate(dateStr);

      const actualUsd = orgCosts.totalCostDollars;
      const estimatedUsd = perCallSumCents / 100;
      const deltaUsd = actualUsd - estimatedUsd;
      const deltaPercent = actualUsd !== 0 ? (deltaUsd / actualUsd) * 100 : 0;
      const orgBilledCents = Math.round(actualUsd * 100);
      const unallocatedCents = orgBilledCents - perCallSumCents;

      const modelBreakdown: Record<string, { costCents: number; requests: number }> = {};
      if (orgUsage) {
        for (const row of orgUsage) {
          modelBreakdown[row.model] = {
            costCents: calculateEstimatedCostCents(row.model, row),
            requests: row.numModelRequests,
          };
        }
      }

      await db
        .insert(dailyReconciliation)
        .values({
          dateUtc: dateStr,
          estimatedUsd: estimatedUsd.toFixed(4),
          actualUsd: actualUsd.toFixed(4),
          deltaUsd: deltaUsd.toFixed(4),
          deltaPercent: deltaPercent.toFixed(2),
          perCallSumCents,
          orgBilledCents,
          unallocatedCents,
          modelBreakdown,
          reconciledAt: new Date(),
        })
        .onConflictDoUpdate({
          target: dailyReconciliation.dateUtc,
          set: {
            estimatedUsd: estimatedUsd.toFixed(4),
            actualUsd: actualUsd.toFixed(4),
            deltaUsd: deltaUsd.toFixed(4),
            deltaPercent: deltaPercent.toFixed(2),
            perCallSumCents,
            orgBilledCents,
            unallocatedCents,
            modelBreakdown,
            reconciledAt: new Date(),
          },
        });

      const lineItemLower = (s: string) => s.toLowerCase();
      let realtimeCostDollars = 0;
      let otherCostDollars = 0;
      for (const item of orgCosts.lineItems) {
        const lower = lineItemLower(item.lineItem);
        const isRealtime =
          lower.includes('realtime') ||
          lower.includes('audio') ||
          lower.includes('whisper') ||
          lower.includes('transcri') ||
          lower.includes('speech') ||
          lower.includes('tts') ||
          lower.includes('stt');
        if (isRealtime) {
          realtimeCostDollars += item.costDollars;
        } else {
          otherCostDollars += item.costDollars;
        }
      }

      await storage.upsertDailyOpenaiCost({
        date: dateStr,
        actualCostCents: Math.round(realtimeCostDollars * 100),
        estimatedCostCents: perCallSumCents,
        realtimeCostCents: Math.round(realtimeCostDollars * 100),
        otherCostCents: Math.round(otherCostDollars * 100),
        discrepancyCents: Math.round(realtimeCostDollars * 100) - perCallSumCents,
        discrepancyPercent: (perCallSumCents > 0
          ? (((Math.round(realtimeCostDollars * 100) - perCallSumCents) / perCallSumCents) * 100).toFixed(2)
          : '0'),
        reconciledBy: 'org-billing-ledger',
        rawApiResponse: orgCosts.rawData,
      });

      console.info(
        `[ORG BILLING] ${dateStr}: actual=$${actualUsd.toFixed(4)}, estimated=$${estimatedUsd.toFixed(4)}, delta=$${deltaUsd.toFixed(4)} (${deltaPercent.toFixed(1)}%)`
      );

      return { success: true, dateStr, actualUsd, estimatedUsd, deltaUsd, deltaPercent };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ORG BILLING] Error reconciling ${dateStr}:`, errorMsg);
      return { success: false, dateStr, error: errorMsg };
    }
  }

  async reconcileDateRange(
    startDate: string,
    endDate: string
  ): Promise<{
    success: boolean;
    totalReconciled: number;
    totalFailed: number;
    results: Array<{
      dateStr: string;
      actualUsd?: number;
      estimatedUsd?: number;
      deltaUsd?: number;
      error?: string;
    }>;
  }> {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { success: false, totalReconciled: 0, totalFailed: 0, results: [] };
    }

    if (start > end) {
      return { success: false, totalReconciled: 0, totalFailed: 0, results: [] };
    }

    const dates: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }

    console.info(`[ORG BILLING] Reconciling ${dates.length} days from ${startDate} to ${endDate}`);

    const results: Array<{
      dateStr: string;
      actualUsd?: number;
      estimatedUsd?: number;
      deltaUsd?: number;
      error?: string;
    }> = [];
    let totalReconciled = 0;
    let totalFailed = 0;

    for (const dateStr of dates) {
      const result = await this.reconcileDay(dateStr);
      results.push(result);

      if (result.success) {
        totalReconciled++;
      } else {
        totalFailed++;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.info(`[ORG BILLING] Range complete: ${totalReconciled} succeeded, ${totalFailed} failed`);

    return { success: totalFailed === 0, totalReconciled, totalFailed, results };
  }
}

export const orgBillingLedger = new OrgBillingLedgerService();
