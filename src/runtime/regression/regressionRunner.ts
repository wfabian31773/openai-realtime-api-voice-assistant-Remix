/**
 * The runtime regression harness: real calls from `call_logs`, replayed
 * through the SAME bound agent the runtime serves, with the model in the
 * loop, graded by the SAME referee that graded the original call.
 *
 * Wayne, 2026-08-30: "we have already in the database benchmarks, testing,
 * all kinds of stuff that we can use as baselines — run those same tests
 * that scored those, score on these, and see what would have been going on
 * on the new runtime." This is that: the corpus builder exports the scored
 * calls (chunk-*.jsonl, `scripts/build-replay-corpus.ts`), this drives each
 * one through `resolveLane`'s real binding — the agent's own prompt, the
 * agent's own tools — and both sides are scored by
 * `runDeterministicGraders`, the old side RE-graded with the current referee
 * exactly as Gate B does, so grader improvements apply to both identically.
 *
 * ## What is honest about it, and what is not
 *
 * Unlike Gate B (deterministic line modules, replayable for free), the
 * runtime is model-driven: a replay needs a live model, costs money per
 * call, and is not identical run to run. It is run ON DEMAND by the
 * operator, never on a schedule and never beside live traffic.
 *
 * The caller's turns are the recorded ones, in order, answering questions
 * the NEW agent may not have asked — the same approximation Gate B records
 * for every run. And the model answering here is a TEXT model with the same
 * instructions and tools, not the realtime voice model: tool selection and
 * conversation shape are comparable, prosody and latency are not measured
 * at all.
 *
 * ## Writes are captured, never executed
 *
 * A corpus run must not file forty real tickets or dial a staff member per
 * row. Tools that WRITE (`file_*`, `create_ticket`, `submit_*`,
 * `request_human_handoff`) are intercepted at the dispatch seam: the intent
 * is recorded — name and arguments, which is what the graders score — and a
 * simulated success returned. Read tools run for real, which is why the
 * harness needs the database env a normal run has.
 */
import { callLogToFixture } from "../../shadow/callLogReplay";
import type { CallGradingService, GraderResult } from "../../services/callGradingService";
import { COMPARABLE, criticalsOf } from "../../core/replay/comparable";
import type { BoundAgent } from "../agentBinding";
import type { GrokToolDefinition } from "../wireTypes";

/** The corpus row fields this harness reads — the shape build-replay-corpus emits. */
export interface RegressionCorpusRow {
  id: string;
  transcript: string;
  from?: string | null;
  transferred_to_human?: boolean | null;
  ticket_number?: string | null;
  total_turns?: number | null;
  duration?: number | null;
}

/** One model exchange. The CLI backs this with xAI chat completions; tests
 * back it with a script. */
export interface RegressionModelClient {
  chat(input: {
    system: string;
    tools: GrokToolDefinition[];
    messages: RegressionMessage[];
  }): Promise<{
    content: string | null;
    toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
  }>;
}

export type RegressionMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> }
  | { role: "tool"; toolCallId: string; content: string };

const WRITE_TOOL = /^file_|^create_ticket$|^submit_|^request_human_handoff$/;

export interface CapturedWrite {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Wrap a bound agent so writes are captured instead of executed. The seam is
 * `dispatch` — the same one the live bridge calls — so everything else about
 * the agent (schema, names, read tools) is exactly what a live call gets.
 */
export function captureWrites(bound: BoundAgent): {
  agent: BoundAgent;
  writes: CapturedWrite[];
} {
  const writes: CapturedWrite[] = [];
  const agent: BoundAgent = {
    ...bound,
    async dispatch(name, args) {
      if (WRITE_TOOL.test(name)) {
        writes.push({ name, args });
        return {
          ok: true,
          output: JSON.stringify({
            success: true,
            simulated: true,
            ticketNumber: `VA-REGRESSION-${writes.length}`,
          }),
        };
      }
      return bound.dispatch(name, args);
    },
  };
  return { agent, writes };
}

/** The caller's recorded lines, in order. */
export function callerTurnsOf(row: RegressionCorpusRow): string[] {
  const fixture = callLogToFixture({ id: row.id, transcript: row.transcript });
  if (!fixture) return [];
  return fixture.fixture.turns
    .filter((t): t is { caller: string } => "caller" in t)
    .map((t) => t.caller);
}

export interface RegressionCallResult {
  callLogId: string;
  newTranscript: string;
  writes: CapturedWrite[];
  newGraders: GraderResult[];
  oldGraders: GraderResult[];
  newCritical: string[];
  oldCritical: string[];
  verdict: "better" | "same" | "worse";
  modelTurns: number;
  approximations: string[];
}

export async function runRegressionCall(input: {
  row: RegressionCorpusRow;
  bound: BoundAgent;
  slug: string;
  model: RegressionModelClient;
  grader?: Pick<CallGradingService, "runDeterministicGraders">;
  /** Hard cap on model exchanges, so a looping model cannot spend forever. */
  maxModelCalls?: number;
}): Promise<RegressionCallResult> {
  const { row, bound, slug, model } = input;
  // Lazy: the grading service opens the database at module load, and this
  // module must be importable (and its tests runnable) without one.
  const grader =
    input.grader ??
    new (await import("../../services/callGradingService")).CallGradingService();
  const maxModelCalls = input.maxModelCalls ?? 40;

  const { agent, writes } = captureWrites(bound);
  const callerTurns = callerTurnsOf(row);
  const messages: RegressionMessage[] = [];
  const newLines: string[] = [];
  let modelCalls = 0;

  for (const turn of callerTurns) {
    if (modelCalls >= maxModelCalls) break;
    messages.push({ role: "user", content: turn });
    newLines.push(`CALLER: ${turn}`);

    // Let the model speak and use tools until it yields a plain reply —
    // the text-loop equivalent of one response cycle per caller turn.
    let guard = 0;
    while (modelCalls < maxModelCalls && guard < 8) {
      guard += 1;
      modelCalls += 1;
      const reply = await model.chat({
        system: agent.instructions,
        tools: agent.tools,
        messages,
      });
      messages.push({
        role: "assistant",
        content: reply.content,
        toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined,
      });
      if (reply.content) newLines.push(`AGENT: ${reply.content}`);
      if (reply.toolCalls.length === 0) break;
      for (const call of reply.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.argumentsJson) as Record<string, unknown>;
        } catch {
          /* malformed arguments dispatch as empty, same as the live bridge */
        }
        const result = await agent.dispatch(call.name, args);
        messages.push({ role: "tool", toolCallId: call.id, content: result.output });
      }
    }
  }

  const newTranscript = newLines.join("\n");
  const newGraders = grader
    .runDeterministicGraders({
      callLogId: `runtime-regression-${row.id}`,
      transcript: newTranscript,
      transferredToHuman: writes.some((w) => w.name === "request_human_handoff"),
      ticketNumber: writes.some((w) => w.name !== "request_human_handoff") ? "SIM-1" : null,
      agentSlug: slug,
      totalTurns: newLines.length,
      interruptionCount: 0,
      truncationCount: 0,
      toolCallCount: writes.length,
      durationSeconds: null,
      firstTranscriptDelayMs: null,
      postTranscriptTailMs: null,
      localDurationSeconds: null,
      transcriptWindowSeconds: null,
      durationMismatchRatio: null,
      durationMismatchFlag: null,
    })
    .filter((g) => COMPARABLE.has(g.grader));

  // The old side is RE-graded with the same current referee, exactly as
  // Gate B does, so grader improvements apply to both sides identically.
  const oldGraders = grader
    .runDeterministicGraders({
      callLogId: row.id,
      transcript: row.transcript,
      transferredToHuman: Boolean(row.transferred_to_human),
      ticketNumber: row.ticket_number ?? null,
      agentSlug: slug,
      totalTurns: row.total_turns ?? null,
      interruptionCount: null,
      truncationCount: null,
      toolCallCount: null,
      durationSeconds: row.duration ?? null,
      firstTranscriptDelayMs: null,
      postTranscriptTailMs: null,
      localDurationSeconds: null,
      transcriptWindowSeconds: null,
      durationMismatchRatio: null,
      durationMismatchFlag: null,
    })
    .filter((g) => COMPARABLE.has(g.grader));

  const newCritical = criticalsOf(newGraders);
  const oldCritical = criticalsOf(oldGraders);
  return {
    callLogId: row.id,
    newTranscript,
    writes,
    newGraders,
    oldGraders,
    newCritical,
    oldCritical,
    verdict:
      newCritical.length < oldCritical.length
        ? "better"
        : newCritical.length === oldCritical.length
          ? "same"
          : "worse",
    modelTurns: modelCalls,
    approximations: [
      "recorded caller turns answered the old core's questions; they are replayed in order against the new agent's questions",
      "text model with the runtime's instructions and tools — tool selection and conversation shape are comparable, voice latency and prosody are not measured",
      "write tools captured, not executed; read tools ran for real",
    ],
  };
}

export interface RegressionSummary {
  slug: string;
  calls: number;
  better: number;
  same: number;
  worse: number;
  oldCriticalCalls: number;
  newCriticalCalls: number;
  totalModelTurns: number;
}

export function summarize(slug: string, results: RegressionCallResult[]): RegressionSummary {
  return {
    slug,
    calls: results.length,
    better: results.filter((r) => r.verdict === "better").length,
    same: results.filter((r) => r.verdict === "same").length,
    worse: results.filter((r) => r.verdict === "worse").length,
    oldCriticalCalls: results.filter((r) => r.oldCritical.length > 0).length,
    newCriticalCalls: results.filter((r) => r.newCritical.length > 0).length,
    totalModelTurns: results.reduce((n, r) => n + r.modelTurns, 0),
  };
}
