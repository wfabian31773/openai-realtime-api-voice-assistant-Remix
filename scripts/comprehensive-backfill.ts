/**
 * Comprehensive Backfill Script
 * Fixes all call data in one run:
 * 1. Strip outbound_conf_ prefix from callSids
 * 2. Fetch correct durations and costs from Twilio
 * 3. Recalculate OpenAI costs based on correct durations
 */
import 'dotenv/config';
import { db } from '../server/db';
import { callLogs } from '../shared/schema';
import { eq, like, or, isNull, and, sql, desc } from 'drizzle-orm';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

interface TwilioCallData {
  sid: string;
  duration: string;
  status: string;
  price: string | null;
  priceUnit: string;
}

async function fetchTwilioCall(callSid: string): Promise<TwilioCallData | null> {
  if (!callSid || !callSid.startsWith('CA')) {
    return null;
  }
  
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    
    const response = await fetch(url, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    
    return await response.json();
  } catch (error: any) {
    console.error(`  [ERROR] ${callSid}:`, error.message);
    return null;
  }
}

function calculateOpenAICost(durationSeconds: number): number {
  const minutes = durationSeconds / 60;
  const audioInputCostPerMin = 0.06;
  const audioOutputCostPerMin = 0.24;
  const avgCostPerMin = (audioInputCostPerMin + audioOutputCostPerMin) / 2;
  return Math.round(minutes * avgCostPerMin * 100);
}

async function runComprehensiveBackfill() {
  console.log('='.repeat(70));
  console.log('COMPREHENSIVE CALL DATA BACKFILL');
  console.log('='.repeat(70));
  console.log(`Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`Twilio: ${TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'}`);
  console.log('');

  // STEP 1: Fix outbound_conf_ and test_conf_ prefixes
  console.log('[STEP 1] Fixing callSid prefixes...');
  
  const prefixedCalls = await db
    .select({ id: callLogs.id, callSid: callLogs.callSid })
    .from(callLogs)
    .where(or(
      like(callLogs.callSid, 'outbound_conf_%'),
      like(callLogs.callSid, 'test_conf_%'),
      like(callLogs.callSid, 'conf_%')
    ));

  console.log(`  Found ${prefixedCalls.length} calls with prefixed callSids`);

  let prefixFixed = 0;
  for (const call of prefixedCalls) {
    if (!call.callSid) continue;
    
    const cleanSid = call.callSid.replace(/^(outbound_|test_)?conf_/, '');
    if (cleanSid.startsWith('CA')) {
      await db.update(callLogs).set({ callSid: cleanSid }).where(eq(callLogs.id, call.id));
      prefixFixed++;
      console.log(`  Fixed: ${call.callSid} → ${cleanSid}`);
    }
  }
  console.log(`  ✓ Fixed ${prefixFixed} callSid prefixes\n`);

  // STEP 2: Backfill Twilio data for all calls
  console.log('[STEP 2] Fetching Twilio data...');

  const allCalls = await db
    .select({
      id: callLogs.id,
      callSid: callLogs.callSid,
      duration: callLogs.duration,
      twilioCostCents: callLogs.twilioCostCents,
      openaiCostCents: callLogs.openaiCostCents,
      status: callLogs.status,
    })
    .from(callLogs)
    .where(like(callLogs.callSid, 'CA%'))
    .orderBy(desc(callLogs.createdAt))
    .limit(1000);

  console.log(`  Found ${allCalls.length} calls with valid callSids to process`);

  let twilioUpdated = 0;
  let twilioSkipped = 0;
  let twilioErrors = 0;

  for (let i = 0; i < allCalls.length; i++) {
    const call = allCalls[i];
    if (!call.callSid) continue;

    // Rate limit: 100ms between calls
    await new Promise(resolve => setTimeout(resolve, 100));

    const twilioData = await fetchTwilioCall(call.callSid);
    
    if (!twilioData) {
      twilioSkipped++;
      continue;
    }

    const twilioDuration = parseInt(twilioData.duration, 10) || 0;
    const twilioPrice = twilioData.price ? Math.round(Math.abs(parseFloat(twilioData.price)) * 100) : null;

    // Check if update needed
    const needsUpdate = 
      call.duration !== twilioDuration ||
      (twilioPrice !== null && call.twilioCostCents !== twilioPrice);

    if (!needsUpdate) {
      continue;
    }

    const updateData: any = {};
    
    if (call.duration !== twilioDuration) {
      updateData.duration = twilioDuration;
      // Recalculate OpenAI cost based on correct duration
      updateData.openaiCostCents = calculateOpenAICost(twilioDuration);
      updateData.costIsEstimated = true;
    }
    
    if (twilioPrice !== null && call.twilioCostCents !== twilioPrice) {
      updateData.twilioCostCents = twilioPrice;
    }

    try {
      await db.update(callLogs).set(updateData).where(eq(callLogs.id, call.id));
      twilioUpdated++;
      
      if (i % 50 === 0 || updateData.duration) {
        console.log(`  [${i+1}/${allCalls.length}] ${call.callSid}: duration ${call.duration}→${updateData.duration || call.duration}s, cost ${call.twilioCostCents}→${updateData.twilioCostCents || call.twilioCostCents}c`);
      }
    } catch (error) {
      twilioErrors++;
      console.error(`  [ERROR] ${call.callSid}:`, error);
    }
  }

  console.log(`  ✓ Updated ${twilioUpdated} calls, skipped ${twilioSkipped}, errors ${twilioErrors}\n`);

  // STEP 3: Recalculate OpenAI costs for calls with durations but no OpenAI cost
  console.log('[STEP 3] Recalculating missing OpenAI costs...');

  const callsMissingOpenAICost = await db
    .select({
      id: callLogs.id,
      duration: callLogs.duration,
      openaiCostCents: callLogs.openaiCostCents,
    })
    .from(callLogs)
    .where(and(
      isNull(callLogs.openaiCostCents),
      sql`${callLogs.duration} > 0`
    ))
    .limit(500);

  console.log(`  Found ${callsMissingOpenAICost.length} calls missing OpenAI cost`);

  let openaiUpdated = 0;
  for (const call of callsMissingOpenAICost) {
    if (!call.duration) continue;
    
    const estimatedCost = calculateOpenAICost(call.duration);
    await db.update(callLogs).set({ 
      openaiCostCents: estimatedCost,
      costIsEstimated: true,
    }).where(eq(callLogs.id, call.id));
    openaiUpdated++;
  }

  console.log(`  ✓ Added OpenAI cost estimates to ${openaiUpdated} calls\n`);

  // Summary
  console.log('='.repeat(70));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(70));
  console.log(`  CallSid prefixes fixed: ${prefixFixed}`);
  console.log(`  Twilio data updated: ${twilioUpdated}`);
  console.log(`  OpenAI costs added: ${openaiUpdated}`);
  console.log('');
}

runComprehensiveBackfill()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
