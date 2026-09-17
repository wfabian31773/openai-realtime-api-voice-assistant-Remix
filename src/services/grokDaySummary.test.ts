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
 *  `existingRow`, records every statement with WHERE it ran (the pool, or a
 *  checked-out client — the port's decision-and-write transaction), throws
 *  on the first statement matching `failOn`, and counts releases. */
const pool = vi.hoisted(() => ({
  existingRow: null as null | { reconciled: boolean; runtime_calls: number | null },
  calls: [] as Array<{ sql: string; params?: unknown[]; via: "pool" | "client" }>,
  failOn: null as RegExp | null,
  released: 0,
  run: async (via: "pool" | "client", sql: string, params?: unknown[]) => {
    pool.calls.push({ sql, params, via });
    if (pool.failOn && pool.failOn.test(sql)) throw new Error(`fake pool refused: ${sql.slice(0, 40)}`);
    return /^\s*SELECT reconciled, runtime_calls/.test(sql) ? { rows: pool.existingRow ? [pool.existingRow] : [] } : { rows: [] };
  },
  query: vi.fn(async (sql: string, params?: unknown[]) => pool.run("pool", sql, params)),
  connect: vi.fn(async () => ({
    query: (sql: string, params?: unknown[]) => pool.run("client", sql, params),
    release: () => { pool.released += 1; },
  })),
}));
vi.mock("../../server/db", () => ({
  pool: {
    query: (...a: unknown[]) => (pool.query as any)(...a),
    connect: (...a: unknown[]) => (pool.connect as any)(...a),
  },
}));
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

  it("when xAI cannot be read: a row that says so, with no xAI figure — and the calls the day DOES hold, read for the summary alone (Codex P2, round 14)", async () => {
    // The outcome returns before readDay when xAI fails first. The first
    // version wrote that as 0 calls / 0 seconds / $0.00 — a measurement the
    // run never made. The summary now reads the day itself.
    const p = ports([{ callSid: "CA1", durationSeconds: 60, estimatedCents: 8 }]);
    await reconcileGrokCostsForDay("2026-09-05", p, {
      setup: SETUP,
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
    });
    expect(p.summaries).toHaveLength(1);
    expect(p.summaries[0]!.reconciled).toBe(false);
    expect(p.summaries[0]!.xaiVoiceCents).toBeUndefined();
    expect(p.summaries[0]).toMatchObject({ runtimeCalls: 1, runtimeSeconds: 60, bookedCents: 8 });
    expect(p.summaries[0]!.refusedReason).toBeTruthy();
  });

  it("when xAI cannot be read AND the day cannot be read either: the measurements are UNKNOWN, never zero, and the outcome still names xAI (round 14)", async () => {
    const p = ports([]);
    p.readDay = async () => { throw new Error("connection refused"); };
    const out = await reconcileGrokCostsForDay("2026-09-05", p, {
      setup: SETUP,
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
    });
    // The summary's own read never changes the outcome: xAI was the refusal.
    expect(out.reconciled).toBe(false);
    expect(out.reason).not.toMatch(/could not read the day/);
    expect(p.summaries).toHaveLength(1);
    const row = p.summaries[0]!;
    expect(row.runtimeCalls).toBeNull();
    expect(row.runtimeSeconds).toBeNull();
    expect(row.bookedCents).toBeNull();
    expect(row.reconciled).toBe(false);
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
    // An UNKNOWN day (round 14) reaches the page as null — Number(null) is 0,
    // which would present a day nobody could read as a measured empty one.
    expect(body).toMatch(/runtimeCalls: d\.runtime_calls == null \? null/);
    expect(body).toMatch(/runtimeMinutes: d\.runtime_seconds == null \? null/);
    expect(body).toMatch(/bookedDollars: d\.booked_cents == null \? null/);
  });

  it("the cost dashboard shows an unknown day as a dash, never as 0 calls / $0.00 (round 14)", () => {
    const page = read("client/src/pages/CostDashboardPage.tsx");
    expect(page).toMatch(/d\.runtimeCalls == null \? '—' : d\.runtimeCalls/);
    expect(page).toMatch(/d\.runtimeMinutes == null \? '—' : d\.runtimeMinutes/);
    expect(page).toMatch(/d\.bookedDollars == null \? '—' :/);
  });

  it("the cost dashboard asks for it", () => {
    expect(read("client/src/pages/CostDashboardPage.tsx")).toMatch(/\/analytics\/grok-usage\?/);
  });

  it("the call page says which kind of number the cost is — reconciled, calculated or estimated — keyed on the reconciliation stamp, never on the estimate flag alone", () => {
    const page = read("client/src/pages/CallDetailsPage.tsx");
    const rec = page.indexOf("log.costReconciledAt ?");
    const calc = page.indexOf("log.costIsEstimated === false");
    const est = page.indexOf("log.costIsEstimated === true");
    expect(rec).toBeGreaterThan(0);
    expect(calc).toBeGreaterThan(rec);
    expect(est).toBeGreaterThan(calc);
    expect(page.slice(rec, calc)).toMatch(/>reconciled</);
    // `costIsEstimated === false` is what updateCallCostsWithTokens writes for
    // a token-priced OpenAI call with no reconciliation at all, so it must
    // never be the reconciled arm (Codex P2, #321 round 10).
    expect(page.slice(calc, est)).toMatch(/>calculated</);
    expect(page.slice(calc, est)).not.toMatch(/>reconciled</);
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

  it("a refusal whose measurements are UNKNOWN counts as one that read no calls (round 14)", () => {
    const unknown = refusal({ runtimeCalls: null, runtimeSeconds: null, bookedCents: null });
    expect(daySummaryWrite({ reconciled: false, runtimeCalls: 239 }, unknown)).toBe("attempt_only");
    expect(daySummaryWrite({ reconciled: true, runtimeCalls: 239 }, unknown)).toBe("attempt_only");
    // ... and an unknown row on disk is replaced by anything that measured.
    expect(daySummaryWrite({ reconciled: false, runtimeCalls: null }, refusal({ runtimeCalls: 5, bookedCents: 40 }))).toBe("full");
    expect(daySummaryWrite({ reconciled: false, runtimeCalls: null }, unknown)).toBe("full");
    expect(daySummaryWrite(null, unknown)).toBe("full");
  });
});

describe("the production port keeps the measured row and records the attempt", () => {
  beforeEach(() => { pool.calls.length = 0; pool.existingRow = null; pool.failOn = null; pool.released = 0; });
  const measured = { day: "2026-09-16", reconciled: true, xaiVoiceCents: 5355, bookedCents: 5355, runtimeCalls: 239, runtimeSeconds: 25116 };
  const refused = { day: "2026-09-16", reconciled: false, refusedReason: "xai_unreachable", bookedCents: 0, runtimeCalls: 0, runtimeSeconds: 0 };
  const onClient = () => pool.calls.filter((c) => c.via === "client").map((c) => c.sql);

  it("a refusal on a reconciled day writes only last_attempt_*, never the upsert", async () => {
    pool.existingRow = { reconciled: true, runtime_calls: 239 };
    await databasePorts().writeDaySummary!(refused);
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls.some((q) => /INSERT INTO daily_grok_costs/.test(q)), "the upsert ran on a failed attempt").toBe(false);
    const attempt = pool.calls.find((c) => /SET last_attempt_at = NOW\(\), last_attempt_reason = \$2/.test(c.sql));
    expect(attempt?.params).toEqual(["2026-09-16", "xai_unreachable"]);
    expect(attempt?.via).toBe("client");
  });

  it("a first write, or a reconciliation, is the full upsert", async () => {
    await databasePorts().writeDaySummary!(measured);
    expect(pool.calls.some((c) => /INSERT INTO daily_grok_costs/.test(c.sql))).toBe(true);
    // The attempt columns exist on a table created before they did.
    expect(pool.calls.some((c) => /ADD COLUMN IF NOT EXISTS last_attempt_at/.test(c.sql))).toBe(true);
  });

  /**
   * THE DECISION AND THE WRITE ARE ONE TRANSACTION UNDER A PER-DAY LOCK —
   * Codex P1, #321 round 14. The scheduler runs in every process and the
   * database supports replicas, so a stale read on one runner could decide
   * `full` while another had just committed `reconciled = true`.
   */
  it("takes the day's advisory lock BEFORE reading the row, and commits after the write — all on one client (Codex P1, round 14)", async () => {
    pool.existingRow = { reconciled: false, runtime_calls: 239 };
    await databasePorts().writeDaySummary!(measured);
    const c = onClient();
    const begin = c.findIndex((q) => q === "BEGIN");
    const lock = c.findIndex((q) => /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(q));
    const read = c.findIndex((q) => /^\s*SELECT reconciled, runtime_calls/.test(q));
    const write = c.findIndex((q) => /INSERT INTO daily_grok_costs/.test(q));
    const commit = c.findIndex((q) => q === "COMMIT");
    expect(begin, "no transaction").toBeGreaterThanOrEqual(0);
    expect(lock, "no lock").toBeGreaterThan(begin);
    expect(read, "the row was read before the lock was held").toBeGreaterThan(lock);
    expect(write).toBeGreaterThan(read);
    expect(commit).toBeGreaterThan(write);
    // The lock is keyed on the DAY, so two days never serialise on each other.
    const lockCall = pool.calls.find((x) => /pg_advisory_xact_lock/.test(x.sql));
    expect(lockCall?.params).toEqual(["daily_grok_costs:2026-09-16"]);
    // The read and the write never run on the pool — a pool query is not in
    // the transaction that holds the lock.
    expect(pool.calls.filter((x) => x.via === "pool").map((x) => x.sql).join("\n")).not.toMatch(/SELECT reconciled, runtime_calls|INSERT INTO daily_grok_costs|last_attempt_at = NOW/);
    expect(pool.released).toBe(1);
  });

  it("the attempt-only arm commits under the same lock", async () => {
    pool.existingRow = { reconciled: true, runtime_calls: 239 };
    await databasePorts().writeDaySummary!(refused);
    const c = onClient();
    expect(c.findIndex((q) => /pg_advisory_xact_lock/.test(q))).toBeGreaterThan(c.indexOf("BEGIN"));
    expect(c.findIndex((q) => /last_attempt_at = NOW/.test(q))).toBeGreaterThan(c.findIndex((q) => /pg_advisory_xact_lock/.test(q)));
    expect(c[c.length - 1]).toBe("COMMIT");
    expect(pool.released).toBe(1);
  });

  it("a write that throws rolls the transaction back, releases the client, and still throws", async () => {
    pool.failOn = /INSERT INTO daily_grok_costs/;
    await expect(databasePorts().writeDaySummary!(measured)).rejects.toThrow(/fake pool refused/);
    const c = onClient();
    expect(c).toContain("ROLLBACK");
    expect(c).not.toContain("COMMIT");
    expect(pool.released).toBe(1);
  });

  it("the DDL is idempotent and runs outside the lock; the three measurement columns are nullable (round 14)", async () => {
    await databasePorts().writeDaySummary!(measured);
    const all = pool.calls.map((c) => c.sql);
    const create = all.findIndex((q) => /CREATE TABLE IF NOT EXISTS daily_grok_costs/.test(q));
    const begin = all.indexOf("BEGIN");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(begin);
    expect(pool.calls[create]!.via).toBe("pool");
    for (const col of ["booked_cents", "runtime_calls", "runtime_seconds"]) {
      expect(all.some((q) => new RegExp(`ALTER COLUMN ${col} DROP NOT NULL`).test(q)), `${col} is still NOT NULL — an unknown day would be forced to 0`).toBe(true);
      expect(all[create]).not.toMatch(new RegExp(`${col} INTEGER NOT NULL`));
    }
  });

  it("an UNKNOWN day is written as NULL in all three measurement columns, not as 0", async () => {
    await databasePorts().writeDaySummary!({ day: "2026-09-16", reconciled: false, refusedReason: "xai_unreachable", bookedCents: null, runtimeCalls: null, runtimeSeconds: null });
    const insert = pool.calls.find((c) => /INSERT INTO daily_grok_costs/.test(c.sql));
    expect(insert?.params?.[6]).toBeNull();  // booked_cents
    expect(insert?.params?.[8]).toBeNull();  // runtime_calls
    expect(insert?.params?.[9]).toBeNull();  // runtime_seconds
  });
});
