/**
 * "Failing since" is read from the stored runs at or before the report shown.
 * Another server can store a newer run while this one serves a cached report,
 * so a run after the shown time must not move the date (Codex review of #525).
 */
import { describe, expect, it } from 'vitest';
import { FAILING_SINCE_SQL, withHistory } from './accuracy';
import type { AccuracyReport } from './accuracy.logic';
import type { Queryable } from './checks';

const REPORT: AccuracyReport = {
  ranAt: '2026-11-26T10:05:00.000Z',
  counts: { pass: 0, fail: 1, unknown: 0 },
  results: [
    { id: 'cost.budget.spend-today', status: 'fail', claim: 'x'.repeat(12), truthSource: 'y'.repeat(12), screenValue: 1, truthValue: 2, note: null },
  ],
} as unknown as AccuracyReport;

/** A stored history: fail 09:05, pass 11:05, fail 12:05 (the newer two from another server). */
const HISTORY = [
  { check_id: 'cost.budget.spend-today', status: 'fail', ran_at: '2026-11-26T09:05:00.000Z' },
  { check_id: 'cost.budget.spend-today', status: 'pass', ran_at: '2026-11-26T11:05:00.000Z' },
  { check_id: 'cost.budget.spend-today', status: 'fail', ran_at: '2026-11-26T12:05:00.000Z' },
];

/** Evaluates the statement's rule over HISTORY, honouring the cutoff only if it is passed. */
function hub(): Queryable & { params: unknown[][] } {
  const params: unknown[][] = [];
  return {
    params,
    async query(text: string, values?: unknown[]) {
      if (text !== FAILING_SINCE_SQL) return { rows: [] };
      params.push(values ?? []);
      const cutoff = values?.[1] ? Date.parse(String(values[1])) : Infinity;
      const ids = (values?.[0] as string[]) ?? [];
      const rows = HISTORY.filter((h) => ids.includes(h.check_id) && Date.parse(h.ran_at) <= cutoff);
      const out: Array<{ check_id: string; since: string }> = [];
      for (const id of ids) {
        const mine = rows.filter((r) => r.check_id === id);
        const lastPass = Math.max(-Infinity, ...mine.filter((r) => r.status === 'pass').map((r) => Date.parse(r.ran_at)));
        const fails = mine.filter((r) => r.status === 'fail' && Date.parse(r.ran_at) > lastPass).map((r) => r.ran_at).sort();
        if (fails.length) out.push({ check_id: id, since: fails[0] });
      }
      return { rows: out };
    },
  };
}

describe('failing since', () => {
  it('is read up to the shown report only, never later than it', async () => {
    const q = hub();
    const res = await withHistory(q, REPORT);
    expect(q.params[0]?.[1]).toBe(REPORT.ranAt);
    const since = res.results[0].failingSince!;
    expect(since).toBe('2026-11-26T09:05:00.000Z');
    expect(Date.parse(since)).toBeLessThanOrEqual(Date.parse(REPORT.ranAt));
  });

  it('the statement cuts both the last pass and the failures at the report time', () => {
    expect(FAILING_SINCE_SQL.match(/ran_at <= \$2::timestamptz/g)?.length).toBe(2);
  });
});
