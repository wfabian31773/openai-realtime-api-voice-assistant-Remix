/**
 * MARK A DEAD LETTER HANDLED, WITHOUT REPLAYING IT.
 *
 * Auth lives on the route. The write is keyed on id + dead_letter +
 * resolved_at IS NULL so a pending row and a second click are both no-ops
 * that say why, rather than silent overwrites.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const updateResults: unknown[] = [];
const selectResults: unknown[] = [];
const setPayloads: Record<string, unknown>[] = [];
const whereCols: string[][] = [];

function columnsOf(node: unknown, out: string[] = []): string[] {
  const n = node as { name?: unknown; table?: unknown; queryChunks?: unknown[] } | null;
  if (!n || typeof n !== 'object') return out;
  if (typeof n.name === 'string' && 'table' in n) out.push(n.name);
  for (const chunk of n.queryChunks ?? []) columnsOf(chunk, out);
  return out;
}

function chain(next: () => unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['from', 'limit', 'values', 'returning', 'groupBy', 'orderBy']) {
    self[m] = () => self;
  }
  self.where = (condition: unknown) => {
    whereCols.push(columnsOf(condition));
    return self;
  };
  self.set = (v: Record<string, unknown>) => {
    setPayloads.push(v);
    return self;
  };
  self.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
    Promise.resolve(next()).then(ok, err);
  return self;
}

vi.mock('../../server/db', () => ({
  db: {
    update: () => chain(() => updateResults.shift() ?? []),
    select: () => chain(() => selectResults.shift() ?? []),
  },
}));

const { actorFromRequest, resolveOutboxRow, listUnresolvedDeadLetters } = await import(
  './ticketOutboxResolve'
);

beforeEach(() => {
  updateResults.length = 0;
  selectResults.length = 0;
  setPayloads.length = 0;
  whereCols.length = 0;
});

describe('actorFromRequest', () => {
  it('prefers the session user', () => {
    expect(
      actorFromRequest({
        session: { userId: 'session-1' },
        user: { claims: { sub: 'claim-1' } },
      }),
    ).toBe('session-1');
  });

  it('falls back to the OIDC subject', () => {
    expect(actorFromRequest({ user: { claims: { sub: 'claim-1' } } })).toBe('claim-1');
  });

  it('returns null when nobody is on the request — the route must 401', () => {
    expect(actorFromRequest({})).toBeNull();
  });
});

describe('resolveOutboxRow', () => {
  it('writes resolved_at / resolved_by / the note on a winning update', async () => {
    const now = new Date('2026-09-25T20:00:00.000Z');
    updateResults.push([
      { id: 'ob-1', resolvedAt: now, resolvedBy: 'wayne' },
    ]);

    const res = await resolveOutboxRow({
      id: 'ob-1',
      resolvedBy: 'wayne',
      note: 'Handled — office filled, staff filed VA-61001',
    });

    expect(res).toEqual({
      ok: true,
      id: 'ob-1',
      resolvedAt: now.toISOString(),
      resolvedBy: 'wayne',
    });
    expect(setPayloads[0]?.resolvedBy).toBe('wayne');
    expect(setPayloads[0]?.resolutionNote).toBe(
      'Handled — office filled, staff filed VA-61001',
    );
    expect(setPayloads[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(whereCols[0]).toEqual(expect.arrayContaining(['id', 'status', 'resolved_at']));
  });

  it('does not invent a note from whitespace', async () => {
    updateResults.push([{ id: 'ob-1', resolvedAt: new Date(), resolvedBy: 'wayne' }]);
    await resolveOutboxRow({ id: 'ob-1', resolvedBy: 'wayne', note: '   ' });
    expect(setPayloads[0]?.resolutionNote).toBeNull();
  });

  it('says already_resolved when the row is there and already stamped', async () => {
    updateResults.push([]);
    selectResults.push([{ id: 'ob-1', status: 'dead_letter', resolvedAt: new Date() }]);
    const res = await resolveOutboxRow({ id: 'ob-1', resolvedBy: 'wayne' });
    expect(res).toEqual({ ok: false, reason: 'already_resolved' });
  });

  it('says not_dead_letter when the row is still pending', async () => {
    updateResults.push([]);
    selectResults.push([{ id: 'ob-1', status: 'pending', resolvedAt: null }]);
    const res = await resolveOutboxRow({ id: 'ob-1', resolvedBy: 'wayne' });
    expect(res).toEqual({ ok: false, reason: 'not_dead_letter' });
  });

  it('says not_found when there is no row', async () => {
    updateResults.push([]);
    selectResults.push([]);
    const res = await resolveOutboxRow({ id: 'missing', resolvedBy: 'wayne' });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('listUnresolvedDeadLetters', () => {
  it('labels a persisted 400 as terminal and a NULL status as transport', async () => {
    selectResults.push([
      {
        id: 'ob-term',
        callSid: 'CAf1c375ee5dc57dd6d705939a7f15cee7',
        createdAt: new Date('2026-09-25T18:00:00.000Z'),
        lastError: 'Missing required information: office',
        refusalStatusCode: 400,
        payload: {
          kind: 'create_ticket_v1',
          params: { departmentId: 1, callData: { agentUsed: 'optical' } },
        },
      },
      {
        id: 'ob-old',
        callSid: 'CA4707e391198147df5032f2e72884e998',
        createdAt: new Date('2026-09-25T18:05:00.000Z'),
        lastError: 'Missing required information: surgeon',
        refusalStatusCode: null,
        payload: {
          kind: 'create_ticket_v1',
          params: { departmentId: 2, callData: { agentUsed: 'surgery' } },
        },
      },
    ]);

    const rows = await listUnresolvedDeadLetters();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'ob-term',
      kind: 'terminal',
      departmentId: '1',
      agentUsed: 'optical',
    });
    expect(rows[1]).toMatchObject({
      id: 'ob-old',
      kind: 'transport',
      departmentId: '2',
      agentUsed: 'surgery',
    });
  });
});

describe('the resolve write is keyed so a second click cannot overwrite', () => {
  const source = readFileSync(new URL('./ticketOutboxResolve.ts', import.meta.url), 'utf8');
  const write = source.slice(
    source.indexOf('export async function resolveOutboxRow'),
    source.indexOf('export interface UnresolvedDeadLetter'),
  );

  it('updates only an unresolved dead letter', () => {
    const where = write.slice(write.indexOf('.where('));
    expect(where).toMatch(/eq\(ticketOutbox\.status, 'dead_letter'\)/);
    expect(where).toMatch(/isNull\(ticketOutbox\.resolvedAt\)/);
    expect(where).toMatch(/eq\(ticketOutbox\.id, input\.id\)/);
    // A commented-out eq still matches the literal. The live write
    // records the columns; that is what the winning-update test reads.
    expect(where).not.toMatch(/\/\/\s*eq\(ticketOutbox\.status/);
  });

  it('does not change status or payload — resolve is not a replay', () => {
    const set = write.slice(write.indexOf('.set({'), write.indexOf('.where('));
    expect(set).toMatch(/resolvedAt:/);
    expect(set).not.toMatch(/status:/);
    expect(set).not.toMatch(/payload:/);
  });
});

describe('the admin route and the Observatory button are the only writers', () => {
  const routes = readFileSync(new URL('../../server/routes.ts', import.meta.url), 'utf8');
  const listRoute = routes.slice(
    routes.indexOf("app.get('/api/ticket-outbox/unresolved'"),
    routes.indexOf("app.post('/api/ticket-outbox/:id/resolve'"),
  );
  const resolveRoute = routes.slice(
    routes.indexOf("app.post('/api/ticket-outbox/:id/resolve'"),
    routes.indexOf("app.post('/api/observatory/listen'"),
  );
  const page = readFileSync(new URL('../../client/src/pages/ObservatoryPage.tsx', import.meta.url), 'utf8');
  const queries = readFileSync(new URL('../../server/observatory/queries.ts', import.meta.url), 'utf8');

  it('guards both endpoints with isAuthenticated and requireRole admin', () => {
    expect(listRoute).toMatch(/isAuthenticated,\s*requireRole\('admin'\)/);
    expect(resolveRoute).toMatch(/isAuthenticated,\s*requireRole\('admin'\)/);
  });

  it('returns 401 when the request has no actor, even after the role check', () => {
    // requireRole can pass a session that has no userId (a stale cookie).
    // The write must still refuse rather than stamp resolved_by as empty.
    expect(resolveRoute).toMatch(/actorFromRequest\(req\)/);
    expect(resolveRoute).toMatch(/status\(401\)/);
  });

  it('maps already_resolved to 409 and not_found to 404', () => {
    expect(resolveRoute).toMatch(/already_resolved.*409/);
    expect(resolveRoute).toMatch(/not_found.*404/);
  });

  it('the Observatory resolve button posts the admin path', () => {
    expect(page).toMatch(/\/ticket-outbox\/\$\{id\}\/resolve/);
    expect(page).toMatch(/\/ticket-outbox\/unresolved/);
  });

  it('the Observatory queries module still has no write', () => {
    expect(queries).not.toMatch(/resolved_at|resolvedAt|ticket-outbox/);
  });
});
