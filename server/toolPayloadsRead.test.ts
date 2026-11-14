/**
 * The read half of v238: one call's full tool arguments and results for the
 * call page's Tool calls tab. Admin-only at the route; the query is tested
 * here without a database.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('./db', () => ({ db: {} }));

const { toolPayloadsForCall } = await import('./toolPayloadsRead');
const dialect = new PgDialect();

describe('toolPayloadsForCall', () => {
  it('reads by the call row and the CallSid, in the order the tools ran', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const out = await toolPayloadsForCall(
      async (q: SQL) => {
        seen.push(dialect.sqlToQuery(q));
        return {
          rows: [
            { seq: '0', tool: 'lookup_patient', event_at: '2026-11-14T10:00:00.000Z', ms: '120', args: { a: 1 }, result: { success: true } },
            { seq: 1, tool: 'end_call', event_at: '2026-11-14T10:01:00.000Z', ms: null, args: null, result: null },
          ],
        };
      },
      { logId: 'row-1', callSid: 'CA00000000000000000000000000000b01' },
    );
    expect(seen[0].sql).toContain('FROM tool_call_payloads');
    expect(seen[0].sql).toContain('call_log_id = $1::text');
    expect(seen[0].sql).toContain('call_sid = $3::text');
    expect(seen[0].sql).toContain('ORDER BY at ASC, seq ASC, id ASC');
    expect(seen[0].params).toEqual(['row-1', 'CA00000000000000000000000000000b01', 'CA00000000000000000000000000000b01', 30]);
    expect(out.retentionDays).toBe(30);
    expect(out.payloads).toEqual([
      { seq: 0, tool: 'lookup_patient', eventAt: '2026-11-14T10:00:00.000Z', ms: 120, args: { a: 1 }, result: { success: true } },
      { seq: 1, tool: 'end_call', eventAt: '2026-11-14T10:01:00.000Z', ms: null, args: null, result: null },
    ]);
  });

  it('never serves a row past the 30-day window, even before the purge reaches it (github-actions review of #484)', async () => {
    const seen: string[] = [];
    await toolPayloadsForCall(
      async (q: SQL) => {
        seen.push(dialect.sqlToQuery(q).sql);
        return { rows: [] };
      },
      { logId: 'row-1', callSid: null },
    );
    expect(seen[0]).toContain('AND created_at >= now() - make_interval(days => $4::integer)');
    // the window applies to both ways of finding the call, not only the second
    expect(seen[0]).toMatch(/WHERE \(call_log_id = \$1::text\s+OR \(/);
  });

  it('a table that does not exist yet reads as nothing stored, not an error', async () => {
    const out = await toolPayloadsForCall(
      async () => {
        throw new Error('relation "tool_call_payloads" does not exist');
      },
      { logId: 'row-1', callSid: null },
    );
    expect(out.payloads).toEqual([]);
  });

  it('the route is admin-only and never cached', () => {
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes("'/api/call-logs/:id/tool-payloads'"));
    expect(line).toContain("requireRole('admin')");
    const body = src.slice(src.indexOf("'/api/call-logs/:id/tool-payloads'"), src.indexOf('STREAM THE RECORDING AUDIO'));
    expect(body).toContain("'Cache-Control', 'no-store'");
    expect(body).toContain('toolPayloadsForCall(');
    // the detail route everyone can read does not serve the store
    const detail = src.slice(src.indexOf("'/api/call-logs/:id/detail'"), src.indexOf("'/api/call-logs/:id/tool-payloads'"));
    expect(detail).not.toContain('tool_call_payloads');
  });
});
