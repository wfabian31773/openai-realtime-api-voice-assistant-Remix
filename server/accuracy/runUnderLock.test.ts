/**
 * The hourly accuracy run takes a SESSION advisory lock. Taking it and
 * releasing it through the pool could use two connections, leaving the lock
 * held on the first and every later run skipped (Codex review of #525). Both
 * statements must run on one checked-out connection.
 */
import { describe, expect, it, vi } from 'vitest';
import { LOCK_SQL, UNLOCK_SQL, runUnderLock, type LockablePool } from './accuracy';

function fakePool(opts: { got?: boolean; unlockFails?: boolean; connectFails?: boolean } = {}) {
  const clients: Array<{ id: number; sql: string[]; released: Array<boolean | Error | undefined> }> = [];
  const poolSql: string[] = [];
  const pool: LockablePool = {
    async query(text) {
      poolSql.push(text);
      return { rows: [] };
    },
    async connect() {
      if (opts.connectFails) throw new Error('no connection');
      const c = { id: clients.length, sql: [] as string[], released: [] as Array<boolean | Error | undefined> };
      clients.push(c);
      return {
        async query(text: string) {
          c.sql.push(text);
          if (text === LOCK_SQL) return { rows: [{ got: opts.got ?? true }] };
          if (text === UNLOCK_SQL && opts.unlockFails) throw new Error('unlock failed');
          return { rows: [] };
        },
        release(destroy?: boolean | Error) {
          c.released.push(destroy);
        },
      };
    },
  };
  return { pool, clients, poolSql };
}

describe('the hourly accuracy run lock', () => {
  it('takes and releases the lock on the same connection, then returns it', async () => {
    const { pool, clients, poolSql } = fakePool();
    const run = vi.fn(async () => {});
    expect(await runUnderLock(pool, run)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(clients).toHaveLength(1);
    expect(clients[0].sql).toEqual([LOCK_SQL, UNLOCK_SQL]);
    expect(clients[0].released).toEqual([undefined]);
    expect(poolSql).toEqual([]);
  });

  it('releases the lock on that connection when the run throws', async () => {
    const { pool, clients } = fakePool();
    expect(await runUnderLock(pool, async () => { throw new Error('boom'); })).toBe(false);
    expect(clients[0].sql).toEqual([LOCK_SQL, UNLOCK_SQL]);
    expect(clients[0].released).toEqual([undefined]);
  });

  it('skips the run when another process holds the lock, and does not unlock', async () => {
    const { pool, clients } = fakePool({ got: false });
    const run = vi.fn(async () => {});
    expect(await runUnderLock(pool, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(clients[0].sql).toEqual([LOCK_SQL]);
    expect(clients[0].released).toEqual([undefined]);
  });

  it('destroys the connection when the unlock fails, so the session and its lock end', async () => {
    const { pool, clients } = fakePool({ unlockFails: true });
    await runUnderLock(pool, async () => {});
    expect(clients[0].released).toEqual([true]);
  });

  it('skips quietly when no connection can be had', async () => {
    const { pool } = fakePool({ connectFails: true });
    const run = vi.fn(async () => {});
    expect(await runUnderLock(pool, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
