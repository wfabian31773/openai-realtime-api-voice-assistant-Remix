import { db } from '../../server/db';
import { dailyOrgUsage, dailyOpenaiCosts } from '../../shared/schema';
import { storage } from '../../server/storage';
import { and, eq, gte, lte } from 'drizzle-orm';

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
  console.warn(`[CSV IMPORT] Unknown model "${model}", falling back to gpt-realtime pricing`);
  return MODEL_PRICING['gpt-realtime'];
}

export interface CsvUsageRow {
  dateUtc: string;
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
  serviceTier: string;
  projectId: string;
  apiKeyId: string;
}

export interface CsvImportResult {
  totalRows: number;
  skippedRows: number;
  datesImported: number;
  totalEstimatedCostDollars: number;
  costByModel: Record<string, number>;
  costByDate: Record<string, number>;
  dailyBreakdown: Array<{
    date: string;
    totalCostDollars: number;
    models: Array<{ model: string; costDollars: number; requests: number }>;
  }>;
}

export interface AuditReport {
  period: { startDate: string; endDate: string };
  csvTotals: {
    totalCostDollars: number;
    costByModel: Record<string, number>;
  };
  internalTotals: {
    orgBilledDollars: number;
    perCallEstimatedDollars: number;
  };
  discrepancy: {
    csvVsOrgBilled: number;
    orgBilledVsPerCall: number;
  };
  dailyComparison: Array<{
    date: string;
    csvCostDollars: number;
    orgBilledDollars: number;
    perCallDollars: number;
    unallocatedDollars: number;
  }>;
}

export function parseOpenAICsv(csvContent: string): CsvUsageRow[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    console.error('[CSV IMPORT] CSV content has no data rows');
    return [];
  }

  const headers = lines[0].split(',');
  const headerIndex: Record<string, number> = {};
  headers.forEach((h, i) => { headerIndex[h.trim()] = i; });

  const rows: CsvUsageRow[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split(',');

    const numModelRequests = parseInt(fields[headerIndex['num_model_requests']] || '0', 10);
    if (numModelRequests < 0) {
      skipped++;
      console.warn(`[CSV IMPORT] Skipping row ${i + 1}: negative num_model_requests (${numModelRequests}) — adjustment/refund`);
      continue;
    }

    const startTimeIso = fields[headerIndex['start_time_iso']] || '';
    const dateUtc = startTimeIso.substring(0, 10);

    rows.push({
      dateUtc,
      model: fields[headerIndex['model']] || 'unknown',
      numModelRequests,
      inputTokens: parseInt(fields[headerIndex['input_tokens']] || '0', 10),
      outputTokens: parseInt(fields[headerIndex['output_tokens']] || '0', 10),
      inputCachedTokens: parseInt(fields[headerIndex['input_cached_tokens']] || '0', 10),
      inputTextTokens: parseInt(fields[headerIndex['input_text_tokens']] || '0', 10),
      outputTextTokens: parseInt(fields[headerIndex['output_text_tokens']] || '0', 10),
      inputCachedTextTokens: parseInt(fields[headerIndex['input_cached_text_tokens']] || '0', 10),
      inputAudioTokens: parseInt(fields[headerIndex['input_audio_tokens']] || '0', 10),
      inputCachedAudioTokens: parseInt(fields[headerIndex['input_cached_audio_tokens']] || '0', 10),
      outputAudioTokens: parseInt(fields[headerIndex['output_audio_tokens']] || '0', 10),
      serviceTier: fields[headerIndex['service_tier']] || '',
      projectId: fields[headerIndex['project_id']] || '',
      apiKeyId: fields[headerIndex['api_key_id']] || '',
    });
  }

  if (skipped > 0) {
    console.warn(`[CSV IMPORT] Skipped ${skipped} rows with negative num_model_requests (adjustments/refunds)`);
  }
  console.info(`[CSV IMPORT] Parsed ${rows.length} valid rows from CSV`);

  return rows;
}

export function calculateCostFromCsvRow(row: CsvUsageRow): number {
  const pricing = getModelPricing(row.model);

  const uncachedAudio = Math.max(0, row.inputAudioTokens - row.inputCachedAudioTokens);
  const uncachedText = Math.max(0, row.inputTextTokens - row.inputCachedTextTokens);

  const costDollars =
    (uncachedAudio / 1_000_000) * pricing.audioInputPerM +
    (row.inputCachedAudioTokens / 1_000_000) * pricing.audioInputCachedPerM +
    (row.outputAudioTokens / 1_000_000) * pricing.audioOutputPerM +
    (uncachedText / 1_000_000) * pricing.textInputPerM +
    (row.inputCachedTextTokens / 1_000_000) * pricing.textInputCachedPerM +
    (row.outputTextTokens / 1_000_000) * pricing.textOutputPerM;

  return Math.ceil(costDollars * 100);
}

export async function importCsvToDatabase(csvContent: string): Promise<CsvImportResult> {
  const rows = parseOpenAICsv(csvContent);
  const totalRows = rows.length;
  const allLines = csvContent.trim().split('\n');
  const skippedRows = allLines.length - 1 - totalRows;

  const rowsByDate: Record<string, CsvUsageRow[]> = {};
  for (const row of rows) {
    if (!rowsByDate[row.dateUtc]) {
      rowsByDate[row.dateUtc] = [];
    }
    rowsByDate[row.dateUtc].push(row);
  }

  const costByModel: Record<string, number> = {};
  const costByDate: Record<string, number> = {};
  const dailyBreakdown: CsvImportResult['dailyBreakdown'] = [];
  let totalEstimatedCostCents = 0;

  const dates = Object.keys(rowsByDate).sort();

  for (const dateStr of dates) {
    const dateRows = rowsByDate[dateStr];

    await db.delete(dailyOrgUsage).where(
      and(
        eq(dailyOrgUsage.dateUtc, dateStr),
        eq(dailyOrgUsage.source, 'csv')
      )
    );

    const models: Array<{ model: string; costDollars: number; requests: number }> = [];
    let dateCostCents = 0;

    const dbRows = dateRows.map((row) => {
      const costCents = calculateCostFromCsvRow(row);
      const costDollars = costCents / 100;

      costByModel[row.model] = (costByModel[row.model] || 0) + costDollars;
      dateCostCents += costCents;
      totalEstimatedCostCents += costCents;

      models.push({ model: row.model, costDollars, requests: row.numModelRequests });

      return {
        dateUtc: row.dateUtc,
        model: row.model,
        projectId: row.projectId,
        apiKeyId: row.apiKeyId,
        serviceTier: row.serviceTier,
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
        estimatedCostCents: costCents,
        source: 'csv' as const,
      };
    });

    if (dbRows.length > 0) {
      await db.insert(dailyOrgUsage).values(dbRows);
    }

    const dateCostDollars = dateCostCents / 100;
    costByDate[dateStr] = dateCostDollars;

    dailyBreakdown.push({
      date: dateStr,
      totalCostDollars: dateCostDollars,
      models,
    });

    console.info(`[CSV IMPORT] Imported ${dateRows.length} rows for ${dateStr}: $${dateCostDollars.toFixed(2)}`);
  }

  const totalEstimatedCostDollars = totalEstimatedCostCents / 100;

  console.info(`[CSV IMPORT] Import complete: ${totalRows} rows, ${dates.length} dates, $${totalEstimatedCostDollars.toFixed(2)} estimated total`);

  return {
    totalRows,
    skippedRows,
    datesImported: dates.length,
    totalEstimatedCostDollars,
    costByModel,
    costByDate,
    dailyBreakdown,
  };
}

export async function generateAuditReport(csvContent: string): Promise<AuditReport> {
  const rows = parseOpenAICsv(csvContent);

  const csvCostByModel: Record<string, number> = {};
  const csvCostByDate: Record<string, number> = {};
  let csvTotalCostCents = 0;

  for (const row of rows) {
    const costCents = calculateCostFromCsvRow(row);
    const costDollars = costCents / 100;
    csvCostByModel[row.model] = (csvCostByModel[row.model] || 0) + costDollars;
    csvCostByDate[row.dateUtc] = (csvCostByDate[row.dateUtc] || 0) + costDollars;
    csvTotalCostCents += costCents;
  }

  const csvTotalCostDollars = csvTotalCostCents / 100;

  const dates = Object.keys(csvCostByDate).sort();
  if (dates.length === 0) {
    console.error('[CSV IMPORT] No valid dates found in CSV for audit report');
    return {
      period: { startDate: '', endDate: '' },
      csvTotals: { totalCostDollars: 0, costByModel: {} },
      internalTotals: { orgBilledDollars: 0, perCallEstimatedDollars: 0 },
      discrepancy: { csvVsOrgBilled: 0, orgBilledVsPerCall: 0 },
      dailyComparison: [],
    };
  }

  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const costs = await db.select().from(dailyOpenaiCosts).where(
    and(gte(dailyOpenaiCosts.date, startDate), lte(dailyOpenaiCosts.date, endDate))
  );

  const orgBilledByDate: Record<string, number> = {};
  let orgBilledTotalCents = 0;
  for (const cost of costs) {
    const cents = cost.actualCostCents || 0;
    orgBilledByDate[cost.date] = cents / 100;
    orgBilledTotalCents += cents;
  }
  const orgBilledDollars = orgBilledTotalCents / 100;

  let perCallTotalCents = 0;
  const perCallByDate: Record<string, number> = {};
  for (const dateStr of dates) {
    const cents = await storage.getEstimatedOpenaiCostForDate(dateStr);
    perCallByDate[dateStr] = cents / 100;
    perCallTotalCents += cents;
  }
  const perCallDollars = perCallTotalCents / 100;

  const dailyComparison = dates.map((dateStr) => {
    const csvCost = csvCostByDate[dateStr] || 0;
    const orgBilled = orgBilledByDate[dateStr] || 0;
    const perCall = perCallByDate[dateStr] || 0;
    return {
      date: dateStr,
      csvCostDollars: csvCost,
      orgBilledDollars: orgBilled,
      perCallDollars: perCall,
      unallocatedDollars: orgBilled - perCall,
    };
  });

  const report: AuditReport = {
    period: { startDate, endDate },
    csvTotals: {
      totalCostDollars: csvTotalCostDollars,
      costByModel: csvCostByModel,
    },
    internalTotals: {
      orgBilledDollars: orgBilledDollars,
      perCallEstimatedDollars: perCallDollars,
    },
    discrepancy: {
      csvVsOrgBilled: csvTotalCostDollars - orgBilledDollars,
      orgBilledVsPerCall: orgBilledDollars - perCallDollars,
    },
    dailyComparison,
  };

  console.info(`[CSV IMPORT] Audit report: CSV=$${csvTotalCostDollars.toFixed(2)}, OrgBilled=$${orgBilledDollars.toFixed(2)}, PerCall=$${perCallDollars.toFixed(2)}`);
  console.info(`[CSV IMPORT] Discrepancy: CSV vs OrgBilled=$${report.discrepancy.csvVsOrgBilled.toFixed(2)}, Unallocated=$${report.discrepancy.orgBilledVsPerCall.toFixed(2)}`);

  return report;
}
