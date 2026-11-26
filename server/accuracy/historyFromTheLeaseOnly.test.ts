/**
 * Only the hourly run, holding the lease, writes accuracy history. A page load
 * or "Check now" runs the checks and returns them but stores nothing: the cache
 * and refresh throttle are per process, so requests reaching two replicas
 * would otherwise both write the same run (Codex review of #525).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountAccuracyCheck, type RunLock } from './accuracy';
import type { AccuracyDeps, Queryable } from './checks';

function fakeHub() {
  const sql: string[] = [];
  const hub: Queryable = {
    async query(text: string) {
      sql.push(text);
      return { rows: [] };
    },
  };
  const inserts = () => sql.filter((s) => /INSERT INTO accuracy_check_results/i.test(s)).length;
  return { hub, sql, inserts };
}

function checkDeps(): AccuracyDeps {
  return {
    // Every truth query answers nothing, so every check reads "could not check".
    hub: { async query() { return { rows: [] }; } },
    screens: {
      todayOverview: async () => ({ opsHub: [] }),
      scorecards: async () => [],
      budgetStatus: async () => ({ todaySpendCents: 0 }),
      operationsMonitor: async () => ({ calls: { total: 0 } }),
    },
  };
}

function mount(lock: RunLock) {
  const routes: Record<string, (req: unknown, res: unknown) => Promise<void>> = {};
  const app = { get: (path: string, _auth: unknown, h: (req: unknown, res: unknown) => Promise<void>) => { routes[path] = h; } };
  const { hub, inserts } = fakeHub();
  const acc = mountAccuracyCheck(app as never, {
    authenticate: ((_req: unknown, _res: unknown, next: () => void) => next()) as never,
    hub: () => hub,
    runLock: lock,
    checkDeps,
    env: {},
  });
  const get = async (refresh: boolean) => {
    let body: unknown;
    const res = { setHeader() {}, json: (b: unknown) => { body = b; }, status() { return res; } };
    await routes['/api/observatory/accuracy']({ query: refresh ? { refresh: '1' } : {} }, res);
    return body as { results: unknown[] };
  };
  return { acc, get, inserts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('accuracy history', () => {
  it('a page load and "Check now" show results and write nothing', async () => {
    const lock: RunLock = { acquire: vi.fn(async () => true), release: vi.fn(async () => {}) };
    const { get, inserts } = mount(lock);
    expect((await get(false)).results.length).toBeGreaterThan(0);
    await get(true);
    expect(inserts()).toBe(0);
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it('the hourly run writes one row set while it holds the lease', async () => {
    vi.useFakeTimers();
    const lock: RunLock = { acquire: vi.fn(async () => true), release: vi.fn(async () => {}) };
    const { acc, inserts } = mount(lock);
    const stop = acc.startSchedule();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 10);
    expect(lock.acquire).toHaveBeenCalledOnce();
    expect(inserts()).toBe(1);
    expect(lock.release).toHaveBeenCalledOnce();
    stop();
  });

  it('the hourly run writes nothing when another process holds the lease', async () => {
    vi.useFakeTimers();
    const lock: RunLock = { acquire: vi.fn(async () => false), release: vi.fn(async () => {}) };
    const { acc, inserts } = mount(lock);
    const stop = acc.startSchedule();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 10);
    expect(inserts()).toBe(0);
    stop();
  });
});
