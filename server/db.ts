import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import ws from "ws";
import * as schema from "../shared/schema";
import { getEnvironmentConfig } from "../src/config/environment";

neonConfig.webSocketConstructor = ws;

export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  isHealthy: boolean;
  utilizationPercent: number;
}

function initializeDatabase() {
  const config = getEnvironmentConfig();
  const isProductionEnv = config.isProduction;
  const databaseUrl = config.database.url;
  const isSupabase = config.database.isSupabase;
  
  if (isProductionEnv && !isSupabase) {
    throw new Error(
      '[DB FATAL] Production MUST use Supabase database.\n' +
      'Set SUPABASE_URL in production environment.\n' +
      'Cross-connection to dev database is blocked.'
    );
  }

  if (isSupabase) {
    // Prefer the explicit pooler URL when provided — it routes through
    // Supabase's PgBouncer (port 6543) and handles connection scaling much better.
    // NOTE: the pooler URL is validated asynchronously after startup; if its
    // credentials are wrong we fail over to the direct URL (see validatePoolerOrFallback).
    const poolerUrl = process.env.SUPABASE_POOLER_URL;
    let connectionUrl = poolerUrl || databaseUrl;
    if (connectionUrl.includes('sslmode=')) {
      connectionUrl = connectionUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
    }
    if (poolerUrl) {
      console.info('[DB] Using SUPABASE_POOLER_URL (PgBouncer transaction pooling)');
    }

    const isPgBouncer = connectionUrl.includes(':6543') || connectionUrl.includes('pooler.supabase');
    
    if (isPgBouncer) {
      console.info('[DB] Using Supabase PgBouncer (transaction pooling mode)');
    } else {
      console.info('[DB] Using Supabase direct connection');
      console.warn('[DB] ⚠ For high-volume production, use PgBouncer URL (port 6543)');
    }
    
    const poolConfig: pg.PoolConfig = { 
      connectionString: connectionUrl,
      // PgBouncer (transaction mode): connections are cheap — the pooler multiplexes
      // them into fewer real Postgres connections, so a higher client max is fine.
      // 20 gives concurrent API requests room without risking hitting Supabase's
      // per-instance limits even if multiple deployment replicas are running.
      // Direct connection: keep low to avoid exhausting the 15–25 Postgres connection
      // slots on the Supabase plan.
      max: isPgBouncer ? 20 : 5,
      min: isPgBouncer ? 2 : 1,
      idleTimeoutMillis: isPgBouncer ? 60000 : 10000,
      connectionTimeoutMillis: 15000,
      allowExitOnIdle: false,
      ssl: {
        rejectUnauthorized: false,
      },
    };
    
    console.info(`[DB] Pool config: max=${poolConfig.max}, min=${poolConfig.min}, idleTimeout=${poolConfig.idleTimeoutMillis}ms, pgBouncer=${isPgBouncer}`);
    
    const pool = new pg.Pool(poolConfig);
    
    pool.on('error', (err) => {
      console.error('[DB POOL] Unexpected error on idle client:', err.message);
    });
    

    const db = drizzlePg({ 
      client: pool, 
      schema,
      casing: 'snake_case',
    });
    return { pool, db, isSupabase, isPgBouncer };
  } else {
    const pool = new NeonPool({ 
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 10000,
    });

    const db = drizzleNeon({ client: pool, schema });
    return { pool, db, isSupabase, isPgBouncer: false };
  }
}

let { pool, db, isSupabase, isPgBouncer } = initializeDatabase();

if (isSupabase) {
  console.info(`[DB] Connected to Supabase (${isPgBouncer ? 'PgBouncer' : 'direct'})`);
} else {
  console.info('[DB] Connected to Replit PostgreSQL (development)');
}

// SAFETY NET: if SUPABASE_POOLER_URL is set but its credentials are wrong,
// fail over to the direct database URL instead of letting every query fail
// (a bad pooler secret previously took production down via Supabase's
// auth-failure circuit breaker). Failure is loud in the logs, never silent.
export const dbReady: Promise<void> = (async () => {
  if (!isSupabase || !process.env.SUPABASE_POOLER_URL) return;
  {
    try {
      await (pool as pg.Pool).query('SELECT 1');
      console.info('[DB] ✓ Pooler connection validated');
    } catch (err: any) {
      console.error('════════════════════════════════════════════════════════');
      console.error('[DB] ✗ SUPABASE_POOLER_URL FAILED VALIDATION:', err.message);
      console.error('[DB] ✗ FAILING OVER to direct database URL.');
      console.error('[DB] ✗ Fix the SUPABASE_POOLER_URL secret: it must be the');
      console.error('[DB] ✗ transaction pooler URI (port 6543) with your real DB password.');
      console.error('════════════════════════════════════════════════════════');
      const oldPool = pool as pg.Pool;
      const config = getEnvironmentConfig();
      let directUrl = config.database.url;
      if (directUrl.includes('sslmode=')) {
        directUrl = directUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
      }
      const directPool = new pg.Pool({
        connectionString: directUrl,
        max: 5,
        min: 1,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 15000,
        allowExitOnIdle: false,
        ssl: { rejectUnauthorized: false },
      });
      directPool.on('error', (e) => {
        console.error('[DB POOL] Unexpected error on idle client:', e.message);
      });
      pool = directPool;
      db = drizzlePg({ client: directPool, schema, casing: 'snake_case' });
      isPgBouncer = false;
      // Drain the bad pool after a grace period so any in-flight work isn't cut off
      setTimeout(() => oldPool.end().catch(() => {}), 30000);
      console.info('[DB] Failover complete — using direct connection');
    }
  }
})();

/**
 * Rebuild the connection pool in place.
 *
 * Exists because of 2026-08-24: Supabase restarted Postgres at 20:19:49 UTC
 * and the voice-agent process NEVER recovered its DB layer — every write
 * (call_logs rows, lifecycle updates, the 60s reconciler) failed silently for
 * 2+ days while calls kept being served, so the Observatory read zeros and
 * four rows sat "live" for 52 hours. The dashboard process recovered; the
 * voice process's pool stayed wedged. Nothing in the app could repair a pool
 * once wedged — this is that repair.
 *
 * Uses the exact live-rebinding pattern the pooler-failover path above has
 * always used (reassign `pool`/`db`, drain the old pool after a grace
 * period), so importers holding `import { db }` bindings pick up the fresh
 * pool automatically. Called by databaseKeepAlive after sustained ping
 * failure; never on a single transient error.
 */
let poolRecycleCount = 0;
let recycleInFlight = false;

export async function recyclePool(reason: string): Promise<boolean> {
  if (recycleInFlight) {
    console.warn('[DB] recyclePool skipped — a recycle is already in flight');
    return false;
  }
  recycleInFlight = true;
  try {
    const oldPool = pool as pg.Pool;
    const fresh = initializeDatabase();
    pool = fresh.pool;
    db = fresh.db;
    isSupabase = fresh.isSupabase;
    isPgBouncer = fresh.isPgBouncer;
    poolRecycleCount++;
    console.warn(`[DB] Pool recycled (#${poolRecycleCount}) — reason: ${reason}`);
    // Drain the old pool after a grace period so in-flight work isn't cut off
    // (same grace the pooler failover uses).
    setTimeout(() => {
      Promise.resolve(oldPool.end()).catch(() => {});
    }, 30000);
    try {
      await (pool as pg.Pool).query('SELECT 1');
      console.info(`[DB] ✓ Recycled pool validated (#${poolRecycleCount})`);
      return true;
    } catch (err: any) {
      console.error(`[DB] ✗ Recycled pool STILL FAILING (#${poolRecycleCount}):`, err?.message ?? err);
      return false;
    }
  } finally {
    recycleInFlight = false;
  }
}

export function getPoolMetrics(): PoolMetrics {
  const pgPool = pool as pg.Pool;
  if (typeof pgPool.totalCount === 'number') {
    const totalCount = pgPool.totalCount;
    const idleCount = pgPool.idleCount;
    const waitingCount = pgPool.waitingCount;
    const utilizationPercent = totalCount > 0 ? Math.round(((totalCount - idleCount) / totalCount) * 100) : 0;
    
    return {
      totalCount,
      idleCount,
      waitingCount,
      isHealthy: waitingCount < 3 && utilizationPercent < 80,
      utilizationPercent,
    };
  }
  
  return {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    isHealthy: true,
    utilizationPercent: 0,
  };
}

export { pool, db, isPgBouncer, isSupabase };
