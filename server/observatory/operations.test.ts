/**
 * The rebuilt Operations Monitor. A fake database keyed by the exact SQL text,
 * fed the counts measured on production 2026-11-26 02:58 UTC (the last 24
 * hours: 662 calls, 10 dropped by the voice provider, 5 dead air). Synthetic
 * CallSids only; no patient data.
 */
import { describe, expect, it } from 'vitest';
import {
  judge,
  LANES_SQL,
  PROBLEMS_SQL,
  readOperations,
  RECONNECTS_SQL,
  STUCK_AFTER_MINUTES,
  THRESHOLDS,
  TOTALS_SQL,
  type OperationsReport,
  type Queryable,
} from './operations';

const DAY_TOTALS = {
  total: 662, live: 0, stuck: 0, dropped: 10, failed_other: 1, dead_air: 5, caller_silent: 3,
  transferred: 71, with_ticket: 430, graded: 655, old_core: 0, last_call_at: '2026-11-26T01:56:47.628Z',
};

function hub(over: Partial<Record<string, Record<string, unknown>[] | Error>> = {}): Queryable & { sent: Array<[string, unknown[]]> } {
  const rows: Record<string, Record<string, unknown>[] | Error> = {
    [TOTALS_SQL]: [DAY_TOTALS],
    [LANES_SQL]: [
      { lane: 'pcp', calls: 173, dropped: 0, dead_air: 1, transferred: 71, with_ticket: 73, avg_seconds: 240 },
      { lane: 'surgery', calls: 91, dropped: 3, dead_air: 0, transferred: 0, with_ticket: 65, avg_seconds: 95 },
    ],
    [PROBLEMS_SQL]: [
      { id: '9001', call_sid: `CA${'a'.repeat(32)}`, lane: 'surgery', outcome: 'provider_failure', seconds: 17, at: '2026-11-26T01:40:00Z' },
    ],
    [RECONNECTS_SQL]: [
      { result: 'reconnected', n: 99 },
      { result: 'limit', n: 2 },
      { result: 'call_ended', n: 1 },
    ],
    ...over,
  };
  const sent: Array<[string, unknown[]]> = [];
  return {
    sent,
    async query(text: string, params: unknown[] = []) {
      sent.push([text, params]);
      const r = rows[text];
      if (r === undefined) throw new Error('unexpected statement');
      if (r instanceof Error) throw r;
      return { rows: r };
    },
  };
}

describe('readOperations', () => {
  it('reports the day the old page showed as 0 calls: 662 calls, 10 dropped, healthy', async () => {
    const r = await readOperations(hub(), 24, new Date('2026-11-26T03:00:00Z'));
    expect(r.calls.total).toBe(662);
    expect(r.calls.dropped).toBe(10);
    expect(r.rates.droppedPct).toBe(1.5);
    expect(r.status).toBe('healthy');
    expect(r.reconnects).toEqual({ drops: 102, reconnected: 99, ended: 3, byResult: { reconnected: 99, limit: 2, call_ended: 1 } });
    expect(r.lanes.map((l) => l.lane)).toEqual(['pcp', 'surgery']);
    expect(r.recentProblems[0]).toMatchObject({ lane: 'surgery', outcome: 'provider_failure', seconds: 17 });
  });

  it('passes the window and the stuck limit as parameters', async () => {
    const h = hub();
    await readOperations(h, 6);
    const totals = h.sent.find(([t]) => t === TOTALS_SQL);
    expect(totals?.[1]).toEqual([6, STUCK_AFTER_MINUTES]);
  });

  it('shows no reconnect data, not an error, when call_events is missing', async () => {
    const r = await readOperations(hub({ [RECONNECTS_SQL]: new Error('relation "call_events" does not exist') }), 24);
    expect(r.reconnects).toBeNull();
    expect(r.calls.total).toBe(662);
  });

  it('fails the whole read when the call records cannot be read, so the page says so instead of showing zeros', async () => {
    await expect(readOperations(hub({ [TOTALS_SQL]: new Error('connection refused') }), 24)).rejects.toThrow('connection refused');
  });

  it('reads no patient data', () => {
    for (const sql of [TOTALS_SQL, LANES_SQL, PROBLEMS_SQL, RECONNECTS_SQL]) {
      expect(sql).not.toMatch(/transcript|caller_name|patient_name|phone|date_of_birth|patient_dob|caller_number|from_number/i);
    }
  });

  it('reads timestamps as UTC wall time, the way call_logs stores them', () => {
    for (const sql of [TOTALS_SQL, LANES_SQL, PROBLEMS_SQL, RECONNECTS_SQL]) {
      expect(sql).toContain(`(now() AT TIME ZONE 'UTC')`);
    }
  });
});

describe('judge', () => {
  const calls = (over: Partial<OperationsReport['calls']> = {}): OperationsReport['calls'] => ({
    total: 662, live: 0, stuck: 0, dropped: 10, failedOther: 0, deadAir: 5, callerSilent: 0,
    transferred: 0, withTicket: 0, graded: 0, oldCore: 0, lastCallAt: null, ...over,
  });

  it('says there is nothing to judge with no calls, never "healthy"', () => {
    expect(judge(calls({ total: 0 }), { droppedPct: null, deadAirPct: null }).status).toBe('no_calls');
  });

  it('goes degraded above 3% dropped and critical above 8%', () => {
    expect(judge(calls(), { droppedPct: 3.1, deadAirPct: 0 }).status).toBe('degraded');
    expect(judge(calls(), { droppedPct: 8.1, deadAirPct: 0 }).status).toBe('critical');
    expect(judge(calls(), { droppedPct: THRESHOLDS.droppedDegradedPct, deadAirPct: 0 }).status).toBe('healthy');
  });

  it('the 7 days before reconnects shipped (13% dropped) would have read critical', () => {
    expect(judge(calls({ total: 4015, dropped: 529 }), { droppedPct: 13.2, deadAirPct: 0 }).status).toBe('critical');
  });

  it('flags calls whose end was never written', () => {
    const v = judge(calls({ stuck: 2 }), { droppedPct: 1, deadAirPct: 1 });
    expect(v.status).toBe('degraded');
    expect(v.reasons.join(' ')).toContain('2 call(s) still read "in progress"');
  });

  it('flags dead air above 3%', () => {
    expect(judge(calls(), { droppedPct: 1, deadAirPct: 3.5 }).status).toBe('degraded');
  });

  it('does not judge a share from a handful of calls', () => {
    const v = judge(calls({ total: 5 }), { droppedPct: null, deadAirPct: null });
    expect(v.status).toBe('healthy');
    expect(v.reasons.join(' ')).toContain('Fewer than 20 calls');
  });
});
