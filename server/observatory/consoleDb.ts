/**
 * Observatory — read-only connection to the Eye Care Patient Console
 * database (Supabase project kbbmywvasbsxnbblrhot).
 *
 * The console owns the person base (patients_master, ~868k persons — what
 * caller-ID recognition reads), the open-slots and week-schedule caches
 * the agents offer from, the NextGen appointment-facts mirror, and the
 * sync-state watermarks for every feed that keeps those fresh. The
 * Observatory reads it through the dedicated `observatory_ro` role
 * (SELECT-only at the database level) with the session additionally
 * pinned read-only — same two-layer guarantee as the 5Star connection.
 *
 * Env: OBS_CONSOLE_DATABASE_URL (Replit secret). Optional: when unset,
 * console-backed widgets state that instead of failing.
 */
import pg from 'pg';

let pool: pg.Pool | null = null;

export function isConsoleConfigured(): boolean {
  return Boolean(process.env.OBS_CONSOLE_DATABASE_URL);
}

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.OBS_CONSOLE_DATABASE_URL;
    if (!url) {
      throw new Error('[observatory] OBS_CONSOLE_DATABASE_URL is not set — console feeds cannot load.');
    }
    pool = new pg.Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
      options: '-c default_transaction_read_only=on -c statement_timeout=15000',
    });
    pool.on('error', (err) => {
      console.error('[observatory] console pool error:', err.message);
    });
  }
  return pool;
}

export async function consoleQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}
