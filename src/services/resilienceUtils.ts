/**
 * Shared Resilience Utilities for OpenAI and Twilio Integrations
 * 
 * Provides:
 * - Retry with exponential backoff and jitter
 * - Circuit breaker pattern to prevent cascading failures
 * - Configurable strategies for different integration types
 */

// ============================================================================
// TYPES
// ============================================================================

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
  retryableErrors?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts?: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: unknown;
  attempts: number;
  totalTimeMs: number;
}

// ============================================================================
// DEFAULT CONFIGURATIONS
// ============================================================================

export const OPENAI_RETRY_CONFIG: RetryOptions = {
  maxAttempts: 8,
  initialDelayMs: 200,
  maxDelayMs: 3000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
  retryableErrors: (error) => {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) return true;
      if (msg.includes('timeout') || msg.includes('timed out')) return true;
      if (msg.includes('econnreset') || msg.includes('econnrefused')) return true;
      if (msg.includes('503') || msg.includes('502') || msg.includes('500')) return true;
    }
    return false;
  },
};

export const TWILIO_RETRY_CONFIG: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.15,
  retryableErrors: (error) => {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('rate limit') || msg.includes('429')) return true;
      if (msg.includes('timeout')) return true;
      if (msg.includes('503') || msg.includes('502')) return true;
    }
    return false;
  },
};

export const TICKETING_RETRY_CONFIG: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 2000,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

export const OPENAI_CIRCUIT_CONFIG: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  halfOpenMaxAttempts: 2,
};

export const TWILIO_CIRCUIT_CONFIG: CircuitBreakerOptions = {
  failureThreshold: 3,
  resetTimeoutMs: 60000,
  halfOpenMaxAttempts: 1,
};

// ============================================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================================

/**
 * Execute an operation with retry logic using exponential backoff
 * 
 * @param operation - Async function to execute
 * @param options - Retry configuration
 * @param context - Optional context string for logging
 * @returns Result object with success status, result/error, and metrics
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  context?: string
): Promise<RetryResult<T>> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier = 2,
    jitterFactor = 0.1,
    retryableErrors = () => true,
    onRetry,
  } = options;

  const startTime = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      return {
        success: true,
        result,
        attempts: attempt,
        totalTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error;

      const isRetryable = retryableErrors(error);
      const hasMoreAttempts = attempt < maxAttempts;

      if (!isRetryable || !hasMoreAttempts) {
        if (context) {
          console.error(`[RESILIENCE] ${context} failed after ${attempt} attempts:`, error);
        }
        return {
          success: false,
          error: lastError,
          attempts: attempt,
          totalTimeMs: Date.now() - startTime,
        };
      }

      const baseDelay = Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs);
      const jitter = baseDelay * jitterFactor * (Math.random() * 2 - 1);
      const delayMs = Math.round(baseDelay + jitter);

      if (onRetry) {
        onRetry(attempt, error, delayMs);
      } else if (context) {
        console.warn(`[RESILIENCE] ${context} attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`);
      }

      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: maxAttempts,
    totalTimeMs: Date.now() - startTime,
  };
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

/**
 * Circuit breaker to prevent cascading failures
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests fail immediately
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private readonly name: string;
  private readonly options: CircuitBreakerOptions;

  constructor(name: string, options: CircuitBreakerOptions) {
    this.name = name;
    this.options = options;
  }

  /**
   * Execute an operation through the circuit breaker
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs) {
        this.transitionTo('half-open');
      } else {
        throw new CircuitOpenError(this.name, this.options.resetTimeoutMs - (Date.now() - this.lastFailureTime));
      }
    }

    if (this.state === 'half-open') {
      if (this.halfOpenAttempts >= (this.options.halfOpenMaxAttempts || 1)) {
        throw new CircuitOpenError(this.name, this.options.resetTimeoutMs);
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.transitionTo('closed');
    }
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.transitionTo('open');
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.transitionTo('open');
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'closed') {
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    }

    if (this.options.onStateChange) {
      this.options.onStateChange(oldState, newState);
    }

    console.info(`[CIRCUIT ${this.name}] State: ${oldState} → ${newState}`);
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

  reset(): void {
    this.transitionTo('closed');
    console.info(`[CIRCUIT ${this.name}] Manually reset`);
  }
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(circuitName: string, retryAfterMs: number) {
    super(`Circuit breaker '${circuitName}' is open. Retry after ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ============================================================================
// COMBINED RETRY + CIRCUIT BREAKER
// ============================================================================

/**
 * Execute an operation with both retry logic and circuit breaker protection
 */
export async function withResiliency<T>(
  operation: () => Promise<T>,
  circuitBreaker: CircuitBreaker,
  retryOptions: RetryOptions,
  context?: string
): Promise<RetryResult<T>> {
  return withRetry(
    () => circuitBreaker.execute(operation),
    {
      ...retryOptions,
      retryableErrors: (error) => {
        if (error instanceof CircuitOpenError) return false;
        return retryOptions.retryableErrors?.(error) ?? true;
      },
    },
    context
  );
}

// ============================================================================
// SINGLETON CIRCUIT BREAKERS FOR INTEGRATIONS
// ============================================================================

const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    const defaultOptions = name.toLowerCase().includes('openai') 
      ? OPENAI_CIRCUIT_CONFIG 
      : name.toLowerCase().includes('twilio')
        ? TWILIO_CIRCUIT_CONFIG
        : { failureThreshold: 5, resetTimeoutMs: 30000 };
    
    circuitBreakers.set(name, new CircuitBreaker(name, options || defaultOptions));
  }
  return circuitBreakers.get(name)!;
}

export function getCircuitBreakerMetrics(): Record<string, { state: CircuitState; failureCount: number; lastFailureTime: number }> {
  const metrics: Record<string, { state: CircuitState; failureCount: number; lastFailureTime: number }> = {};
  for (const [name, breaker] of circuitBreakers) {
    metrics[name] = breaker.getMetrics();
  }
  return metrics;
}

// ============================================================================
// UTILITIES
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a timeout wrapper for any promise
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${context || 'Operation'} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Wrap a fetch call with retry and circuit breaker
 */
export async function resilientFetch(
  url: string,
  options: RequestInit,
  config: {
    circuitName: string;
    retryOptions?: Partial<RetryOptions>;
    timeoutMs?: number;
    context?: string;
  }
): Promise<Response> {
  const circuitBreaker = getCircuitBreaker(config.circuitName);
  const retryOpts: RetryOptions = {
    ...OPENAI_RETRY_CONFIG,
    ...config.retryOptions,
  };

  const operation = async () => {
    const fetchPromise = fetch(url, options);
    const response = config.timeoutMs 
      ? await withTimeout(fetchPromise, config.timeoutMs, config.context)
      : await fetchPromise;

    if (!response.ok && response.status >= 500) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  };

  const result = await withResiliency(operation, circuitBreaker, retryOpts, config.context);

  if (!result.success) {
    throw result.error;
  }

  return result.result!;
}
