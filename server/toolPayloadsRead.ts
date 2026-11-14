/**
 * Read one call's full tool arguments and results (v238) for the call page's
 * Tool calls tab. Admin-only at the route (`server/routes.ts`); this module is
 * only the query, so it can be tested without a database.
 *
 * The table is created by the writer on its first insert
 * (`src/services/toolPayloads.ts`), so a deploy that has not stored a tool
 * call yet has no table, and that must read as "nothing stored" rather than a
 * 500 — the same rule the detail route applies to `call_events`.
 */
import { sql, type SQL } from 'drizzle-orm';
import { TOOL_PAYLOAD_RETENTION_DAYS } from '../src/services/toolPayloads';

export interface ToolPayloadView {
  seq: number;
  tool: string;
  eventAt: string;
  ms: number | null;
  args: unknown;
  result: unknown;
}

export interface ToolPayloadsResponse {
  payloads: ToolPayloadView[];
  retentionDays: number;
}

export async function toolPayloadsForCall(
  execute: (q: SQL) => Promise<unknown>,
  call: { logId: string; callSid: string | null },
): Promise<ToolPayloadsResponse> {
  let rows: any[] = [];
  try {
    const r: any = await execute(sql`
      SELECT seq, tool, event_at, ms, args, result
      FROM tool_call_payloads
      WHERE (call_log_id = ${call.logId}::text
             OR (${call.callSid}::text IS NOT NULL AND call_sid = ${call.callSid}::text))
        -- Never serve a row past the window, even before the purge reaches it.
        AND created_at >= now() - make_interval(days => ${TOOL_PAYLOAD_RETENTION_DAYS}::integer)
      ORDER BY at ASC, seq ASC, id ASC
    `);
    rows = r?.rows ?? r ?? [];
  } catch {
    rows = [];
  }
  return {
    payloads: rows.map((r) => ({
      seq: Number(r.seq),
      tool: String(r.tool),
      eventAt: String(r.event_at),
      ms: r.ms == null ? null : Number(r.ms),
      args: r.args ?? null,
      result: r.result ?? null,
    })),
    retentionDays: TOOL_PAYLOAD_RETENTION_DAYS,
  };
}
