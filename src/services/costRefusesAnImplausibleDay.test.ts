/**
 * THE DAY THE ALLOCATION BOOKED A 104-SECOND CALL AT $37.43.
 *
 * `CAb04962a559c013987d12958542b2b02c`, optical, Saturday 2026-09-12, 104
 * seconds, stored at 3,743 cents with `cost_is_estimated = false` and
 * `cost_reconciled_at = 2026-09-13 20:45:49`. At the published rate that call
 * costs 14 cents.
 *
 * Nothing malfunctioned. xAI reported $37.43 of voice spend for that day,
 * `call_logs` held exactly ONE grok call — the queue lanes are near-silent at
 * the weekend — and largest remainder correctly handed the whole day to it.
 * The allocator did what it is for; what was missing was anything asking
 * whether the answer could be true.
 *
 * It is not academic: that one call is 21.7% of optical's entire reconciled
 * cost, and the Observatory's per-lane report sums this column
 * (`server/routes.ts:2259`, `:2300`).
 *
 * RULE THREE: the real SID and the real shape live here; the values below are
 * the day's actual arithmetic, which is not PHI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  impliedRateIsImplausible,
  RATE_SANITY_MULTIPLE,
  allocateDailyCost,
} from "./grokCostAllocation";
import {
  reconcileGrokCostsForDay,
  type ReconcilerPorts,
  type GrokCallRow,
} from "./grokCostReconciler";
import { GROK_COST_CENTS_PER_SECOND } from "./voiceCostRates";
import type { FetchLike, XaiBillingSetup } from "./xaiBilling";

const SETUP: XaiBillingSetup = {
  configured: true,
  config: { baseUrl: "https://management-api.x.ai", managementKey: "mk", teamId: "t" },
};

const spending = (usd: number): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        timeSeries: [{ groupLabels: ["grok-voice-think-fast-2.0"], dataPoints: [{ values: [usd] }] }],
      }),
  });

function ports(calls: GrokCallRow[]): ReconcilerPorts & { written: Array<{ callSid: string; costCents: number }> } {
  const written: Array<{ callSid: string; costCents: number }> = [];
  return {
    written,
    readDay: async () => calls,
    writeCosts: async (_day, costs) => {
      written.push(...costs);
      return costs.length;
    },
  };
}

/** The real day, by its real numbers. */
const SATURDAY = "2026-09-12";
const THE_ONE_CALL = "CAb04962a559c013987d12958542b2b02c";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("2026-09-12, replayed", () => {
  it("REFUSES the day instead of booking $37.43 onto 104 seconds", async () => {
    const p = ports([{ callSid: THE_ONE_CALL, durationSeconds: 104, estimatedCents: 14 }]);
    const out = await reconcileGrokCostsForDay(SATURDAY, p, { setup: SETUP, fetchImpl: spending(37.43) });

    expect(out.reconciled).toBe(false);
    // NOTHING is written — the rows stay estimated, which is the honest state.
    expect(p.written).toEqual([]);
    // And the refusal says what it saw, in the units a person reads.
    expect(out.reason).toMatch(/37\.43/);
    expect(out.reason).toMatch(/104s/);
    expect(out.reason).toMatch(/c\/min/);
    expect(out.xaiTotalCents).toBe(3743);
  });

  it("is what the ALLOCATOR would have produced, so the guard is the only thing standing between", () => {
    // Proof the refusal is not academic: this is the number that reached the
    // database, computed the same way it was on 2026-09-13.
    const allocation = allocateDailyCost([{ callSid: THE_ONE_CALL, durationSeconds: 104 }], 3743);
    expect(allocation.calls).toEqual([{ callSid: THE_ONE_CALL, costCents: 3743 }]);
    expect(impliedRateIsImplausible(allocation.derivedCentsPerSecond, GROK_COST_CENTS_PER_SECOND)).toBe(true);
  });
});

describe("what the threshold must not refuse", () => {
  /**
   * Every reconciled day on disk, by its own derived rate over OUR minutes.
   * The widest legitimate day is 2026-09-03 at 1.6x, so a real day must
   * survive and the test says which days those are rather than asserting a
   * bare boolean.
   */
  const REAL_DAYS: Array<[string, number, number]> = [
    // day, xAI-reported cents, seconds we recorded
    ["2026-09-03", 5355, 25116],
    ["2026-09-04", 7130, 43562],
    ["2026-09-08", 9317, 55623],
    ["2026-09-09", 7587, 46386],
    ["2026-09-10", 7832, 41487],
    ["2026-09-11", 9327, 48890],
    ["2026-09-14", 13218, 89069],
    ["2026-09-15", 10386, 76189],
  ];

  it.each(REAL_DAYS)("%s is written, not refused", (_day, cents, seconds) => {
    expect(impliedRateIsImplausible(cents / seconds, GROK_COST_CENTS_PER_SECOND)).toBe(false);
  });

  it("leaves real headroom above the widest day we have seen", () => {
    // 09-03 is the widest: 12.79 c/min against an assumed 8.00 = 1.60x.
    const widest = Math.max(...REAL_DAYS.map(([, c, s]) => c / s)) / GROK_COST_CENTS_PER_SECOND;
    expect(widest).toBeLessThan(2);
    expect(RATE_SANITY_MULTIPLE).toBeGreaterThan(widest);
  });

  it("does not bound the LOW side, because under-booking errs toward honest", () => {
    // 2026-09-15 came in 1% BELOW our own estimate and is a good day.
    expect(impliedRateIsImplausible(GROK_COST_CENTS_PER_SECOND / 100, GROK_COST_CENTS_PER_SECOND)).toBe(false);
    expect(impliedRateIsImplausible(0, GROK_COST_CENTS_PER_SECOND)).toBe(false);
  });

  it("judges nothing when there is nothing to judge", () => {
    // The no-seconds case has its own refusal; this predicate must not claim it.
    expect(impliedRateIsImplausible(null, GROK_COST_CENTS_PER_SECOND)).toBe(false);
    expect(impliedRateIsImplausible(5, 0)).toBe(false);
  });
});

describe("wiring, read from the source", () => {
  /**
   * Failure mode 10. A predicate that is never consulted is decoration, and
   * `rateDriftMarker` is the worked example: it has computed this exact number
   * since the module was written and only ever PRINTED it, which is why
   * 2026-09-12 was written at all.
   */
  const reconciler = readFileSync(path.resolve(__dirname, "./grokCostReconciler.ts"), "utf8");

  it("the reconciler consults the predicate", () => {
    expect(reconciler).toContain("impliedRateIsImplausible(allocation.derivedCentsPerSecond");
  });

  it("and it decides BEFORE the write, not after", () => {
    const guard = reconciler.indexOf("impliedRateIsImplausible(allocation.derivedCentsPerSecond");
    const write = reconciler.indexOf("await ports.writeCosts(");
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
    // And nothing returns between the guard and its own refusal, so the
    // branch cannot be left in the source and stone dead — the shape that
    // survived a first attempt on #318.
    expect(reconciler.slice(guard, guard + 400)).toMatch(/reconciled: false/);
  });
});

/**
 * THE REFUSAL HAS TO REACH A HUMAN, or the guard only half works.
 *
 * Codex P2, #319: `startGrokCostReconciler` discards the fulfilled outcome
 * and catches only rejections, so a refused day left the rows estimated, was
 * retried every six hours, and said nothing anywhere. The anomalous charge —
 * the one thing this guard exists to surface — was the most invisible of all.
 */
describe("a refused day is announced", () => {
  it("says so on the console, with the charge and the derived rate in it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = ports([{ callSid: THE_ONE_CALL, durationSeconds: 104, estimatedCents: 14 }]);
    await reconcileGrokCostsForDay(SATURDAY, p, { setup: SETUP, fetchImpl: spending(37.43) });

    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("[GROK COST]");
    expect(line).toContain("not reconciled");
    expect(line).toContain(SATURDAY);
    expect(line).toMatch(/37\.43/);
    expect(line).toMatch(/c\/min/);
  });

  it("announces EVERY refusal, not just the rate one", async () => {
    // A day with no runtime calls at all. Different branch, same requirement:
    // the scheduler cannot see the returned outcome, so the log is the only
    // channel there is.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reconcileGrokCostsForDay(SATURDAY, ports([]), { setup: SETUP, fetchImpl: spending(37.43) });

    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("not reconciled");
    expect(line).toContain("no runtime-served calls");
  });

  it("still announces a SUCCESSFUL day on info, and does not warn about it", async () => {
    // The guard must not have turned the good path into an alarm, and the
    // marker it has always printed must survive the move to the wrapper.
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = ports([{ callSid: THE_ONE_CALL, durationSeconds: 104, estimatedCents: 14 }]);
    const out = await reconcileGrokCostsForDay(SATURDAY, p, { setup: SETUP, fetchImpl: spending(0.14) });

    expect(out.reconciled).toBe(true);
    expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toContain("reconciled 1 call(s)");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("not reconciled");
  });

  it("logs at ONE exit, so a refusal branch added later cannot forget", () => {
    // Read from the source, because a test that only drives today's branches
    // proves nothing about the next one somebody adds (failure mode 10).
    const src = readFileSync(path.resolve(__dirname, "./grokCostReconciler.ts"), "utf8");
    // Exactly one site renders the marker for each outcome, and it is in the
    // wrapper — not scattered through the branches, which is the bug.
    expect(src.match(/console\.info\(reconcileMarker\(/g) ?? []).toHaveLength(1);
    expect(src.match(/console\.warn\(reconcileMarker\(/g) ?? []).toHaveLength(1);
    // And the branches themselves live in a function that cannot return to
    // the caller without passing through it.
    expect(src).toContain("const outcome = await runReconciliation(day, ports, options, scratch);");
    expect(src).toMatch(/async function runReconciliation\(/);
    // BOTH sites are in the WRAPPER, above the branching function — counting
    // them is not the same as locating them, and a mutation that moved the
    // success marker back inside the branches kept the count at one and
    // sailed through. The whole logging story has to read in one place.
    const body = src.indexOf("async function runReconciliation(");
    expect(body).toBeGreaterThan(-1);
    expect(src.indexOf("console.info(reconcileMarker(")).toBeLessThan(body);
    expect(src.indexOf("console.warn(reconcileMarker(")).toBeLessThan(body);
  });
});
