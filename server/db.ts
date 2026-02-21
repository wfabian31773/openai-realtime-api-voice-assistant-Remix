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
    let connectionUrl = databaseUrl;
    if (databaseUrl.includes('sslmode=')) {
      connectionUrl = databaseUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
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
      max: isPgBouncer ? 8 : 5,
      min: isPgBouncer ? 2 : 1,
      idleTimeoutMillis: isPgBouncer ? 30000 : 10000,
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

const { pool, db, isSupabase, isPgBouncer } = initializeDatabase();

if (isSupabase) {
  console.info(`[DB] Connected to Supabase (${isPgBouncer ? 'PgBouncer' : 'direct'})`);
} else {
  console.info('[DB] Connected to Replit PostgreSQL (development)');
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
