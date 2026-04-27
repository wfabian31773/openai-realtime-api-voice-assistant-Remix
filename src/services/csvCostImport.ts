import { db } from '../../server/db';
import { dailyOrgUsage, dailyOpenaiCosts } from '../../shared/schema';
import { storage } from '../../server/storage';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getModelPricing } from './modelPricing';

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
  detectedFormat: string;
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

export type CsvFormat = 'token-usage' | 'audio-speeches' | 'completions' | 'unknown';

const TOKEN_USAGE_REQUIRED = ['start_time_iso', 'model', 'num_model_requests'];
const AUDIO_SPEECHES_REQUIRED = ['num_characters'];
const COMPLETIONS_REQUIRED = ['tokens_used'];

export function detectCsvFormat(headers: string[]): CsvFormat {
  const headerSet = new Set(headers.map(h => h.trim().toLowerCase()));
  if (TOKEN_USAGE_REQUIRED.every(h => headerSet.has(h))) return 'token-usage';
  if (AUDIO_SPEECHES_REQUIRED.some(h => headerSet.has(h))) return 'audio-speeches';
  if (COMPLETIONS_REQUIRED.every(h => headerSet.has(h))) return 'completions';
  return 'unknown';
}

function getMissingColumns(headers: string[], required: string[]): string[] {
  const headerSet = new Set(headers.map(h => h.trim().toLowerCase()));
  return required.filter(h => !headerSet.has(h));
}

function getTtsCharacterCostDollars(model: string, numChars: number): number {
  const m = model.toLowerCase();
  let pricePerThousand = 0.015;
  if (m.includes('hd') || m.includes('tts-1-hd')) pricePerThousand = 0.030;
  else if (m.includes('gpt-4o-mini-tts')) pricePerThousand = 0.012;
  else if (m.includes('gpt-4o-tts')) pricePerThousand = 0.030;
  return (numChars / 1000) * pricePerThousand;
}

export function parseOpenAICsv(csvContent: string): CsvUsageRow[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    console.error('[CSV IMPORT] CSV content has no data rows');
    return [];
  }

  const rawHeaders = lines[0].split(',');
  const format = detectCsvFormat(rawHeaders);
  const headers = rawHeaders.map(h => h.trim());
  const headerIndex: Record<string, number> = {};
  headers.forEach((h, i) => { headerIndex[h] = i; });

  if (format === 'audio-speeches') {
    return parseAudioSpeechesCsv(lines, headerIndex);
  }

  if (format === 'completions') {
    return parseCompletionsCsv(lines, headerIndex);
  }

  if (format === 'unknown') {
    const allRequired = [...TOKEN_USAGE_REQUIRED, ...AUDIO_SPEECHES_REQUIRED];
    const missing = getMissingColumns(headers, TOKEN_USAGE_REQUIRED);
    console.error(`[CSV IMPORT] Unrecognized CSV format. Missing columns for token-usage format: ${missing.join(', ')}`);
    return [];
  }

  return parseTokenUsageCsv(lines, headerIndex);
}

function parseTokenUsageCsv(lines: string[], headerIndex: Record<string, number>): CsvUsageRow[] {
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
  console.info(`[CSV IMPORT] Parsed ${rows.length} valid token-usage rows from CSV`);

  return rows;
}

function parseAudioSpeechesCsv(lines: string[], headerIndex: Record<string, number>): CsvUsageRow[] {
  const rows: CsvUsageRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split(',');

    const dateRaw = fields[headerIndex['date'] ?? headerIndex['start_time_iso'] ?? -1] || '';
    const dateUtc = dateRaw.substring(0, 10);
    if (!dateUtc || dateUtc.length < 10) continue;

    const model = fields[headerIndex['model']] || 'tts-1';
    const numModelRequests = parseInt(fields[headerIndex['num_model_requests']] || '0', 10);
    const numChars = parseInt(fields[headerIndex['num_characters']] || '0', 10);
    const numSeconds = parseInt(fields[headerIndex['num_seconds'] ?? -1] || '0', 10);

    const costDollars = getTtsCharacterCostDollars(model, numChars);
    const costCents = Math.ceil(costDollars * 100);

    rows.push({
      dateUtc,
      model,
      numModelRequests,
      inputTokens: 0,
      outputTokens: numChars,
      inputCachedTokens: 0,
      inputTextTokens: numChars,
      outputTextTokens: 0,
      inputCachedTextTokens: 0,
      inputAudioTokens: 0,
      inputCachedAudioTokens: 0,
      outputAudioTokens: numSeconds ? numSeconds * 16000 / 1000 : 0,
      serviceTier: 'standard',
      projectId: fields[headerIndex['project_id']] || '',
      apiKeyId: fields[headerIndex['api_key_id']] || '',
    });
  }

  console.info(`[CSV IMPORT] Parsed ${rows.length} valid audio-speeches rows from CSV`);
  return rows;
}

function parseCompletionsCsv(lines: string[], headerIndex: Record<string, number>): CsvUsageRow[] {
  const rows: CsvUsageRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split(',');

    const dateRaw = fields[headerIndex['date'] ?? headerIndex['start_time_iso'] ?? -1] || '';
    const dateUtc = dateRaw.substring(0, 10);
    if (!dateUtc || dateUtc.length < 10) continue;

    const model = fields[headerIndex['model'] ?? headerIndex['model_id'] ?? -1] || 'gpt-4o';
    const requests = parseInt(fields[headerIndex['num_model_requests'] ?? headerIndex['request_count'] ?? -1] || '0', 10);
    const inputTokens = parseInt(fields[headerIndex['input_tokens'] ?? headerIndex['prompt_tokens'] ?? -1] || '0', 10);
    const outputTokens = parseInt(fields[headerIndex['output_tokens'] ?? headerIndex['completion_tokens'] ?? headerIndex['tokens_used'] ?? -1] || '0', 10);

    rows.push({
      dateUtc,
      model,
      numModelRequests: requests,
      inputTokens,
      outputTokens,
      inputCachedTokens: parseInt(fields[headerIndex['input_cached_tokens']] || '0', 10),
      inputTextTokens: inputTokens,
      outputTextTokens: outputTokens,
      inputCachedTextTokens: 0,
      inputAudioTokens: 0,
      inputCachedAudioTokens: 0,
      outputAudioTokens: 0,
      serviceTier: fields[headerIndex['service_tier']] || 'standard',
      projectId: fields[headerIndex['project_id']] || '',
      apiKeyId: fields[headerIndex['api_key_id']] || '',
    });
  }

  console.info(`[CSV IMPORT] Parsed ${rows.length} valid completions rows from CSV`);
  return rows;
}

export function calculateCostFromCsvRow(row: CsvUsageRow): number {
  const modelLower = row.model.toLowerCase();
  const isTts = modelLower.includes('tts') || modelLower.includes('audio-speech');

  if (isTts) {
    const numChars = row.inputTextTokens || row.outputTokens || 0;
    if (numChars > 0) {
      return Math.ceil(getTtsCharacterCostDollars(row.model, numChars) * 100);
    }
  }

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

export function validateCsvFormat(csvContent: string): { valid: boolean; format: CsvFormat; error?: string; missingColumns?: string[] } {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 1) {
    return { valid: false, format: 'unknown', error: 'CSV file is empty' };
  }

  const rawHeaders = lines[0].split(',');
  const format = detectCsvFormat(rawHeaders);

  if (format === 'unknown') {
    const missing = getMissingColumns(rawHeaders.map(h => h.trim()), TOKEN_USAGE_REQUIRED);
    return {
      valid: false,
      format: 'unknown',
      error: `Unrecognized CSV format. Expected one of: token-usage (requires: ${TOKEN_USAGE_REQUIRED.join(', ')}), audio-speeches (requires: num_characters column), or completions (requires: tokens_used column). Missing required columns for token-usage format: ${missing.join(', ')}`,
      missingColumns: missing,
    };
  }

  if (lines.length < 2) {
    return { valid: false, format, error: `Detected format "${format}" but CSV has no data rows` };
  }

  return { valid: true, format };
}

export async function importCsvToDatabase(csvContent: string): Promise<CsvImportResult> {
  const validation = validateCsvFormat(csvContent);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const rows = parseOpenAICsv(csvContent);
  const detectedFormat = validation.format;

  if (rows.length === 0) {
    throw new Error(`CSV was parsed as format "${detectedFormat}" but produced 0 rows. Check that the file has valid data rows.`);
  }

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

  console.info(`[CSV IMPORT] Import complete: ${totalRows} rows, ${dates.length} dates, format=${detectedFormat}, $${totalEstimatedCostDollars.toFixed(2)} estimated total`);

  return {
    totalRows,
    skippedRows,
    datesImported: dates.length,
    totalEstimatedCostDollars,
    costByModel,
    costByDate,
    detectedFormat,
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

export function parseTwilioCsv(csvContent: string): Array<{
  dateUtc: string;
  category: string;
  phoneNumber: string;
  durationSeconds: number;
  costCents: number;
}> {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('Twilio CSV file is empty or has no data rows');
  }

  const rawHeaders = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const headerIndex: Record<string, number> = {};
  rawHeaders.forEach((h, i) => { headerIndex[h] = i; });

  const hasDate = 'date' in headerIndex || 'start_date' in headerIndex || 'start_time' in headerIndex;
  const hasCost = 'price' in headerIndex || 'cost' in headerIndex || 'total_price' in headerIndex;

  if (!hasDate || !hasCost) {
    const missing: string[] = [];
    if (!hasDate) missing.push('date (or start_date, start_time)');
    if (!hasCost) missing.push('price (or cost, total_price)');
    throw new Error(`Unrecognized Twilio CSV format. Missing required columns: ${missing.join(', ')}. Expected columns: date, price (or equivalent).`);
  }

  const getField = (fields: string[], keys: string[]): string => {
    for (const k of keys) {
      if (k in headerIndex) {
        return (fields[headerIndex[k]] || '').replace(/['"]/g, '').trim();
      }
    }
    return '';
  };

  const rows: Array<{ dateUtc: string; category: string; phoneNumber: string; durationSeconds: number; costCents: number }> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split(',');

    const dateRaw = getField(fields, ['date', 'start_date', 'start_time']);
    const dateUtc = dateRaw.substring(0, 10);
    if (!dateUtc || dateUtc.length < 10) continue;

    const costStr = getField(fields, ['price', 'cost', 'total_price']).replace(/[$"']/g, '');
    const costDollars = parseFloat(costStr) || 0;
    // Twilio exports charges as negative prices (e.g. -0.05 = $0.05 charge).
    // Credits/refunds appear as positive values (e.g. +5.00 = $5 credit).
    // Negate so that charges become positive cents and credits become negative cents,
    // preserving the sign so they net correctly when summed per day.
    const costCents = Math.round(-costDollars * 100);

    const category = getField(fields, ['category', 'type', 'description', 'product']);
    const phoneNumber = getField(fields, ['phone_number', 'to', 'from', 'number']);
    const durationRaw = getField(fields, ['duration', 'duration_seconds', 'call_duration']);
    const durationSeconds = parseInt(durationRaw, 10) || 0;

    rows.push({ dateUtc, category, phoneNumber, durationSeconds, costCents });
  }

  return rows;
}
