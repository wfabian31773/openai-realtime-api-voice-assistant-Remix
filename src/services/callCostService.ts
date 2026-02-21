import { getTwilioClient } from '../lib/twilioClient';
import { storage } from '../../server/storage';
import OpenAI from 'openai';

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
  console.warn(`[COST] Unknown model "${model}", falling back to gpt-realtime pricing`);
  return MODEL_PRICING['gpt-realtime'];
}

const OPENAI_REALTIME_PRICING = {
  inputAudioPerK: MODEL_PRICING['gpt-realtime'].audioInputPerM / 1000,
  inputAudioCachedPerK: MODEL_PRICING['gpt-realtime'].audioInputCachedPerM / 1000,
  outputAudioPerK: MODEL_PRICING['gpt-realtime'].audioOutputPerM / 1000,
  inputTextPerK: MODEL_PRICING['gpt-realtime'].textInputPerM / 1000,
  inputTextCachedPerK: MODEL_PRICING['gpt-realtime'].textInputCachedPerM / 1000,
  outputTextPerK: MODEL_PRICING['gpt-realtime'].textOutputPerM / 1000,
};

const OPENAI_COST_CENTS_PER_SECOND = 0.027;

const OPENAI_AUDIO_INPUT_RATE = 6;
const OPENAI_AUDIO_OUTPUT_RATE = 24;

export interface AudioUsageMetrics {
  inputDurationMs: number;
  outputDurationMs: number;
}

export interface TokenUsageMetrics {
  inputAudioTokens: number;
  outputAudioTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  inputCachedTokens: number;
  model?: string;
}

export interface TokenCostBreakdown {
  inputAudioCostCents: number;
  outputAudioCostCents: number;
  inputTextCostCents: number;
  outputTextCostCents: number;
  cachedDiscountCents: number;
  totalCostCents: number;
  isEstimated: boolean;
}

export interface CallCosts {
  twilioCostCents: number;
  openaiCostCents: number;
  totalCostCents: number;
  audioInputMinutes: number;
  audioOutputMinutes: number;
}

export interface OpenAIUsageEntry {
  date: string;
  model: string;
  costDollars: number;
  inputTokens: number;
  outputTokens: number;
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
}

export interface OpenAIUsageSummary {
  totalCostDollars: number;
  costByModel: Record<string, number>;
  costByDate: Record<string, number>;
  realtimeCostDollars: number;
  opsHubCostByDate: Record<string, number>;
  opsHubCostByModel: Record<string, number>;
  entries: OpenAIUsageEntry[];
  dateRange: { startDate: string; endDate: string };
}

export class CallCostService {
  private openaiClient: OpenAI;

  constructor() {
    this.openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async fetchOpenAIUsage(
    startDate: string,
    endDate: string,
    projectId?: string
  ): Promise<OpenAIUsageSummary | null> {
    try {
      const adminApiKey = process.env.OPENAI_ADMIN_API_KEY;
      if (!adminApiKey) {
        console.error('[OPENAI USAGE] No Admin API key available. Set OPENAI_ADMIN_API_KEY in secrets.');
        return null;
      }

      const startTime = Math.floor(new Date(startDate).getTime() / 1000);
      const endTime = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

      const entries: OpenAIUsageEntry[] = [];
      const costByModel: Record<string, number> = {};
      const costByDate: Record<string, number> = {};
      const opsHubCostByDate: Record<string, number> = {};
      const opsHubCostByModel: Record<string, number> = {};
      let totalCostDollars = 0;
      let realtimeCostDollars = 0;
      
      let nextPage: string | null = null;
      let pageCount = 0;
      const maxPages = 20;

      do {
        const params = new URLSearchParams({
          start_time: startTime.toString(),
          end_time: endTime.toString(),
          bucket_width: '1d',
          group_by: 'line_item',
        });

        if (projectId) {
          params.append('project_ids[]', projectId);
        }
        
        if (nextPage) {
          params.append('page', nextPage);
        }

        console.info(`[OPENAI USAGE] Fetching page ${pageCount + 1}...`);

        const response = await fetch(
          `https://api.openai.com/v1/organization/costs?${params.toString()}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${adminApiKey}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[OPENAI USAGE] Costs API error ${response.status}: ${errorText}`);
          
          if (response.status === 403 || response.status === 401) {
            console.error('[OPENAI USAGE] This endpoint requires an Admin API Key.');
            console.error('[OPENAI USAGE] Create an Admin Key at: https://platform.openai.com/settings/organization/admin-keys');
          }
          return null;
        }

        const data = await response.json();

        for (const bucket of data.data || []) {
          const results = bucket.results || [];
          const date = bucket.start_time ? new Date(bucket.start_time * 1000).toISOString().split('T')[0] : 'unknown';
          
          for (const result of results) {
            const lineItem = result.line_item || 'unknown';
            const costDollars = Number(result.amount?.value) || 0;

            entries.push({
              date,
              model: lineItem,
              costDollars,
              inputTokens: result.input_tokens || 0,
              outputTokens: result.output_tokens || 0,
            });

            costByModel[lineItem] = (costByModel[lineItem] || 0) + costDollars;
            costByDate[date] = (costByDate[date] || 0) + costDollars;
            totalCostDollars += costDollars;

            const lineItemLower = lineItem.toLowerCase();
            const isOpsHubModel = lineItemLower.includes('realtime') || 
                lineItemLower.includes('audio') || 
                lineItemLower.includes('whisper') ||
                lineItemLower.includes('transcri') ||
                lineItemLower.includes('speech') ||
                lineItemLower.includes('tts') ||
                lineItemLower.includes('stt');
            
            if (isOpsHubModel) {
              realtimeCostDollars += costDollars;
              opsHubCostByDate[date] = (opsHubCostByDate[date] || 0) + costDollars;
              opsHubCostByModel[lineItem] = (opsHubCostByModel[lineItem] || 0) + costDollars;
            }
          }
        }

        nextPage = data.has_more ? data.next_page : null;
        pageCount++;
        
      } while (nextPage && pageCount < maxPages);

      console.info(`[OPENAI USAGE] Completed: $${totalCostDollars.toFixed(2)} total, $${realtimeCostDollars.toFixed(2)} realtime, ${entries.length} entries across ${pageCount} pages`);

      return {
        totalCostDollars,
        costByModel,
        costByDate,
        realtimeCostDollars,
        opsHubCostByDate,
        opsHubCostByModel,
        entries,
        dateRange: { startDate, endDate },
      };
    } catch (error) {
      console.error('[OPENAI USAGE] Error fetching usage:', error);
      return null;
    }
  }

  calculateOpenAICost(audioMetrics: AudioUsageMetrics): { costCents: number; inputMinutes: number; outputMinutes: number } {
    const inputMinutes = audioMetrics.inputDurationMs / 60000;
    const outputMinutes = audioMetrics.outputDurationMs / 60000;
    
    const inputCost = Math.round(inputMinutes * OPENAI_AUDIO_INPUT_RATE);
    const outputCost = Math.round(outputMinutes * OPENAI_AUDIO_OUTPUT_RATE);
    
    return {
      costCents: inputCost + outputCost,
      inputMinutes: Math.round(inputMinutes * 10), // Store as tenths of minutes
      outputMinutes: Math.round(outputMinutes * 10),
    };
  }

  /**
   * Calculate OpenAI cost from actual token counts (most accurate method)
   * Uses official OpenAI Realtime API pricing per token type
   */
  calculateOpenAICostFromTokens(tokens: TokenUsageMetrics, model?: string): TokenCostBreakdown {
    const { inputAudioTokens, outputAudioTokens, inputTextTokens, outputTextTokens, inputCachedTokens } = tokens;
    const pricing = getModelPricing(model || tokens.model || 'gpt-realtime');
    
    const totalInputTokens = inputAudioTokens + inputTextTokens;
    
    const effectiveCachedTokens = Math.min(inputCachedTokens, totalInputTokens);
    if (inputCachedTokens > totalInputTokens) {
      console.warn(`[COST] Anomaly: cached tokens (${inputCachedTokens}) > total input (${totalInputTokens}), clamping to ${totalInputTokens}`);
    }
    
    const cachedAudioTokens = totalInputTokens > 0 
      ? Math.min(Math.round(effectiveCachedTokens * (inputAudioTokens / totalInputTokens)), inputAudioTokens)
      : 0;
    const cachedTextTokens = Math.min(effectiveCachedTokens - cachedAudioTokens, inputTextTokens);
    
    const uncachedAudioTokens = Math.max(0, inputAudioTokens - cachedAudioTokens);
    const uncachedTextTokens = Math.max(0, inputTextTokens - cachedTextTokens);
    
    const inputAudioCost = (uncachedAudioTokens / 1_000_000) * pricing.audioInputPerM;
    const inputAudioCachedCost = (cachedAudioTokens / 1_000_000) * pricing.audioInputCachedPerM;
    const outputAudioCost = (outputAudioTokens / 1_000_000) * pricing.audioOutputPerM;
    
    const inputTextCost = (uncachedTextTokens / 1_000_000) * pricing.textInputPerM;
    const inputTextCachedCost = (cachedTextTokens / 1_000_000) * pricing.textInputCachedPerM;
    const outputTextCost = (outputTextTokens / 1_000_000) * pricing.textOutputPerM;
    
    const totalAudioInputCost = inputAudioCost + inputAudioCachedCost;
    const totalTextInputCost = inputTextCost + inputTextCachedCost;
    
    const uncachedAudioCostIfNotCached = (cachedAudioTokens / 1_000_000) * pricing.audioInputPerM;
    const uncachedTextCostIfNotCached = (cachedTextTokens / 1_000_000) * pricing.textInputPerM;
    const cachedDiscount = (uncachedAudioCostIfNotCached - inputAudioCachedCost) + (uncachedTextCostIfNotCached - inputTextCachedCost);
    
    const totalCostDollars = totalAudioInputCost + outputAudioCost + totalTextInputCost + outputTextCost;
    
    return {
      inputAudioCostCents: Math.ceil((totalAudioInputCost) * 100),
      outputAudioCostCents: Math.ceil(outputAudioCost * 100),
      inputTextCostCents: Math.ceil((totalTextInputCost) * 100),
      outputTextCostCents: Math.ceil(outputTextCost * 100),
      cachedDiscountCents: Math.floor(cachedDiscount * 100),
      totalCostCents: Math.ceil(totalCostDollars * 100),
      isEstimated: false,
    };
  }

  /**
   * Estimate OpenAI cost from call duration when token counts unavailable
   * Uses calibrated rate from historical billing data analysis
   */
  estimateOpenAICostFromDuration(durationSeconds: number): { costCents: number; isEstimated: boolean } {
    return {
      costCents: Math.ceil(durationSeconds * OPENAI_COST_CENTS_PER_SECOND),
      isEstimated: true,
    };
  }

  /**
   * Update call with token-based cost calculation (most accurate)
   */
  async updateCallCostsWithTokens(
    callLogId: string,
    callSid: string | null,
    tokens: TokenUsageMetrics,
    model?: string
  ): Promise<{ openaiCostCents: number; twilioCostCents: number; totalCostCents: number } | null> {
    try {
      const tokenCost = this.calculateOpenAICostFromTokens(tokens, model);
      
      let twilioCostCents = 0;
      if (callSid) {
        const twilioResult = await this.fetchTwilioCost(callSid);
        if (twilioResult) {
          twilioCostCents = twilioResult.costCents;
        }
      }
      
      const totalCostCents = twilioCostCents + tokenCost.totalCostCents;
      
      await storage.updateCallLog(callLogId, {
        twilioCostCents,
        openaiCostCents: tokenCost.totalCostCents,
        totalCostCents,
        inputAudioTokens: tokens.inputAudioTokens,
        outputAudioTokens: tokens.outputAudioTokens,
        inputTextTokens: tokens.inputTextTokens,
        outputTextTokens: tokens.outputTextTokens,
        inputCachedTokens: tokens.inputCachedTokens,
        costIsEstimated: false,
        costCalculatedAt: new Date(),
      });
      
      console.info(`[COST] Token-based update for ${callLogId}: OpenAI $${(tokenCost.totalCostCents/100).toFixed(2)} (audio:${tokens.inputAudioTokens}/${tokens.outputAudioTokens}, text:${tokens.inputTextTokens}/${tokens.outputTextTokens})`);
      
      return { openaiCostCents: tokenCost.totalCostCents, twilioCostCents, totalCostCents };
    } catch (error) {
      console.error(`[COST] Error updating token costs for ${callLogId}:`, error);
      return null;
    }
  }

  async fetchTwilioCost(callSid: string): Promise<{ costCents: number; duration: number } | null> {
    try {
      const client = await getTwilioClient();
      const call = await client.calls(callSid).fetch();
      
      if (call.price && call.priceUnit) {
        const costDollars = Math.abs(parseFloat(call.price));
        // Use ceiling so tiny costs (like $0.0045) don't round to 0
        const costCents = Math.ceil(costDollars * 100);
        
        console.info(`[COST] Twilio call ${callSid}: $${costDollars.toFixed(4)} (${call.duration}s) -> ${costCents}c`);
        
        return {
          costCents,
          duration: parseInt(call.duration || '0', 10),
        };
      }
      
      console.warn(`[COST] Twilio price not yet available for ${callSid}`);
      return null;
    } catch (error) {
      console.error(`[COST] Error fetching Twilio cost for ${callSid}:`, error);
      return null;
    }
  }

  async updateCallCosts(
    callLogId: string, 
    callSid: string | null, 
    audioMetrics: AudioUsageMetrics
  ): Promise<CallCosts | null> {
    try {
      const openaiCalc = this.calculateOpenAICost(audioMetrics);
      
      let twilioCostCents = 0;
      
      if (callSid) {
        const twilioResult = await this.fetchTwilioCost(callSid);
        if (twilioResult) {
          twilioCostCents = twilioResult.costCents;
        }
      }
      
      const totalCostCents = twilioCostCents + openaiCalc.costCents;
      
      const costs: CallCosts = {
        twilioCostCents,
        openaiCostCents: openaiCalc.costCents,
        totalCostCents,
        audioInputMinutes: openaiCalc.inputMinutes,
        audioOutputMinutes: openaiCalc.outputMinutes,
      };
      
      await storage.updateCallLog(callLogId, {
        twilioCostCents: costs.twilioCostCents,
        openaiCostCents: costs.openaiCostCents,
        totalCostCents: costs.totalCostCents,
        audioInputMinutes: costs.audioInputMinutes,
        audioOutputMinutes: costs.audioOutputMinutes,
        costCalculatedAt: new Date(),
      });
      
      console.info(`[COST] Updated call ${callLogId}: Twilio $${(twilioCostCents/100).toFixed(2)}, OpenAI $${(openaiCalc.costCents/100).toFixed(2)}, Total $${(totalCostCents/100).toFixed(2)}`);
      
      return costs;
    } catch (error) {
      console.error(`[COST] Error updating costs for call ${callLogId}:`, error);
      return null;
    }
  }

  async retryTwilioCostFetch(callLogId: string, callSid: string): Promise<boolean> {
    try {
      const twilioResult = await this.fetchTwilioCost(callSid);
      
      if (!twilioResult) {
        return false;
      }
      
      const callLog = await storage.getCallLog(callLogId);
      if (!callLog) {
        return false;
      }
      
      // Build update object - start with cost data
      const updateData: any = {
        twilioCostCents: twilioResult.costCents,
        costCalculatedAt: new Date(),
      };
      
      // CRITICAL: Only update duration if Twilio returns a positive value
      // AND it differs from stored duration (which may be session timeout like 600s)
      // Never overwrite with 0 - that means Twilio hasn't finalized yet
      let actualDuration = callLog.duration || 0;
      if (twilioResult.duration > 0 && twilioResult.duration !== callLog.duration) {
        updateData.duration = twilioResult.duration;
        actualDuration = twilioResult.duration;
        console.info(`[COST] Duration correction: ${callLog.duration}s -> ${twilioResult.duration}s (from Twilio)`);
      }
      
      // Recalculate OpenAI cost based on best available duration
      const openaiCostCents = Math.ceil(actualDuration * OPENAI_COST_CENTS_PER_SECOND);
      updateData.openaiCostCents = openaiCostCents;
      updateData.totalCostCents = twilioResult.costCents + openaiCostCents;
      
      await storage.updateCallLog(callLogId, updateData);
      
      console.info(`[COST] Retry successful for ${callLogId}: Duration=${actualDuration}s, Twilio=$${(twilioResult.costCents/100).toFixed(2)}, OpenAI=$${(openaiCostCents/100).toFixed(2)}`);
      return true;
    } catch (error) {
      console.error(`[COST] Retry failed for ${callLogId}:`, error);
      return false;
    }
  }

  /**
   * Fetch comprehensive call data from Twilio and update call log.
   * This should be called after a call ends to get authoritative data.
   * Includes: actual duration, status, cost (if available), recording URL
   * 
   * IMPORTANT: Only updates duration/status when Twilio returns FINALIZED data:
   * - Status must be terminal (completed, busy, no-answer, failed, canceled)
   * - Duration must be positive (> 0)
   * This prevents overwriting valid data with 0 or incomplete Twilio responses.
   */
  async reconcileTwilioCallData(callLogId: string, callSid: string): Promise<{
    success: boolean;
    actualDuration?: number;
    twilioStatus?: string;
    costCents?: number;
    skipped?: boolean;
    error?: string;
  }> {
    try {
      // CRITICAL: Strip known prefixes from callSid before Twilio lookup
      // These prefixes (outbound_conf_, test_conf_, conf_) cause Twilio API failures
      const cleanCallSid = callSid.replace(/^(outbound_|test_)?conf_/, '');
      
      // Only proceed with Twilio lookup if we have a valid call SID (starts with CA)
      // Other SID types (CF for conference, RE for recording) are not call lookups
      if (!cleanCallSid.startsWith('CA')) {
        console.info(`[TWILIO RECONCILE] ${callLogId}: Skipping - SID type not a call: ${cleanCallSid.substring(0, 2)}`);
        return { success: true, skipped: true, error: 'Not a call SID' };
      }
      
      // If we cleaned the callSid, also update it in the database
      if (cleanCallSid !== callSid) {
        console.info(`[TWILIO RECONCILE] ${callLogId}: Fixed callSid prefix: ${callSid} → ${cleanCallSid}`);
        await storage.updateCallLog(callLogId, { callSid: cleanCallSid });
      }
      
      const client = await getTwilioClient();
      const twilioCall = await client.calls(cleanCallSid).fetch();
      
      const actualDuration = parseInt(twilioCall.duration || '0', 10);
      const twilioStatus = twilioCall.status;
      
      // Define terminal statuses - only update when call is truly finished
      const terminalStatuses = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
      const isTerminal = terminalStatuses.includes(twilioStatus);
      
      // CRITICAL: Only update if Twilio has finalized data
      // Skip if call is still in-progress or duration is 0 (Twilio hasn't finalized)
      if (!isTerminal) {
        console.info(`[TWILIO RECONCILE] ${callLogId}: Skipping - call still ${twilioStatus} (not terminal)`);
        return {
          success: true,
          skipped: true,
          twilioStatus,
          actualDuration,
        };
      }
      
      if (actualDuration === 0) {
        console.info(`[TWILIO RECONCILE] ${callLogId}: Skipping - Twilio duration is 0 (not finalized yet)`);
        return {
          success: true,
          skipped: true,
          twilioStatus,
          actualDuration: 0,
        };
      }
      
      // Get cost if available (may take 1-2 minutes after call ends)
      let costCents = 0;
      if (twilioCall.price && twilioCall.priceUnit) {
        costCents = Math.ceil(Math.abs(parseFloat(twilioCall.price)) * 100);
      }
      
      // Build update object - only with finalized data
      const updateData: any = {
        duration: actualDuration, // Only set when > 0 and terminal
        twilioStatus,
      };
      
      // Map Twilio status to our status
      const statusMap: Record<string, string> = {
        'completed': 'completed',
        'busy': 'busy',
        'no-answer': 'no_answer',
        'failed': 'failed',
        'canceled': 'failed',
      };
      updateData.status = statusMap[twilioStatus] || 'completed';
      
      if (costCents > 0) {
        updateData.twilioCostCents = costCents;
        
        // Recalculate OpenAI cost based on actual duration
        const openaiCostCents = Math.ceil(actualDuration * OPENAI_COST_CENTS_PER_SECOND);
        updateData.openaiCostCents = openaiCostCents;
        updateData.totalCostCents = costCents + openaiCostCents;
        updateData.costCalculatedAt = new Date();
      }
      
      // P0-4: Duration mismatch detection
      const callLog = await storage.getCallLog(callLogId);
      if (callLog) {
        const localDuration = callLog.localDurationSeconds;
        const transcriptWindow = callLog.transcriptWindowSeconds;
        
        if (localDuration && localDuration > 0 && actualDuration > 0) {
          const mismatchRatio = Math.abs(localDuration - actualDuration) / Math.max(localDuration, actualDuration);
          updateData.durationMismatchRatio = Math.round(mismatchRatio * 1000) / 1000;
          updateData.durationMismatchFlag = mismatchRatio > 0.35;
          
          if (mismatchRatio > 0.35) {
            console.warn(`[DURATION MISMATCH] ⚠️ ${callLogId}: local=${localDuration}s vs twilio=${actualDuration}s (ratio=${(mismatchRatio * 100).toFixed(1)}% > 35% threshold)${transcriptWindow ? `, transcriptWindow=${transcriptWindow}s` : ''}`);
          }
        }
      }

      await storage.updateCallLog(callLogId, updateData);
      
      console.info(`[TWILIO RECONCILE] ${callLogId}: duration=${actualDuration}s, status=${twilioStatus}, cost=${costCents}c${updateData.durationMismatchFlag ? ' ⚠️ DURATION_MISMATCH' : ''}`);
      
      // Fetch detailed Twilio Insights data asynchronously (don't block the main flow)
      setImmediate(async () => {
        try {
          const { twilioInsightsService } = await import('./twilioInsightsService');
          await twilioInsightsService.fetchAndSaveInsights(callLogId, callSid);
        } catch (insightsError) {
          console.warn(`[TWILIO RECONCILE] Insights fetch failed for ${callLogId}:`, insightsError);
        }
      });
      
      return {
        success: true,
        actualDuration,
        twilioStatus,
        costCents: costCents > 0 ? costCents : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[TWILIO RECONCILE] Failed for ${callLogId}:`, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Recalculate OpenAI costs based on actual call duration stored in the database.
   * Uses calibrated rate from actual OpenAI billing data.
   */
  async recalculateOpenAICostFromDuration(callLogId: string): Promise<boolean> {
    try {
      const callLog = await storage.getCallLog(callLogId);
      if (!callLog || !callLog.duration) {
        return false;
      }

      const durationSeconds = callLog.duration;
      
      // Use calibrated rate from actual billing data
      const openaiCostCents = Math.ceil(durationSeconds * OPENAI_COST_CENTS_PER_SECOND);
      
      const twilioCostCents = callLog.twilioCostCents || 0;
      const totalCostCents = twilioCostCents + openaiCostCents;
      
      await storage.updateCallLog(callLogId, {
        openaiCostCents,
        totalCostCents,
        costCalculatedAt: new Date(),
      });
      
      console.info(`[COST] Recalculated for ${callLogId} (${durationSeconds}s): OpenAI $${(openaiCostCents/100).toFixed(2)}`);
      return true;
    } catch (error) {
      console.error(`[COST] Recalculation failed for ${callLogId}:`, error);
      return false;
    }
  }

  /**
   * Recalculate OpenAI costs for ALL completed calls with incorrect audio metrics.
   * This is a batch fix for the bug where all calls got the same metrics.
   */
  async recalculateAllOpenAICosts(): Promise<{ fixed: number; failed: number }> {
    const { db } = await import('../../server/db');
    const { callLogs } = await import('../../shared/schema');
    const { eq, isNotNull, and, sql } = await import('drizzle-orm');

    let fixed = 0;
    let failed = 0;

    // Find all completed calls with OpenAI cost that might be wrong
    // We check for calls where audio_input_minutes doesn't match expected based on duration
    const calls = await db
      .select({
        id: callLogs.id,
        duration: callLogs.duration,
        audioInputMinutes: callLogs.audioInputMinutes,
      })
      .from(callLogs)
      .where(
        and(
          eq(callLogs.status, 'completed'),
          isNotNull(callLogs.duration),
          isNotNull(callLogs.openaiCostCents)
        )
      );

    console.info(`[COST] Found ${calls.length} calls to check for recalculation`);

    for (const call of calls) {
      if (!call.duration) continue;

      // Calculate expected audio_input_minutes (stored as tenths)
      const expectedInputTenths = Math.round(call.duration * 700 / 60000 * 10);
      
      // If stored value doesn't match expected, recalculate
      if (call.audioInputMinutes !== expectedInputTenths) {
        const success = await this.recalculateOpenAICostFromDuration(call.id);
        if (success) {
          fixed++;
        } else {
          failed++;
        }
      }
    }

    console.info(`[COST] Recalculation complete: ${fixed} fixed, ${failed} failed`);
    return { fixed, failed };
  }

  /**
   * Batch fetch Twilio costs for all calls that have call_sid but no Twilio cost.
   * This fixes the gap where Twilio costs weren't fetched after calls.
   */
  async batchFetchMissingTwilioCosts(): Promise<{ fetched: number; failed: number; skipped: number }> {
    const { db } = await import('../../server/db');
    const { callLogs } = await import('../../shared/schema');
    const { eq, and, isNotNull, or, isNull } = await import('drizzle-orm');

    let fetched = 0;
    let failed = 0;
    let skipped = 0;

    // Find all completed calls with call_sid but missing Twilio cost
    const calls = await db
      .select({
        id: callLogs.id,
        callSid: callLogs.callSid,
        duration: callLogs.duration,
      })
      .from(callLogs)
      .where(
        and(
          eq(callLogs.status, 'completed'),
          isNotNull(callLogs.callSid),
          or(
            isNull(callLogs.twilioCostCents),
            eq(callLogs.twilioCostCents, 0)
          )
        )
      );

    console.info(`[COST] Found ${calls.length} calls needing Twilio cost fetch`);

    for (const call of calls) {
      if (!call.callSid) {
        skipped++;
        continue;
      }

      try {
        const success = await this.retryTwilioCostFetch(call.id, call.callSid);
        if (success) {
          fetched++;
        } else {
          failed++;
        }
        
        // Rate limit: Twilio has API limits
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        failed++;
      }
    }

    console.info(`[COST] Twilio batch fetch complete: ${fetched} fetched, ${failed} failed, ${skipped} skipped`);
    return { fetched, failed, skipped };
  }

  /**
   * Daily reconciliation job: Compares our calculated costs against OpenAI Usage API.
   * This helps identify discrepancies and ensures billing accuracy.
   * Should be run once daily, typically early morning for previous day's costs.
   */
  async runDailyReconciliation(targetDate?: Date): Promise<{
    date: string;
    ourTotalCents: number;
    openaiTotalCents: number;
    discrepancyCents: number;
    discrepancyPercent: number;
    callsChecked: number;
    callsReconciled: number;
  } | null> {
    try {
      const { db } = await import('../../server/db');
      const { callLogs } = await import('../../shared/schema');
      const { and, gte, lt, eq, isNotNull } = await import('drizzle-orm');

      // Default to yesterday if no date specified
      const date = targetDate || new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      const startOfDay = new Date(dateStr + 'T00:00:00Z');
      const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

      console.info(`[RECONCILIATION] Starting daily reconciliation for ${dateStr}`);

      // 1. Sum our calculated OpenAI costs for the day
      const calls = await db
        .select({
          id: callLogs.id,
          openaiCostCents: callLogs.openaiCostCents,
          costIsEstimated: callLogs.costIsEstimated,
          duration: callLogs.duration,
        })
        .from(callLogs)
        .where(
          and(
            eq(callLogs.status, 'completed'),
            gte(callLogs.createdAt, startOfDay),
            lt(callLogs.createdAt, endOfDay),
            isNotNull(callLogs.openaiCostCents)
          )
        );

      const ourTotalCents = calls.reduce((sum, c) => sum + (c.openaiCostCents || 0), 0);

      // 2. Fetch OpenAI's reported costs for the day
      const openaiUsage = await this.fetchOpenAIUsage(dateStr, dateStr);
      const openaiTotalCents = openaiUsage 
        ? Math.round(openaiUsage.realtimeCostDollars * 100)
        : 0;

      // 3. Calculate discrepancy
      const discrepancyCents = Math.abs(ourTotalCents - openaiTotalCents);
      const discrepancyPercent = openaiTotalCents > 0 
        ? (discrepancyCents / openaiTotalCents) * 100 
        : 0;

      // 4. Mark calls as reconciled if within acceptable margin (10%)
      let callsReconciled = 0;
      if (discrepancyPercent <= 10 && openaiUsage) {
        for (const call of calls) {
          await storage.updateCallLog(call.id, {
            costReconciledAt: new Date(),
          });
          callsReconciled++;
        }
      }

      const result = {
        date: dateStr,
        ourTotalCents,
        openaiTotalCents,
        discrepancyCents,
        discrepancyPercent: Math.round(discrepancyPercent * 100) / 100,
        callsChecked: calls.length,
        callsReconciled,
      };

      console.info(
        `[RECONCILIATION] ${dateStr}: Our=$${(ourTotalCents/100).toFixed(2)}, OpenAI=$${(openaiTotalCents/100).toFixed(2)}, ` +
        `Diff=$${(discrepancyCents/100).toFixed(2)} (${result.discrepancyPercent.toFixed(1)}%), ` +
        `${callsReconciled}/${calls.length} reconciled`
      );

      return result;
    } catch (error) {
      console.error('[RECONCILIATION] Daily reconciliation failed:', error);
      return null;
    }
  }
}

export const callCostService = new CallCostService();
