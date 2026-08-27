import { pool, recyclePool } from '../db';
import { getEnvironmentConfig } from '../../src/config/environment';
import {
  selfHealAction,
  DB_SELF_HEAL_MARKER,
  RECYCLE_AFTER_CONSECUTIVE_FAILURES,
} from './dbSelfHeal.logic';

// Supabase needs more frequent pings (2 min) to prevent connection termination
// Dev Neon can use longer intervals (4 min)
const config = getEnvironmentConfig();
const KEEP_ALIVE_INTERVAL_MS = config.isProduction ? 2 * 60 * 1000 : 4 * 60 * 1000;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

let keepAliveInterval: NodeJS.Timeout | null = null;
let isRunning = false;

// Self-heal state (2026-08-24 incident — see dbSelfHeal.logic.ts):
// consecutive failed pings; escalates to a pool rebuild instead of only
// logging forever while call logging silently stays down.
let consecutivePingFailures = 0;

async function handlePingResult(success: boolean): Promise<void> {
  if (success) {
    if (consecutivePingFailures > 0) {
      console.warn(
        `[DB KEEP-ALIVE] ✓ RECOVERED after ${consecutivePingFailures} consecutive failed ping(s)`,
      );
    }
    consecutivePingFailures = 0;
    return;
  }
  consecutivePingFailures++;
  console.error(
    `[DB KEEP-ALIVE] ✗ DATABASE UNREACHABLE — ${consecutivePingFailures} consecutive failed ping(s). ` +
      `Call logging and lifecycle updates are DOWN until this recovers.`,
  );
  if (selfHealAction(consecutivePingFailures) === 'recycle') {
    console.warn(
      `[DB KEEP-ALIVE] Escalating: rebuilding the connection pool ` +
        `(threshold ${RECYCLE_AFTER_CONSECUTIVE_FAILURES} reached)`,
    );
    const ok = await recyclePool(
      `keep-alive: ${consecutivePingFailures} consecutive failed pings`,
    );
    if (ok) {
      console.warn('[DB KEEP-ALIVE] ✓ Pool rebuild restored connectivity');
      consecutivePingFailures = 0;
    }
  }
}

async function executeWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      
      if (attempt < maxRetries) {
        console.log(`[DB KEEP-ALIVE] ${operationName} attempt ${attempt} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

async function pingDatabase(): Promise<boolean> {
  try {
    await executeWithRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    }, 'Database ping');
    
    return true;
  } catch (error) {
    console.error('[DB KEEP-ALIVE] Failed to ping database after retries:', error);
    return false;
  }
}

export async function warmupDatabase(): Promise<boolean> {
  console.log('[DB KEEP-ALIVE] Warming up database connection...');
  const success = await pingDatabase();
  if (success) {
    console.log('[DB KEEP-ALIVE] Database connection warmed up successfully');
  } else {
    console.error('[DB KEEP-ALIVE] Failed to warm up database connection');
  }
  return success;
}

export function startKeepAlive(): void {
  if (isRunning) {
    console.log('[DB KEEP-ALIVE] Already running');
    return;
  }
  
  isRunning = true;
  console.log(`[DB KEEP-ALIVE] Starting keep-alive service (interval: ${KEEP_ALIVE_INTERVAL_MS / 1000}s)`);
  console.log(DB_SELF_HEAL_MARKER);

  warmupDatabase();

  keepAliveInterval = setInterval(async () => {
    const success = await pingDatabase();
    if (success) {
      console.log('[DB KEEP-ALIVE] Ping successful');
    }
    await handlePingResult(success);
  }, KEEP_ALIVE_INTERVAL_MS);
}

export function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  isRunning = false;
  console.log('[DB KEEP-ALIVE] Stopped');
}

export { executeWithRetry };
