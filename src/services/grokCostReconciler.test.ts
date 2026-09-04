/**
 * What the reconciler does, and — mostly — what it refuses to do.
 *
 * A cost reconciler that writes a wrong number is worse than one that writes
 * nothing, because "estimated" is honest and a reconciled number is believed.
 * Most of these tests are about declining.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reconcileGrokCostsForDay,
  reconcileMarker,
  type ReconcilerPorts,
  type GrokCallRow,
  previousUtcDay,
  startGrokCostReconciler,
} from "./grokCostReconciler";
import type { FetchLike, XaiBillingSetup } from "./xaiBilling";

const SETUP: XaiBillingSetup = {
  configured: true,
  config: { baseUrl: "https://management-api.x.ai", managementKey: "mk", teamId: "t" },
};

/** xAI answered with this many dollars for the day. */
const spending = (usd: number): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        timeSeries: [{ groupLabels: ["grok-voice-think-fast-2.0"], dataPoints: [{ values: [usd] }] }],
      }),
  });

const DAY = "2026-09-03";

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

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("reconciling a day", () => {
  it("splits xAI's total across the day's calls, to the cent", async () => {
    const p = ports([
      { callSid: "CA1", durationSeconds: 100, estimatedCents: 14 },
      { callSid: "CA2", durationSeconds: 200, estimatedCents: 27 },
    ]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(0.4) });
    expect(out.reconciled).toBe(true);
    expect(out.xaiTotalCents).toBe(40);
    expect(p.written.reduce((s, c) => s + c.costCents, 0)).toBe(40);
    // 100:200 seconds -> 1:2 of the money.
    expect(p.written).toEqual([
      { callSid: "CA1", costCents: 13 },
      { callSid: "CA2", costCents: 27 },
    ]);
  });

  it("reports what our estimate had said, so the drift is visible", async () => {
    const p = ports([{ callSid: "CA1", durationSeconds: 105, estimatedCents: 14 }]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(0.2) });
    expect(out.estimatedTotalCents).toBe(14);
    expect(out.xaiTotalCents).toBe(20);
  });

  /**
   * Rounding dollars to cents happens ONCE, at the day. Rounding per call is
   * exactly the bug being fixed: Math.ceil per call overstated the measured
   * 421 minutes by 3.5%, in the same direction every time.
   */
  it("rounds at the day, not at each call", async () => {
    const calls = Array.from({ length: 241 }, (_, i) => ({
      callSid: `CA${i}`,
      durationSeconds: 40 + ((i * 17) % 220),
      estimatedCents: 1,
    }));
    const p = ports(calls);
    // 33.6712 rounds DOWN to 3367 and ceils UP to 3368 — chosen so this test
    // can tell the two apart. Rounding to nearest is right: xAI's dollar
    // figure is the truth and we are only choosing a cent to store it in,
    // whereas ceiling it would overstate every day in the same direction,
    // which is the per-call bug this whole module exists to end.
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(33.6712) });
    expect(out.xaiTotalCents).toBe(3367);
    expect(p.written.reduce((s, c) => s + c.costCents, 0)).toBe(3367);
  });
});

describe("what it refuses", () => {
  it("writes NOTHING when xAI cannot be read", async () => {
    const p = ports([{ callSid: "CA1", durationSeconds: 100, estimatedCents: 14 }]);
    const out = await reconcileGrokCostsForDay(DAY, p, {
      setup: SETUP,
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
    });
    expect(out.reconciled).toBe(false);
    expect(p.written).toEqual([]);
  });

  it("writes NOTHING when the billing key is not configured", async () => {
    const p = ports([{ callSid: "CA1", durationSeconds: 100, estimatedCents: 14 }]);
    const out = await reconcileGrokCostsForDay(DAY, p, {
      setup: { configured: false, missing: ["XAI_MANAGEMENT_KEY", "XAI_TEAM_ID"] },
    });
    expect(out.reconciled).toBe(false);
    expect(out.reason).toContain("XAI_MANAGEMENT_KEY");
    expect(p.written).toEqual([]);
  });

  /**
   * A truncated usage series would be a total that is quietly too low, and
   * allocating it would mark every call on the day reconciled at the wrong
   * price — the worst outcome available, because it looks finished.
   */
  it("writes NOTHING when xAI say the series was truncated", async () => {
    const p = ports([{ callSid: "CA1", durationSeconds: 100, estimatedCents: 14 }]);
    const out = await reconcileGrokCostsForDay(DAY, p, {
      setup: SETUP,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ limitReached: true, timeSeries: [{ dataPoints: [{ values: [1] }] }] }),
      }),
    });
    expect(out.reconciled).toBe(false);
    expect(p.written).toEqual([]);
  });

  it("says so rather than throwing when the day cannot be read", async () => {
    const out = await reconcileGrokCostsForDay(
      DAY,
      { readDay: async () => { throw new Error("pool exhausted"); }, writeCosts: async () => 0 },
      { setup: SETUP, fetchImpl: spending(1) },
    );
    expect(out.reconciled).toBe(false);
    expect(out.reason).toContain("pool exhausted");
  });

  it("does not claim success when the write fails", async () => {
    const out = await reconcileGrokCostsForDay(
      DAY,
      {
        readDay: async () => [{ callSid: "CA1", durationSeconds: 10, estimatedCents: 1 }],
        writeCosts: async () => { throw new Error("deadlock"); },
      },
      { setup: SETUP, fetchImpl: spending(1) },
    );
    expect(out.reconciled).toBe(false);
    expect(out.reason).toContain("deadlock");
  });

  it("is a no-op on a day the runtime served nothing", async () => {
    const p = ports([]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(5) });
    expect(out.reconciled).toBe(false);
    expect(p.written).toEqual([]);
  });
});

describe("the marker", () => {
  it("states both totals and the direction of the gap", () => {
    const line = reconcileMarker({
      day: DAY, reconciled: true, callsUpdated: 241,
      xaiTotalCents: 3368, estimatedTotalCents: 3486,
    });
    expect(line).toContain("[GROK COST]");
    expect(line).toContain("$33.68");
    expect(line).toContain("$34.86");
    expect(line).toContain("-$1.18");
    expect(line).toContain("241");
  });

  it("says why when it did not run", () => {
    expect(reconcileMarker({ day: DAY, reconciled: false, reason: "no key" })).toContain("not reconciled");
  });

  it("carries no call sid and no phone number", () => {
    const line = reconcileMarker({
      day: DAY, reconciled: true, callsUpdated: 3, xaiTotalCents: 100, estimatedTotalCents: 90,
    });
    expect(line).not.toMatch(/CA[0-9a-f]{6}/);
    expect(line).not.toMatch(/\+?1?\d{10}/);
  });
});

describe("the nightly runner", () => {
  it("settles YESTERDAY, not today — today is still accruing", () => {
    expect(previousUtcDay(new Date("2026-09-04T01:30:00Z"))).toBe("2026-09-03");
    expect(previousUtcDay(new Date("2026-09-01T00:00:01Z"))).toBe("2026-08-31");
  });

  /**
   * A scheduler that wakes every few hours to say it has no credential is
   * noise, and noise is what stops people reading logs at all.
   */
  it("does NOT schedule without a management key, and says which vars to set", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const out = startGrokCostReconciler({
      setup: { configured: false, missing: ["XAI_MANAGEMENT_KEY", "XAI_TEAM_ID"] },
    });
    expect(out.scheduled).toBe(false);
    expect(out.timer).toBeUndefined();
    // Not .at(-1): the configured lib does not have it, and an earlier use of
    // it in this repo typechecked nowhere while passing at runtime.
    const calls = log.mock.calls;
    const line = String(calls[calls.length - 1]?.[0]);
    expect(line).toContain("DORMANT");
    expect(line).toContain("XAI_MANAGEMENT_KEY");
    expect(line).toContain("XAI_TEAM_ID");
    // The boot line has to say what happens meanwhile, or "dormant" reads as
    // "broken" rather than "still estimating, honestly".
    expect(line).toContain("cost_is_estimated");
  });

  it("runs once immediately when it IS configured, rather than waiting hours", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let askedFor: string | null = null;
    const out = startGrokCostReconciler({
      setup: SETUP,
      fetchImpl: spending(1),
      ports: {
        readDay: async (day) => {
          askedFor = day;
          return [];
        },
        writeCosts: async () => 0,
      },
    });
    try {
      expect(out.scheduled).toBe(true);
      // The first run is fired without awaiting, so let its microtasks drain.
      await new Promise((resolve) => setImmediate(resolve));
      expect(askedFor).toBe(previousUtcDay(new Date()));
    } finally {
      if (out.timer) clearInterval(out.timer);
    }
  });

  /** A billing job must never be the reason a deploy will not shut down. */
  it("does not hold the process open", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const out = startGrokCostReconciler({
      setup: SETUP,
      fetchImpl: spending(1),
      ports: { readDay: async () => [], writeCosts: async () => 0 },
    });
    try {
      expect(out.timer).toBeDefined();
      expect((out.timer as any)?.hasRef?.()).toBe(false);
    } finally {
      if (out.timer) clearInterval(out.timer);
    }
  });
});
