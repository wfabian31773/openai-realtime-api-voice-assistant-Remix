/**
 * THE CALL-LOG SEARCH FINDS A CALL BY ITS SECOND TICKET (v223), and only a
 * ticket-shaped term changes the query.
 *
 * Driven through the REAL `storage.getCallLogs` with only the database
 * replaced, so the WHERE clause asserted is the one the list route sends.
 * The real SQL was also run read-only on the Hub: a search for PCP-78999
 * (the second ticket of CAea209df12ff11e5c11d5b04bb3fce82d, which the row's
 * `ticket_number` does not hold) finds that call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  return { wheres: [] as unknown[] };
});

vi.mock('./db', () => {
  const where = (w: unknown) => {
    h.wheres.push(w);
    const counted = Promise.resolve([{ count: 0 }]);
    return Object.assign(counted, {
      orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
    });
  };
  return { db: { select: () => ({ from: () => ({ where }) }) }, pool: {} };
});

import { storage } from './storage';
import { timelineHoldsTicket } from './callTicketSearch';

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);

beforeEach(() => {
  h.wheres.length = 0;
});

describe('timelineHoldsTicket', () => {
  it('asks whether a filing on the timeline reported the ticket, under either spelling', () => {
    const q = render(timelineHoldsTicket('pcp-78999'));
    expect(q.sql).toBe(
      '("call_logs"."tool_timeline" @> $1::jsonb OR "call_logs"."tool_timeline" @> $2::jsonb)',
    );
    expect(JSON.parse(String(q.params[0]))).toEqual({ events: [{ outcome: { ticket_number: 'PCP-78999' } }] });
    expect(JSON.parse(String(q.params[1]))).toEqual({ events: [{ outcome: { ticketNumber: 'PCP-78999' } }] });
  });

  it('is nothing for a term that is not a whole ticket number', () => {
    for (const t of ['Smith', '5551234567', 'VA-', '84703', '', undefined]) {
      expect(timelineHoldsTicket(t)).toBeNull();
    }
  });
});

describe('storage.getCallLogs search', () => {
  it('a ticket number also searches the timeline', async () => {
    await storage.getCallLogs({ search: 'PCP-78999' });
    for (const w of h.wheres) {
      const q = render(w);
      expect(q.sql).toContain('"call_logs"."ticket_number" ilike');
      expect(q.sql).toContain('"call_logs"."tool_timeline" @>');
      expect(q.params).toContain(JSON.stringify({ events: [{ outcome: { ticket_number: 'PCP-78999' } }] }));
    }
    expect(h.wheres).toHaveLength(2); // the count and the page, the same clause
  });

  it('a name or a phone runs exactly the query it ran before', async () => {
    for (const term of ['Smith', '5551234567']) {
      h.wheres.length = 0;
      await storage.getCallLogs({ search: term });
      for (const w of h.wheres) {
        const q = render(w);
        expect(q.sql).not.toContain('tool_timeline');
        expect(q.sql.match(/ ilike /g)).toHaveLength(5);
      }
    }
  });
});
