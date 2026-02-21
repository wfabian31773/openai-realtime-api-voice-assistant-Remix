import { db } from '../server/db';
import { callLogs } from '../shared/schema';
import { eq, isNull, and, or, sql } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs';

interface TwilioCallRecord {
  callSid: string;
  from: string;
  to: string;
  direction: string;
  type: string;
  status: string;
  duration: number;
  startTime: Date;
  endTime: Date;
  price: number | null;
  calledVia: string;
}

interface ReconciliationReport {
  twilioInboundCount: number;
  databaseCount: number;
  matchedCount: number;
  orphansInDatabase: any[];
  missingFromDatabase: TwilioCallRecord[];
  recordsToUpdate: any[];
}

interface TwilioCSVRow {
  'Call Sid': string;
  'From': string;
  'To': string;
  'Direction': string;
  'Type': string;
  'Status': string;
  'Duration': string;
  'Date Created': string;
  'Price': string;
  'Called Via': string;
}

async function parseTwilioCSV(filePath: string): Promise<TwilioCallRecord[]> {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const records: TwilioCSVRow[] = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const inboundCalls: TwilioCallRecord[] = [];

  for (const record of records) {
    if (record['Direction'] === 'Incoming' && record['Type'] === 'Phone') {
      const price = record['Price'] && record['Price'] !== 'null' 
        ? parseFloat(record['Price']) 
        : null;
      
      inboundCalls.push({
        callSid: record['Call Sid'],
        from: record['From'],
        to: record['To'],
        direction: record['Direction'],
        type: record['Type'],
        status: record['Status'],
        duration: parseInt(record['Duration'] || '0', 10),
        startTime: new Date(record['Date Created']),
        endTime: new Date(record['Date Created']),
        price: price,
        calledVia: record['Called Via'],
      });
    }
  }

  return inboundCalls;
}

async function reconcile(csvPath: string, dryRun: boolean = true): Promise<ReconciliationReport> {
  console.log('='.repeat(60));
  console.log('TWILIO CALL RECONCILIATION');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify database)'}`);
  console.log('='.repeat(60));
  console.log('');

  const twilioInbound = await parseTwilioCSV(csvPath);
  console.log(`[TWILIO] Parsed ${twilioInbound.length} inbound phone calls from CSV`);

  const twilioCallSids = new Set(twilioInbound.map(c => c.callSid));
  const twilioByCallSid = new Map(twilioInbound.map(c => [c.callSid, c]));

  const dbCalls = await db
    .select({
      id: callLogs.id,
      callSid: callLogs.callSid,
      from: callLogs.from,
      to: callLogs.to,
      status: callLogs.status,
      duration: callLogs.duration,
      startTime: callLogs.startTime,
      twilioCostCents: callLogs.twilioCostCents,
      transcript: callLogs.transcript,
      direction: callLogs.direction,
    })
    .from(callLogs)
    .where(eq(callLogs.direction, 'inbound'));

  console.log(`[DATABASE] Found ${dbCalls.length} inbound call records in database`);
  console.log('');

  const dbCallSids = new Set(dbCalls.filter(c => c.callSid).map(c => c.callSid!));

  const orphans = dbCalls.filter(c => !c.callSid || !twilioCallSids.has(c.callSid));
  const matched = dbCalls.filter(c => c.callSid && twilioCallSids.has(c.callSid));
  const missingFromDb = twilioInbound.filter(t => !dbCallSids.has(t.callSid));

  console.log('='.repeat(60));
  console.log('RECONCILIATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Twilio inbound calls (source of truth): ${twilioInbound.length}`);
  console.log(`Database inbound calls: ${dbCalls.length}`);
  console.log(`Matched (in both): ${matched.length}`);
  console.log(`Orphans in DB (no matching Twilio record): ${orphans.length}`);
  console.log(`Missing from DB (in Twilio but not in our records): ${missingFromDb.length}`);
  console.log('');

  console.log('='.repeat(60));
  console.log('ORPHAN ANALYSIS (Records to potentially remove)');
  console.log('='.repeat(60));
  
  const unknownCallers = orphans.filter(o => o.from === 'Unknown' || !o.from);
  const noCallSid = orphans.filter(o => !o.callSid);
  const withTranscript = orphans.filter(o => o.transcript && o.transcript.length > 50);
  
  console.log(`  - Unknown/empty caller: ${unknownCallers.length}`);
  console.log(`  - No callSid: ${noCallSid.length}`);
  console.log(`  - With transcript (may have value): ${withTranscript.length}`);
  console.log('');

  if (orphans.length > 0 && orphans.length <= 20) {
    console.log('Sample orphan records:');
    for (const o of orphans.slice(0, 10)) {
      console.log(`  - ID: ${o.id.slice(0, 8)}... | From: ${o.from || 'N/A'} | CallSid: ${o.callSid?.slice(0, 10) || 'N/A'} | Status: ${o.status}`);
    }
    console.log('');
  }

  const recordsToUpdate: any[] = [];
  for (const dbCall of matched) {
    const twilioCall = twilioByCallSid.get(dbCall.callSid!);
    if (!twilioCall) continue;

    const updates: any = { id: dbCall.id, callSid: dbCall.callSid };
    let needsUpdate = false;

    if (dbCall.from !== twilioCall.from) {
      updates.from = { old: dbCall.from, new: twilioCall.from };
      needsUpdate = true;
    }

    if (dbCall.to !== twilioCall.to && twilioCall.calledVia) {
      updates.to = { old: dbCall.to, new: twilioCall.calledVia };
      needsUpdate = true;
    }

    if (dbCall.duration !== twilioCall.duration) {
      updates.duration = { old: dbCall.duration, new: twilioCall.duration };
      needsUpdate = true;
    }

    const twilioCostCents = twilioCall.price 
      ? Math.abs(Math.round(twilioCall.price * 100)) 
      : null;
    
    if (twilioCostCents !== null && dbCall.twilioCostCents !== twilioCostCents) {
      updates.twilioCostCents = { old: dbCall.twilioCostCents, new: twilioCostCents };
      needsUpdate = true;
    }

    if (needsUpdate) {
      recordsToUpdate.push(updates);
    }
  }

  console.log('='.repeat(60));
  console.log('RECORDS TO UPDATE (with Twilio source data)');
  console.log('='.repeat(60));
  console.log(`Records needing updates: ${recordsToUpdate.length}`);
  
  if (recordsToUpdate.length > 0 && recordsToUpdate.length <= 20) {
    console.log('\nSample updates:');
    for (const u of recordsToUpdate.slice(0, 5)) {
      console.log(`  CallSid: ${u.callSid?.slice(0, 12)}...`);
      if (u.from) console.log(`    from: "${u.from.old}" → "${u.from.new}"`);
      if (u.to) console.log(`    to: "${u.to.old}" → "${u.to.new}"`);
      if (u.duration) console.log(`    duration: ${u.duration.old} → ${u.duration.new}`);
      if (u.twilioCostCents) console.log(`    cost: ${u.twilioCostCents.old}¢ → ${u.twilioCostCents.new}¢`);
    }
  }
  console.log('');

  if (!dryRun) {
    console.log('='.repeat(60));
    console.log('APPLYING CHANGES...');
    console.log('='.repeat(60));

    let updatedCount = 0;
    for (const record of recordsToUpdate) {
      const updateData: any = {};
      if (record.from) updateData.from = record.from.new;
      if (record.to) updateData.to = record.to.new;
      if (record.duration) updateData.duration = record.duration.new;
      if (record.twilioCostCents) {
        updateData.twilioCostCents = record.twilioCostCents.new;
        updateData.totalCostCents = (record.twilioCostCents.new || 0);
      }

      await db.update(callLogs)
        .set(updateData)
        .where(eq(callLogs.id, record.id));
      updatedCount++;
    }
    console.log(`Updated ${updatedCount} records with Twilio source data`);

    const orphansToDelete = orphans.filter(o => 
      (o.from === 'Unknown' || !o.from) && 
      (!o.transcript || o.transcript.length < 50)
    );
    
    if (orphansToDelete.length > 0) {
      console.log(`\nDeleting ${orphansToDelete.length} ghost records (Unknown caller, no transcript)...`);
      for (const orphan of orphansToDelete) {
        await db.delete(callLogs).where(eq(callLogs.id, orphan.id));
      }
      console.log(`Deleted ${orphansToDelete.length} ghost records`);
    }
  }

  return {
    twilioInboundCount: twilioInbound.length,
    databaseCount: dbCalls.length,
    matchedCount: matched.length,
    orphansInDatabase: orphans,
    missingFromDatabase: missingFromDb,
    recordsToUpdate,
  };
}

async function main() {
  const csvPath = process.argv[2] || 'attached_assets/call-log-AC5c3dd09f2ff0dc01aff39ae00e6d3a34_1767264319454_1767264335553.csv';
  const dryRun = process.argv[3] !== '--apply';

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  try {
    const report = await reconcile(csvPath, dryRun);
    
    console.log('');
    console.log('='.repeat(60));
    console.log('NEXT STEPS');
    console.log('='.repeat(60));
    
    if (dryRun) {
      console.log('This was a DRY RUN. No changes were made.');
      console.log('To apply changes, run: npx tsx scripts/reconcileCalls.ts <csvpath> --apply');
    } else {
      console.log('Changes have been applied to the database.');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Reconciliation failed:', error);
    process.exit(1);
  }
}

main();
