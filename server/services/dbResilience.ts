import { Pool, PoolClient } from 'pg';
import { systemAlertService } from './systemAlertService';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenRequests: number;
}

export interface QueryTimeoutConfig {
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 4000,
  jitterMs: 200,
};

const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 15000,
  halfOpenRequests: 2,
};

const DEFAULT_TIMEOUT_CONFIG: QueryTimeoutConfig = {
  statementTimeoutMs: 5000,
  queryTimeoutMs: 7000,
  idleInTransactionTimeoutMs: 5000,
};

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;
  private config: CircuitBreakerConfig;
  private name: string;

  constructor(name: string, config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG) {
    this.name = name;
    this.config = config;
  }

  canExecute(): boolean {
    if (this.state === 'CLOSED') {
      return true;
    }

    if (this.state === 'OPEN') {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure >= this.config.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenSuccesses = 0;
        console.log(`[CIRCUIT ${this.name}] Transitioning from OPEN to HALF_OPEN after ${timeSinceFailure}ms cooldown`);
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        console.log(`[CIRCUIT ${this.name}] Transitioning from HALF_OPEN to CLOSED`);
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      console.log(`[CIRCUIT ${this.name}] Failure in HALF_OPEN - back to OPEN`);
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
      console.log(`[CIRCUIT ${this.name}] Failure threshold (${this.config.failureThreshold}) reached - OPEN`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getMetrics(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

const dbCircuitBreaker = new CircuitBreaker('DATABASE', DEFAULT_CIRCUIT_BREAKER_CONFIG);

function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = Math.min(
    config.baseDelayMs * Math.pow(2, attempt),
    config.maxDelayMs
  );
  const jitter = Math.random() * config.jitterMs;
  return exponentialDelay + jitter;
}

function isRetryableError(error: any): boolean {
  const message = error?.message?.toLowerCase() || '';
  const code = error?.code || '';
  
  const retryablePatterns = [
    'connection terminated',
    'connection timeout',
    'connection refused',
    'econnreset',
    'econnrefused',
    'etimedout',
    'too many clients',
    'remaining connection slots',
    'connection pool',
    'socket hang up',
  ];
  
  const retryableCodes = [
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08004', // sqlserver_rejected_establishment_of_sqlconnection
  ];
  
  return retryablePatterns.some(p => message.includes(p)) || retryableCodes.includes(code);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await operation();
      // Record success for alerting (resets failure count)
      systemAlertService.recordDatabaseSuccess();
      return result;
    } catch (error: any) {
      lastError = error;
      
      if (!isRetryableError(error) || attempt === config.maxRetries) {
        // Record final failure for alerting
        systemAlertService.recordDatabaseFailure(operationName, error).catch(() => {});
        throw error;
      }
      
      const delay = calculateDelay(attempt, config);
      console.log(`[DB RETRY] ${operationName} attempt ${attempt + 1} failed (${error.message}), retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  if (!dbCircuitBreaker.canExecute()) {
    const metrics = dbCircuitBreaker.getMetrics();
    const waitTime = DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs - (Date.now() - metrics.lastFailureTime);
    throw new Error(`[DB CIRCUIT OPEN] ${operationName} blocked - circuit breaker open, retry in ${Math.round(waitTime)}ms`);
  }
  
  try {
    const result = await operation();
    dbCircuitBreaker.recordSuccess();
    return result;
  } catch (error) {
    if (isRetryableError(error)) {
      dbCircuitBreaker.recordFailure();
    }
    throw error;
  }
}

export async function withResiliency<T>(
  operation: () => Promise<T>,
  operationName: string,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  return withCircuitBreaker(
    () => withRetry(operation, operationName, retryConfig),
    operationName
  );
}

export async function acquireConnectionWithRetry(
  pool: Pool,
  timeoutMs: number = 15000
): Promise<PoolClient> {
  const startTime = Date.now();
  let lastError: Error | null = null;
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const client = await Promise.race([
        pool.connect(),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Connection acquisition timeout')), 5000)
        ),
      ]);
      return client;
    } catch (error: any) {
      lastError = error;
      const elapsed = Date.now() - startTime;
      
      if (elapsed >= timeoutMs) {
        break;
      }
      
      const delay = Math.min(500 * Math.pow(2, Math.floor(elapsed / 2000)), 4000);
      console.log(`[DB POOL] Connection acquire failed (${error.message}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error(`Failed to acquire database connection after ${timeoutMs}ms: ${lastError?.message}`);
}

export async function executeWithTimeout<T>(
  client: PoolClient,
  query: string,
  params: any[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_CONFIG.statementTimeoutMs
): Promise<T> {
  try {
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const result = await client.query(query, params);
    return result as T;
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
  }
}

export function getCircuitBreakerMetrics() {
  return {
    database: dbCircuitBreaker.getMetrics(),
  };
}

export function getRetryConfig(): RetryConfig {
  return { ...DEFAULT_RETRY_CONFIG };
}

export function getTimeoutConfig(): QueryTimeoutConfig {
  return { ...DEFAULT_TIMEOUT_CONFIG };
}

export { DEFAULT_RETRY_CONFIG, DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_TIMEOUT_CONFIG };
