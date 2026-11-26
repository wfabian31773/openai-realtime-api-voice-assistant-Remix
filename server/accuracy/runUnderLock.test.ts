/**
 * The hourly accuracy run's lock. Production reaches the Hub through Supabase's
 * PgBouncer in transaction mode, where a session advisory lock can be taken on
 * one backend and "released" on another, leaving it held and every later run
 * skipped (Codex review of #525). The run uses the app's lease lock instead
 * (distributed_locks), and always releases it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RUN_LOCK_NAME, runUnderLock, type RunLock } from './accuracy';

function fakeLock(opts: { got?: boolean; acquireThrows?: boolean; releaseThrows?: boolean } = {}) {
  const calls: string[] = [];
  const lock: RunLock = {
    async acquire() {
      calls.push('acquire');
      if (opts.acquireThrows) throw new Error('no database');
      return opts.got ?? true;
    },
    async release() {
      calls.push('release');
      if (opts.releaseThrows) throw new Error('release failed');
    },
  };
  return { lock, calls };
}

describe('the hourly accuracy run lock', () => {
  it('runs once and releases the lock', async () => {
    const { lock, calls } = fakeLock();
    const run = vi.fn(async () => {});
    expect(await runUnderLock(lock, run)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(calls).toEqual(['acquire', 'release']);
  });

  it('releases the lock when the run throws', async () => {
    const { lock, calls } = fakeLock();
    expect(await runUnderLock(lock, async () => { throw new Error('boom'); })).toBe(false);
    expect(calls).toEqual(['acquire', 'release']);
  });

  it('skips the run when another process holds the lock, and releases nothing', async () => {
    const { lock, calls } = fakeLock({ got: false });
    const run = vi.fn(async () => {});
    expect(await runUnderLock(lock, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual(['acquire']);
  });

  it('skips quietly when the lock cannot be read', async () => {
    const { lock } = fakeLock({ acquireThrows: true });
    const run = vi.fn(async () => {});
    expect(await runUnderLock(lock, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not throw when the release fails (the lease expires on its own)', async () => {
    const { lock } = fakeLock({ releaseThrows: true });
    await expect(runUnderLock(lock, async () => {})).resolves.toBe(true);
  });

  it('uses the lease lock, never a session advisory lock', () => {
    const src = readFileSync(join(__dirname, 'accuracy.ts'), 'utf8');
    expect(src).not.toMatch(/pg_try_advisory_lock|pg_advisory_unlock/);
    expect(src).toContain("import('../../src/services/distributedLock')");
    expect(src).toContain('const lock = deps.runLock ?? leaseRunLock();');
    expect(RUN_LOCK_NAME).toBe('accuracy-check-run');
  });
});
