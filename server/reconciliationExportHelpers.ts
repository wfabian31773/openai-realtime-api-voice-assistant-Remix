export interface ReconciliationRow {
  dateUtc: string;
  actualUsd: string | number | null;
  estimatedUsd: string | number | null;
  deltaUsd: string | number | null;
  deltaPercent: string | number | null;
  hasDiscrepancyAlert: boolean | null;
}

export interface OrgUsageRow {
  dateUtc: string;
  model: string;
  estimatedCostCents: number | null;
}

export interface TwilioCostRow {
  dateUtc: string;
  totalCostCents: number | null;
}

export function buildReconciliationCsv(
  reconciliations: ReconciliationRow[],
  orgUsageRows: OrgUsageRow[],
  twilioRows: TwilioCostRow[],
): string {
  const twilioCostByDate: Record<string, number> = {};
  for (const row of twilioRows) {
    twilioCostByDate[row.dateUtc] = (row.totalCostCents || 0) / 100;
  }

  const modelCostByDate: Record<string, Record<string, number>> = {};
  for (const row of orgUsageRows) {
    if (!modelCostByDate[row.dateUtc]) modelCostByDate[row.dateUtc] = {};
    modelCostByDate[row.dateUtc][row.model] =
      (modelCostByDate[row.dateUtc][row.model] || 0) + (row.estimatedCostCents || 0);
  }

  const allModels = [...new Set(orgUsageRows.map(r => r.model))].sort();

  const reconciliationByDate: Record<string, ReconciliationRow> = {};
  for (const r of reconciliations) {
    reconciliationByDate[r.dateUtc] = r;
  }

  const allDates = [
    ...new Set([
      ...reconciliations.map(r => r.dateUtc),
      ...twilioRows.map(r => r.dateUtc),
    ]),
  ].sort();

  const headers = [
    'date',
    'actual_billed_usd',
    'estimated_usd',
    'delta_usd',
    'delta_percent',
    'has_discrepancy_alert',
    'twilio_actual_usd',
    'combined_total_usd',
    ...allModels.map(m => `model_${m}_cents`),
  ];
  const csvLines: string[] = [headers.join(',')];

  let totalActualUsd = 0;
  let totalEstimatedUsd = 0;
  let totalDeltaUsd = 0;
  let totalTwilioUsd = 0;
  let totalCombinedUsd = 0;
  const totalModelCents: Record<string, number> = {};

  for (const dateUtc of allDates) {
    const r = reconciliationByDate[dateUtc];
    const modelCosts = modelCostByDate[dateUtc] || {};
    const modelValues = allModels.map(m => modelCosts[m] || 0);
    const twilioUsd = twilioCostByDate[dateUtc] || 0;
    const openaiUsd = Number(r?.actualUsd || 0);
    const combinedUsd = openaiUsd + twilioUsd;
    const row = [
      dateUtc,
      openaiUsd.toFixed(4),
      Number(r?.estimatedUsd || 0).toFixed(4),
      Number(r?.deltaUsd || 0).toFixed(4),
      Number(r?.deltaPercent || 0).toFixed(2),
      r?.hasDiscrepancyAlert ? 'true' : 'false',
      twilioUsd.toFixed(4),
      combinedUsd.toFixed(4),
      ...modelValues,
    ];
    csvLines.push(row.join(','));

    totalActualUsd += openaiUsd;
    totalEstimatedUsd += Number(r?.estimatedUsd || 0);
    totalDeltaUsd += Number(r?.deltaUsd || 0);
    totalTwilioUsd += twilioUsd;
    totalCombinedUsd += combinedUsd;
    for (const m of allModels) {
      totalModelCents[m] = (totalModelCents[m] || 0) + (modelCosts[m] || 0);
    }
  }

  const totalRow = [
    'TOTAL',
    totalActualUsd.toFixed(4),
    totalEstimatedUsd.toFixed(4),
    totalDeltaUsd.toFixed(4),
    '',
    '',
    totalTwilioUsd.toFixed(4),
    totalCombinedUsd.toFixed(4),
    ...allModels.map(m => totalModelCents[m] || 0),
  ];
  csvLines.push(totalRow.join(','));

  return csvLines.join('\n');
}
