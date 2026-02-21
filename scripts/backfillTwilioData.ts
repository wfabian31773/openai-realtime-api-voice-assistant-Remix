import { config } from 'dotenv';
config();

import { storage } from '../server/storage';
import { twilioInsightsService } from '../src/services/twilioInsightsService';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

interface TwilioCallData {
  sid: string;
  duration: string;
  status: string;
  price: string | null;
  priceUnit: string;
  startTime: string;
  endTime: string;
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
        console.log(`  [SKIP] ${callSid} - Not found in Twilio`);
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

async function backfillAllCalls(dryRun: boolean = true, limit: number = 100) {
  console.log('========================================');
  console.log(`Twilio Data Backfill - ${dryRun ? 'DRY RUN' : 'LIVE MODE'}`);
  console.log(`Processing up to ${limit} calls`);
  console.log('========================================\n');

  const calls = await storage.getCallLogs({ page: 1, limit, direction: undefined, status: undefined, startDate: undefined, endDate: undefined });
  
  console.log(`Found ${calls.data.length} calls to process\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const updates: Array<{id: string, before: any, after: any}> = [];

  for (const call of calls.data) {
    if (!call.callSid || !call.callSid.startsWith('CA')) {
      console.log(`[SKIP] ${call.id} - Invalid callSid: ${call.callSid}`);
      skipped++;
      continue;
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    const twilioData = await fetchTwilioCall(call.callSid);
    
    if (!twilioData) {
      skipped++;
      continue;
    }

    const twilioDuration = parseInt(twilioData.duration, 10) || 0;
    const twilioPrice = twilioData.price ? Math.round(Math.abs(parseFloat(twilioData.price)) * 100) : null;
    const twilioStatus = twilioData.status;

    const needsUpdate = 
      call.duration !== twilioDuration ||
      (twilioPrice !== null && call.twilioCostCents !== twilioPrice) ||
      call.twilioStatus !== twilioStatus;

    if (!needsUpdate) {
      console.log(`[OK] ${call.callSid} - Data matches (${twilioDuration}s, ${twilioPrice}c)`);
      continue;
    }

    const updateData: any = {};
    
    if (call.duration !== twilioDuration) {
      updateData.duration = twilioDuration;
    }
    if (twilioPrice !== null && call.twilioCostCents !== twilioPrice) {
      updateData.twilioCostCents = twilioPrice;
    }
    if (call.twilioStatus !== twilioStatus) {
      updateData.twilioStatus = twilioStatus;
    }

    updates.push({
      id: call.id,
      before: { duration: call.duration, twilioCostCents: call.twilioCostCents, twilioStatus: call.twilioStatus },
      after: updateData
    });

    console.log(`[UPDATE] ${call.callSid}:`);
    if (updateData.duration !== undefined) {
      console.log(`  Duration: ${call.duration}s → ${updateData.duration}s`);
    }
    if (updateData.twilioCostCents !== undefined) {
      console.log(`  Cost: ${call.twilioCostCents}c → ${updateData.twilioCostCents}c`);
    }
    if (updateData.twilioStatus !== undefined) {
      console.log(`  Status: ${call.twilioStatus} → ${updateData.twilioStatus}`);
    }

    if (!dryRun) {
      try {
        await storage.updateCallLog(call.id, updateData);
        
        await twilioInsightsService.fetchAndSaveInsights(call.id, call.callSid);
        
        updated++;
      } catch (err: any) {
        console.error(`  [FAILED] ${call.id}:`, err.message);
        errors++;
      }
    } else {
      updated++;
    }
  }

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`Total processed: ${calls.data.length}`);
  console.log(`Would update: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  
  if (dryRun) {
    console.log('\nThis was a DRY RUN. No changes were made.');
    console.log('Run with --live to apply changes.');
  } else {
    console.log(`\nUpdated ${updated} calls in database.`);
  }

  return { updated, skipped, errors, updates };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--live');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 100;

  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Limit: ${limit} calls\n`);

  try {
    await backfillAllCalls(dryRun, limit);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

main();
