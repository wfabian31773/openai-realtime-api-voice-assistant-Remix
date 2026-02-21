import { pool, getPoolMetrics, isPgBouncer, isSupabase } from '../db';
import { getCircuitBreakerMetrics } from './dbResilience';

export interface DatabaseHealthMetrics {
  poolMode: 'pgbouncer' | 'direct' | 'neon';
  connections: {
    total: number;
    idle: number;
    waiting: number;
    utilization: string;
  };
  healthy: boolean;
}

export interface SystemHealthMetrics {
  status: 'healthy' | 'degraded' | 'unhealthy';
  database: DatabaseHealthMetrics;
  circuitBreakers: Record<string, string>;
  timestamp: string;
}

export function getDatabaseHealthMetrics(): DatabaseHealthMetrics {
  const poolMetrics = getPoolMetrics();
  
  let poolMode: 'pgbouncer' | 'direct' | 'neon' = 'neon';
  if (isSupabase) {
    poolMode = isPgBouncer ? 'pgbouncer' : 'direct';
  }
  
  return {
    poolMode,
    connections: {
      total: poolMetrics.totalCount,
      idle: poolMetrics.idleCount,
      waiting: poolMetrics.waitingCount,
      utilization: `${poolMetrics.utilizationPercent}%`,
    },
    healthy: poolMetrics.isHealthy,
  };
}

export function getSystemHealthMetrics(): SystemHealthMetrics {
  const dbMetrics = getDatabaseHealthMetrics();
  const circuitBreakers = getCircuitBreakerMetrics();
  
  const circuitStatus = Object.entries(circuitBreakers).reduce((acc, [name, metrics]) => {
    acc[name] = metrics.state;
    return acc;
  }, {} as Record<string, string>);
  
  const hasOpenCircuit = Object.values(circuitStatus).includes('OPEN');
  
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (hasOpenCircuit || !dbMetrics.healthy) {
    status = 'degraded';
  }
  
  return {
    status,
    database: dbMetrics,
    circuitBreakers: circuitStatus,
    timestamp: new Date().toISOString(),
  };
}

export async function checkDatabaseConnectivity(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[HEALTH] Database connectivity check failed:', error);
    return false;
  }
}
