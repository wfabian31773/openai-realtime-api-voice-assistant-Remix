import { getTwilioClient, getTwilioAccountSid } from '../lib/twilioClient';
import { storage } from '../../server/storage';

export interface TwilioCallInsights {
  fromConnectionType?: string;
  fromCountry?: string;
  fromCarrier?: string;
  toConnectionType?: string;
  toCountry?: string;
  toCarrier?: string;
  whoHungUp?: string;
  postDialDelayMs?: number;
  lastSipResponse?: string;
  callState?: string;
  twilioRtpLatencyInbound?: number;
  twilioRtpLatencyOutbound?: number;
  codec?: string;
  packetLossDetected?: boolean;
  jitterDetected?: boolean;
  highPostDialDelay?: boolean;
  edgeLocation?: string;
  stirShakenStatus?: string;
  stirShakenAttestation?: string;
  conferenceSid?: string;
  twilioCostCents?: number;
  duration?: number;
  twilioStatus?: string;
}

export class TwilioInsightsService {
  private static instance: TwilioInsightsService;

  static getInstance(): TwilioInsightsService {
    if (!TwilioInsightsService.instance) {
      TwilioInsightsService.instance = new TwilioInsightsService();
    }
    return TwilioInsightsService.instance;
  }

  async fetchCallInsights(callSid: string): Promise<TwilioCallInsights | null> {
    try {
      const client = await getTwilioClient();
      const accountSid = await getTwilioAccountSid();

      const insights: TwilioCallInsights = {};

      const call = await client.calls(callSid).fetch();
      
      insights.twilioStatus = call.status;
      insights.duration = call.duration ? parseInt(call.duration) : undefined;
      
      if (call.price) {
        const priceValue = parseFloat(call.price);
        insights.twilioCostCents = Math.round(Math.abs(priceValue) * 100);
      }

      try {
        const summary = await client.insights.v1.calls(callSid).summary().fetch();
        
        if (summary.from) {
          insights.fromConnectionType = (summary.from as any).connection_type || (summary.from as any).connectionType;
          insights.fromCountry = (summary.from as any).country || (summary.from as any).country_code;
          insights.fromCarrier = (summary.from as any).carrier?.name || (summary.from as any).carrier;
        }
        
        if (summary.to) {
          insights.toConnectionType = (summary.to as any).connection_type || (summary.to as any).connectionType;
          insights.toCountry = (summary.to as any).country || (summary.to as any).country_code;
          insights.toCarrier = (summary.to as any).carrier?.name || (summary.to as any).carrier;
        }

        if (summary.callState) {
          insights.callState = summary.callState;
        }

        if (summary.processingState) {
          console.log(`[TWILIO INSIGHTS] Processing state: ${summary.processingState}`);
        }

        const properties = (summary as any).properties || summary;
        if (properties) {
          if (properties.last_sip_response_num) {
            insights.lastSipResponse = `${properties.last_sip_response_num} ${properties.sip_response_phrase || ''}`.trim();
          }
          if (properties.pdd_ms !== undefined) {
            insights.postDialDelayMs = properties.pdd_ms;
          }
          if (properties.disconnected_by) {
            insights.whoHungUp = properties.disconnected_by;
          } else if (properties.end_reason) {
            insights.whoHungUp = properties.end_reason === 'caller-hangup' ? 'caller' : 
                                 properties.end_reason === 'callee-hangup' ? 'callee' : 
                                 properties.end_reason;
          }
        }

        const attributes = (summary as any).attributes || {};
        if (attributes.conference_region) {
          insights.edgeLocation = attributes.conference_region;
        }

      } catch (summaryError: any) {
        // 404 errors are expected for very short calls or calls still processing - demote to info
        const is404 = summaryError?.status === 404 || summaryError?.message?.includes('not found');
        if (is404) {
          console.info(`[TWILIO INSIGHTS] Summary not yet available for ${callSid} (still processing or too short)`);
        } else {
          console.warn(`[TWILIO INSIGHTS] Summary API error for ${callSid}: ${summaryError.message || summaryError}`);
        }
      }

      try {
        const callInsights = client.insights.v1.calls(callSid) as any;
        const metrics = await callInsights.metrics.list({ limit: 1 });
        
        if (metrics.length > 0) {
          const metric = metrics[0];
          const carrierEdge = (metric as any).carrier_edge || (metric as any).carrierEdge || {};
          const clientEdge = (metric as any).client_edge || (metric as any).clientEdge || {};
          const sdkEdge = (metric as any).sdk_edge || (metric as any).sdkEdge || {};
          
          insights.codec = carrierEdge.codec || clientEdge.codec || sdkEdge.codec;
          
          if (carrierEdge.latency?.rtt) {
            insights.twilioRtpLatencyInbound = carrierEdge.latency.rtt.min || carrierEdge.latency.rtt.avg;
            insights.twilioRtpLatencyOutbound = carrierEdge.latency.rtt.max || carrierEdge.latency.rtt.avg;
          }

          insights.packetLossDetected = !!(carrierEdge.properties?.packet_loss || clientEdge.properties?.packet_loss);
          insights.jitterDetected = !!(carrierEdge.properties?.jitter || clientEdge.properties?.jitter);
          insights.highPostDialDelay = !!(carrierEdge.properties?.high_pdd || clientEdge.properties?.high_pdd);

          if (!insights.edgeLocation) {
            insights.edgeLocation = (metric as any).edge || (metric as any).edge_location;
          }
        }
      } catch (metricsError: any) {
        console.warn(`[TWILIO INSIGHTS] Metrics API error for ${callSid}: ${metricsError.message || metricsError}`);
      }

      try {
        const callInsightsEvents = client.insights.v1.calls(callSid) as any;
        const events = await callInsightsEvents.events.list({ limit: 50 });
        
        for (const event of events) {
          const eventData = event as any;
          
          if (eventData.name === 'stir-shaken' || eventData.group === 'stir-shaken') {
            insights.stirShakenStatus = eventData.status || eventData.level;
            insights.stirShakenAttestation = eventData.attestation;
          }
          
          if (eventData.name === 'conference-start' && eventData.conference_sid) {
            insights.conferenceSid = eventData.conference_sid;
          }
        }
      } catch (eventsError: any) {
        console.warn(`[TWILIO INSIGHTS] Events API error for ${callSid}: ${eventsError.message || eventsError}`);
      }

      console.log(`[TWILIO INSIGHTS] Fetched insights for ${callSid}:`, {
        cost: insights.twilioCostCents ? `${insights.twilioCostCents}¢` : 'unknown',
        duration: insights.duration ? `${insights.duration}s` : 'unknown',
        carrier: insights.fromCarrier || 'unknown',
        whoHungUp: insights.whoHungUp || 'unknown',
      });

      return insights;
    } catch (error: any) {
      console.error(`[TWILIO INSIGHTS] Failed to fetch insights for ${callSid}:`, error.message || error);
      return null;
    }
  }

  async fetchAndSaveInsights(callLogId: string, callSid: string): Promise<boolean> {
    try {
      const insights = await this.fetchCallInsights(callSid);
      
      if (!insights) {
        console.warn(`[TWILIO INSIGHTS] No insights returned for ${callSid}`);
        await storage.updateCallLog(callLogId, {
          twilioInsightsFetchedAt: new Date(),
        });
        return false;
      }

      const updateData: Record<string, any> = {
        twilioInsightsFetchedAt: new Date(),
      };

      if (insights.fromConnectionType) updateData.fromConnectionType = insights.fromConnectionType;
      if (insights.fromCountry) updateData.fromCountry = insights.fromCountry;
      if (insights.fromCarrier) updateData.fromCarrier = insights.fromCarrier;
      if (insights.toConnectionType) updateData.toConnectionType = insights.toConnectionType;
      if (insights.toCountry) updateData.toCountry = insights.toCountry;
      if (insights.toCarrier) updateData.toCarrier = insights.toCarrier;
      if (insights.whoHungUp) updateData.whoHungUp = insights.whoHungUp;
      if (insights.postDialDelayMs !== undefined) updateData.postDialDelayMs = insights.postDialDelayMs;
      if (insights.lastSipResponse) updateData.lastSipResponse = insights.lastSipResponse;
      if (insights.callState) updateData.callState = insights.callState;
      if (insights.twilioRtpLatencyInbound !== undefined) updateData.twilioRtpLatencyInbound = insights.twilioRtpLatencyInbound;
      if (insights.twilioRtpLatencyOutbound !== undefined) updateData.twilioRtpLatencyOutbound = insights.twilioRtpLatencyOutbound;
      if (insights.codec) updateData.codec = insights.codec;
      if (insights.packetLossDetected !== undefined) updateData.packetLossDetected = insights.packetLossDetected;
      if (insights.jitterDetected !== undefined) updateData.jitterDetected = insights.jitterDetected;
      if (insights.highPostDialDelay !== undefined) updateData.highPostDialDelay = insights.highPostDialDelay;
      if (insights.edgeLocation) updateData.edgeLocation = insights.edgeLocation;
      if (insights.stirShakenStatus) updateData.stirShakenStatus = insights.stirShakenStatus;
      if (insights.stirShakenAttestation) updateData.stirShakenAttestation = insights.stirShakenAttestation;
      if (insights.conferenceSid) updateData.conferenceSid = insights.conferenceSid;
      if (insights.twilioCostCents !== undefined) updateData.twilioCostCents = insights.twilioCostCents;
      if (insights.duration !== undefined) updateData.duration = insights.duration;
      if (insights.twilioStatus) updateData.twilioStatus = insights.twilioStatus;

      // If we have Twilio cost data (even if $0), recalculate total cost and mark as finalized
      // Twilio cost of $0 is legitimate for toll-free inbound, sub-second calls, etc.
      if (insights.twilioCostCents !== undefined) {
        const callLog = await storage.getCallLog(callLogId);
        if (callLog) {
          const openaiCostCents = callLog.openaiCostCents || 0;
          updateData.totalCostCents = openaiCostCents + insights.twilioCostCents;
          updateData.costIsEstimated = false;
          updateData.costCalculatedAt = new Date();
        }
      }

      await storage.updateCallLog(callLogId, updateData);

      console.log(`[TWILIO INSIGHTS] ✓ Saved insights to call log ${callLogId} (${Object.keys(updateData).length - 1} fields)`);
      return true;
    } catch (error: any) {
      console.error(`[TWILIO INSIGHTS] Failed to save insights for ${callLogId}:`, error.message || error);
      try {
        await storage.updateCallLog(callLogId, {
          twilioInsightsFetchedAt: new Date(),
        });
      } catch {}
      return false;
    }
  }

  async backfillInsightsForRecentCalls(hoursBack: number = 24, limit: number = 50): Promise<{ success: number; failed: number }> {
    const results = { success: 0, failed: 0 };

    try {
      const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      const recentCalls = await storage.getCallLogsNeedingInsights(cutoffDate, limit);

      console.log(`[TWILIO INSIGHTS] Backfilling ${recentCalls.length} calls from the last ${hoursBack} hours`);

      for (const call of recentCalls) {
        if (!call.callSid) {
          console.warn(`[TWILIO INSIGHTS] Skipping call ${call.id} - no callSid`);
          continue;
        }

        await new Promise(resolve => setTimeout(resolve, 200));

        const success = await this.fetchAndSaveInsights(call.id, call.callSid);
        if (success) {
          results.success++;
        } else {
          results.failed++;
        }
      }

      console.log(`[TWILIO INSIGHTS] Backfill complete: ${results.success} success, ${results.failed} failed`);
      return results;
    } catch (error: any) {
      console.error('[TWILIO INSIGHTS] Backfill error:', error.message || error);
      return results;
    }
  }

  /**
   * Start periodic backfill job to catch calls that missed insights fetch
   * Runs every 15 minutes to backfill calls from the last 6 hours
   */
  startPeriodicBackfill(): void {
    const BACKFILL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
    const HOURS_BACK = 6;
    const BATCH_LIMIT = 30;

    console.log(`[TWILIO INSIGHTS] Starting periodic backfill job (every ${BACKFILL_INTERVAL_MS / 60000} min)`);

    setInterval(async () => {
      try {
        const results = await this.backfillInsightsForRecentCalls(HOURS_BACK, BATCH_LIMIT);
        if (results.success > 0 || results.failed > 0) {
          console.log(`[TWILIO INSIGHTS] Periodic backfill: ${results.success} success, ${results.failed} failed`);
        }
      } catch (error) {
        console.error('[TWILIO INSIGHTS] Periodic backfill error:', error);
      }
    }, BACKFILL_INTERVAL_MS);

    // Also run once on startup after a short delay
    setTimeout(async () => {
      try {
        console.log('[TWILIO INSIGHTS] Running startup backfill...');
        const results = await this.backfillInsightsForRecentCalls(HOURS_BACK, BATCH_LIMIT);
        console.log(`[TWILIO INSIGHTS] Startup backfill: ${results.success} success, ${results.failed} failed`);
      } catch (error) {
        console.error('[TWILIO INSIGHTS] Startup backfill error:', error);
      }
    }, 10000); // 10 second delay for startup
  }
}

export const twilioInsightsService = TwilioInsightsService.getInstance();

// Start periodic backfill on module load
twilioInsightsService.startPeriodicBackfill();
