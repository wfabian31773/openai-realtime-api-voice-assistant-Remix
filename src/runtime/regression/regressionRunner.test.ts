import { describe, it, expect } from "vitest";
import {
  callerTurnsOf,
  captureWrites,
  runRegressionCall,
  summarize,
  type RegressionCorpusRow,
  type RegressionModelClient,
} from "./regressionRunner";
import type { BoundAgent } from "../agentBinding";
import type { GraderResult } from "../../services/callGradingService";

function boundAgent(over: Partial<BoundAgent> = {}): BoundAgent {
  return {
    instructions: "You are the proving agent.",
    tools: [],
    guardrails: [],
    toolNames: ["lookup_patient", "create_ticket"],
    skipped: [],
    dispatch: async (name) => ({ ok: true, output: JSON.stringify({ success: true, tool: name }) }),
    ...over,
  };
}

/** A model that follows a script: each entry is one chat() reply. */
function scriptedModel(
  script: Array<{
    content?: string | null;
    toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  }>,
): RegressionModelClient & { seen: Array<{ messageCount: number }> } {
  let i = 0;
  const seen: Array<{ messageCount: number }> = [];
  return {
    seen,
    async chat({ messages }) {
      seen.push({ messageCount: messages.length });
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return { content: step.content ?? null, toolCalls: step.toolCalls ?? [] };
    },
  };
}

/** A grader stub returning fixed verdicts per side, keyed by callLogId prefix. */
function grader(newCriticalCount: number, oldCriticalCount: number) {
  const make = (n: number): GraderResult[] =>
    Array.from({ length: n }, (_, i) => ({
      grader: "question_repetition",
      pass: false,
      score: 0,
      reason: `critical ${i}`,
      severity: "critical" as const,
    }));
  return {
    runDeterministicGraders: (input: { callLogId: string }) =>
      String(input.callLogId).startsWith("runtime-regression-")
        ? make(newCriticalCount)
        : make(oldCriticalCount),
  };
}

const ROW: RegressionCorpusRow = {
  id: "cl-1",
  transcript: "AGENT: Thank you for calling.\nCALLER: I need a refill.\nAGENT: Sure.\nCALLER: My name is Pat.",
};

describe("caller turns", () => {
  it("extracts the caller's recorded lines, in order, and nothing the agent said", () => {
    expect(callerTurnsOf(ROW)).toEqual(["I need a refill.", "My name is Pat."]);
  });

  it("yields nothing for an empty transcript rather than inventing a call", () => {
    expect(callerTurnsOf({ id: "x", transcript: "  " })).toEqual([]);
  });
});

describe("write capture", () => {
  it("captures a write with its arguments and returns a simulated success", async () => {
    const real: string[] = [];
    const { agent, writes } = captureWrites(
      boundAgent({
        dispatch: async (name) => {
          real.push(name);
          return { ok: true, output: "{}" };
        },
      }),
    );
    const out = await agent.dispatch("create_ticket", { description: "refill" });
    expect(writes).toEqual([{ name: "create_ticket", args: { description: "refill" } }]);
    expect(JSON.parse(out.output)).toMatchObject({ success: true, simulated: true });
    // The real dispatch never ran for the write…
    expect(real).toEqual([]);
    // …but a read passes straight through.
    await agent.dispatch("lookup_patient", { phone: "x" });
    expect(real).toEqual(["lookup_patient"]);
  });

  it("captures every write family: file_*, create_ticket, submit_*, the handoff", async () => {
    const { agent, writes } = captureWrites(boundAgent());
    for (const name of [
      "file_optical_ticket",
      "file_surgery_ticket",
      "create_ticket",
      "submit_otp_code",
      "request_human_handoff",
    ]) {
      await agent.dispatch(name, {});
    }
    expect(writes.map((w) => w.name)).toEqual([
      "file_optical_ticket",
      "file_surgery_ticket",
      "create_ticket",
      "submit_otp_code",
      "request_human_handoff",
    ]);
  });
});

describe("the conversation loop", () => {
  it("feeds each recorded caller turn, lets the model use tools, and builds the new transcript", async () => {
    const model = scriptedModel([
      { content: "How can I help?" },
      {
        toolCalls: [{ id: "t1", name: "create_ticket", argumentsJson: '{"description":"refill"}' }],
      },
      { content: "Your request is filed." },
    ]);
    const result = await runRegressionCall({
      row: ROW,
      bound: boundAgent(),
      slug: "runtime-proof",
      model,
      grader: grader(0, 1),
    });

    expect(result.newTranscript).toContain("CALLER: I need a refill.");
    expect(result.newTranscript).toContain("AGENT: How can I help?");
    expect(result.newTranscript).toContain("AGENT: Your request is filed.");
    expect(result.writes.map((w) => w.name)).toEqual(["create_ticket"]);
    expect(result.modelTurns).toBe(3);
  });

  it("scores both sides with the same referee and derives the verdict", async () => {
    const better = await runRegressionCall({
      row: ROW,
      bound: boundAgent(),
      slug: "x",
      model: scriptedModel([{ content: "ok" }]),
      grader: grader(0, 2),
    });
    expect(better.verdict).toBe("better");
    expect(better.oldCritical).toHaveLength(2);
    expect(better.newCritical).toHaveLength(0);

    const worse = await runRegressionCall({
      row: ROW,
      bound: boundAgent(),
      slug: "x",
      model: scriptedModel([{ content: "ok" }]),
      grader: grader(3, 1),
    });
    expect(worse.verdict).toBe("worse");
  });

  it("caps model calls so a looping model cannot spend forever", async () => {
    // A model that ALWAYS calls a tool and never yields a plain reply.
    const looping = scriptedModel([
      { toolCalls: [{ id: "t", name: "lookup_patient", argumentsJson: "{}" }] },
    ]);
    const result = await runRegressionCall({
      row: ROW,
      bound: boundAgent(),
      slug: "x",
      model: looping,
      grader: grader(0, 0),
      maxModelCalls: 5,
    });
    expect(result.modelTurns).toBe(5);
  });

  it("dispatches malformed tool arguments as empty rather than crashing the run", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const model = scriptedModel([
      { toolCalls: [{ id: "t", name: "lookup_patient", argumentsJson: "{not json" }] },
      { content: "done" },
    ]);
    await runRegressionCall({
      row: ROW,
      bound: boundAgent({
        dispatch: async (_name, args) => {
          dispatched.push(args);
          return { ok: true, output: "{}" };
        },
      }),
      slug: "x",
      model,
      grader: grader(0, 0),
    });
    expect(dispatched[0]).toEqual({});
  });

  it("names its approximations on every result, so a number is never quoted without them", async () => {
    const result = await runRegressionCall({
      row: ROW,
      bound: boundAgent(),
      slug: "x",
      model: scriptedModel([{ content: "ok" }]),
      grader: grader(0, 0),
    });
    expect(result.approximations.join(" ")).toContain("recorded caller turns");
    expect(result.approximations.join(" ")).toContain("text model");
  });
});

describe("the summary", () => {
  it("counts verdicts and critical calls per side", async () => {
    const mk = (newC: number, oldC: number) =>
      runRegressionCall({
        row: ROW,
        bound: boundAgent(),
        slug: "x",
        model: scriptedModel([{ content: "ok" }]),
        grader: grader(newC, oldC),
      });
    const results = [await mk(0, 2), await mk(1, 1), await mk(2, 0)];
    expect(summarize("x", results)).toMatchObject({
      calls: 3,
      better: 1,
      same: 1,
      worse: 1,
      oldCriticalCalls: 2,
      newCriticalCalls: 2,
    });
  });
});
