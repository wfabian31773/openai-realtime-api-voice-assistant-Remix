/**
 * The cutover day is the test case. On 2026-09-03 tech served 274 calls on
 * the old core and 100 on the runtime, and a card that read "374 calls" said
 * nothing true about either.
 */
import { describe, it, expect } from "vitest";
import { describePipeline } from "./pipelineSplit";

describe("naming the pipeline behind a card's numbers", () => {
  it("says nothing about a lane that took no calls", () => {
    expect(describePipeline({ runtime: 0, legacy: 0 })).toEqual({ kind: "idle", label: "" });
  });

  it("names the runtime when every call was served by it", () => {
    const out = describePipeline({ runtime: 84, legacy: 0 });
    expect(out.kind).toBe("runtime");
    expect(out.label).toContain("Grok");
  });

  it("names the old core when no call was", () => {
    const out = describePipeline({ runtime: 0, legacy: 38 });
    expect(out.kind).toBe("legacy");
    expect(out.label).toContain("SIP");
  });

  /**
   * The whole point. tech on the cutover day: two populations, one number.
   */
  it("WARNS on a cutover day instead of averaging two populations", () => {
    const out = describePipeline({ runtime: 100, legacy: 274 });
    expect(out.kind).toBe("mixed");
    expect(out.label).toContain("100");
    expect(out.label).toContain("274");
    expect(out.label).toContain("Do not read these as one population");
  });

  it("does not call a single-pipeline lane mixed just because it is busy", () => {
    expect(describePipeline({ runtime: 500, legacy: 0 }).kind).toBe("runtime");
    expect(describePipeline({ runtime: 0, legacy: 500 }).kind).toBe("legacy");
  });
});
