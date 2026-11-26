/**
 * THE CALL LOG LIST'S FILTERS AND SORT ORDERS (server/callLogListing.ts).
 *
 * The helpers are rendered to SQL and pinned; storage.getCallLogs is driven
 * with only the database replaced, so the ORDER BY and WHERE asserted are the
 * ones the list route sends. The same SQL was run read-only on the Hub on
 * 2026-11-26 over 14 days (8,502 calls): ghost 1,729 and real 6,773 (every
 * call in exactly one), transferred 713 and not 7,789.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  return { wheres: [] as unknown[], orders: [] as unknown[][] };
});

vi.mock('./db', () => {
  const where = (w: unknown) => {
    h.wheres.push(w);
    const counted = Promise.resolve([{ count: 0 }]);
    return Object.assign(counted, {
      orderBy: (...o: unknown[]) => {
        h.orders.push(o);
        return { limit: () => ({ offset: async () => [] }) };
      },
    });
  };
  return { db: { select: () => ({ from: () => ({ where }) }) }, pool: {} };
});

import { storage } from './storage';
import { callLogOrder, callQualityCondition, transferredCondition, callerWasHeard } from './callLogListing';

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);
const orderSql = (parts: unknown[]) => parts.map((p) => render(p).sql).join(', ');

beforeEach(() => {
  h.wheres.length = 0;
  h.orders.length = 0;
});

describe('callLogOrder', () => {
  it('"Oldest First" sorts oldest first (it sorted newest first)', () => {
    expect(orderSql(callLogOrder('date', 'asc'))).toBe('"call_logs"."created_at" asc, "call_logs"."id" asc');
  });

  it('newest first is the default, with the id as a tie-break', () => {
    expect(orderSql(callLogOrder(undefined, undefined))).toBe('"call_logs"."created_at" desc, "call_logs"."id" desc');
    expect(orderSql(callLogOrder('date', 'desc'))).toBe('"call_logs"."created_at" desc, "call_logs"."id" desc');
  });

  it('a call with no cost or duration sorts last in both directions, then by date and id', () => {
    expect(orderSql(callLogOrder('cost', 'desc'))).toBe(
      '"call_logs"."total_cost_cents" desc nulls last, "call_logs"."created_at" desc, "call_logs"."id" desc',
    );
    expect(orderSql(callLogOrder('cost', 'asc'))).toBe(
      '"call_logs"."total_cost_cents" asc nulls last, "call_logs"."created_at" desc, "call_logs"."id" desc',
    );
    expect(orderSql(callLogOrder('duration', 'desc'))).toBe(
      '"call_logs"."duration" desc nulls last, "call_logs"."created_at" desc, "call_logs"."id" desc',
    );
    expect(orderSql(callLogOrder('duration', 'asc'))).toBe(
      '"call_logs"."duration" asc nulls last, "call_logs"."created_at" desc, "call_logs"."id" desc',
    );
  });
});

describe('callQualityCondition', () => {
  it('a heard caller is a runtime call with a first caller transcript, or an old-core transcript with a caller line', () => {
    expect(render(callerWasHeard).sql).toBe(
      `("call_logs"."first_transcript_delay_ms" IS NOT NULL OR ("call_logs"."voice_provider" IS NULL AND strpos(coalesce("call_logs"."transcript", ''), 'CALLER:') > 0))`,
    );
  });

  it('a ghost is exactly a call on which the caller was never heard, and real is its complement', () => {
    const heard = render(callerWasHeard).sql;
    expect(render(callQualityCondition('ghost')).sql).toBe(`NOT ${heard}`);
    expect(render(callQualityCondition('real')).sql).toBe(heard);
    expect(callQualityCondition(undefined)).toBeUndefined();
  });

  it('no longer reads call length or a recording (the old rule put 1,006 heard callers among the ghosts)', () => {
    const q = render(callQualityCondition('ghost')).sql;
    expect(q).not.toContain('duration');
    expect(q).not.toContain('recording_url');
  });
});

describe('transferredCondition', () => {
  it('a queue transfer counts as transferred (the flag alone found 3 of 713)', () => {
    const q = render(transferredCondition(true));
    expect(q.sql).toBe('("call_logs"."transferred_to_human" = $1 or "call_logs"."runtime_outcome" = $2)');
    expect(q.params).toEqual([true, 'transferred']);
  });

  it('not transferred is the exact complement, nulls included', () => {
    const q = render(transferredCondition(false));
    expect(q.sql).toBe(
      '(("call_logs"."transferred_to_human" = $1 or "call_logs"."transferred_to_human" is null) and ("call_logs"."runtime_outcome" is null or "call_logs"."runtime_outcome" <> $2))',
    );
    expect(q.params).toEqual([false, 'transferred']);
    expect(transferredCondition(undefined)).toBeUndefined();
  });
});

describe('storage.getCallLogs', () => {
  it('sends the sort the page asked for', async () => {
    await storage.getCallLogs({ sortBy: 'date', sortOrder: 'asc' });
    expect(h.orders).toHaveLength(1);
    expect(orderSql(h.orders[0])).toBe('"call_logs"."created_at" asc, "call_logs"."id" asc');

    h.orders.length = 0;
    await storage.getCallLogs({ sortBy: 'cost', sortOrder: 'desc' });
    expect(orderSql(h.orders[0])).toContain('"call_logs"."total_cost_cents" desc nulls last');
  });

  it('the ghost filter reaches the query', async () => {
    await storage.getCallLogs({ callQuality: 'ghost' });
    expect(h.wheres.length).toBeGreaterThan(0);
    for (const w of h.wheres) {
      const q = render(w).sql;
      expect(q).toContain('NOT ("call_logs"."first_transcript_delay_ms" IS NOT NULL');
      expect(q).not.toContain('"call_logs"."recording_url"');
    }
  });

  it('the transferred filter reaches the query, queue transfers included', async () => {
    await storage.getCallLogs({ transferred: true });
    expect(h.wheres.length).toBeGreaterThan(0);
    for (const w of h.wheres) {
      const q = render(w);
      expect(q.sql).toContain('"call_logs"."runtime_outcome" = $');
      expect(q.params).toContain('transferred');
    }
  });
});
