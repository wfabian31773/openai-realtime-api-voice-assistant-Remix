/**
 * Observatory OBS-0 — read-only connection to the 5Star database (SAGE).
 *
 * The Observatory reads two projects (docs/observatory/01-data-contracts.md):
 * this app's own database (native pool in server/db.ts) and 5Star via the
 * dedicated `observatory_ro` role. That role is SELECT-only at the database
 * level (writes and CREATE revoked), and this pool additionally pins every
 * session to read-only transactions — two independent layers guaranteeing
 * the Observatory can never write to 5Star.
 *
 * Env: OBS_5STAR_DATABASE_URL (Replit secret, set 2026-08-06).
 */
import pg from 'pg';

let pool: pg.Pool | null = null;

export function isFivestarConfigured(): boolean {
  return Boolean(process.env.OBS_5STAR_DATABASE_URL);
}

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.OBS_5STAR_DATABASE_URL;
    if (!url) {
      throw new Error(
        '[observatory] OBS_5STAR_DATABASE_URL is not set — the SAGE column cannot load.',
      );
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
      console.error('[observatory] 5Star pool error:', err.message);
    });
  }
  return pool;
}

export async function fivestarQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export interface FivestarHealth {
  configured: boolean;
  reachable: boolean;
  readOnly: boolean;
  role: string | null;
  /** NGE schedule-mirror freshness — surfaced on the Observatory header. */
  mirrorLastSyncAt: string | null;
  mirrorAgeHours: number | null;
  latestDeploySha: string | null;
  error: string | null;
}

export async function checkFivestarHealth(): Promise<FivestarHealth> {
  const out: FivestarHealth = {
    configured: isFivestarConfigured(),
    reachable: false,
    readOnly: false,
    role: null,
    mirrorLastSyncAt: null,
    mirrorAgeHours: null,
    latestDeploySha: null,
    error: null,
  };
  if (!out.configured) {
    out.error = 'OBS_5STAR_DATABASE_URL not set';
    return out;
  }
  try {
    const probe = await fivestarQuery<{
      role: string;
      ro: string;
      mirror_last: string | null;
      deploy_sha: string | null;
    }>(`
      SELECT current_user AS role,
             current_setting('transaction_read_only') AS ro,
             (SELECT MAX(last_run_at)::text FROM nge_schedule_sync_state) AS mirror_last,
             (SELECT git_short_sha FROM release_history ORDER BY deployed_at DESC LIMIT 1) AS deploy_sha
    `);
    const row = probe.rows[0];
    out.reachable = true;
    out.role = row.role;
    out.readOnly = row.ro === 'on';
    out.mirrorLastSyncAt = row.mirror_last;
    out.latestDeploySha = row.deploy_sha;
    if (row.mirror_last) {
      out.mirrorAgeHours =
        Math.round(((Date.now() - new Date(row.mirror_last + 'Z').getTime()) / 3_600_000) * 10) / 10;
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}
