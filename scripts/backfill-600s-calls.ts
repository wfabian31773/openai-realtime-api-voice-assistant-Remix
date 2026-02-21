/**
 * One-time backfill script for calls with 600s duration that have valid callSids
 * but missing Twilio insights
 */
import 'dotenv/config';
import { db } from '../server/db';
import { callLogs } from '../shared/schema';
import { sql, and, eq, isNull, like } from 'drizzle-orm';

async function backfill600sCalls() {
  console.log('[BACKFILL] Starting 600s duration call backfill...');
  
  // Import dynamically to avoid circular deps
  const { twilioInsightsService } = await import('../src/services/twilioInsightsService');
  
  try {
    // Get calls with duration=600 that have valid CA... callSids but no insights
    const callsToFix = await db
      .select({ id: callLogs.id, callSid: callLogs.callSid })
      .from(callLogs)
      .where(and(
        eq(callLogs.duration, 600),
        like(callLogs.callSid, 'CA%'),
        isNull(callLogs.twilioInsightsFetchedAt)
      ))
      .limit(50);
    
    console.log(`[BACKFILL] Found ${callsToFix.length} calls to process`);
    
    let success = 0;
    let failed = 0;
    
    for (const call of callsToFix) {
      if (!call.callSid) continue;
      
      console.log(`[BACKFILL] Processing ${call.id} (${call.callSid})`);
      
      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 500));
      
      try {
        const result = await twilioInsightsService.fetchAndSaveInsights(call.id, call.callSid);
        if (result) {
          success++;
          console.log(`[BACKFILL] ✓ Success for ${call.id}`);
        } else {
          failed++;
          console.log(`[BACKFILL] ✗ Failed for ${call.id}`);
        }
      } catch (error) {
        failed++;
        console.error(`[BACKFILL] Error for ${call.id}:`, error);
      }
    }
    
    console.log(`[BACKFILL] Complete: ${success} success, ${failed} failed`);
  } catch (error) {
    console.error('[BACKFILL] Fatal error:', error);
  }
}

backfill600sCalls().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
