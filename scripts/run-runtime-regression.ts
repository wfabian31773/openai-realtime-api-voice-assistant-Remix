/**
 * Replay a scored corpus of real calls through the Grok runtime's bound
 * agent, with a live model, and score both sides with the production referee.
 *
 *   Usage:
 *     XAI_API_KEY=... XAI_REGRESSION_MODEL=<chat model id> \
 *       tsx scripts/run-runtime-regression.ts --slug answering-service \
 *       --corpus replay-corpus/as --out replay-out/runtime-as [--limit 20]
 *
 * The corpus comes from `scripts/build-replay-corpus.ts`. Results are files
 * only — nothing is written to the database, no tickets are filed, nobody is
 * dialled (write tools are captured, read tools run for real, so the normal
 * database env is required).
 *
 * ON DEMAND ONLY. Every call costs model spend; there is no schedule and no
 * shadowing of live traffic here.
 *
 * The model id is REQUIRED (env XAI_REGRESSION_MODEL or --model) rather than
 * defaulted: the realtime voice model does not serve chat completions, and a
 * guessed default would fail on the operator's clock instead of at launch.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { resolveLane, defaultLaneSource } from "../src/runtime/laneRegistry";
import {
  runRegressionCall,
  summarize,
  type RegressionCorpusRow,
  type RegressionModelClient,
  type RegressionCallResult,
} from "../src/runtime/regression/regressionRunner";
import type { GrokToolDefinition } from "../src/runtime/wireTypes";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function xaiChatClient(apiKey: string, model: string): RegressionModelClient {
  return {
    async chat({ system, tools, messages }) {
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) =>
            m.role === "tool"
              ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
              : m.role === "assistant"
                ? {
                    role: "assistant",
                    content: m.content,
                    tool_calls: m.toolCalls?.map((c) => ({
                      id: c.id,
                      type: "function",
                      function: { name: c.name, arguments: c.argumentsJson },
                    })),
                  }
                : m,
          ),
        ],
        tools: tools.map((t: GrokToolDefinition) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      };
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`xAI chat completions ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
      };
      const msg = data.choices[0]?.message;
      return {
        content: msg?.content ?? null,
        toolCalls: (msg?.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          argumentsJson: c.function.arguments,
        })),
      };
    },
  };
}

async function main(): Promise<void> {
  const slug = arg("--slug");
  const corpusDir = arg("--corpus");
  const outDir = arg("--out");
  const limit = Number(arg("--limit") ?? 25);
  const model = arg("--model") ?? process.env.XAI_REGRESSION_MODEL;
  const apiKey = process.env.XAI_API_KEY;
  if (!slug || !corpusDir || !outDir) {
    console.error(
      "usage: tsx scripts/run-runtime-regression.ts --slug <lane> --corpus <dir> --out <dir> [--limit N] [--model <id>]",
    );
    process.exit(2);
  }
  if (!apiKey || !model) {
    console.error("XAI_API_KEY and XAI_REGRESSION_MODEL (or --model) are required.");
    process.exit(2);
  }

  const rows: RegressionCorpusRow[] = fs
    .readdirSync(corpusDir)
    .filter((f) => /^chunk-.*\.jsonl$/.test(f))
    .sort()
    .flatMap((f) =>
      fs
        .readFileSync(path.join(corpusDir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RegressionCorpusRow),
    )
    .slice(0, limit);

  // The REAL binding — the same resolveLane a live call goes through, with
  // the same knowledge pack, prompt and tools. No transfer is injected, so
  // request_human_handoff refuses exactly as an unconfigured deployment's
  // would (and the capture layer records the attempt either way).
  const lane = await resolveLane(
    slug,
    { callSid: "regression", callId: "regression", callerPhone: "", dialedNumber: "" },
    { source: await defaultLaneSource(), env: process.env },
  );
  if (!lane) {
    console.error(`lane '${slug}' refused or unknown — see the runtime's logged reason`);
    process.exit(1);
  }

  // results.json carries full transcripts — the PHI-never-in-git rule. The
  // same guard build-replay-corpus.ts uses: the REAL ignore rules, checked
  // before anything is written.
  let ignored = false;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", outDir], { stdio: "ignore" });
    ignored = true;
  } catch {
    ignored = false;
  }
  if (!ignored) {
    console.error(
      `refusing to write regression results to '${outDir}': it is not ignored by git. ` +
        "Results carry full call transcripts. Use an ignored path (the repo ignores " +
        "'replay-out/'), or write outside the repo.",
    );
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const client = xaiChatClient(apiKey, model);
  const results: RegressionCallResult[] = [];
  for (const row of rows) {
    try {
      const r = await runRegressionCall({ row, bound: lane.agent, slug, model: client });
      results.push(r);
      console.log(`[regression] ${row.id}: ${r.verdict} (old ${r.oldCritical.length} vs new ${r.newCritical.length} critical)`);
    } catch (err) {
      console.error(`[regression] ${row.id} FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  fs.writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
    "utf8",
  );
  const summary = summarize(slug, results);
  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8",
  );
  console.log(`[regression] ${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
