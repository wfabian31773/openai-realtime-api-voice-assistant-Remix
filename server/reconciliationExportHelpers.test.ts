import { describe, it, expect } from 'vitest';
import { buildReconciliationCsv } from './reconciliationExportHelpers';

function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

describe('buildReconciliationCsv', () => {
  it('includes Twilio-only dates not present in dailyReconciliation', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '5.00',
        estimatedUsd: '4.50',
        deltaUsd: '0.50',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 300 },
      { dateUtc: '2025-01-02', totalCostCents: 750 },
    ];

    const csv = buildReconciliationCsv(reconciliations, [], twilioRows);
    const rows = parseCsv(csv);

    const dates = rows.map(r => r.date);
    expect(dates).toContain('2025-01-02');
  });

  it('shows 0.00 for OpenAI columns on Twilio-only rows', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '5.00',
        estimatedUsd: '4.50',
        deltaUsd: '0.50',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 300 },
      { dateUtc: '2025-01-02', totalCostCents: 750 },
    ];

    const csv = buildReconciliationCsv(reconciliations, [], twilioRows);
    const rows = parseCsv(csv);

    const twilioOnlyRow = rows.find(r => r.date === '2025-01-02');
    expect(twilioOnlyRow).toBeDefined();
    expect(twilioOnlyRow!.actual_billed_usd).toBe('0.0000');
    expect(twilioOnlyRow!.estimated_usd).toBe('0.0000');
    expect(twilioOnlyRow!.delta_usd).toBe('0.0000');
    expect(twilioOnlyRow!.delta_percent).toBe('0.00');
    expect(twilioOnlyRow!.has_discrepancy_alert).toBe('false');
  });

  it('sets combined_total_usd equal to the Twilio value for Twilio-only rows', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '5.00',
        estimatedUsd: '4.50',
        deltaUsd: '0.50',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 300 },
      { dateUtc: '2025-01-02', totalCostCents: 750 },
    ];

    const csv = buildReconciliationCsv(reconciliations, [], twilioRows);
    const rows = parseCsv(csv);

    const twilioOnlyRow = rows.find(r => r.date === '2025-01-02');
    expect(twilioOnlyRow).toBeDefined();

    const expectedTwilioUsd = (750 / 100).toFixed(4);
    expect(twilioOnlyRow!.twilio_actual_usd).toBe(expectedTwilioUsd);
    expect(twilioOnlyRow!.combined_total_usd).toBe(expectedTwilioUsd);
  });

  it('correctly computes combined_total_usd for rows present in both sources', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '5.00',
        estimatedUsd: '4.50',
        deltaUsd: '0.50',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const twilioRows = [{ dateUtc: '2025-01-01', totalCostCents: 300 }];

    const csv = buildReconciliationCsv(reconciliations, [], twilioRows);
    const rows = parseCsv(csv);

    const row = rows.find(r => r.date === '2025-01-01');
    expect(row).toBeDefined();
    expect(row!.actual_billed_usd).toBe('5.0000');
    expect(row!.twilio_actual_usd).toBe('3.0000');
    expect(row!.combined_total_usd).toBe('8.0000');
  });

  it('produces correct header row', () => {
    const csv = buildReconciliationCsv([], [], []);
    const headers = csv.split('\n')[0].split(',');
    expect(headers).toEqual([
      'date',
      'actual_billed_usd',
      'estimated_usd',
      'delta_usd',
      'delta_percent',
      'has_discrepancy_alert',
      'twilio_actual_usd',
      'combined_total_usd',
    ]);
  });

  it('includes per-model cost columns for org usage rows', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '2.00',
        estimatedUsd: '1.80',
        deltaUsd: '0.20',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 150 },
      { dateUtc: '2025-01-01', model: 'gpt-4o-mini', estimatedCostCents: 30 },
    ];

    const twilioRows = [{ dateUtc: '2025-01-01', totalCostCents: 200 }];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, twilioRows);
    const rows = parseCsv(csv);

    const row = rows.find(r => r.date === '2025-01-01');
    expect(row).toBeDefined();
    expect(row!['model_gpt-4o_cents']).toBe('150');
    expect(row!['model_gpt-4o-mini_cents']).toBe('30');
  });

  it('sums multiple org usage rows for the same date and model', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '3.00',
        estimatedUsd: '2.80',
        deltaUsd: '0.20',
        deltaPercent: '7.14',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 100 },
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 75 },
      { dateUtc: '2025-01-01', model: 'gpt-4o-mini', estimatedCostCents: 20 },
      { dateUtc: '2025-01-01', model: 'gpt-4o-mini', estimatedCostCents: 5 },
    ];

    const twilioRows = [{ dateUtc: '2025-01-01', totalCostCents: 300 }];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, twilioRows);
    const rows = parseCsv(csv);

    const row = rows.find(r => r.date === '2025-01-01');
    expect(row).toBeDefined();
    expect(row!['model_gpt-4o_cents']).toBe('175');
    expect(row!['model_gpt-4o-mini_cents']).toBe('25');
  });

  it('sorts model column headers alphabetically', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '1.00',
        estimatedUsd: '0.90',
        deltaUsd: '0.10',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-01-01', model: 'gpt-4o-mini', estimatedCostCents: 10 },
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 50 },
      { dateUtc: '2025-01-01', model: 'gpt-3.5-turbo', estimatedCostCents: 5 },
    ];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, []);
    const headers = csv.split('\n')[0].split(',');
    const modelHeaders = headers.filter(h => h.startsWith('model_'));

    expect(modelHeaders).toEqual([
      'model_gpt-3.5-turbo_cents',
      'model_gpt-4o_cents',
      'model_gpt-4o-mini_cents',
    ]);
  });

  it('keeps model costs isolated to their own date across multiple dates', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '1.50',
        estimatedUsd: '1.40',
        deltaUsd: '0.10',
        deltaPercent: '6.67',
        hasDiscrepancyAlert: false,
      },
      {
        dateUtc: '2025-01-02',
        actualUsd: '3.00',
        estimatedUsd: '2.80',
        deltaUsd: '0.20',
        deltaPercent: '6.67',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 100 },
      { dateUtc: '2025-01-02', model: 'gpt-4o', estimatedCostCents: 200 },
    ];

    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 150 },
      { dateUtc: '2025-01-02', totalCostCents: 300 },
    ];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, twilioRows);
    const rows = parseCsv(csv);

    const row1 = rows.find(r => r.date === '2025-01-01');
    const row2 = rows.find(r => r.date === '2025-01-02');

    expect(row1).toBeDefined();
    expect(row2).toBeDefined();
    expect(row1!['model_gpt-4o_cents']).toBe('100');
    expect(row2!['model_gpt-4o_cents']).toBe('200');
  });

  it('keeps model costs isolated to their own date across three or more dates', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '1.00',
        estimatedUsd: '0.90',
        deltaUsd: '0.10',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
      {
        dateUtc: '2025-01-02',
        actualUsd: '2.00',
        estimatedUsd: '1.80',
        deltaUsd: '0.20',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
      {
        dateUtc: '2025-01-03',
        actualUsd: '3.00',
        estimatedUsd: '2.70',
        deltaUsd: '0.30',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 50 },
      { dateUtc: '2025-01-02', model: 'gpt-4o', estimatedCostCents: 80 },
      { dateUtc: '2025-01-03', model: 'gpt-4o', estimatedCostCents: 120 },
    ];

    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 100 },
      { dateUtc: '2025-01-02', totalCostCents: 200 },
      { dateUtc: '2025-01-03', totalCostCents: 300 },
    ];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, twilioRows);
    const rows = parseCsv(csv);

    const row1 = rows.find(r => r.date === '2025-01-01');
    const row2 = rows.find(r => r.date === '2025-01-02');
    const row3 = rows.find(r => r.date === '2025-01-03');

    expect(row1).toBeDefined();
    expect(row2).toBeDefined();
    expect(row3).toBeDefined();

    expect(row1!['model_gpt-4o_cents']).toBe('50');
    expect(row2!['model_gpt-4o_cents']).toBe('80');
    expect(row3!['model_gpt-4o_cents']).toBe('120');
  });

  it('sums multiple rows per model per date without accumulating across three or more dates', () => {
    const reconciliations = [
      {
        dateUtc: '2025-02-01',
        actualUsd: '2.00',
        estimatedUsd: '1.80',
        deltaUsd: '0.20',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
      {
        dateUtc: '2025-02-02',
        actualUsd: '4.00',
        estimatedUsd: '3.60',
        deltaUsd: '0.40',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
      {
        dateUtc: '2025-02-03',
        actualUsd: '6.00',
        estimatedUsd: '5.40',
        deltaUsd: '0.60',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-02-01', model: 'gpt-4o', estimatedCostCents: 40 },
      { dateUtc: '2025-02-01', model: 'gpt-4o', estimatedCostCents: 60 },
      { dateUtc: '2025-02-02', model: 'gpt-4o', estimatedCostCents: 90 },
      { dateUtc: '2025-02-02', model: 'gpt-4o', estimatedCostCents: 110 },
      { dateUtc: '2025-02-03', model: 'gpt-4o', estimatedCostCents: 130 },
      { dateUtc: '2025-02-03', model: 'gpt-4o', estimatedCostCents: 170 },
    ];

    const twilioRows = [
      { dateUtc: '2025-02-01', totalCostCents: 100 },
      { dateUtc: '2025-02-02', totalCostCents: 200 },
      { dateUtc: '2025-02-03', totalCostCents: 300 },
    ];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, twilioRows);
    const rows = parseCsv(csv);

    const row1 = rows.find(r => r.date === '2025-02-01');
    const row2 = rows.find(r => r.date === '2025-02-02');
    const row3 = rows.find(r => r.date === '2025-02-03');

    expect(row1).toBeDefined();
    expect(row2).toBeDefined();
    expect(row3).toBeDefined();

    expect(row1!['model_gpt-4o_cents']).toBe('100');
    expect(row2!['model_gpt-4o_cents']).toBe('200');
    expect(row3!['model_gpt-4o_cents']).toBe('300');
  });

  it('sums only non-null estimatedCostCents and produces no NaN when some entries are null', () => {
    const reconciliations = [
      {
        dateUtc: '2025-03-01',
        actualUsd: '1.00',
        estimatedUsd: '0.90',
        deltaUsd: '0.10',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
      {
        dateUtc: '2025-03-02',
        actualUsd: '2.00',
        estimatedUsd: '1.80',
        deltaUsd: '0.20',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
      {
        dateUtc: '2025-03-03',
        actualUsd: '3.00',
        estimatedUsd: '2.70',
        deltaUsd: '0.30',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-03-01', model: 'gpt-4o', estimatedCostCents: 100 },
      { dateUtc: '2025-03-01', model: 'gpt-4o', estimatedCostCents: null },
      { dateUtc: '2025-03-02', model: 'gpt-4o', estimatedCostCents: null },
      { dateUtc: '2025-03-02', model: 'gpt-4o', estimatedCostCents: null },
      { dateUtc: '2025-03-03', model: 'gpt-4o', estimatedCostCents: 75 },
      { dateUtc: '2025-03-03', model: 'gpt-4o', estimatedCostCents: 25 },
    ];

    const twilioRows = [
      { dateUtc: '2025-03-01', totalCostCents: 100 },
      { dateUtc: '2025-03-02', totalCostCents: 200 },
      { dateUtc: '2025-03-03', totalCostCents: 300 },
    ];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, twilioRows);
    const rows = parseCsv(csv);

    const row1 = rows.find(r => r.date === '2025-03-01');
    const row2 = rows.find(r => r.date === '2025-03-02');
    const row3 = rows.find(r => r.date === '2025-03-03');

    expect(row1).toBeDefined();
    expect(row2).toBeDefined();
    expect(row3).toBeDefined();

    expect(row1!['model_gpt-4o_cents']).toBe('100');
    expect(row1!['model_gpt-4o_cents']).not.toBe('NaN');

    expect(row2!['model_gpt-4o_cents']).toBe('0');
    expect(row2!['model_gpt-4o_cents']).not.toBe('NaN');

    expect(row3!['model_gpt-4o_cents']).toBe('100');
    expect(row3!['model_gpt-4o_cents']).not.toBe('NaN');
  });

  it('outputs zero model costs for Twilio-only rows when org usage exists for other dates', () => {
    const reconciliations = [
      {
        dateUtc: '2025-01-01',
        actualUsd: '2.00',
        estimatedUsd: '1.80',
        deltaUsd: '0.20',
        deltaPercent: '11.11',
        hasDiscrepancyAlert: false,
      },
    ];

    const orgUsageRows = [
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 150 },
    ];

    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 200 },
      { dateUtc: '2025-01-02', totalCostCents: 400 },
    ];

    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, twilioRows);
    const rows = parseCsv(csv);

    const twilioOnlyRow = rows.find(r => r.date === '2025-01-02');
    expect(twilioOnlyRow).toBeDefined();
    expect(twilioOnlyRow!['model_gpt-4o_cents']).toBe('0');
  });

  it('appends a TOTAL row as the last row', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '10.00', estimatedUsd: '9.00', deltaUsd: '1.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
      { dateUtc: '2025-01-02', actualUsd: '20.00', estimatedUsd: '18.00', deltaUsd: '2.00', deltaPercent: '11.11', hasDiscrepancyAlert: true },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], []);
    const rows = parseCsv(csv);
    expect(rows[rows.length - 1].date).toBe('TOTAL');
  });

  it('TOTAL row sums actual_billed_usd across all data rows', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '10.00', estimatedUsd: '9.00', deltaUsd: '1.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
      { dateUtc: '2025-01-02', actualUsd: '20.00', estimatedUsd: '18.00', deltaUsd: '2.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], []);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(parseFloat(total.actual_billed_usd)).toBeCloseTo(30.0, 4);
  });

  it('TOTAL row sums estimated_usd across all data rows', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '10.00', estimatedUsd: '9.00', deltaUsd: '1.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
      { dateUtc: '2025-01-02', actualUsd: '20.00', estimatedUsd: '18.00', deltaUsd: '2.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], []);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(parseFloat(total.estimated_usd)).toBeCloseTo(27.0, 4);
  });

  it('TOTAL row sums delta_usd across all data rows', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '10.00', estimatedUsd: '9.00', deltaUsd: '1.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
      { dateUtc: '2025-01-02', actualUsd: '20.00', estimatedUsd: '18.00', deltaUsd: '2.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], []);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(parseFloat(total.delta_usd)).toBeCloseTo(3.0, 4);
  });

  it('TOTAL row sums twilio_actual_usd across all data rows', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '5.00', estimatedUsd: '4.50', deltaUsd: '0.50', deltaPercent: '11.11', hasDiscrepancyAlert: false },
    ];
    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 1000 },
      { dateUtc: '2025-01-02', totalCostCents: 2000 },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], twilioRows);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(parseFloat(total.twilio_actual_usd)).toBeCloseTo(30.0, 4);
  });

  it('TOTAL row sums combined_total_usd across all data rows', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '5.00', estimatedUsd: '4.50', deltaUsd: '0.50', deltaPercent: '11.11', hasDiscrepancyAlert: false },
    ];
    const twilioRows = [
      { dateUtc: '2025-01-01', totalCostCents: 1000 },
      { dateUtc: '2025-01-02', totalCostCents: 2000 },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], twilioRows);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(parseFloat(total.combined_total_usd)).toBeCloseTo(5.0 + 10.0 + 20.0, 4);
  });

  it('TOTAL row sums per-model cost columns across all data rows', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '1.00', estimatedUsd: '0.90', deltaUsd: '0.10', deltaPercent: '11.11', hasDiscrepancyAlert: false },
      { dateUtc: '2025-01-02', actualUsd: '2.00', estimatedUsd: '1.80', deltaUsd: '0.20', deltaPercent: '11.11', hasDiscrepancyAlert: false },
    ];
    const orgUsageRows = [
      { dateUtc: '2025-01-01', model: 'gpt-4o', estimatedCostCents: 500 },
      { dateUtc: '2025-01-01', model: 'gpt-4o-mini', estimatedCostCents: 100 },
      { dateUtc: '2025-01-02', model: 'gpt-4o', estimatedCostCents: 800 },
      { dateUtc: '2025-01-02', model: 'gpt-4o-mini', estimatedCostCents: 200 },
    ];
    const csv = buildReconciliationCsv(reconciliations, orgUsageRows, []);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(parseFloat(total['model_gpt-4o_cents'])).toBeCloseTo(1300, 0);
    expect(parseFloat(total['model_gpt-4o-mini_cents'])).toBeCloseTo(300, 0);
  });

  it('TOTAL row leaves delta_percent blank', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '10.00', estimatedUsd: '9.00', deltaUsd: '1.00', deltaPercent: '11.11', hasDiscrepancyAlert: false },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], []);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(total.delta_percent).toBe('');
  });

  it('TOTAL row leaves has_discrepancy_alert blank', () => {
    const reconciliations = [
      { dateUtc: '2025-01-01', actualUsd: '10.00', estimatedUsd: '9.00', deltaUsd: '1.00', deltaPercent: '11.11', hasDiscrepancyAlert: true },
    ];
    const csv = buildReconciliationCsv(reconciliations, [], []);
    const rows = parseCsv(csv);
    const total = rows.find(r => r.date === 'TOTAL')!;
    expect(total.has_discrepancy_alert).toBe('');
  });

  it('TOTAL row shows zeros when there are no data rows', () => {
    const csv = buildReconciliationCsv([], [], []);
    const rows = parseCsv(csv);
    expect(rows.length).toBe(1);
    const total = rows[0];
    expect(total.date).toBe('TOTAL');
    expect(total.actual_billed_usd).toBe('0.0000');
    expect(total.combined_total_usd).toBe('0.0000');
  });
});
