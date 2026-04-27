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
});
