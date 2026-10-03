/**
 * THE PCP FLOOR — what it does, and the two things about the wiring that a
 * module test cannot see and so are read from the source.
 *
 * The defect this covers was never in the floor's logic: `sweepPcpUnfiledCall`
 * has been built and tested since v18/v30/v31. It was that nothing on this
 * runtime called it. So the tests worth having here are about the LANE GUARD,
 * the KEY it passes, the BOUND, and the fact that the default seam is the real
 * sweep — a seam defaulted to a no-op would pass every behavioural test in this
 * file and file nothing in production.
 *
 * The call itself is pinned at the runtime, in voiceRuntime.test.ts: a helper
 * proven in isolation proves the helper, not that anything invokes it
 * (CLAUDE.md failure mode 10).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PCP_FLOOR_BUDGET_MS, PCP_FLOOR_LANE, runPcpFloor } from "./pcpFloor";
import type { VoiceCallRecord } from "./mediaStreamBridge";

/** The fields the floor reads. Nothing here is PHI. */
function record(over: Partial<VoiceCallRecord> = {}): VoiceCallRecord {
  return {
    callSid: "CA0000000000000000000000000000ab01",
    slug: "pcp",
    outcome: "caller_hangup",
    transcript: "",
    toolEvents: [],
    ...over,
  } as unknown as VoiceCallRecord;
}

describe("the PCP floor runs for the PCP lane and no other", () => {
  it("calls the sweep with the call's own CallSid", async () => {
    const sweep = vi.fn(async () => undefined);
    await runPcpFloor(record(), { sweep });
    expect(sweep).toHaveBeenCalledTimes(1);
    // THE KEY IS THE WHOLE THING. The runtime builds the lane agent with
    // `callId: entry.callSid`, so the director state and metadata the sweep
    // reads live under exactly this string. Any other key reads an empty state
    // and files nothing, silently.
    expect(sweep).toHaveBeenCalledWith("CA0000000000000000000000000000ab01");
  });

  it.each(["optical", "surgery", "tech", "records", "no-ivr"])(
    "is a no-op on %s",
    async (slug) => {
      const sweep = vi.fn(async () => undefined);
      await runPcpFloor(record({ slug }), { sweep });
      expect(sweep).not.toHaveBeenCalled();
    },
  );

  it("names the lane it guards on, so the guard cannot drift from the table", () => {
    expect(PCP_FLOOR_LANE).toBe("pcp");
  });
});

describe("it can never cost the caller their record", () => {
  it("does not reject when the sweep throws", async () => {
    const sweep = vi.fn(async () => {
      throw new Error("ticketing app down");
    });
    await expect(runPcpFloor(record(), { sweep })).resolves.toBeUndefined();
  });

  it("does not reject when the sweep never settles, and gives up at the budget", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const wedged = runPcpFloor(record(), {
        // A wedged ticketing POST: never resolves, never rejects.
        sweep: () => new Promise<void>(() => {}),
        budgetMs: 1_000,
      }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await wedged;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the old core's own bound on this call", () => {
    // voiceAgentRoutes.ts has raced sweepPcpUnfiledCall against 25s since it
    // was written. Same function, same bound — this is not a new judgement.
    expect(PCP_FLOOR_BUDGET_MS).toBe(25_000);
  });
});

describe("the wiring facts a behavioural test cannot see", () => {
  const floor = readFileSync(new URL("./pcpFloor.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./voiceRuntime.ts", import.meta.url), "utf8");

  it("defaults to the lane's OWN teardownSweep, not a stub and not a second import", () => {
    // THE SEAM'S DEFAULT IS THE PROPERTY THAT MATTERS. If it drifted to a no-op
    // every behavioural test above would still pass and production would file
    // nothing — v69's failure. v90 found the default WAS doing that on Node 20:
    // it was `await import("../agents/pcpAgent")`, which evaluated a second
    // copy of the module with an empty metadata map, so every call logged
    // "has intake but no metadata" and filed nothing. The default now reads
    // the sweep off the lane's registration, which is the only route that is
    // the factory's own module by construction.
    //
    // Comments are stripped first: this file's docstring quotes the old import
    // and an assertion a comment can satisfy is not an assertion.
    const code = floor
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/import\(["']\.\.\/agents\//);
    expect(code).toMatch(/getAgentConfig\(PCP_FLOOR_LANE\)\?\.teardownSweep/);
  });

  it("registers the sweep from the SAME import statement as the factory", () => {
    // One import statement is one module evaluation, whatever the loader does
    // underneath — that is the whole fix. Two statements (or a dynamic import
    // anywhere) can be two evaluations on Node 20.
    const agents = readFileSync(new URL("../config/agents.ts", import.meta.url), "utf8");
    const statement = agents.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/agents\/pcpAgent';/);
    expect(statement).not.toBeNull();
    expect(statement![1]).toMatch(/\bcreatePcpAgent\b/);
    expect(statement![1]).toMatch(/\bsweepPcpUnfiledCall\b/);
    expect(agents.match(/from\s*'\.\.\/agents\/pcpAgent'/g)).toHaveLength(1);
    const entry = agents.slice(agents.indexOf("id: pcpAgentConfig.slug"));
    const block = entry.slice(0, entry.indexOf("});"));
    expect(block).toMatch(/factory:\s*createPcpAgent\b/);
    expect(block).toMatch(/teardownSweep:\s*sweepPcpUnfiledCall\b/);
  });

  it("reads the sweep off the source it is given, keyed on the call's own SID", async () => {
    const teardownSweep = vi.fn(async () => undefined);
    const getAgentConfig = vi.fn(() => ({ id: "pcp", enabled: true, factory: () => undefined, teardownSweep }));
    await runPcpFloor(record(), { source: async () => ({ getAgentConfig }) as never });
    expect(getAgentConfig).toHaveBeenCalledWith("pcp");
    expect(teardownSweep).toHaveBeenCalledWith("CA0000000000000000000000000000ab01");
  });

  it("says so loudly, and does not throw, when the lane registers no sweep or no source is given", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        runPcpFloor(record(), { source: async () => ({ getAgentConfig: () => ({ id: "pcp", enabled: true, factory: () => undefined }) }) as never }),
      ).resolves.toBeUndefined();
      expect(error.mock.calls.some((c) => String(c[0]).includes("registers no teardownSweep"))).toBe(true);
      error.mockClear();
      await expect(runPcpFloor(record())).resolves.toBeUndefined();
      expect(error.mock.calls.some((c) => String(c[0]).includes("registers no teardownSweep"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("is wired into the runtime's teardown, awaited, and after the row", () => {
    // The runtime hands the floor the SAME lane source it resolved the call's
    // agent from — that is what makes the sweep the factory's own module.
    expect(runtime).toMatch(/options\.sweepPcpFloor \?\? \(\(record: VoiceCallRecord\) => runPcpFloor\(record, \{ source: laneSource \}\)\)/);
    const persist = runtime.indexOf("const persisted = await withinOrNull(");
    const floorCall = runtime.indexOf("await sweepPcpFloor(record)");
    expect(persist).toBeGreaterThan(-1);
    expect(floorCall).toBeGreaterThan(persist);
  });

  it("does not add pcp to the generic sweep's lane table", () => {
    // The smaller diff and the wrong one: that path builds a queue-lane payload
    // against a department id, where this lane has its own endpoint, payload and
    // disposition rules. It is also what keeps the two from double-filing —
    // decideSweep declines pcp at its first line.
    const sweep = readFileSync(new URL("./requestSweep.ts", import.meta.url), "utf8");
    const table = sweep.slice(
      sweep.indexOf("const DEPARTMENT_BY_SLUG"),
      sweep.indexOf("};", sweep.indexOf("const DEPARTMENT_BY_SLUG")),
    );
    expect(table).not.toMatch(/\bpcp\b/);
  });
});
