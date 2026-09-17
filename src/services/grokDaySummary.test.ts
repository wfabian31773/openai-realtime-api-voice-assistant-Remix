/**
 * THE RECONCILER WRITES ONE ROW PER DAY, REFUSALS INCLUDED.
 *
 * Measured 2026-09-17 against the operator's own xAI usage export: 2026-09-12
 * booked $37.43 onto ONE 104-second runtime call (the guard that refuses that
 * now exists; the row was written before it did), and 09-09 / 09-14 booked
 * voice above the whole account's day. None of that was visible in SQL,
 * because the reconciler kept the day's xAI figures — and its refusals — in
 * console lines only. `daily_grok_costs` is where they go now; this pins what
 * the row says on a reconciled day, on a refused day, and when xAI is down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  reconcileGrokCostsForDay,
  daySummaryFrom,
  daySummaryWrite,
  databasePorts,
  type ReconcilerPorts,
  type GrokCallRow,
  type GrokDaySummary,
} from "./grokCostReconciler";

/** A fake pool for the production port: answers the existing-row SELECT from
 *  `existingRow` and records every statement. */
const pool = vi.hoisted(() => ({
  existingRow: null as null | { reconciled: boolean; runtime_calls: number },
  calls: [] as Array<{ sql: string; params?: unknown[] }>,
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    pool.calls.push({ sql, params });
    return /^\s*SELECT reconciled, runtime_calls/.test(sql) ? { rows: pool.existingRow ? [pool.existingRow] : [] } : { rows: [] };
  }),
}));
vi.mock("../../server/db", () => ({ pool: { query: (...a: unknown[]) => (pool.query as any)(...a) } }));
import type { FetchLike, XaiBillingSetup } from "./xaiBilling";

const SETUP: XaiBillingSetup = {
  configured: true,
  config: { baseUrl: "https://management-api.x.ai", managementKey: "mk", teamId: "t" },
};

/** xAI's usage response: a voice line, and a text line the reconciler must ignore. */
const spending = (voiceUsd: number, textUsd = 5.35): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        timeSeries: [
          { groupLabels: ["grok-voice-think-fast-2.0"], dataPoints: [{ values: [voiceUsd] }] },
          { groupLabels: ["grok-4-fast-non-reasoning"], dataPoints: [{ values: [textUsd] }] },
        ],
      }),
  });

function ports(calls: GrokCallRow[]) {
  const summaries: GrokDaySummary[] = [];
  const p: ReconcilerPorts & { summaries: GrokDaySummary[] } = {
    summaries,
    readDay: async () => calls,
    writeCosts: async (_day, costs) => costs.length,
    writeDaySummary: async (s) => { summaries.push(s); },
  };
  return p;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the day row", () => {
  it("on a reconciled day: xAI's voice total, the lines it ignored, and booked = xAI", async () => {
    const p = ports([
      { callSid: "CA1", durationSeconds: 600, estimatedCents: 80 },
      { callSid: "CA2", durationSeconds: 300, estimatedCents: 40 },
    ]);
    await reconcileGrokCostsForDay("2026-09-03", p, { setup: SETUP, fetchImpl: spending(1.5) });
    expect(p.summaries).toHaveLength(1);
    expect(p.summaries[0]).toMatchObject({
      day: "2026-09-03",
      reconciled: true,
      xaiVoiceCents: 150,
      bookedCents: 150,
      estimatedCents: 120,
      runtimeCalls: 2,
      runtimeSeconds: 900,
    });
    expect(p.summaries[0]!.refusedReason).toBeUndefined();
    expect(p.summaries[0]!.xaiVoiceLines).toEqual([{ description: "grok-voice-think-fast-2.0", usd: 1.5 }]);
    expect(p.summaries[0]!.xaiIgnoredLines).toEqual([{ description: "grok-4-fast-non-reasoning", usd: 5.35 }]);
    expect(p.summaries[0]!.derivedCentsPerMinute).toBeCloseTo(10, 5); // 150c / 15min
  });

  /** 2026-09-12: $37.43 against one 104-second call. */
  it("on a refused day: the reason, xAI's figure, and booked = the estimate the rows keep", async () => {
    const p = ports([{ callSid: "CAb04962a5", durationSeconds: 104, estimatedCents: 14 }]);
    const out = await reconcileGrokCostsForDay("2026-09-12", p, { setup: SETUP, fetchImpl: spending(37.43) });
    expect(out.reconciled).toBe(false);
    expect(p.summaries).toHaveLength(1);
    expect(p.summaries[0]).toMatchObject({
      day: "2026-09-12",
      reconciled: false,
      xaiVoiceCents: 3743,
      bookedCents: 14,
      runtimeCalls: 1,
      runtimeSeconds: 104,
    });
    expect(p.summaries[0]!.refusedReason).toMatch(/c\/min/);
  });

  it("when xAI cannot be read: a row that says so, with no xAI figure and the estimate as booked", async () => {
    const p = ports([{ callSid: "CA1", durationSeconds: 60, estimatedCents: 8 }]);
    await reconcileGrokCostsForDay("2026-09-05", p, {
      setup: SETUP,
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
    });
    expect(p.summaries).toHaveLength(1);
    expect(p.summaries[0]!.reconciled).toBe(false);
    expect(p.summaries[0]!.xaiVoiceCents).toBeUndefined();
    // The day was never read (xAI failed first), so the row cannot count calls it did not see.
    expect(p.summaries[0]!.runtimeCalls).toBe(0);
    expect(p.summaries[0]!.refusedReason).toBeTruthy();
  });

  it("a failed summary write never changes the outcome", async () => {
    const p = ports([{ callSid: "CA1", durationSeconds: 600, estimatedCents: 80 }]);
    p.writeDaySummary = async () => { throw new Error("relation does not exist"); };
    const out = await reconcileGrokCostsForDay("2026-09-03", p, { setup: SETUP, fetchImpl: spending(0.8) });
    expect(out.reconciled).toBe(true);
  });

  it("a port without the summary hook still reconciles", async () => {
    const out = await reconcileGrokCostsForDay(
      "2026-09-03",
      { readDay: async () => [{ callSid: "CA1", durationSeconds: 600, estimatedCents: 80 }], writeCosts: async (_d, c) => c.length },
      { setup: SETUP, fetchImpl: spending(0.8) },
    );
    expect(out.reconciled).toBe(true);
  });
});

describe("daySummaryFrom", () => {
  it("converts the per-second rate to per-minute and leaves an unknown rate unknown", () => {
    const base = { day: "d", reconciled: false as const, derivedCentsPerSecond: null };
    expect(daySummaryFrom(base, { calls: [] }).derivedCentsPerMinute).toBeNull();
    expect(daySummaryFrom({ ...base, derivedCentsPerSecond: 0.2 }, { calls: [] }).derivedCentsPerMinute).toBeCloseTo(12);
    expect(daySummaryFrom({ day: "d", reconciled: true }, {}).derivedCentsPerMinute).toBeUndefined();
  });
});

describe("the production port", () => {
  const src = readFileSync(new URL("./grokCostReconciler.ts", import.meta.url), "utf8");
  it("creates the table on first write and keeps one row per day", () => {
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS daily_grok_costs/);
    expect(src).toMatch(/ON CONFLICT \(day\) DO UPDATE/);
  });
  it("writes the summary on every outcome, before the marker is printed", () => {
    const write = src.indexOf("ports.writeDaySummary(daySummaryFrom(outcome, scratch))");
    const marker = src.indexOf("if (outcome.reconciled) console.info(reconcileMarker(outcome));");
    expect(write).toBeGreaterThan(0);
    expect(write).toBeLessThan(marker);
  });
});

/**
 * THE WIRING, read from source. A table nothing serves and a page nothing
 * reads would leave the operator exactly where he was — comparing his xAI
 * export against a console line.
 */
describe("the day table reaches the Observatory", () => {
  const root = new URL("../../", import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, root), "utf8");

  it("the API serves daily_grok_costs on /api/analytics/grok-usage, and a missing table is no rows rather than a 500", () => {
    const routes = read("server/routes.ts");
    const at = routes.indexOf("app.get('/api/analytics/grok-usage'");
    expect(at, "the route is not registered").toBeGreaterThan(0);
    const body = routes.slice(at, at + 3000);
    expect(body).toMatch(/FROM daily_grok_costs/);
    expect(body).toMatch(/tableExists = false/);
  });

  it("the cost dashboard asks for it", () => {
    expect(read("client/src/pages/CostDashboardPage.tsx")).toMatch(/\/analytics\/grok-usage\?/);
  });

  it("the call page says which kind of number the cost is — reconciled or estimated — and never one for the other", () => {
    const page = read("client/src/pages/CallDetailsPage.tsx");
    const rec = page.indexOf("log.costIsEstimated === false");
    const est = page.indexOf("log.costIsEstimated === true");
    expect(rec).toBeGreaterThan(0);
    expect(est).toBeGreaterThan(rec);
    expect(page.slice(rec, est)).toMatch(/>reconciled</);
    expect(page.slice(est, est + 400)).toMatch(/>estimated</);
  });
});

/**
 * A FAILED RERUN NEVER OVERWRITES A MEASURED ROW — Codex P1 on #321. The
 * scheduler attempts each day up to four times; a later run that cannot reach
 * xAI or the database must not turn a reconciled row into false / null / 0.
 */
describe("daySummaryWrite", () => {
  const measured = (over: Partial<GrokDaySummary> = {}): GrokDaySummary => ({
    day: "2026-09-16", reconciled: true, xaiVoiceCents: 5355, bookedCents: 5355, runtimeCalls: 239, runtimeSeconds: 25116, ...over,
  });
  const refusal = (over: Partial<GrokDaySummary> = {}): GrokDaySummary => ({
    day: "2026-09-16", reconciled: false, refusedReason: "xai_unreachable", bookedCents: 0, runtimeCalls: 0, runtimeSeconds: 0, ...over,
  });

  it("the first write of a day is always full, whatever it says", () => {
    expect(daySummaryWrite(null, measured())).toBe("full");
    expect(daySummaryWrite(null, refusal())).toBe("full");
  });

  it("a reconciliation always replaces what is there", () => {
    expect(daySummaryWrite({ reconciled: false, runtimeCalls: 239 }, measured())).toBe("full");
    expect(daySummaryWrite({ reconciled: true, runtimeCalls: 239 }, measured())).toBe("full");
  });

  it("a refusal landing on a reconciled day is an attempt, not a measurement", () => {
    expect(daySummaryWrite({ reconciled: true, runtimeCalls: 239 }, refusal())).toBe("attempt_only");
    expect(daySummaryWrite({ reconciled: true, runtimeCalls: 239 }, refusal({ runtimeCalls: 239, bookedCents: 3466 }))).toBe("attempt_only");
  });

  it("a refusal that read no calls does not erase a refusal that did", () => {
    expect(daySummaryWrite({ reconciled: false, runtimeCalls: 239 }, refusal())).toBe("attempt_only");
    // A refusal that DID read the calls is a newer measurement and replaces an older refusal.
    expect(daySummaryWrite({ reconciled: false, runtimeCalls: 239 }, refusal({ runtimeCalls: 240, bookedCents: 3470 }))).toBe("full");
  });
});

describe("the production port keeps the measured row and records the attempt", () => {
  beforeEach(() => { pool.calls.length = 0; pool.existingRow = null; });

  it("a refusal on a reconciled day writes only last_attempt_*, never the upsert", async () => {
    pool.existingRow = { reconciled: true, runtime_calls: 239 };
    await databasePorts().writeDaySummary!({ day: "2026-09-16", reconciled: false, refusedReason: "xai_unreachable", bookedCents: 0, runtimeCalls: 0, runtimeSeconds: 0 });
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls.some((q) => /INSERT INTO daily_grok_costs/.test(q)), "the upsert ran on a failed attempt").toBe(false);
    const attempt = pool.calls.find((c) => /SET last_attempt_at = NOW\(\), last_attempt_reason = \$2/.test(c.sql));
    expect(attempt?.params).toEqual(["2026-09-16", "xai_unreachable"]);
  });

  it("a first write, or a reconciliation, is the full upsert", async () => {
    await databasePorts().writeDaySummary!({ day: "2026-09-16", reconciled: true, xaiVoiceCents: 5355, bookedCents: 5355, runtimeCalls: 239, runtimeSeconds: 25116 });
    expect(pool.calls.some((c) => /INSERT INTO daily_grok_costs/.test(c.sql))).toBe(true);
    // The attempt columns exist on a table created before they did.
    expect(pool.calls.some((c) => /ADD COLUMN IF NOT EXISTS last_attempt_at/.test(c.sql))).toBe(true);
  });
});
