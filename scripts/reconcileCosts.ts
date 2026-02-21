import { db } from '../server/db';
import { callLogs } from '../shared/schema';
import { eq, isNull, and, or, sql, gte, lte, between } from 'drizzle-orm';
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
  sipCallId: string;
}

interface OpenAIDailyRecord {
  date: string;
  startTime: Date;
  endTime: Date;
  amountUsd: number;
  projectId: string;
}

interface CostReconciliationReport {
  dateRange: { start: Date; end: Date };
  twilio: {
    csvTotalCents: number;
    dbTotalCents: number;
    discrepancyCents: number;
    callsInCsv: number;
    callsMatched: number;
    callsUpdated: number;
    callsMissingCost: number;
  };
  openai: {
    csvTotalCents: number;
    dbTotalCents: number;
    discrepancyCents: number;
    dailyBreakdown: Array<{
      date: string;
      csvCents: number;
      dbCents: number;
      discrepancyCents: number;
    }>;
  };
  summary: {
    totalActualCents: number;
    totalTrackedCents: number;
    totalDiscrepancyCents: number;
    discrepancyPercent: number;
  };
}

interface TwilioCSVRow {
  'Call Sid': string;
  'From': string;
  'To': string;
  'Direction': string;
  'Type': string;
  'Status': string;
  'Duration': string;
  'Start Time': string;
  'End Time': string;
  'Date Created': string;
  'Price': string;
  'Price Unit': string;
  'Called Via': string;
  'SIP Call ID': string;
}

interface OpenAICSVRow {
  'start_time': string;
  'end_time': string;
  'start_time_iso': string;
  'end_time_iso': string;
  'amount_value': string;
  'amount_currency': string;
  'project_id': string;
  'project_name': string;
  'organization_name': string;
}

function parseTwilioCSV(filePath: string): TwilioCallRecord[] {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const records: TwilioCSVRow[] = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const calls: TwilioCallRecord[] = [];

  for (const record of records) {
    const price = record['Price'] && record['Price'] !== 'null' && record['Price'] !== ''
      ? parseFloat(record['Price']) 
      : null;
    
    calls.push({
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
      sipCallId: record['SIP Call ID'] || '',
    });
  }

  return calls;
}

function parseOpenAICSV(filePath: string): OpenAIDailyRecord[] {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const records: OpenAICSVRow[] = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const dailyCosts: OpenAIDailyRecord[] = [];

  for (const record of records) {
    const amountStr = record['amount_value'];
    if (!amountStr || amountStr === '' || amountStr === '0E-6176') continue;
    
    const amountUsd = parseFloat(amountStr);
    if (isNaN(amountUsd) || amountUsd === 0) continue;

    const startIso = record['start_time_iso'];
    const endIso = record['end_time_iso'];
    
    if (!startIso || !endIso) continue;

    dailyCosts.push({
      date: startIso.split('T')[0],
      startTime: new Date(startIso),
      endTime: new Date(endIso),
      amountUsd: amountUsd,
      projectId: record['project_id'] || '',
    });
  }

  return dailyCosts;
}

async function reconcileCosts(
  twilioCsvPath: string,
  openaiCsvPath: string,
  dryRun: boolean = true
): Promise<CostReconciliationReport> {
  console.log('='.repeat(70));
  console.log('COMPREHENSIVE COST RECONCILIATION');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify database)'}`);
  console.log('='.repeat(70));
  console.log('');

  const twilioCalls = parseTwilioCSV(twilioCsvPath);
  const openaiDaily = parseOpenAICSV(openaiCsvPath);

  console.log(`[TWILIO] Parsed ${twilioCalls.length} calls from CSV`);
  console.log(`[OPENAI] Parsed ${openaiDaily.length} daily cost records from CSV`);

  const inboundPhoneCalls = twilioCalls.filter(c => c.direction === 'Incoming' && c.type === 'Phone');
  const sipCalls = twilioCalls.filter(c => c.type === 'SIP');
  
  console.log(`  - Inbound phone calls: ${inboundPhoneCalls.length}`);
  console.log(`  - SIP calls (to OpenAI): ${sipCalls.length}`);
  console.log('');

  const allDates = [
    ...twilioCalls.map(c => c.startTime),
    ...openaiDaily.map(o => o.startTime),
  ].filter(d => d instanceof Date && !isNaN(d.getTime()));
  
  if (allDates.length === 0) {
    console.error('[ERROR] No valid dates found in CSV files. Cannot determine date range.');
    console.error('Please check that your CSV files contain valid date fields.');
    process.exit(1);
  }
  
  const dateRange = {
    start: new Date(Math.min(...allDates.map(d => d.getTime()))),
    end: new Date(Math.max(...allDates.map(d => d.getTime()))),
  };

  console.log(`Date Range: ${dateRange.start.toISOString().split('T')[0]} to ${dateRange.end.toISOString().split('T')[0]}`);
  console.log('');

  console.log('='.repeat(70));
  console.log('TWILIO COST RECONCILIATION');
  console.log('='.repeat(70));

  const twilioCsvTotalCents = Math.round(
    inboundPhoneCalls
      .filter(c => c.price !== null)
      .reduce((sum, c) => sum + Math.abs(c.price!) * 100, 0)
  );

  console.log(`Twilio CSV total cost: $${(twilioCsvTotalCents / 100).toFixed(2)}`);

  const twilioCallSids = new Set(inboundPhoneCalls.map(c => c.callSid));
  const twilioByCallSid = new Map(inboundPhoneCalls.map(c => [c.callSid, c]));

  const dbCalls = await db
    .select({
      id: callLogs.id,
      callSid: callLogs.callSid,
      from: callLogs.from,
      startTime: callLogs.startTime,
      twilioCostCents: callLogs.twilioCostCents,
      openaiCostCents: callLogs.openaiCostCents,
      totalCostCents: callLogs.totalCostCents,
      direction: callLogs.direction,
    })
    .from(callLogs)
    .where(
      and(
        eq(callLogs.direction, 'inbound'),
        gte(callLogs.startTime, dateRange.start),
        lte(callLogs.startTime, dateRange.end)
      )
    );

  console.log(`Database calls in date range: ${dbCalls.length}`);

  const dbCallSids = new Set(dbCalls.filter(c => c.callSid).map(c => c.callSid!));
  const matched = dbCalls.filter(c => c.callSid && twilioCallSids.has(c.callSid));
  
  console.log(`Matched (callSid in both): ${matched.length}`);

  const dbTwilioCostCents = dbCalls.reduce((sum, c) => sum + (c.twilioCostCents || 0), 0);
  console.log(`Database Twilio cost total: $${(dbTwilioCostCents / 100).toFixed(2)}`);

  const callsNeedingCostUpdate: Array<{ id: string; callSid: string; newCostCents: number; oldCostCents: number | null }> = [];
  
  for (const dbCall of matched) {
    const twilioCall = twilioByCallSid.get(dbCall.callSid!);
    if (!twilioCall || twilioCall.price === null) continue;

    const newCostCents = Math.round(Math.abs(twilioCall.price) * 100);
    
    if (dbCall.twilioCostCents !== newCostCents) {
      callsNeedingCostUpdate.push({
        id: dbCall.id,
        callSid: dbCall.callSid!,
        newCostCents,
        oldCostCents: dbCall.twilioCostCents,
      });
    }
  }

  console.log(`Calls needing Twilio cost update: ${callsNeedingCostUpdate.length}`);
  
  if (callsNeedingCostUpdate.length > 0 && callsNeedingCostUpdate.length <= 10) {
    console.log('Sample updates:');
    for (const u of callsNeedingCostUpdate.slice(0, 5)) {
      console.log(`  ${u.callSid.slice(0, 12)}...: ${u.oldCostCents ?? 'null'}¢ → ${u.newCostCents}¢`);
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('OPENAI COST RECONCILIATION');
  console.log('='.repeat(70));

  const openaiCsvTotalCents = Math.round(
    openaiDaily.reduce((sum, d) => sum + d.amountUsd * 100, 0)
  );
  console.log(`OpenAI CSV total cost: $${(openaiCsvTotalCents / 100).toFixed(2)}`);

  const dbOpenaiCostCents = dbCalls.reduce((sum, c) => sum + (c.openaiCostCents || 0), 0);
  console.log(`Database OpenAI cost total: $${(dbOpenaiCostCents / 100).toFixed(2)}`);

  const dailyBreakdown: Array<{ date: string; csvCents: number; dbCents: number; discrepancyCents: number }> = [];

  for (const dayRecord of openaiDaily) {
    const dayStart = dayRecord.startTime;
    const dayEnd = dayRecord.endTime;
    
    const dbCallsForDay = dbCalls.filter(c => {
      if (!c.startTime) return false;
      return c.startTime >= dayStart && c.startTime < dayEnd;
    });

    const dbDayCents = dbCallsForDay.reduce((sum, c) => sum + (c.openaiCostCents || 0), 0);
    const csvDayCents = Math.round(dayRecord.amountUsd * 100);

    dailyBreakdown.push({
      date: dayRecord.date,
      csvCents: csvDayCents,
      dbCents: dbDayCents,
      discrepancyCents: csvDayCents - dbDayCents,
    });
  }

  console.log('\nDaily breakdown (top 10 discrepancies):');
  const sortedDaily = [...dailyBreakdown].sort((a, b) => Math.abs(b.discrepancyCents) - Math.abs(a.discrepancyCents));
  for (const day of sortedDaily.slice(0, 10)) {
    const discSign = day.discrepancyCents >= 0 ? '+' : '';
    console.log(`  ${day.date}: CSV $${(day.csvCents/100).toFixed(2)} | DB $${(day.dbCents/100).toFixed(2)} | Diff: ${discSign}$${(day.discrepancyCents/100).toFixed(2)}`);
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const totalActualCents = twilioCsvTotalCents + openaiCsvTotalCents;
  const totalTrackedCents = dbTwilioCostCents + dbOpenaiCostCents;
  const totalDiscrepancyCents = totalActualCents - totalTrackedCents;
  const discrepancyPercent = totalActualCents > 0 
    ? (totalDiscrepancyCents / totalActualCents) * 100 
    : 0;

  console.log(`Total Actual (from CSVs):    $${(totalActualCents / 100).toFixed(2)}`);
  console.log(`Total Tracked (in database): $${(totalTrackedCents / 100).toFixed(2)}`);
  console.log(`Discrepancy:                 $${(totalDiscrepancyCents / 100).toFixed(2)} (${discrepancyPercent.toFixed(1)}%)`);
  console.log('');

  if (totalDiscrepancyCents > 0) {
    console.log('⚠️  We are UNDER-TRACKING costs - actual spend is higher than recorded');
  } else if (totalDiscrepancyCents < 0) {
    console.log('⚠️  We are OVER-TRACKING costs - recorded spend is higher than actual');
  } else {
    console.log('✓ Costs are perfectly reconciled');
  }

  if (!dryRun && callsNeedingCostUpdate.length > 0) {
    console.log('');
    console.log('='.repeat(70));
    console.log('APPLYING TWILIO COST UPDATES...');
    console.log('='.repeat(70));

    let updatedCount = 0;
    for (const record of callsNeedingCostUpdate) {
      const currentCall = dbCalls.find(c => c.id === record.id);
      const openaiCost = currentCall?.openaiCostCents || 0;
      
      await db.update(callLogs)
        .set({
          twilioCostCents: record.newCostCents,
          totalCostCents: record.newCostCents + openaiCost,
        })
        .where(eq(callLogs.id, record.id));
      updatedCount++;
    }
    console.log(`Updated ${updatedCount} call records with correct Twilio costs`);
  }

  return {
    dateRange,
    twilio: {
      csvTotalCents: twilioCsvTotalCents,
      dbTotalCents: dbTwilioCostCents,
      discrepancyCents: twilioCsvTotalCents - dbTwilioCostCents,
      callsInCsv: inboundPhoneCalls.length,
      callsMatched: matched.length,
      callsUpdated: dryRun ? 0 : callsNeedingCostUpdate.length,
      callsMissingCost: callsNeedingCostUpdate.length,
    },
    openai: {
      csvTotalCents: openaiCsvTotalCents,
      dbTotalCents: dbOpenaiCostCents,
      discrepancyCents: openaiCsvTotalCents - dbOpenaiCostCents,
      dailyBreakdown,
    },
    summary: {
      totalActualCents,
      totalTrackedCents,
      totalDiscrepancyCents,
      discrepancyPercent,
    },
  };
}

async function main() {
  const twilioCsvPath = process.argv[2];
  const openaiCsvPath = process.argv[3];
  const dryRun = process.argv[4] !== '--apply';

  if (!twilioCsvPath || !openaiCsvPath) {
    console.log('Usage: npx tsx scripts/reconcileCosts.ts <twilio-csv> <openai-csv> [--apply]');
    console.log('');
    console.log('Example:');
    console.log('  npx tsx scripts/reconcileCosts.ts attached_assets/twilio-calls.csv attached_assets/openai-costs.csv');
    console.log('  npx tsx scripts/reconcileCosts.ts attached_assets/twilio-calls.csv attached_assets/openai-costs.csv --apply');
    process.exit(1);
  }

  if (!fs.existsSync(twilioCsvPath)) {
    console.error(`Twilio CSV file not found: ${twilioCsvPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(openaiCsvPath)) {
    console.error(`OpenAI CSV file not found: ${openaiCsvPath}`);
    process.exit(1);
  }

  try {
    const report = await reconcileCosts(twilioCsvPath, openaiCsvPath, dryRun);
    
    console.log('');
    console.log('='.repeat(70));
    console.log('NEXT STEPS');
    console.log('='.repeat(70));
    
    if (dryRun) {
      console.log('This was a DRY RUN. No changes were made.');
      console.log('To apply Twilio cost corrections, run with --apply flag');
    } else {
      console.log('Twilio cost corrections have been applied.');
    }
    
    console.log('');
    console.log('Note: OpenAI costs are calculated from tokens at call-end and cannot be');
    console.log('retroactively corrected from daily aggregates. Large discrepancies may');
    console.log('indicate calls that timed out without proper token capture.');
    
    const jsonReportPath = `attached_assets/reconciliation-report-${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${jsonReportPath}`);
    
    process.exit(0);
  } catch (error) {
    console.error('Reconciliation failed:', error);
    process.exit(1);
  }
}

main();
