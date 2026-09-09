import { describe, it, expect } from 'vitest';
import {
  assessBarelyHeard,
  assessCeiling,
  assessFiling,
  assessFleet,
  isClosedOfficeShape,
  isRealMove,
  formatPct,
  CEILING_PER_CALL_DISPATCHES,
  MIN_N_FOR_A_RATE,
  FILING_STOP_RUN,
  foldCallsIntoWindows,
  longestUnfiledRun,
  type LaneWindow,
  type CallRow,
} from './fleetWatch.logic';

/**
 * Each block below names the misreading it prevents, and is written so that
 * REVERTING the rule makes it red — not so that it merely describes what the
 * code does today. See failure mode 10 in /CLAUDE.md.
 */

function laneWindow(over: Partial<LaneWindow> = {}): LaneWindow {
  return {
    lane: 'optical',
    pipeline: 'grok',
    substantive: 100,
    barelyHeard: 0,
    ceilingReached: 0,
    maxToolCalls: 12,
    toolCountNull: 0,
    dobRefused: 0,
    filed: 60,
    longestUnfiledRun: 3,
    ...over,
  };
}

describe('rule 1 — the ceiling', () => {
  it('is pinned to the real limit in toolCeiling.ts', () => {
    // Literal, not the constant — same reason as the filing-stop threshold.
    // `DEFAULT_CEILING_LIMITS.perCallDispatches` is 40; if that ever changes,
    // this test is the thing that says so out loud.
    expect(CEILING_PER_CALL_DISPATCHES).toBe(40);
  });

  it('treats a call AT the ceiling as the ceiling working, not a regression', () => {
    const f = assessCeiling(laneWindow({ ceilingReached: 2, maxToolCalls: 40 }));
    expect(f?.severity).toBe('watch');
    expect(f?.headline).toContain('reached the tool ceiling');
    // The old `> 40` reading would have produced nothing at all here.
    expect(f).not.toBeNull();
  });

  it('alarms only ABOVE the ceiling, because that means the ceiling is not in the path', () => {
    const f = assessCeiling(laneWindow({ ceilingReached: 1, maxToolCalls: 118 }));
    expect(f?.severity).toBe('alarm');
    expect(f?.headline).toContain('ABOVE the ceiling');
  });

  it('says how many rows the check is blind to, rather than implying a clean sweep', () => {
    const f = assessCeiling(laneWindow({ ceilingReached: 1, maxToolCalls: 40, toolCountNull: 18, substantive: 50 }));
    expect(f?.detail).toContain('18 of 50');
    expect(f?.detail).toContain('NULL tool_call_count');
  });

  it('is silent when nothing reached the ceiling', () => {
    expect(assessCeiling(laneWindow({ maxToolCalls: 23 }))).toBeNull();
  });
});

describe('rule 3 — a closed office is not an outage', () => {
  it('reads quiet queues WITH a busy after-hours agent as the office being shut', () => {
    // 2026-09-07, Labor Day: 276 no-ivr, 2 records, zero on the three big lanes.
    expect(isClosedOfficeShape(2, 276)).toBe(true);
  });

  it('does NOT excuse quiet queues when the after-hours agent is quiet too', () => {
    // Both silent in business hours is the shape of a real outage.
    expect(isClosedOfficeShape(0, 0)).toBe(false);
    expect(isClosedOfficeShape(2, 9)).toBe(false);
  });

  it('does not fire on a normal business day', () => {
    expect(isClosedOfficeShape(181, 50)).toBe(false);
  });

  it('reports the closed-office shape once, for the fleet, not per lane', () => {
    const { findings, closedOffice } = assessFleet([
      laneWindow({ lane: 'optical', substantive: 0, filed: 0, longestUnfiledRun: 0 }),
      laneWindow({ lane: 'tech', substantive: 0, filed: 0, longestUnfiledRun: 0 }),
      laneWindow({ lane: 'no-ivr', pipeline: 'old-core', substantive: 276, filed: 100, longestUnfiledRun: 2 }),
    ]);
    expect(closedOffice).toBe(true);
    expect(findings.filter((f) => f.headline.includes('closed')).length + findings.filter((f) => f.lane === 'fleet').length)
      .toBeGreaterThan(0);
    // and it must not also raise a filing alarm against the empty lanes
    expect(findings.some((f) => f.severity === 'alarm')).toBe(false);
  });
});

describe('rule 4 — an unmeasured filing rate is unknown, never zero', () => {
  it('says UNKNOWN when the Support Center was unreachable', () => {
    const f = assessFiling(laneWindow({ filed: null, longestUnfiledRun: null }));
    expect(f?.severity).toBe('info');
    expect(f?.headline).toContain('UNKNOWN');
    // The failure this prevents: rendering it as 0% and calling the lane broken.
    expect(f?.headline).not.toContain('0.0%');
  });

  it('alarms on a filing-stop run at the measured threshold', () => {
    // The threshold is pinned to the LITERAL 12, not to the constant. Asserting
    // against FILING_STOP_RUN moves with the constant, so raising the limit
    // would pass — the sink-not-source failure this suite exists to avoid.
    // Derivation (2026-09-01): runs of consecutive unfiled queue calls were 185
    // once (the 08-31 outage) and never above 8 otherwise. 12 sits between the
    // worst healthy run and the outage, and would have caught 08-31 at 20:23:06.
    expect(FILING_STOP_RUN).toBe(12);
    expect(assessFiling(laneWindow({ longestUnfiledRun: 12 }))?.severity).toBe('alarm');
    expect(assessFiling(laneWindow({ longestUnfiledRun: 11 }))).toBeNull();
    // 8 is the worst run ever seen on a healthy day — it must stay silent.
    expect(assessFiling(laneWindow({ longestUnfiledRun: 8 }))).toBeNull();
  });

  it('never alarms on a run it could not measure', () => {
    expect(assessFiling(laneWindow({ filed: null, longestUnfiledRun: null }))?.severity).not.toBe('alarm');
  });
});

describe('rule 7 — a move at small n is not a move', () => {
  it('refuses to call the cutover deltas real, because they were not', () => {
    // tech 49/73 -> 46/66 (+2.6 points) and surgery 22/44 -> 18/32 (+6.3).
    expect(isRealMove(49, 73, 46, 66)).toBe(false);
    expect(isRealMove(22, 44, 18, 32)).toBe(false);
  });

  it('refuses any comparison below the minimum n, whatever the gap looks like', () => {
    // 0% vs 100% on 10 calls a side is still not a finding.
    expect(isRealMove(0, 10, 10, 10)).toBe(false);
    expect(MIN_N_FOR_A_RATE).toBeGreaterThan(10);
  });

  it('does report a move that is genuinely outside noise', () => {
    // The date-of-birth gate across the runtime cutover: 2/123 -> 23/186.
    expect(isRealMove(2, 123, 23, 186)).toBe(true);
  });
});

describe('rule 2 — a rate needs a denominator worth having', () => {
  it('reports but does not alarm below the minimum n', () => {
    const f = assessBarelyHeard(laneWindow({ substantive: 9, barelyHeard: 4 }));
    expect(f?.severity).toBe('info');
  });

  it('watches a sustained rate over a real denominator', () => {
    // surgery on the runtime, 2026-09-03 at VAD 0.85: 16 of 43 = 37.2%.
    const f = assessBarelyHeard(laneWindow({ substantive: 43, barelyHeard: 16 }));
    expect(f?.severity).toBe('watch');
  });

  it('stays quiet under the watch level', () => {
    // surgery on 2026-09-08 after the VAD drop to 0.6: 29 of 134 = 21.6%.
    // Elevated against its old-core history and still not a thing to page on.
    expect(assessBarelyHeard(laneWindow({ substantive: 134, barelyHeard: 29 }))).toBeNull();
    expect(assessBarelyHeard(laneWindow({ substantive: 100, barelyHeard: 11 }))).toBeNull();
  });
});

describe('folding calls into lane windows', () => {
  function call(over: Partial<CallRow> = {}): CallRow {
    return {
      call_sid: `CA${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}`,
      agent_used: 'optical',
      pipeline: 'grok',
      tool_call_count: 5,
      caller_lines: 6,
      dob_refused: false,
      ...over,
    };
  }

  it('propagates an unmeasurable filing half as null, never as zero', () => {
    const [w] = foldCallsIntoWindows([call(), call()], null);
    expect(w.filed).toBeNull();
    expect(w.longestUnfiledRun).toBeNull();
    // The failure this prevents: `filed: 0` on a lane that filed everything,
    // purely because a credential was missing.
    expect(w.filed).not.toBe(0);
  });

  it('splits one lane across pipelines, because a mid-day cutover is two populations', () => {
    const windows = foldCallsIntoWindows(
      [call({ pipeline: 'old-core' }), call({ pipeline: 'grok' }), call({ pipeline: 'grok' })],
      null,
    );
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => w.pipeline).sort()).toEqual(['grok', 'old-core']);
  });

  it('counts a call at the ceiling but leaves NULL tool counts out of the max', () => {
    const [w] = foldCallsIntoWindows(
      [call({ tool_call_count: 40 }), call({ tool_call_count: null }), call({ tool_call_count: 7 })],
      null,
    );
    expect(w.ceilingReached).toBe(1);
    expect(w.maxToolCalls).toBe(40);
    expect(w.toolCountNull).toBe(1);
  });

  it('reports maxToolCalls as null when every row is NULL, rather than 0', () => {
    // 0 would read as "no tool ever ran"; null reads as "we cannot see".
    const [w] = foldCallsIntoWindows([call({ tool_call_count: null })], null);
    expect(w.maxToolCalls).toBeNull();
  });
});

describe('longestUnfiledRun — the 2026-08-31 detector', () => {
  function seq(pattern: string): { calls: CallRow[]; filed: Set<string> } {
    // 'f' filed, '.' not filed, in time order.
    const calls = [...pattern].map((ch, i) => ({
      call_sid: `CA${String(i).padStart(32, '0')}`,
      agent_used: 'tech',
      pipeline: 'grok' as const,
      tool_call_count: 3,
      caller_lines: 4,
      dob_refused: false,
      _filed: ch === 'f',
    }));
    const filed = new Set(calls.filter((c) => c._filed).map((c) => c.call_sid));
    return { calls: calls as unknown as CallRow[], filed };
  }

  it('finds the longest gap, not the last one', () => {
    const { calls, filed } = seq('f...f.f.....f');
    expect(longestUnfiledRun(calls, filed)).toBe(5);
  });

  it('counts a run that reaches the end of the day', () => {
    const { calls, filed } = seq('f.......');
    expect(longestUnfiledRun(calls, filed)).toBe(7);
  });

  it('is zero when everything filed', () => {
    const { calls, filed } = seq('ffff');
    expect(longestUnfiledRun(calls, filed)).toBe(0);
  });

  it('counts the whole day when nothing filed — the outage shape', () => {
    const { calls, filed } = seq('.'.repeat(185));
    expect(longestUnfiledRun(calls, filed)).toBe(185);
  });
});

describe('formatPct', () => {
  it('never divides by zero', () => {
    expect(formatPct(0, 0)).toBe('n/a');
  });
  it('matches the published form', () => {
    expect(formatPct(75, 410)).toBe('18.3%');
  });
});
