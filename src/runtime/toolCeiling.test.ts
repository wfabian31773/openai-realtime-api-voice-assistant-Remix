import { describe, it, expect } from "vitest";
import {
  ToolCallCeiling,
  DEFAULT_CEILING_LIMITS,
  stableKey,
  ceilingMessage,
  ceilingRefusal,
  ceilingMarker,
} from "./toolCeiling";

/** The refusal `missing(['date_of_birth'], …)` actually produces. */
const DOB_REFUSAL = {
  success: false,
  missingFields: ["date_of_birth"],
  message: "I did not catch that date of birth — month, day and year?",
};

const ARGS = { first_name: "A", last_name: "B", callback_number: "5550000" };

/** One complete dispatch: reserve, then settle — how the bridge uses it. */
function attempt(
  ceiling: ToolCallCeiling,
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  output?: unknown,
): boolean {
  if (!ceiling.begin(name, args).allow) return false;
  ceiling.settle(name, args, ok, output);
  return true;
}

function runUntilRefused(
  ceiling: ToolCallCeiling,
  name: string,
  args: Record<string, unknown>,
  attempts: number,
): number {
  let dispatched = 0;
  for (let i = 0; i < attempts; i += 1) {
    if (!ceiling.begin(name, args).allow) break;
    ceiling.settle(name, args, false, DOB_REFUSAL);
    dispatched += 1;
  }
  return dispatched;
}

describe("stableKey", () => {
  it("is insensitive to key order", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
  });

  it("is insensitive to key order at depth", () => {
    expect(stableKey({ o: { a: 1, b: 2 }, z: 3 })).toBe(stableKey({ z: 3, o: { b: 2, a: 1 } }));
  });

  it("keeps array order, because order is meaning in an array", () => {
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]));
  });

  it("separates values that differ", () => {
    expect(stableKey({ dob: "03/17/1973" })).not.toBe(stableKey({ dob: "03/18/1973" }));
  });

  it("does not conflate a missing key with an undefined one at the top level", () => {
    // JSON.stringify drops undefined values; stableKey must not let
    // {a:1} and {a:1,b:undefined} collide into one counter.
    expect(stableKey({ a: 1, b: undefined })).not.toBe(stableKey({ a: 1 }));
  });

  it("handles null and primitives without throwing", () => {
    expect(stableKey(null)).toBe("null");
    expect(stableKey(5)).toBe("5");
    expect(stableKey("x")).toBe('"x"');
  });
});

describe("the production loop this exists to stop", () => {
  /**
   * CAc9f38039b80c47cf13cf5c15b79c1c37, optical, 2026-09-03 16:00:43 UTC:
   * file_optical_ticket refused 110 times for a missing date of birth in
   * 144 seconds. The caller hung up with no ticket.
   */
  it("stops file_optical_ticket at the identical-argument limit, not at 110", () => {
    const ceiling = new ToolCallCeiling();
    const dispatched = runUntilRefused(ceiling, "file_optical_ticket", ARGS, 110);
    expect(dispatched).toBe(DEFAULT_CEILING_LIMITS.identicalFailures);
    const verdict = ceiling.begin("file_optical_ticket", ARGS);
    expect(verdict).toEqual({
      allow: false,
      reason: "identical-args",
      failures: DEFAULT_CEILING_LIMITS.identicalFailures,
    });
  });

  it("stays refused however many more times the model asks", () => {
    const ceiling = new ToolCallCeiling();
    runUntilRefused(ceiling, "file_optical_ticket", ARGS, 110);
    for (let i = 0; i < 100; i += 1) {
      expect(ceiling.begin("file_optical_ticket", ARGS).allow).toBe(false);
    }
    // A refused call is never dispatched, so it never adds to the count.
    expect(ceiling.dispatchCount).toBe(DEFAULT_CEILING_LIMITS.identicalFailures);
  });

  it("hands back the tool's own wording, not wording of its own", () => {
    const ceiling = new ToolCallCeiling();
    runUntilRefused(ceiling, "file_optical_ticket", ARGS, 10);
    const refusal = ceilingRefusal(
      "file_optical_ticket",
      "identical-args",
      ceiling.lastFailureOutput("file_optical_ticket"),
    );
    expect(refusal.message).toBe(DOB_REFUSAL.message);
    expect(refusal.retryable).toBe(false);
    expect(refusal.success).toBe(false);
  });
});

describe("only failures count, and a success resets", () => {
  it("never refuses a tool that keeps succeeding", () => {
    const ceiling = new ToolCallCeiling();
    for (let i = 0; i < 30; i += 1) {
      expect(ceiling.begin("lookup_patient", ARGS).allow).toBe(true);
      ceiling.settle("lookup_patient", ARGS, true, { success: true });
    }
  });

  it("lets lookup_patient retry after a timeout — it times out on 13-17% of queue calls", () => {
    const ceiling = new ToolCallCeiling();
    // Fail, fail, then succeed: the pattern of a real transient.
    expect(attempt(ceiling, "lookup_patient", ARGS, false, { success: false, error: "timed out" })).toBe(true);
    expect(attempt(ceiling, "lookup_patient", ARGS, false, { success: false, error: "timed out" })).toBe(true);
    expect(attempt(ceiling, "lookup_patient", ARGS, true, { success: true })).toBe(true);
    // The success cleared the counters, so the next failure run starts from zero.
    const dispatched = runUntilRefused(ceiling, "lookup_patient", ARGS, 10);
    expect(dispatched).toBe(DEFAULT_CEILING_LIMITS.identicalFailures);
  });

  it("a success clears the per-argument counters too, not just the tool counter", () => {
    const ceiling = new ToolCallCeiling();
    runUntilRefused(ceiling, "resolve_location", ARGS, 10);
    expect(ceiling.begin("resolve_location", ARGS).allow).toBe(false);
    attempt(ceiling, "resolve_location", { office: "Downey" }, true, { success: true });
    expect(ceiling.begin("resolve_location", ARGS).allow).toBe(true);
  });
});

describe("different arguments are a different attempt", () => {
  it("a corrected office name is not the same call", () => {
    const ceiling = new ToolCallCeiling();
    runUntilRefused(ceiling, "resolve_location", { office: "Downtown LA" }, 10);
    expect(ceiling.begin("resolve_location", { office: "Downtown LA" }).allow).toBe(false);
    expect(ceiling.begin("resolve_location", { office: "Downey" }).allow).toBe(true);
  });

  it("but varying one field every time still hits the same-tool limit", () => {
    const ceiling = new ToolCallCeiling();
    let dispatched = 0;
    for (let i = 0; i < 50; i += 1) {
      const args = { office: `guess-${i}` };
      if (!ceiling.begin("resolve_location", args).allow) break;
      ceiling.settle("resolve_location", args, false, DOB_REFUSAL);
      dispatched += 1;
    }
    expect(dispatched).toBe(DEFAULT_CEILING_LIMITS.perToolFailures);
    expect(ceiling.begin("resolve_location", { office: "new" })).toEqual({
      allow: false,
      reason: "same-tool",
      failures: DEFAULT_CEILING_LIMITS.perToolFailures,
    });
  });
});

describe("the whole-call backstop", () => {
  it("stops a loop that alternates tools and succeeds every time", () => {
    const ceiling = new ToolCallCeiling();
    let dispatched = 0;
    for (let i = 0; i < 500; i += 1) {
      const name = i % 2 === 0 ? "lookup_patient" : "check_open_tickets";
      if (!ceiling.begin(name, { i }).allow) break;
      ceiling.settle(name, { i }, true, { success: true });
      dispatched += 1;
    }
    expect(dispatched).toBe(DEFAULT_CEILING_LIMITS.perCallDispatches);
    const verdict = ceiling.begin("lookup_patient", {});
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toBe("call-total");
  });

  it("sits comfortably above the old core's observed maximum of 24", () => {
    expect(DEFAULT_CEILING_LIMITS.perCallDispatches).toBeGreaterThan(24);
  });
});

describe("counters are per call", () => {
  it("one caller's loop does not refuse the next caller", () => {
    const first = new ToolCallCeiling();
    runUntilRefused(first, "file_optical_ticket", ARGS, 10);
    expect(first.begin("file_optical_ticket", ARGS).allow).toBe(false);
    const second = new ToolCallCeiling();
    expect(second.begin("file_optical_ticket", ARGS).allow).toBe(true);
  });
});

describe("ceilingMessage", () => {
  it("prefers the tool's message", () => {
    expect(ceilingMessage("t", { message: "ask again", error: "boom" })).toBe("ask again");
  });

  it("falls back through say, then error", () => {
    expect(ceilingMessage("t", { say: "spoken" })).toBe("spoken");
    expect(ceilingMessage("t", { error: "boom" })).toBe("boom");
  });

  it("ignores blank strings rather than speaking nothing", () => {
    expect(ceilingMessage("file_optical_ticket", { message: "   " })).toContain("Do not call it again");
  });

  it("instructs the model when the tool said nothing usable", () => {
    for (const output of [undefined, null, {}, "a string", 7]) {
      const m = ceilingMessage("file_optical_ticket", output);
      expect(m).toContain("file_optical_ticket");
      expect(m).toContain("Do not call it again");
    }
  });
});

describe("no arguments are ever logged", () => {
  it("the marker names the tool and the count and nothing else", () => {
    const ceiling = new ToolCallCeiling();
    const secret = { first_name: "Wayne", date_of_birth: "03/17/1973", callback_number: "5551234567" };
    runUntilRefused(ceiling, "file_optical_ticket", secret, 10);
    const verdict = ceiling.begin("file_optical_ticket", secret);
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    const line = ceilingMarker("file_optical_ticket", verdict);
    expect(line).toContain("[TOOL CEILING]");
    expect(line).toContain("file_optical_ticket");
    for (const value of Object.values(secret)) expect(line).not.toContain(value);
  });

  it("names each reason distinctly", () => {
    expect(ceilingMarker("t", { allow: false, reason: "identical-args", failures: 3 })).toContain(
      "same arguments",
    );
    expect(ceilingMarker("t", { allow: false, reason: "same-tool", failures: 6 })).toContain(
      "6 consecutive failures",
    );
    expect(ceilingMarker("t", { allow: false, reason: "call-total", failures: 40 })).toContain(
      "40 tool dispatches",
    );
  });
});

describe("in-flight dispatches count", () => {
  /**
   * One model response can carry several tool calls; they all reach the
   * transport before any of them has an answer. A ceiling that only counted
   * SETTLED failures would wave the whole batch through — which is exactly
   * what the bridge test "still asks the agent to speak" caught.
   */
  it("stops the fourth of four identical calls issued before any of them answers", () => {
    const ceiling = new ToolCallCeiling();
    expect(ceiling.begin("file_optical_ticket", ARGS).allow).toBe(true);
    expect(ceiling.begin("file_optical_ticket", ARGS).allow).toBe(true);
    expect(ceiling.begin("file_optical_ticket", ARGS).allow).toBe(true);
    expect(ceiling.begin("file_optical_ticket", ARGS)).toEqual({
      allow: false,
      reason: "identical-args",
      failures: 3,
    });
  });

  it("releases the reservation when a call settles, whatever it settled as", () => {
    const ceiling = new ToolCallCeiling();
    ceiling.begin("t", ARGS);
    ceiling.begin("t", ARGS);
    ceiling.begin("t", ARGS);
    expect(ceiling.begin("t", ARGS).allow).toBe(false);
    ceiling.settle("t", ARGS, true, { success: true });
    expect(ceiling.begin("t", ARGS).allow).toBe(true);
  });

  it("a reservation that is never settled still cannot exceed the limit", () => {
    const ceiling = new ToolCallCeiling();
    let allowed = 0;
    for (let i = 0; i < 100; i += 1) if (ceiling.begin("t", ARGS).allow) allowed += 1;
    expect(allowed).toBe(DEFAULT_CEILING_LIMITS.identicalFailures);
  });

  it("counts a reserved dispatch against the whole-call backstop immediately", () => {
    const ceiling = new ToolCallCeiling({ perCallDispatches: 3 });
    // Distinct arguments each time, so only the backstop can stop this.
    expect(ceiling.begin("t", { i: 1 }).allow).toBe(true);
    expect(ceiling.begin("t", { i: 2 }).allow).toBe(true);
    expect(ceiling.begin("t", { i: 3 }).allow).toBe(true);
    expect(ceiling.begin("t", { i: 4 })).toEqual({
      allow: false,
      reason: "call-total",
      failures: 3,
    });
  });

  it("counts in-flight calls with DIFFERENT arguments against the same-tool limit", () => {
    // The model varying one field per call, all issued on one response
    // before any of them answers. Each argument shape is under the
    // identical limit, so only the same-tool limit can stop this — and it
    // has to see the reservations to do it.
    const ceiling = new ToolCallCeiling();
    let allowed = 0;
    for (let i = 0; i < 20; i += 1) if (ceiling.begin("resolve_location", { office: `g${i}` }).allow) allowed += 1;
    expect(allowed).toBe(DEFAULT_CEILING_LIMITS.perToolFailures);
    expect(ceiling.begin("resolve_location", { office: "another" })).toEqual({
      allow: false,
      reason: "same-tool",
      failures: DEFAULT_CEILING_LIMITS.perToolFailures,
    });
  });

  it("a settle without a matching begin cannot drive the counter negative", () => {
    // Without the clamp, stray settles bank negative in-flight credit and
    // the next burst of dispatches rides straight through the limit.
    const ceiling = new ToolCallCeiling();
    for (let i = 0; i < 5; i += 1) ceiling.settle("t", ARGS, true, { success: true });
    let allowed = 0;
    for (let i = 0; i < 20; i += 1) if (ceiling.begin("t", { i }).allow) allowed += 1;
    expect(allowed).toBe(DEFAULT_CEILING_LIMITS.perToolFailures);
  });
});
