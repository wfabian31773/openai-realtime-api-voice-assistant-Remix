/**
 * The property that makes this an allocation and not another estimate: the
 * parts sum to xAI's total, exactly, on every input.
 */
import { describe, it, expect } from "vitest";
import { allocateDailyCost, rateDriftMarker } from "./grokCostAllocation";
import { GROK_COST_CENTS_PER_SECOND } from "./voiceCostRates";

const call = (callSid: string, durationSeconds: number) => ({ callSid, durationSeconds });

describe("splitting xAI's daily charge across the day's calls", () => {
  it("hands out exactly the total, never a cent more or less", () => {
    // Three calls that cannot divide 100 cleanly.
    const out = allocateDailyCost([call("a", 10), call("b", 10), call("c", 10)], 100);
    expect(out.calls.reduce((s, c) => s + c.costCents, 0)).toBe(100);
  });

  it("holds that property on the real shape of a day", () => {
    // The measured day: 241 calls, 25,259 seconds, and a total that is not
    // divisible by anything convenient.
    const calls = Array.from({ length: 241 }, (_, i) => call(`CA${i}`, 40 + ((i * 17) % 220)));
    for (const total of [3368, 3369, 1, 99991]) {
      const out = allocateDailyCost(calls, total);
      expect(out.calls.reduce((s, c) => s + c.costCents, 0), `total ${total}`).toBe(total);
    }
  });

  it("gives a longer call more than a shorter one", () => {
    const out = allocateDailyCost([call("short", 30), call("long", 300)], 1000);
    const by = Object.fromEntries(out.calls.map((c) => [c.callSid, c.costCents]));
    expect(by.long).toBeGreaterThan(by.short);
    expect(by.long + by.short).toBe(1000);
  });

  it("is deterministic — a re-run cannot move a cent between calls", () => {
    const calls = [call("a", 7), call("b", 7), call("c", 7), call("d", 7)];
    const first = allocateDailyCost(calls, 10);
    const again = allocateDailyCost(calls, 10);
    expect(again).toEqual(first);
    // And the order the calls arrive in must not change who gets the cent.
    const shuffled = allocateDailyCost([calls[3], calls[1], calls[0], calls[2]], 10);
    const asMap = (a: typeof first) => Object.fromEntries(a.calls.map((c) => [c.callSid, c.costCents]));
    expect(asMap(shuffled)).toEqual(asMap(first));
  });

  /**
   * A zero-duration call must still appear. Dropping it would be
   * indistinguishable from a call we failed to price, and this codebase has
   * already been bitten once by a measure that silently omitted rows
   * (tool_timeline dropping a third of successful filings).
   */
  it("keeps a zero-duration call in the output, at zero", () => {
    const out = allocateDailyCost([call("real", 100), call("hangup", 0)], 500);
    expect(out.calls.map((c) => c.callSid).sort()).toEqual(["hangup", "real"]);
    expect(out.calls.find((c) => c.callSid === "hangup")?.costCents).toBe(0);
    expect(out.calls.find((c) => c.callSid === "real")?.costCents).toBe(500);
  });

  it("does not divide by zero on a day with no billable seconds", () => {
    const out = allocateDailyCost([call("a", 0)], 250);
    expect(out.derivedCentsPerSecond).toBeNull();
    expect(out.calls[0].costCents).toBe(0);
  });

  it("copes with an empty day", () => {
    const out = allocateDailyCost([], 0);
    expect(out.calls).toEqual([]);
    expect(out.derivedCentsPerSecond).toBeNull();
  });

  /**
   * The number that answers whether our constant is right. 421 minutes billed
   * at exactly $0.08/min is $33.68 — feed that back in and the derived rate
   * must land on the constant.
   */
  it("recovers the published rate when xAI charge exactly the published rate", () => {
    const seconds = 25_259;
    const totalCents = Math.round(seconds * GROK_COST_CENTS_PER_SECOND);
    const out = allocateDailyCost([call("all", seconds)], totalCents);
    expect(out.derivedCentsPerSecond).toBeCloseTo(GROK_COST_CENTS_PER_SECOND, 4);
  });
});

describe("the rate-drift marker", () => {
  it("names both rates per minute, so the gap is readable without arithmetic", () => {
    const line = rateDriftMarker("2026-09-03", 8 / 60, GROK_COST_CENTS_PER_SECOND);
    expect(line).toContain("[GROK COST]");
    expect(line).toContain("2026-09-03");
    expect(line).toContain("8.0000 c/min");
    expect(line).toContain("+0.00%");
  });

  it("shows the direction and size of a real gap", () => {
    const line = rateDriftMarker("2026-09-03", 10 / 60, GROK_COST_CENTS_PER_SECOND);
    expect(line).toContain("10.0000 c/min");
    expect(line).toContain("+25.00%");
  });

  it("names the three things a gap can mean, rather than just flagging one", () => {
    const line = rateDriftMarker("2026-09-03", 9 / 60, GROK_COST_CENTS_PER_SECOND);
    expect(line).toContain("text-input");
    expect(line).toContain("duration");
  });

  it("says so plainly when there is nothing to reconcile", () => {
    expect(rateDriftMarker("2026-09-03", null, GROK_COST_CENTS_PER_SECOND)).toContain(
      "nothing to reconcile",
    );
  });
});
