/**
 * server/preservedCostSet.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SQL THAT ACTUALLY GOES TO THE DATABASE, rendered and read.
 *
 * Three rounds of this PR were passed by checks that could only see the shape
 * of the code building this clause — a mutation ignoring the incoming Twilio
 * value passed a source scan cleanly (round 9), and a total rebuilt from the
 * stale column passed another (round 10). Drizzle renders a query without a
 * connection, so there is no longer any excuse for asserting on source text:
 * every case below reads the generated statement.
 */
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { callLogs } from '../shared/schema';
import { buildPreservedCostSet } from './preservedCostSet';

/** The UPDATE this clause would produce, as text plus bound parameters. */
function render(updates: Record<string, unknown>) {
  const built = buildPreservedCostSet(updates);
  if (!built.touchesCost) return { sql: '', params: [] as unknown[], built };
  const db = drizzle({} as never);
  const q = db
    .update(callLogs)
    .set(built.set as never)
    .where(eq(callLogs.id, 'call-id'));
  const { sql, params } = q.toSQL();
  return { sql, params: params as unknown[], built };
}

/** The `total_cost_cents = …` assignment, isolated from the rest of the SET. */
function totalClause(sql: string): string {
  const at = sql.indexOf('"total_cost_cents" =');
  if (at === -1) return '';
  const rest = sql.slice(at);
  const end = rest.indexOf(' where ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('an update that touches no defended column', () => {
  it('is handed straight through, with no CASE anywhere', () => {
    const built = buildPreservedCostSet({ status: 'completed', duration: 42 });
    expect(built.touchesCost).toBe(false);
    expect(built.set).toEqual({});
  });

  it('a Twilio price alone is not a defended column', () => {
    // twilio_cost_cents is written normally — it is the provider cost and the
    // total that a reconciled row defends, not Twilio's own charge.
    expect(buildPreservedCostSet({ twilioCostCents: 5 }).touchesCost).toBe(false);
  });
});

describe('the total is rebuilt from its two components, at write time', () => {
  /**
   * ROUND 13. A caller that fetched no fresh Twilio price correctly omits the
   * column so the stored one survives — but its total was assembled from a
   * snapshot read moments earlier. On an UNRECONCILED row the old clause
   * wrote that number verbatim, so a Twilio price corrected inside the window
   * left total_cost_cents disagreeing with its own components.
   */
  it('reads the stored Twilio column when the update does not carry one', () => {
    const { sql } = render({ openaiCostCents: 25, totalCostCents: 25 });
    const total = totalClause(sql);
    expect(total).toContain('COALESCE("call_logs"."twilio_cost_cents", 0)');
    // Both branches of the CASE, not just the reconciled one.
    expect(total.match(/COALESCE\("call_logs"\."twilio_cost_cents", 0\)/g)).toHaveLength(2);
  });

  it('reads the stored provider column when the update does not carry one', () => {
    const { sql } = render({ twilioCostCents: 7, totalCostCents: 999 });
    const total = totalClause(sql);
    expect(total).toContain('COALESCE("call_logs"."openai_cost_cents", 0)');
  });

  it('never writes the total the caller computed', () => {
    // 999 is deliberately not the sum of anything here. It must not appear.
    const { sql, params } = render({ openaiCostCents: 25, twilioCostCents: 7, totalCostCents: 999 });
    expect(totalClause(sql)).not.toContain('999');
    // ...and not smuggled in as a bound parameter either.
    const total = totalClause(sql);
    const placeholders = [...total.matchAll(/\$(\d+)/g)].map((m) => params[Number(m[1]) - 1]);
    expect(placeholders).not.toContain(999);
    expect(placeholders).toContain(25);
    expect(placeholders).toContain(7);
  });

  it('uses the INCOMING Twilio price, never the stale column, when one is supplied', () => {
    // Postgres evaluates SET against the pre-update row, so naming the column
    // here would read the OLD price while this same statement writes a new
    // one — on exactly the paths whose job is correcting it (round 9).
    const { sql, params } = render({ openaiCostCents: 25, twilioCostCents: 7, totalCostCents: 32 });
    const total = totalClause(sql);
    expect(total).not.toContain('"call_logs"."twilio_cost_cents"');
    const placeholders = [...total.matchAll(/\$(\d+)/g)].map((m) => params[Number(m[1]) - 1]);
    expect(placeholders).toContain(7);
  });
});

describe('a reconciled row keeps its invoice', () => {
  it('guards each defended column on the column itself, in SQL', () => {
    const { sql } = render({ openaiCostCents: 25, totalCostCents: 32, costIsEstimated: true });
    // The condition is read from the row, not from a constant the caller chose.
    expect(sql).toMatch(/"call_logs"\."cost_reconciled_at" IS NOT NULL/i);
    for (const col of ['"openai_cost_cents"', '"total_cost_cents"', '"cost_is_estimated"']) {
      const at = sql.indexOf(`${col} = `);
      expect(at, `${col} must be written`).toBeGreaterThan(-1);
      expect(sql.slice(at, at + 60)).toContain('CASE WHEN');
    }
  });

  it('rebuilds the reconciled total from the STORED provider cost', () => {
    const { sql } = render({ openaiCostCents: 25, twilioCostCents: 7, totalCostCents: 32 });
    const total = totalClause(sql);
    // The reconciled branch comes first and must read the column, so the
    // incoming 25 cannot displace an invoice.
    const reconciledBranch = total.slice(0, total.indexOf('ELSE'));
    expect(reconciledBranch).toContain('COALESCE("call_logs"."openai_cost_cents", 0)');
  });

  it('forces cost_is_estimated false on a reconciled row', () => {
    const { sql } = render({ costIsEstimated: true });
    const at = sql.indexOf('"cost_is_estimated" = ');
    const clause = sql.slice(at, sql.indexOf(' where ', at));
    expect(clause).toMatch(/CASE WHEN .*cost_reconciled_at.* THEN false ELSE .* END/i);
  });
});

describe('a Twilio price that is not a price', () => {
  it('is dropped from the write AND from the total, together', () => {
    const { sql, built } = render({ twilioCostCents: -5, totalCostCents: 10 });
    expect(built.rejectedTwilio).toBe(true);
    // Refusing it for the total while still writing it to the column is the
    // exact inconsistency this path exists to prevent (round 10).
    expect(sql).not.toContain('"twilio_cost_cents" = ');
    expect(totalClause(sql)).toContain('COALESCE("call_logs"."twilio_cost_cents", 0)');
  });

  it('accepts a genuine zero — Twilio reports it on some legs', () => {
    const { sql, params, built } = render({ twilioCostCents: 0, totalCostCents: 25 });
    expect(built.rejectedTwilio).toBe(false);
    expect(sql).toContain('"twilio_cost_cents" = ');
    const total = totalClause(sql);
    expect(total).not.toContain('"call_logs"."twilio_cost_cents"');
    const placeholders = [...total.matchAll(/\$(\d+)/g)].map((m) => params[Number(m[1]) - 1]);
    expect(placeholders).toContain(0);
  });
});

describe('columns that are not cost', () => {
  it('travel through untouched', () => {
    const { sql } = render({ status: 'completed', transcript: 'x', costIsEstimated: true });
    expect(sql).toContain('"status" = ');
    expect(sql).toContain('"transcript" = ');
    const at = sql.indexOf('"status" = ');
    expect(sql.slice(at, at + 40)).not.toContain('CASE');
  });
});
