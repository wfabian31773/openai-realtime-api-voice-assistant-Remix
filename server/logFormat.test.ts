import { describe, it, expect } from 'vitest';
import { formatLogFields, createRepeatLogGate } from './logFormat';

describe('formatLogFields', () => {
  it('drops unset fields instead of printing them as undefined', () => {
    const line = formatLogFields({
      page: 1,
      limit: 50,
      status: 'in_progress,ringing,initiated',
      direction: undefined,
      agentId: undefined,
      search: undefined,
      transferred: undefined,
      sortBy: 'date',
    });

    expect(line).toBe('page=1 limit=50 status=in_progress,ringing,initiated sortBy=date');
    expect(line).not.toContain('undefined');
  });

  it('drops null the same way as undefined', () => {
    expect(formatLogFields({ a: null, b: 2 })).toBe('b=2');
  });

  it('keeps false and 0, which are real filter values', () => {
    expect(formatLogFields({ hasTicket: false, minCost: 0 })).toBe('hasTicket=false minCost=0');
  });

  it('stays on a single line for nested objects', () => {
    const line = formatLogFields({ pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } });

    expect(line).not.toContain('\n');
    expect(line).toBe('pagination={"page":1,"limit":50,"total":0,"totalPages":0}');
  });

  it('renders dates as ISO strings', () => {
    expect(formatLogFields({ startDate: new Date('2026-08-08T13:55:18.380Z') }))
      .toBe('startDate=2026-08-08T13:55:18.380Z');
  });

  it('quotes values containing whitespace so pairs stay parseable', () => {
    expect(formatLogFields({ search: 'jane doe' })).toBe('search="jane doe"');
  });

  it('returns a placeholder when every field is unset', () => {
    expect(formatLogFields({ a: undefined, b: undefined })).toBe('(none)');
  });
});

describe('createRepeatLogGate', () => {
  it('suppresses an unchanged outcome inside the window', () => {
    const gate = createRepeatLogGate(60_000);

    expect(gate('page=1', 'rows=0', 0)).toBe(true);
    expect(gate('page=1', 'rows=0', 3_000)).toBe(false);
    expect(gate('page=1', 'rows=0', 59_999)).toBe(false);
  });

  it('logs immediately when the outcome changes', () => {
    const gate = createRepeatLogGate(60_000);

    expect(gate('page=1', 'rows=0', 0)).toBe(true);
    expect(gate('page=1', 'rows=2', 3_000)).toBe(true);
    expect(gate('page=1', 'rows=0', 6_000)).toBe(true);
  });

  it('logs again once the window elapses', () => {
    const gate = createRepeatLogGate(60_000);

    expect(gate('page=1', 'rows=0', 0)).toBe(true);
    expect(gate('page=1', 'rows=0', 60_000)).toBe(true);
  });

  it('tracks distinct queries independently', () => {
    const gate = createRepeatLogGate(60_000);

    expect(gate('page=1', 'rows=0', 0)).toBe(true);
    expect(gate('page=2', 'rows=0', 0)).toBe(true);
    expect(gate('page=1', 'rows=0', 1_000)).toBe(false);
  });

  it('evicts stale keys instead of growing without bound', () => {
    const gate = createRepeatLogGate(60_000, 10);

    for (let i = 0; i < 50; i++) gate(`search=${i}`, 'rows=0', i);
    // The oldest keys were evicted, so they log as if never seen.
    expect(gate('search=0', 'rows=0', 60)).toBe(true);
  });
});
