/**
 * What the reconciler does, and — mostly — what it refuses to do.
 *
 * A cost reconciler that writes a wrong number is worse than one that writes
 * nothing, because "estimated" is honest and a reconciled number is believed.
 * Most of these tests are about declining.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  reconcileGrokCostsForDay,
  reconcileMarker,
  type ReconcilerPorts,
  type GrokCallRow,
  previousUtcDay,
  startGrokCostReconciler,
  mapDayRow,
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

  /**
   * xAI billed for the day but every row has a null or zero duration. The
   * allocation correctly hands out zeros — there is nothing to divide by —
   * and writing them would mark every row reconciled and NOT-estimated at
   * $0 against a positive invoice, then report success. Zeros wearing an
   * authoritative badge are the worst thing this module can produce
   * (Codex, PR #268 round 2).
   */
  it("REFUSES a positive bill with no billable seconds, rather than writing zeros", async () => {
    const p = ports([
      { callSid: "CA1", durationSeconds: 0, estimatedCents: 0 },
      { callSid: "CA2", durationSeconds: 0, estimatedCents: 0 },
    ]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(33.68) });
    expect(out.reconciled).toBe(false);
    expect(out.reason).toContain("no billable seconds");
    expect(p.written).toEqual([]);
  });

  /**
   * ROUND 16. The round-2 case above is every row; this is one row among
   * many, which is the shape that actually reaches production — the status
   * callback permits a terminal update with no CallDuration.
   */
  it("REFUSES a day where even ONE finalised call has an UNKNOWN duration", async () => {
    const p = ports([
      { callSid: "CA1", durationSeconds: 120, estimatedCents: 16 },
      { callSid: "CA2", durationSeconds: 90, estimatedCents: 12 },
      { callSid: "CA3", durationSeconds: 0, estimatedCents: 0, durationUnknown: true },
    ]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(33.68) });
    expect(out.reconciled).toBe(false);
    // The reason has to name the blocker, or the refusal is undiagnosable.
    expect(out.reason).toContain("CA3");
    expect(out.reason).toContain("1 of 3");
    // Nothing written — not even for the two rows that DO have durations.
    expect(p.written).toEqual([]);
  });

  it("reconciles the same day once the missing duration lands", async () => {
    // Refusing is self-correcting: this is the next run.
    const p = ports([
      { callSid: "CA1", durationSeconds: 120, estimatedCents: 16 },
      { callSid: "CA2", durationSeconds: 90, estimatedCents: 12 },
      { callSid: "CA3", durationSeconds: 30, estimatedCents: 4 },
    ]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(33.68) });
    expect(out.reconciled).toBe(true);
    // And the whole invoice is allocated, to the cent, across all three.
    expect(p.written.reduce((s, c) => s + c.costCents, 0)).toBe(3368);
    expect(p.written).toHaveLength(3);
  });

  /**
   * ROUND 17, AND IT IS THE COUNTERWEIGHT TO ROUND 16 — my fix for that one
   * blocked on any zero, which is a worse bug than the one it fixed.
   *
   * Zero is a FINAL answer here, not a pending one. `toCallLogRow` rounds a
   * sub-500ms call to 0 seconds, and `reconcileTwilioCallData` explicitly
   * skips a terminal call whose Twilio duration is 0 — so nothing will ever
   * raise it. Blocking on it left every real call that day estimated
   * forever, and an immediate hangup is routine on a line taking 400 calls
   * a day.
   */
  it("does NOT block on a genuinely zero-second call — it just takes no share", async () => {
    const p = ports([
      { callSid: "CA1", durationSeconds: 120, estimatedCents: 16 },
      { callSid: "CA2", durationSeconds: 80, estimatedCents: 11 },
      { callSid: "CA3", durationSeconds: 0, estimatedCents: 0 }, // 400ms hangup, known
    ]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(33.68) });
    expect(out.reconciled).toBe(true);
    // The whole invoice still lands, and the zero-second call takes none of it.
    expect(p.written.reduce((s, c) => s + c.costCents, 0)).toBe(3368);
    expect(p.written.find((c) => c.callSid === "CA3")?.costCents).toBe(0);
  });

  it("still reconciles a genuinely free day", async () => {
    const p = ports([{ callSid: "CA1", durationSeconds: 0, estimatedCents: 0 }]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(0) });
    // Nothing billed and nothing to bill for is consistent, not an error.
    expect(out.reconciled).toBe(true);
    expect(p.written.reduce((s, c) => s + c.costCents, 0)).toBe(0);
  });

  it("is a no-op on a day the runtime served nothing", async () => {
    const p = ports([]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(5) });
    expect(out.reconciled).toBe(false);
    expect(p.written).toEqual([]);
  });
});

describe("a re-run of a day already reconciled", () => {
  /**
   * The six-hour schedule settles the previous UTC day more than once. On the
   * second pass `readDay` returns costs the FIRST pass already replaced with
   * xAI's own allocation — so counting them as "our estimate" compares the
   * bill against itself and reports a drift near zero, hiding the one thing
   * the drift exists to reveal: that the rate constant is wrong (Codex,
   * PR #268 round 3).
   */
  it("does not count an already-reconciled row as an estimate", async () => {
    const p = ports([
      { callSid: "CA1", durationSeconds: 100, estimatedCents: 13, alreadyReconciled: true },
      { callSid: "CA2", durationSeconds: 100, estimatedCents: 14 },
    ]);
    const out = await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(0.4) });
    expect(out.reconciled).toBe(true);
    // Only CA2's 14 cents was ever an estimate.
    expect(out.estimatedTotalCents).toBe(14);
    expect(out.estimateCoversCalls).toBe(1);
  });

  it("still allocates across EVERY call, reconciled or not", async () => {
    const p = ports([
      { callSid: "CA1", durationSeconds: 100, estimatedCents: 13, alreadyReconciled: true },
      { callSid: "CA2", durationSeconds: 100, estimatedCents: 14 },
    ]);
    await reconcileGrokCostsForDay(DAY, p, { setup: SETUP, fetchImpl: spending(0.4) });
    // The day's charge is still split over the whole day.
    expect(p.written.map((c) => c.callSid).sort()).toEqual(["CA1", "CA2"]);
    expect(p.written.reduce((s, c) => s + c.costCents, 0)).toBe(40);
  });

  it("says out loud when the drift it reports is only partial", () => {
    const line = reconcileMarker({
      day: DAY, reconciled: true, callsUpdated: 200,
      xaiTotalCents: 3368, estimatedTotalCents: 100, estimateCoversCalls: 7,
    });
    expect(line).toContain("partial");
    expect(line).toContain("7 call(s)");
  });

  it("says nothing about partiality on a first run", () => {
    const line = reconcileMarker({
      day: DAY, reconciled: true, callsUpdated: 200,
      xaiTotalCents: 3368, estimatedTotalCents: 3486, estimateCoversCalls: 200,
    });
    expect(line).not.toContain("partial");
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

/**
 * A source pin, and it says so. The day query is a SQL string, so nothing
 * here proves behaviour — what it proves is that the restriction has not been
 * quietly dropped. The reason it matters is behavioural: the first run after
 * UTC midnight can catch a previous-day call still in flight, whose NULL
 * duration COALESCEd to zero and got that live call stamped reconciled at $0
 * while the finished calls absorbed its share of the bill (Codex, PR #268
 * round 7). Later writers then preserve the zero, because the row claims to
 * be reconciled.
 */
describe("what the day query's row becomes", () => {
  /**
   * BEHAVIOURAL, because the source pin below cannot be. Every other test
   * here substitutes the ports, so the real readDay and this mapping were
   * exercised by nothing — a mutation deleting the NULL/zero distinction
   * from the SQL *and* the mapping passed the whole suite.
   */
  const row = (over: Partial<Parameters<typeof mapDayRow>[0]> = {}) =>
    mapDayRow({
      call_sid: "CA1",
      duration: 120,
      duration_unknown: false,
      estimated_cents: 16,
      already_reconciled: false,
      ...over,
    });

  it("marks a NULL duration as unknown, so the caller can block on it", () => {
    // Postgres COALESCEs the NULL to 0 in `duration`; the flag is the only
    // thing that still knows it was NULL.
    expect(row({ duration: 0, duration_unknown: true }).durationUnknown).toBe(true);
  });

  it("leaves a genuine zero UNflagged, so it does not block the day", () => {
    expect(row({ duration: 0, duration_unknown: false }).durationUnknown).toBeUndefined();
    expect(row({ duration: 0, duration_unknown: false }).durationSeconds).toBe(0);
  });

  it("carries the estimate and the reconciled flag through", () => {
    const r = row({ estimated_cents: 41, already_reconciled: true });
    expect(r.estimatedCents).toBe(41);
    expect(r.alreadyReconciled).toBe(true);
  });
});

describe("the day query takes finalised rows only", () => {
  it("asks Postgres for the NULL/zero distinction the COALESCE destroys", () => {
    // The mapping above can only report what the query selects.
    expect(readFileSync(new URL("./grokCostReconciler.ts", import.meta.url), "utf8"))
      .toMatch(/\(duration IS NULL\) AS duration_unknown/);
  });

  const src = readFileSync(new URL("./grokCostReconciler.ts", import.meta.url), "utf8");

  it("excludes only IN-FLIGHT rows, not every non-completed one", () => {
    expect(src).toMatch(/AND status <> 'in_progress'/);
  });

  /**
   * AND THIS PIN USED TO REQUIRE THE OPPOSITE.
   *
   * It asserted `AND duration IS NOT NULL` and `AND duration > 0` were in the
   * query, which is how the round-16 defect was held in place: a finalised
   * row with no duration was hidden from the read, xAI billed for it anyway,
   * and the allocator spread the whole invoice over the rest and stamped them
   * authoritative. Filtering was never the right answer — the day is simply
   * not attributable yet, and the caller refuses it. Behaviourally covered
   * above; the scan only stops the filter creeping back.
   */
  it("does NOT hide a finalised row that has no duration", () => {
    expect(src).not.toMatch(/AND duration IS NOT NULL/);
    expect(src).not.toMatch(/AND duration > 0/);
  });

  /**
   * The first version of this filter said `status = 'completed'`, which also
   * dropped the calls the runtime ends as `failed` — dead air and provider
   * failures. xAI bills those: the audio happened. Dropping them spread the
   * whole invoice across the survivors and left the failed row's estimate
   * standing, so the stored total came out ABOVE the invoice (Codex,
   * PR #268 round 8).
   */
  it("does NOT filter on 'completed', which would drop billable failed calls", () => {
    expect(src).not.toMatch(/AND status = 'completed'/);
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
