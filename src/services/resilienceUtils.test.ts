import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, CircuitBreaker, withResiliency } from './resilienceUtils';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should succeed on first attempt when operation succeeds', async () => {
    const operation = vi.fn().mockResolvedValue('success');
    
    const promise = withRetry(operation, { 
      maxAttempts: 3, 
      initialDelayMs: 100, 
      maxDelayMs: 1000 
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed after transient failure', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValue('success');
    
    const promise = withRetry(operation, { 
      maxAttempts: 3, 
      initialDelayMs: 100, 
      maxDelayMs: 1000 
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('should exhaust retries and return failure after max attempts', async () => {
    const error = new Error('persistent error');
    const operation = vi.fn().mockRejectedValue(error);
    
    const promise = withRetry(operation, { 
      maxAttempts: 3, 
      initialDelayMs: 100, 
      maxDelayMs: 1000 
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.success).toBe(false);
    expect(result.error).toBe(error);
    expect(result.attempts).toBe(3);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should use exponential backoff between retries', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('error 1'))
      .mockRejectedValueOnce(new Error('error 2'))
      .mockResolvedValue('success');
    
    const onRetry = vi.fn();
    const promise = withRetry(operation, { 
      maxAttempts: 4, 
      initialDelayMs: 100,
      maxDelayMs: 1000,
      onRetry 
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.success).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow operations when circuit is closed', async () => {
    const breaker = new CircuitBreaker('test', { 
      failureThreshold: 3, 
      resetTimeoutMs: 30000 
    });
    const operation = vi.fn().mockResolvedValue('success');
    
    const result = await breaker.execute(operation);
    
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(breaker.getMetrics().state).toBe('closed');
  });

  it('should open after reaching failure threshold', async () => {
    const breaker = new CircuitBreaker('test-threshold', { 
      failureThreshold: 3, 
      resetTimeoutMs: 30000 
    });
    const failingOperation = vi.fn().mockRejectedValue(new Error('failure'));
    
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(failingOperation);
      } catch (e) {}
    }
    
    expect(breaker.getMetrics().state).toBe('open');
    expect(breaker.getMetrics().failureCount).toBe(3);
  });

  it('should reject calls when circuit is open', async () => {
    const breaker = new CircuitBreaker('test-open', { 
      failureThreshold: 2, 
      resetTimeoutMs: 30000 
    });
    const failingOperation = vi.fn().mockRejectedValue(new Error('failure'));
    const successOperation = vi.fn().mockResolvedValue('success');
    
    try { await breaker.execute(failingOperation); } catch (e) {}
    try { await breaker.execute(failingOperation); } catch (e) {}
    
    expect(breaker.getMetrics().state).toBe('open');
    
    await expect(breaker.execute(successOperation)).rejects.toThrow(/Circuit breaker.*is open/);
    expect(successOperation).not.toHaveBeenCalled();
  });

  it('should transition to half-open after reset timeout when call attempted', async () => {
    const breaker = new CircuitBreaker('test-halfopen', { 
      failureThreshold: 2, 
      resetTimeoutMs: 1000 
    });
    const failingOperation = vi.fn().mockRejectedValue(new Error('failure'));
    const successOperation = vi.fn().mockResolvedValue('success');
    
    try { await breaker.execute(failingOperation); } catch (e) {}
    try { await breaker.execute(failingOperation); } catch (e) {}
    
    expect(breaker.getMetrics().state).toBe('open');
    
    vi.advanceTimersByTime(1001);
    
    const result = await breaker.execute(successOperation);
    expect(result).toBe('success');
    expect(breaker.getMetrics().state).toBe('closed');
  });

  it('should close circuit after successful operation following timeout', async () => {
    const breaker = new CircuitBreaker('test-close', { 
      failureThreshold: 2, 
      resetTimeoutMs: 1000 
    });
    const failingOperation = vi.fn().mockRejectedValue(new Error('failure'));
    const successOperation = vi.fn().mockResolvedValue('success');
    
    try { await breaker.execute(failingOperation); } catch (e) {}
    try { await breaker.execute(failingOperation); } catch (e) {}
    
    expect(breaker.getMetrics().state).toBe('open');
    
    vi.advanceTimersByTime(1001);
    
    const result = await breaker.execute(successOperation);
    
    expect(result).toBe('success');
    expect(breaker.getMetrics().state).toBe('closed');
    expect(breaker.getMetrics().failureCount).toBe(0);
  });

  it('should reopen circuit after failure following timeout', async () => {
    const breaker = new CircuitBreaker('test-reopen', { 
      failureThreshold: 2, 
      resetTimeoutMs: 1000 
    });
    const failingOperation = vi.fn().mockRejectedValue(new Error('failure'));
    
    try { await breaker.execute(failingOperation); } catch (e) {}
    try { await breaker.execute(failingOperation); } catch (e) {}
    
    expect(breaker.getMetrics().state).toBe('open');
    
    vi.advanceTimersByTime(1001);
    
    try { await breaker.execute(failingOperation); } catch (e) {}
    
    expect(breaker.getMetrics().state).toBe('open');
  });
});

describe('withResiliency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should combine retry and circuit breaker for transient failures', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValue('success');
    
    const breaker = new CircuitBreaker('test-resilient', {
      failureThreshold: 5,
      resetTimeoutMs: 30000
    });
    
    const retryOpts = {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 1000
    };
    
    const promise = withResiliency(operation, breaker, retryOpts);
    
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe('Failure Mode Simulations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle OpenAI-style slow response with timeout', async () => {
    const slowOperation = vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve('late response'), 15000);
    }));
    
    const timeoutPromise = Promise.race([
      slowOperation(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
    ]);
    
    vi.advanceTimersByTime(10001);
    
    await expect(timeoutPromise).rejects.toThrow('timeout');
  });

  it('should handle Twilio callback failure with circuit breaker protection', async () => {
    const twilioBreaker = new CircuitBreaker('twilio-sim', { 
      failureThreshold: 3, 
      resetTimeoutMs: 30000 
    });
    
    const twilioCall = vi.fn().mockRejectedValue(new Error('Connection refused'));
    
    for (let i = 0; i < 3; i++) {
      try { await twilioBreaker.execute(twilioCall); } catch (e) {}
    }
    
    expect(twilioBreaker.getMetrics().state).toBe('open');
    expect(twilioBreaker.getMetrics().failureCount).toBe(3);
    
    await expect(twilioBreaker.execute(vi.fn())).rejects.toThrow(/Circuit breaker.*is open/);
    
    vi.advanceTimersByTime(30001);
    
    const recoveredCall = vi.fn().mockResolvedValue('ok');
    const result = await twilioBreaker.execute(recoveredCall);
    
    expect(result).toBe('ok');
    expect(twilioBreaker.getMetrics().state).toBe('closed');
  });

  it('should handle database connection failure with retry', async () => {
    const dbQuery = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValue([{ id: 1, data: 'result' }]);
    
    const promise = withRetry(dbQuery, { 
      maxAttempts: 5, 
      initialDelayMs: 100,
      maxDelayMs: 1000
    });
    
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.success).toBe(true);
    expect(result.result).toEqual([{ id: 1, data: 'result' }]);
    expect(dbQuery).toHaveBeenCalledTimes(3);
  });

  it('should propagate failure after all resilience attempts exhausted', async () => {
    const criticalOperation = vi.fn().mockRejectedValue(new Error('Critical system failure'));
    
    const promise = withRetry(criticalOperation, { 
      maxAttempts: 3, 
      initialDelayMs: 50,
      maxDelayMs: 500
    });
    
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('Critical system failure');
    expect(criticalOperation).toHaveBeenCalledTimes(3);
  });
});
