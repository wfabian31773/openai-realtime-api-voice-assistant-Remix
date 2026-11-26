import { describe, expect, it } from 'vitest';
import {
  compare,
  createAccuracyRunner,
  describeResult,
  formatValue,
  runCheck,
  runChecks,
  sortResults,
  type AccuracyCheck,
  type CheckResult,
} from './accuracy.logic';

function check(
  id: string,
  screen: () => Promise<{ value: number | null; note?: string }>,
  truth: () => Promise<{ value: number | null; note?: string }>,
  extra: Partial<AccuracyCheck<unknown>> = {},
): AccuracyCheck<unknown> {
  return {
    id,
    screen: extra.screen ?? 'Screen',
    widget: extra.widget ?? id,
    claim: 'a claim',
    truthSource: 'a source',
    unit: extra.unit ?? 'count',
    tolerance: extra.tolerance,
    screenValue: screen,
    truthValue: truth,
  };
}

describe('compare', () => {
  it('passes an exact match and fails any difference with no tolerance', () => {
    expect(compare(662, 662).status).toBe('pass');
    expect(compare(0, 662)).toEqual({ status: 'fail', difference: 662, allowed: 0 });
  });

  it('allows the larger of the absolute and relative tolerance', () => {
    expect(compare(105, 100, { abs: 2, rel: 0.05 }).status).toBe('pass');
    expect(compare(106, 100, { abs: 2, rel: 0.05 }).status).toBe('fail');
    expect(compare(103, 100, { abs: 3 }).status).toBe('pass');
  });

  it('is unknown when either side is unknown, and never passes a missing screen', () => {
    expect(compare(null, 5).status).toBe('unknown');
    expect(compare(5, null).status).toBe('unknown');
    expect(compare(undefined, undefined).status).toBe('unknown');
  });

  it('fails a screen that would show NaN or Infinity, whatever the truth', () => {
    expect(compare(Number.NaN, 0).status).toBe('fail');
    expect(compare(Number.POSITIVE_INFINITY, 4).status).toBe('fail');
  });

  it('treats a non-finite truth as unknown, not as a failure of the screen', () => {
    expect(compare(4, Number.NaN).status).toBe('unknown');
  });

  it('absorbs floating-point noise but nothing more', () => {
    expect(compare(0.1 + 0.2, 0.3).status).toBe('pass');
    expect(compare(0.3001, 0.3).status).toBe('fail');
  });
});

describe('formatValue and describeResult', () => {
  it('formats each unit the way a screen shows it', () => {
    expect(formatValue(0.1325, 'percent')).toBe('13.3%');
    expect(formatValue(3380.871, 'dollars')).toBe('$3380.87');
    expect(formatValue(4015, 'count')).toBe('4,015');
    expect(formatValue(null, 'count')).toBe('unknown');
  });

  it('names both numbers and the gap on a failure', () => {
    const r = compare(0, 662);
    const text = describeResult(r.status, { value: 0 }, { value: 662 }, 'count', r.difference, r.allowed);
    expect(text).toContain('The screen shows 0');
    expect(text).toContain('the truth is 662');
    expect(text).toContain('off by 662');
  });

  it('says why the truth could not be read', () => {
    const text = describeResult('unknown', { value: 1 }, { value: null, note: 'table missing' }, 'count', null, null);
    expect(text).toBe('The truth could not be read: table missing');
  });
});

describe('runCheck', () => {
  it('turns a thrown read into an unknown with the reason, never a throw', async () => {
    const r = await runCheck(
      check('boom', async () => {
        throw new Error('relation "x" does not exist');
      }, async () => ({ value: 3 })),
      {},
      { timeoutMs: 1000 },
    );
    expect(r.status).toBe('unknown');
    expect(r.note).toContain('the screen read failed: relation "x" does not exist');
  });

  it('times out a read that never answers', async () => {
    const r = await runCheck(
      check('slow', () => new Promise(() => {}), async () => ({ value: 3 })),
      {},
      { timeoutMs: 20 },
    );
    expect(r.status).toBe('unknown');
    expect(r.note).toContain('took longer than 20 ms');
  });

  it('carries the readings, the difference and the tolerance onto the result', async () => {
    const r = await runCheck(
      check('ops', async () => ({ value: 0 }), async () => ({ value: 662 }), { tolerance: { abs: 2 } }),
      {},
      { timeoutMs: 1000 },
    );
    expect(r).toMatchObject({ status: 'fail', screenValue: 0, truthValue: 662, difference: 662, allowed: 2 });
  });
});

describe('runChecks', () => {
  it('runs every check, counts each status, and lists failures first', async () => {
    const report = await runChecks(
      [
        check('a-pass', async () => ({ value: 1 }), async () => ({ value: 1 }), { screen: 'A' }),
        check('b-fail', async () => ({ value: 0 }), async () => ({ value: 5 }), { screen: 'B' }),
        check('c-unknown', async () => ({ value: 1 }), async () => ({ value: null }), { screen: 'C' }),
      ],
      {},
      { now: () => new Date('2026-11-26T03:00:00Z') },
    );
    expect(report.counts).toEqual({ pass: 1, fail: 1, unknown: 1 });
    expect(report.results.map((r) => r.id)).toEqual(['b-fail', 'c-unknown', 'a-pass']);
    expect(report.ranAt).toBe('2026-11-26T03:00:00.000Z');
  });

  it('never runs more checks at once than the concurrency allows', async () => {
    let live = 0;
    let peak = 0;
    const slow = async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { value: 1 };
    };
    const checks = Array.from({ length: 7 }, (_, i) => check(`c${i}`, slow, async () => ({ value: 1 })));
    await runChecks(checks, {}, { concurrency: 2 });
    expect(peak).toBe(2);
  });
});

describe('sortResults', () => {
  it('orders by status, then screen, then widget', () => {
    const base = { claim: '', truthSource: '', unit: 'count' as const, screenValue: 0, truthValue: 0, difference: 0, allowed: 0, note: '', ms: 0 };
    const rows: CheckResult[] = [
      { ...base, id: '1', screen: 'Z', widget: 'a', status: 'pass' },
      { ...base, id: '2', screen: 'B', widget: 'b', status: 'fail' },
      { ...base, id: '3', screen: 'A', widget: 'a', status: 'fail' },
    ];
    expect(sortResults(rows).map((r) => r.id)).toEqual(['3', '2', '1']);
  });
});

describe('createAccuracyRunner', () => {
  function runner(now: { t: number }, onReport?: () => void) {
    let runs = 0;
    const r = createAccuracyRunner({
      checks: () => [check('x', async () => { runs++; return { value: 1 }; }, async () => ({ value: 1 }))],
      deps: () => ({}),
      ttlMs: 1000,
      minRefreshMs: 100,
      now: () => new Date(now.t),
      onReport,
    });
    return { r, runs: () => runs };
  }

  it('reuses a fresh report and reruns a stale one', async () => {
    const now = { t: 0 };
    const { r, runs } = runner(now);
    await r.report();
    now.t = 500;
    await r.report();
    expect(runs()).toBe(1);
    now.t = 1500;
    await r.report();
    expect(runs()).toBe(2);
  });

  it('honours a forced refresh only once the report is old enough', async () => {
    const now = { t: 0 };
    const { r, runs } = runner(now);
    await r.report();
    now.t = 50;
    await r.report(true);
    expect(runs()).toBe(1);
    now.t = 150;
    await r.report(true);
    expect(runs()).toBe(2);
  });

  it('shares one run between two callers at once', async () => {
    const now = { t: 0 };
    const { r, runs } = runner(now);
    await Promise.all([r.report(), r.report(), r.report(true)]);
    expect(runs()).toBe(1);
  });

  it('keeps the report when storing it fails', async () => {
    const now = { t: 0 };
    const { r } = runner(now, () => {
      throw new Error('db down');
    });
    const report = await r.report();
    expect(report.counts.pass).toBe(1);
    expect(r.last()).toBe(report);
  });
});
