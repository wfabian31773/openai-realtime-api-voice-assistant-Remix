/**
 * The budget's day. It read a UTC day (4 PM Pacific to 4 PM Pacific) until
 * 2026-11-26: $229.40 against $212.96 for the Pacific day, measured that
 * evening. The statement below was run on the Hub the same day and its bounds
 * gave the same sum as reading each row's Pacific date directly.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PACIFIC_DAY_BOUNDS_SQL } from './pacificDay';

describe('PACIFIC_DAY_BOUNDS_SQL', () => {
  const q = new PgDialect().sqlToQuery(PACIFIC_DAY_BOUNDS_SQL('2026-11-25'));

  it('binds the date as a parameter, never as text in the statement', () => {
    expect(q.params).toEqual(['2026-11-25', '2026-11-25']);
    expect(q.sql).not.toContain('2026-11-25');
  });

  it('runs from one Pacific midnight to the next, converted to UTC wall time', () => {
    expect(q.sql).toContain(`created_at >= (($1::date)::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'`);
    expect(q.sql).toContain(`created_at < ((($2::date + 1))::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'`);
  });

  it('never builds a UTC day from the date again', () => {
    expect(q.sql).not.toMatch(/T00:00:00Z|T23:59/);
  });
});
