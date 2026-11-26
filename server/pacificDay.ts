import { sql, type SQL } from 'drizzle-orm';

/**
 * `created_at` between two Pacific midnights. call_logs.created_at is a
 * timestamp WITHOUT time zone holding UTC wall time, so each midnight is
 * converted to that wall time: comparing the bare column keeps the created_at
 * index in use, which a cast of the column would not.
 *
 * `date` is a Pacific calendar date, YYYY-MM-DD.
 */
export function PACIFIC_DAY_BOUNDS_SQL(date: string): SQL {
  return sql`created_at >= ((${date}::date)::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'
    AND created_at < (((${date}::date + 1))::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'`;
}
