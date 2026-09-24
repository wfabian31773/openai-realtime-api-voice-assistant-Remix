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

  it("defaults to the REAL sweep, not a stub", () => {
    // The seam exists for tests. If its default drifted to a no-op every test
    // above would still pass and production would file nothing — which is
    // precisely the failure being fixed, reintroduced through the seam.
    //
    // COMMENTS ARE STRIPPED FIRST, because this file's own docstring names
    // `sweepPcpUnfiledCall` several times and an assertion a comment can
    // satisfy is not an assertion — the device recognisedCallerBlock.test.ts
    // uses for the same reason.
    //
    // AND IT ASSERTS THE PROPERTY, NOT ONE SPELLING OF IT. The first version
    // banned the literal `m.sweepPcpUnfiledCall`, which went red the moment
    // the access form changed from `.then((m) => m.x)` to `(await …).x` for a
    // typecheck fix that changed no behaviour at all. Banning one spelling of
    // a right answer is the mirror of banning one spelling of a wrong one
    // (the v37 round-2 lesson).
    const code = floor
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toMatch(/import\(["']\.\.\/agents\/pcpAgent["']\)/);
    expect(code).toMatch(/\bsweepPcpUnfiledCall\b/);
  });

  it("is wired into the runtime's teardown, awaited, and after the row", () => {
    expect(runtime).toMatch(/const sweepPcpFloor = options\.sweepPcpFloor \?\? runPcpFloor;/);
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
