import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const where = vi.hoisted(() => vi.fn(async (_condition: unknown) => []));
vi.mock('../../server/db', () => ({ db: { select: () => ({ from: () => ({ where }) }) } }));
const { callbackExtensionFilings } = await import('./callbackExtensionNote');
const dialect = new PgDialect();

it('loads the base and patient-scoped filing keys for the call', async () => {
  const sid = 'CA0123456789abcdef0123456789abcdef';
  await callbackExtensionFilings(sid);
  const query = dialect.sqlToQuery(where.mock.lastCall![0] as any);
  expect(query.sql).toContain('idempotency_key');
  expect(query.params).toEqual([`call-${sid}`, `call-${sid}-p%`]);
});

it('can load the saved filing by ticket number when the call SID is absent', async () => {
  await callbackExtensionFilings(undefined, 'VA-TEST');
  const query = dialect.sqlToQuery(where.mock.lastCall![0] as any);
  expect(query.sql).toContain('ticket_number');
  expect(query.params).toEqual(['VA-TEST']);
});
