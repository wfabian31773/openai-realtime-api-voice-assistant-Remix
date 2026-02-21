import { config } from 'dotenv';
config();

import { storage } from '../server/storage';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

interface TwilioCallData {
  sid: string;
  duration: string;
  status: string;
  price: string | null;
}

async function fetchTwilioCall(callSid: string): Promise<TwilioCallData | null> {
  if (!callSid || !callSid.startsWith('CA')) return null;
  
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    
    const response = await fetch(url, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function processBatch(calls: any[], batchNum: number, forceUpdate: boolean): Promise<{updated: number, skipped: number}> {
  let updated = 0, skipped = 0;
  
  for (const call of calls) {
    if (!call.callSid?.startsWith('CA')) {
      skipped++;
      continue;
    }

    const twilioData = await fetchTwilioCall(call.callSid);
    if (!twilioData) {
      skipped++;
      continue;
    }

    const twilioDuration = parseInt(twilioData.duration, 10) || 0;
    const twilioPrice = twilioData.price ? Math.round(Math.abs(parseFloat(twilioData.price)) * 100) : 0;
    const twilioStatus = twilioData.status;

    if (forceUpdate) {
      try {
        await storage.updateCallLog(call.id, {
          duration: twilioDuration,
          twilioCostCents: twilioPrice,
          twilioStatus: twilioStatus
        });
        updated++;
      } catch {
        skipped++;
      }
    } else {
      const needsUpdate = 
        call.duration !== twilioDuration ||
        call.twilioCostCents !== twilioPrice ||
        call.twilioStatus !== twilioStatus;

      if (!needsUpdate) continue;

      try {
        await storage.updateCallLog(call.id, {
          duration: twilioDuration,
          twilioCostCents: twilioPrice,
          twilioStatus: twilioStatus
        });
        updated++;
      } catch {
        skipped++;
      }
    }
  }
  
  console.log(`Batch ${batchNum}: ${updated} updated, ${skipped} skipped`);
  return { updated, skipped };
}

async function main() {
  const forceUpdate = process.argv.includes('--force');
  
  console.log(`Fast Twilio Data Backfill ${forceUpdate ? '(FORCE MODE)' : ''}`);
  console.log('========================\n');

  let page = 1;
  const batchSize = 50;
  let totalUpdated = 0, totalSkipped = 0;
  
  while (true) {
    const calls = await storage.getCallLogs({ page, limit: batchSize, direction: undefined, status: undefined, startDate: undefined, endDate: undefined });
    
    if (calls.data.length === 0) break;
    
    const result = await processBatch(calls.data, page, forceUpdate);
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    
    if (page >= calls.pagination.totalPages) break;
    page++;
    
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('\n========================');
  console.log(`Total: ${totalUpdated} updated, ${totalSkipped} skipped`);
  process.exit(0);
}

main();
