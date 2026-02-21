import { db } from "../db";
import { callLogs } from "../../shared/schema";
import { eq, and, isNull, isNotNull, or, sql, lt, gte } from "drizzle-orm";
import { ticketingApiClient } from "./ticketingApiClient";
import { callCostService } from "../../src/services/callCostService";
import { callGradingService } from "../../src/services/callGradingService";

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3; // Stop retrying after 3 failed attempts

interface SyncResult {
  callId: string;
  callSid: string | null;
  ticketNumber: string | null;
  success: boolean;
  error?: string;
  retriesExhausted?: boolean;
}

export class TicketingSyncService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private currentRunPromise: Promise<SyncResult[]> | null = null;

  start(): void {
    if (this.intervalId) {
      console.log("[TICKETING SYNC] Service already running");
      return;
    }

    console.log("[TICKETING SYNC] Starting background sync service (every 5 minutes)");
    
    this.runSync();
    this.retryTwilioCosts(); // Also run cost retry on startup
    this.gradeUngradedCalls(); // Also run grading for missed calls
    this.reconcileStaleCallsWithTwilio(); // Cleanup stale calls
    this.fixSuspiciousDurations(); // Fix 600s timeout durations on startup
    
    this.intervalId = setInterval(() => {
      this.runSync();
      this.retryTwilioCosts();
      this.gradeUngradedCalls();
      this.reconcileStaleCallsWithTwilio(); // Cleanup stale calls every cycle
      this.fixSuspiciousDurations(); // Fix 600s timeout durations with correct Twilio data
    }, SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[TICKETING SYNC] Service stopped");
    }
  }

  async runSync(): Promise<SyncResult[]> {
    if (this.isRunning) {
      console.log("[TICKETING SYNC] Sync already in progress, skipping");
      return [];
    }

    this.isRunning = true;
    const results: SyncResult[] = [];

    try {
      console.log("[TICKETING SYNC] Starting sync cycle...");

      const pendingCalls = await db
        .select({
          id: callLogs.id,
          callSid: callLogs.callSid,
          ticketNumber: callLogs.ticketNumber,
          from: callLogs.from,
          to: callLogs.to,
          agentId: callLogs.agentId,
          direction: callLogs.direction,
          status: callLogs.status,
          startTime: callLogs.startTime,
          endTime: callLogs.endTime,
          duration: callLogs.duration,
          transcript: callLogs.transcript,
          recordingUrl: callLogs.recordingUrl,
          transferredToHuman: callLogs.transferredToHuman,
          sentiment: callLogs.sentiment,
          qualityScore: callLogs.qualityScore,
          agentOutcome: callLogs.agentOutcome,
          ticketingSynced: callLogs.ticketingSynced,
          ticketingSyncError: callLogs.ticketingSyncError,
          ticketingSyncRetries: callLogs.ticketingSyncRetries,
        })
        .from(callLogs)
        .where(
          and(
            eq(callLogs.status, "completed"),
            or(
              eq(callLogs.ticketingSynced, false),
              isNull(callLogs.ticketingSynced)
            ),
            isNotNull(callLogs.transcript),
            sql`LENGTH(${callLogs.transcript}) > 50`,
            or(
              isNotNull(callLogs.ticketNumber),
              isNotNull(callLogs.callSid)
            ),
            // Only include calls that haven't exceeded retry limit
            or(
              isNull(callLogs.ticketingSyncRetries),
              lt(callLogs.ticketingSyncRetries, MAX_RETRIES)
            )
          )
        )
        .limit(20);

      if (pendingCalls.length === 0) {
        console.log("[TICKETING SYNC] No pending calls to sync");
        return results;
      }

      console.log(`[TICKETING SYNC] Found ${pendingCalls.length} calls to sync`);

      for (const call of pendingCalls) {
        const result = await this.syncCall(call);
        results.push(result);
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      const exhaustedCount = results.filter(r => r.retriesExhausted).length;
      console.log(`[TICKETING SYNC] Sync cycle complete: ${successCount} success, ${failCount} failed, ${exhaustedCount} gave up`);

    } catch (error) {
      console.error("[TICKETING SYNC] Error during sync cycle:", error);
    } finally {
      this.isRunning = false;
      this.currentRunPromise = null;
    }

    return results;
  }

  private async syncCall(call: any): Promise<SyncResult> {
    const identifier = call.ticketNumber || call.callSid;
    const currentRetries = call.ticketingSyncRetries || 0;
    console.log(`[TICKETING SYNC] Syncing call ${call.id} (${identifier}) - attempt ${currentRetries + 1}/${MAX_RETRIES}`);

    try {
      // VALIDATION FIX: Sanitize dialedNumber - must be <=20 chars and look like a phone number
      // SIP project IDs like "proj_fsAu2Z4CM7BLIN66diBekWsa" will fail ticketing validation
      let sanitizedDialedNumber = call.to;
      if (sanitizedDialedNumber) {
        // Check if it looks like a SIP project ID or is too long
        if (sanitizedDialedNumber.startsWith('proj_') || sanitizedDialedNumber.length > 20) {
          console.warn(`[TICKETING SYNC] Invalid dialedNumber "${sanitizedDialedNumber}" - clearing`);
          sanitizedDialedNumber = undefined;
        }
      }
      
      const payload = {
        callSid: call.callSid || undefined,
        ticketNumber: call.ticketNumber || undefined,
        recordingUrl: call.recordingUrl || undefined,
        transcript: call.transcript || undefined,
        callerPhone: call.from,
        dialedNumber: sanitizedDialedNumber,
        agentUsed: call.agentId || "unknown",
        callStartTime: call.startTime?.toISOString(),
        callEndTime: call.endTime?.toISOString(),
        callDurationSeconds: call.duration || 0,
        humanHandoffOccurred: call.transferredToHuman || false,
        qualityScore: call.qualityScore || undefined,
        patientSentiment: call.sentiment || undefined,
        agentOutcome: call.agentOutcome || undefined,
      };

      const response = await ticketingApiClient.updateTicketCallData(payload);

      if (response.success) {
        await db
          .update(callLogs)
          .set({
            ticketingSynced: true,
            ticketingSyncedAt: new Date(),
            ticketingSyncError: null,
            ticketNumber: response.ticketNumber || call.ticketNumber,
            ticketingSyncRetries: currentRetries + 1,
          })
          .where(eq(callLogs.id, call.id));

        console.log(`[TICKETING SYNC] ✓ Successfully synced call ${identifier}`);
        
        return {
          callId: call.id,
          callSid: call.callSid,
          ticketNumber: response.ticketNumber || call.ticketNumber,
          success: true,
        };
      } else {
        const errorMsg = response.error || "Unknown error";
        const newRetryCount = currentRetries + 1;
        const retriesExhausted = newRetryCount >= MAX_RETRIES;
        
        await db
          .update(callLogs)
          .set({
            ticketingSyncError: retriesExhausted 
              ? `GAVE UP after ${MAX_RETRIES} attempts: ${errorMsg}`
              : errorMsg,
            ticketingSyncRetries: newRetryCount,
          })
          .where(eq(callLogs.id, call.id));

        if (retriesExhausted) {
          console.warn(`[TICKETING SYNC] ✗ Gave up on call ${identifier} after ${MAX_RETRIES} attempts: ${errorMsg}`);
        } else {
          console.error(`[TICKETING SYNC] ✗ Failed to sync call ${identifier} (attempt ${newRetryCount}/${MAX_RETRIES}): ${errorMsg}`);
        }
        
        return {
          callId: call.id,
          callSid: call.callSid,
          ticketNumber: call.ticketNumber,
          success: false,
          error: errorMsg,
          retriesExhausted,
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const newRetryCount = currentRetries + 1;
      const retriesExhausted = newRetryCount >= MAX_RETRIES;
      
      await db
        .update(callLogs)
        .set({
          ticketingSyncError: retriesExhausted 
            ? `GAVE UP after ${MAX_RETRIES} attempts: ${errorMsg}`
            : errorMsg,
          ticketingSyncRetries: newRetryCount,
        })
        .where(eq(callLogs.id, call.id));

      if (retriesExhausted) {
        console.warn(`[TICKETING SYNC] ✗ Gave up on call ${identifier} after ${MAX_RETRIES} attempts: ${errorMsg}`);
      } else {
        console.error(`[TICKETING SYNC] ✗ Exception syncing call ${identifier} (attempt ${newRetryCount}/${MAX_RETRIES}):`, errorMsg);
      }
      
      return {
        callId: call.id,
        callSid: call.callSid,
        ticketNumber: call.ticketNumber,
        success: false,
        error: errorMsg,
        retriesExhausted,
      };
    }
  }

  async manualSync(): Promise<SyncResult[] | { inProgress: true; message: string }> {
    if (this.isRunning) {
      console.log("[TICKETING SYNC] Manual sync requested but sync already in progress");
      return { inProgress: true, message: "A sync is already in progress. Please wait for it to complete." };
    }
    console.log("[TICKETING SYNC] Manual sync triggered");
    return this.runSync();
  }

  async getSyncStatus(): Promise<{
    pending: number;
    synced: number;
    failed: number;
  }> {
    const [pendingResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(callLogs)
      .where(
        and(
          eq(callLogs.status, "completed"),
          or(
            eq(callLogs.ticketingSynced, false),
            isNull(callLogs.ticketingSynced)
          ),
          isNotNull(callLogs.transcript),
          sql`LENGTH(${callLogs.transcript}) > 50`
        )
      );

    const [syncedResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(callLogs)
      .where(eq(callLogs.ticketingSynced, true));

    const [failedResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(callLogs)
      .where(
        and(
          or(
            eq(callLogs.ticketingSynced, false),
            isNull(callLogs.ticketingSynced)
          ),
          isNotNull(callLogs.ticketingSyncError)
        )
      );

    return {
      pending: Number(pendingResult?.count || 0),
      synced: Number(syncedResult?.count || 0),
      failed: Number(failedResult?.count || 0),
    };
  }

  /**
   * Retry fetching Twilio costs for completed calls that have:
   * - A valid callSid
   * - Missing or zero twilioCostCents
   * - Completed within the last 4 hours (Twilio pricing becomes available within 1-2 hours)
   */
  async retryTwilioCosts(): Promise<void> {
    try {
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
      
      // Find calls that need cost retry
      const callsNeedingCostRetry = await db
        .select({
          id: callLogs.id,
          callSid: callLogs.callSid,
        })
        .from(callLogs)
        .where(
          and(
            eq(callLogs.status, "completed"),
            isNotNull(callLogs.callSid),
            // Missing or zero Twilio cost
            or(
              isNull(callLogs.twilioCostCents),
              eq(callLogs.twilioCostCents, 0)
            ),
            // Completed within last 4 hours (Twilio needs time to calculate price)
            gte(callLogs.endTime, fourHoursAgo)
          )
        )
        .limit(10); // Process max 10 per cycle

      if (callsNeedingCostRetry.length === 0) {
        return; // No calls need cost retry
      }

      console.log(`[COST RETRY] Found ${callsNeedingCostRetry.length} calls needing Twilio cost fetch`);

      let successCount = 0;
      for (const call of callsNeedingCostRetry) {
        if (!call.callSid) continue;
        
        try {
          const success = await callCostService.retryTwilioCostFetch(call.id, call.callSid);
          if (success) {
            successCount++;
          }
        } catch (error) {
          // Individual call errors don't stop the loop
          console.error(`[COST RETRY] Error for call ${call.id}:`, error);
        }
        
        // Small delay between calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (successCount > 0) {
        console.log(`[COST RETRY] Successfully updated costs for ${successCount}/${callsNeedingCostRetry.length} calls`);
      }
    } catch (error) {
      console.error("[COST RETRY] Error during cost retry:", error);
    }
  }

  /**
   * Run AI grading on completed calls that are missing sentiment/outcome analysis.
   * This catches any calls that were missed during normal call completion.
   */
  async gradeUngradedCalls(): Promise<void> {
    try {
      const gradedCount = await callGradingService.gradeCallsWithoutGrades(5); // Process 5 per cycle
      if (gradedCount > 0) {
        console.log(`[AI GRADING] Graded ${gradedCount} previously ungraded calls`);
      }
    } catch (error) {
      console.error("[AI GRADING] Error during grading:", error);
    }
  }

  /**
   * Fix completed calls with suspicious durations (600s timeout with low Twilio cost).
   * These are calls where OpenAI session timed out but Twilio shows a short actual call.
   * This is the "cleanup" step that catches any calls missed by the primary reconciliation.
   */
  async fixSuspiciousDurations(): Promise<void> {
    try {
      // Find completed calls with duration >= 550s but Twilio cost <= 5 cents
      // These are almost certainly timeout cases where actual call was short
      const suspiciousCalls = await db
        .select({
          id: callLogs.id,
          callSid: callLogs.callSid,
          duration: callLogs.duration,
          twilioCostCents: callLogs.twilioCostCents,
        })
        .from(callLogs)
        .where(
          and(
            eq(callLogs.status, "completed"),
            isNotNull(callLogs.callSid),
            isNotNull(callLogs.duration),
            sql`${callLogs.duration} >= 550`,
            or(
              isNull(callLogs.twilioCostCents),
              sql`${callLogs.twilioCostCents} <= 5`
            )
          )
        )
        .limit(20);

      if (suspiciousCalls.length === 0) {
        return; // No suspicious calls
      }

      console.log(`[DURATION FIX] Found ${suspiciousCalls.length} calls with suspicious durations to reconcile`);

      let fixedCount = 0;
      for (const call of suspiciousCalls) {
        if (!call.callSid) continue;
        
        try {
          const result = await callCostService.reconcileTwilioCallData(call.id, call.callSid);
          if (result.success && !result.skipped && result.actualDuration) {
            // Also recalculate OpenAI cost based on correct duration
            await callCostService.recalculateOpenAICostFromDuration(call.id);
            fixedCount++;
            console.info(`[DURATION FIX] Fixed ${call.id}: ${call.duration}s → ${result.actualDuration}s`);
          }
        } catch (error) {
          console.error(`[DURATION FIX] Error fixing ${call.id}:`, error);
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      if (fixedCount > 0) {
        console.log(`[DURATION FIX] Fixed ${fixedCount}/${suspiciousCalls.length} calls with incorrect durations`);
      }
    } catch (error) {
      console.error("[DURATION FIX] Error during suspicious duration fix:", error);
    }
  }

  /**
   * Find calls marked as 'in_progress' that are older than 15 minutes and reconcile with Twilio.
   * This catches calls that didn't properly close - fetches real status and duration from Twilio.
   */
  async reconcileStaleCallsWithTwilio(): Promise<void> {
    try {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      
      // Find stale calls: in_progress status but started more than 15 minutes ago
      const staleCalls = await db
        .select({
          id: callLogs.id,
          callSid: callLogs.callSid,
          status: callLogs.status,
          startTime: callLogs.startTime,
          duration: callLogs.duration,
        })
        .from(callLogs)
        .where(
          and(
            or(
              eq(callLogs.status, "in_progress"),
              eq(callLogs.status, "initiated"),
              eq(callLogs.status, "ringing")
            ),
            isNotNull(callLogs.callSid),
            lt(callLogs.startTime, fifteenMinutesAgo)
          )
        )
        .limit(10);

      if (staleCalls.length === 0) {
        return; // No stale calls
      }

      console.log(`[STALE CALL] Found ${staleCalls.length} stale calls to reconcile with Twilio`);

      let reconciledCount = 0;
      let skippedCount = 0;
      for (const call of staleCalls) {
        if (!call.callSid) continue;
        
        try {
          const result = await callCostService.reconcileTwilioCallData(call.id, call.callSid);
          if (result.success && !result.skipped) {
            reconciledCount++;
            console.info(`[STALE CALL] Reconciled ${call.id}: status=${result.twilioStatus}, duration=${result.actualDuration}s`);
          } else if (result.skipped) {
            skippedCount++;
            // Call still not finalized in Twilio - will retry next cycle
          }
        } catch (error) {
          // Individual errors don't stop the loop
          console.error(`[STALE CALL] Error reconciling ${call.id}:`, error);
        }
        
        // Small delay between API calls
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (reconciledCount > 0 || skippedCount > 0) {
        console.log(`[STALE CALL] Processed ${staleCalls.length} calls: ${reconciledCount} reconciled, ${skippedCount} skipped (not finalized)`);
      }
    } catch (error) {
      console.error("[STALE CALL] Error during stale call reconciliation:", error);
    }
  }
}

export const ticketingSyncService = new TicketingSyncService();
