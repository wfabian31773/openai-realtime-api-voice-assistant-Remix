/**
 * The Urgent Calls page's calls and days. Measured 2026-11-26 over 90 days:
 * the old rule listed 149 calls, 70 of them PCP queue transfers, and missed
 * the 101 after-hours escalations nobody answered; the rule below returns 180
 * on the same window, 101 of them unanswered. Synthetic rows only.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  AFTER_HOURS_LANES,
  pacificDaysBefore,
  pacificToday,
  transferResult,
  urgentCondition,
  urgentReason,
  urgentWindow,
} from './urgentCalls';

describe('urgentWindow', () => {
  it('defaults to the Pacific date, not the UTC date, in the evening', () => {
    // 7 PM Pacific on Nov 25 is already Nov 26 in UTC.
    const now = new Date('2026-11-26T03:00:00Z');
    expect(pacificToday(now)).toBe('2026-11-25');
    expect(urgentWindow({}, now)).toEqual({ from: '2026-08-27', to: '2026-11-25' });
  });

  it('takes Pacific calendar dates as given', () => {
    expect(urgentWindow({ startDate: '2026-11-01', endDate: '2026-11-25' })).toEqual({ from: '2026-11-01', to: '2026-11-25' });
  });

  it('refuses a date that is not a real YYYY-MM-DD date instead of guessing', () => {
    expect(urgentWindow({ endDate: '2026-02-30' })).toEqual({ error: expect.stringContaining('endDate') });
    expect(urgentWindow({ startDate: 'yesterday' })).toEqual({ error: expect.stringContaining('startDate') });
    expect(urgentWindow({ startDate: '2026-11-25', endDate: '2026-11-01' })).toEqual({ error: 'startDate is after endDate' });
  });

  it('counts days back across a month and a DST change', () => {
    expect(pacificDaysBefore('2026-11-25', 90)).toBe('2026-08-27');
    expect(pacificDaysBefore('2026-03-09', 1)).toBe('2026-03-08');
  });
});

describe('urgentCondition', () => {
  const q = new PgDialect().sqlToQuery(urgentCondition('2026-11-01', '2026-11-25'));

  it('lists after-hours calls that rang the on-call provider, answered or not', () => {
    expect(q.sql).toContain('agent_used IN (');
    expect(q.sql).toContain('transferred_to_human = true OR transfer_outcome IS NOT NULL');
    expect(q.params.slice(0, AFTER_HOURS_LANES.length)).toEqual([...AFTER_HOURS_LANES]);
    expect(q.params).not.toContain('pcp');
  });

  it('runs from the first Pacific midnight to the midnight after the last day', () => {
    expect(q.sql).toContain(`AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'`);
    expect(q.sql).toMatch(/created_at < \(\(\(\$\d+::date \+ 1\)\)::timestamp/);
    expect(q.params.slice(-2)).toEqual(['2026-11-01', '2026-11-25']);
  });
});

describe('what the page shows for each call', () => {
  const timeline = (reason: string) => ({
    events: [
      { tool: 'lookup_schedule', args: {} },
      { tool: 'escalate_to_human', args: { reason: 'first try' } },
      { tool: 'escalate_to_human', args: { reason } },
    ],
  });

  it('reads the reason from the last escalation the agent made', () => {
    expect(urgentReason({ toolTimeline: timeline('Caller reports sudden vision loss') })).toBe('Caller reports sudden vision loss');
    expect(urgentReason({ toolTimeline: null })).toBeNull();
  });

  it('says whether the on-call provider answered, from the dial itself', () => {
    expect(transferResult({ transferOutcome: { status: 'CONNECTED' } })).toBe('connected');
    expect(transferResult({ transferOutcome: { status: 'DECLINED' } })).toBe('not_answered');
    expect(transferResult({ transferOutcome: { status: 'NO_ANSWER' } })).toBe('not_answered');
    expect(transferResult({ transferredToHuman: true })).toBe('connected');
    expect(transferResult({})).toBe('unknown');
  });
});
