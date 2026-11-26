import { describe, expect, it } from 'vitest';
import { RUNTIME_CAMPAIGN_COUNTS_SQL, withRuntimeCounts } from './campaignCounts';

describe('withRuntimeCounts', () => {
  const hub = (rows: Record<string, unknown>[]) => ({
    sent: [] as string[],
    async query(text: string) {
      this.sent.push(text);
      if (text !== RUNTIME_CAMPAIGN_COUNTS_SQL) throw new Error('unexpected statement');
      return { rows };
    },
  });

  it('counts NPX outreach from its contacts instead of showing 0/0 (2026-11-26: 1,472 / 1,414 / 192)', async () => {
    const h = hub([{ campaign_id: 'npx', total: 1472, contacted: 1414, completed: 192 }]);
    const out = await withRuntimeCounts(h, [
      { id: 'npx', campaignType: 'runtime_outbound', totalContacts: 0, completedContacts: 0, successfulContacts: 0 },
      { id: 'old', campaignType: 'call', totalContacts: 379, completedContacts: 0, successfulContacts: 0 },
    ]);
    expect(out[0]).toMatchObject({ totalContacts: 1472, completedContacts: 1414, successfulContacts: 192 });
    expect(out[1]).toMatchObject({ totalContacts: 379, completedContacts: 0 });
  });

  it('reads nothing when no campaign is a runtime campaign', async () => {
    const h = hub([]);
    await withRuntimeCounts(h, [{ id: 'old', campaignType: 'call' }]);
    expect(h.sent).toEqual([]);
  });

  it('shows a runtime campaign with no contacts as zero', async () => {
    const out = await withRuntimeCounts(hub([]), [{ id: 'empty', campaignType: 'runtime_outbound', totalContacts: 9 }]);
    expect(out[0].totalContacts).toBe(0);
  });

  it('selects no patient data', () => {
    expect(RUNTIME_CAMPAIGN_COUNTS_SQL).not.toMatch(/phone|name|date_of_birth|custom_data/i);
  });
});
