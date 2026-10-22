import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidBriefDate, parseBriefDateParam, pickYesterday } from './dailyBrief.logic';

/**
 * The Daily Brief day picker. The rule that matters most: asking for a past
 * day is READ ONLY — it must never generate or write a brief. Synthetic
 * payloads only; no call or patient data.
 */

const query = vi.fn();
vi.mock('../db', () => ({ pool: { query: (...args: unknown[]) => query(...args) } }));
vi.mock('./fivestarDb', () => ({ fivestarQuery: vi.fn() }));

function payload(briefDate: string, extra: Record<string, unknown> = {}) {
  return {
    briefDate,
    generatedAt: `${briefDate}T13:00:00.000Z`,
    agents: [{ agentId: 'a1', agentSlug: 'tech', agentName: 'Tech', calls: 10, criticalCalls: 2, criticalRate: 0.2, quality: 4 }],
    categories: [],
    sage: { error: 'n/a' },
    syncReds: [],
    ...extra,
  };
}

const STORED = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'];

/** A pool that answers the two read statements from STORED and records everything. */
function fakePool() {
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^\s*SELECT payload FROM observatory_daily_briefs WHERE brief_date = \$1::date/.test(sql)) {
      const d = String(params?.[0]);
      return { rows: STORED.includes(d) ? [{ payload: payload(d) }] : [] };
    }
    if (/SELECT brief_date::text AS d, payload FROM observatory_daily_briefs ORDER BY brief_date ASC/.test(sql)) {
      return { rows: STORED.map((d) => ({ d, payload: payload(d) })) };
    }
    throw new Error(`unexpected SQL in a read-only path: ${sql.slice(0, 80)}`);
  });
}

const statements = () => query.mock.calls.map((c) => String(c[0]));

describe('isValidBriefDate', () => {
  it('accepts real days', () => {
    expect(isValidBriefDate('2026-10-01')).toBe(true);
    expect(isValidBriefDate('2028-02-29')).toBe(true);
  });
  it('refuses impossible days and other shapes', () => {
    for (const v of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '20261001', '2026-10-01T00:00', ' 2026-10-01', "2026-10-01' OR 1=1"]) {
      expect(isValidBriefDate(v), v).toBe(false);
    }
  });
});

describe('parseBriefDateParam', () => {
  it('absent or empty is the latest brief', () => {
    expect(parseBriefDateParam(undefined)).toEqual({ kind: 'latest' });
    expect(parseBriefDateParam('')).toEqual({ kind: 'latest' });
  });
  it('a valid day is that day', () => {
    expect(parseBriefDateParam('2026-10-05')).toEqual({ kind: 'date', date: '2026-10-05' });
  });
  it('an invalid day, or a repeated parameter, is invalid', () => {
    expect(parseBriefDateParam('2026-02-31').kind).toBe('invalid');
    expect(parseBriefDateParam(['2026-10-01', '2026-10-02']).kind).toBe('invalid');
    expect(parseBriefDateParam({ a: 1 }).kind).toBe('invalid');
  });
});

describe('pickYesterday', () => {
  const rows = STORED.map((d) => ({ d }));
  it('is the stored row immediately before the SELECTED day, skipping gaps', () => {
    expect(pickYesterday(rows, '2026-10-05')?.d).toBe('2026-10-02');
    expect(pickYesterday(rows, '2026-10-06')?.d).toBe('2026-10-05');
  });
  it('is null for the first stored day', () => {
    expect(pickYesterday(rows, '2026-10-01')).toBeNull();
  });
  it('works for a day that is not itself stored', () => {
    expect(pickYesterday(rows, '2026-10-04')?.d).toBe('2026-10-02');
  });
});

describe('dailyBriefResponse', () => {
  beforeEach(() => {
    query.mockReset();
    fakePool();
  });

  it('a past day reads its stored row and never writes', async () => {
    const { dailyBriefResponse } = await import('./dailyBrief');
    const res = await dailyBriefResponse('2026-10-05');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.selectedDate).toBe('2026-10-05');
    expect(body.today.briefDate).toBe('2026-10-05');
    expect(body.yesterday.briefDate).toBe('2026-10-02');
    expect(body.baselineDate).toBe('2026-10-01');
    expect(body.availableDates).toEqual(STORED);
    expect(statements().some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
    expect(query.mock.calls[0][1]).toEqual(['2026-10-05']);
  });

  it('a day with no stored brief is 404 and nothing is generated', async () => {
    const { dailyBriefResponse } = await import('./dailyBrief');
    const res = await dailyBriefResponse('2026-10-03');
    expect(res.status).toBe(404);
    expect(statements()).toHaveLength(1);
    expect(statements().some((s) => /INSERT/i.test(s))).toBe(false);
  });

  it('a malformed date is 400 and touches no database', async () => {
    const { dailyBriefResponse } = await import('./dailyBrief');
    for (const bad of ['2026-02-30', 'yesterday', "2026-10-01'; DROP TABLE x;--"]) {
      expect((await dailyBriefResponse(bad)).status).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('carries a backfill correction through untouched', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/WHERE brief_date = \$1::date/.test(sql)) {
        return { rows: [{ payload: payload(String(params?.[0]), { correction: { label: 'Backfilled', correctedAt: '2026-10-21T00:00:00Z' } }) }] };
      }
      return { rows: STORED.map((d) => ({ d, payload: payload(d) })) };
    });
    const { dailyBriefResponse } = await import('./dailyBrief');
    const res = await dailyBriefResponse('2026-10-02');
    expect((res.body as any).today.correction.label).toBe('Backfilled');
  });
});
