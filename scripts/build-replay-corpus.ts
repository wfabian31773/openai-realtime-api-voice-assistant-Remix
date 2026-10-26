/**
 * Export a runtime replay corpus from production `call_logs`.
 *
 *   Usage:
 *     tsx scripts/build-replay-corpus.ts --agents optical,surgery,tech,records \
 *       --from 2026-09-02 --to 2026-09-02 --out replay-corpus/2026-09-02 \
 *       [--worst-first] [--limit N] [--chunk-size N] [--min-caller-words N]
 *
 *   Then:
 *     XAI_API_KEY=... XAI_REGRESSION_MODEL=<chat model id> \
 *       tsx scripts/run-runtime-regression.ts --slug optical \
 *       --corpus replay-corpus/2026-09-02 --out replay-out/optical
 *
 * `run-runtime-regression.ts` has always read `chunk-*.jsonl` from a directory
 * that **nothing in this repo produced** — the builder lived only on an
 * unmerged branch and imported `src/core/replay/`, deleted 2026-09-01. So the
 * harness had no input. This is that missing half.
 *
 * The logic lives in `src/runtime/regression/corpusBuilder.ts` and is tested
 * there. This file is the shell: argv, SQL, files.
 *
 * **It refuses to write anywhere git does not ignore.** The check shells out to
 * `git check-ignore`, so it consults the real ignore rules rather than trusting
 * a directory name. Rows carry full call transcripts. PHI never in git.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { Pool } from "pg";
import {
  assertOutputDirIsIgnored,
  buildManifest,
  chunkFileName,
  chunkRows,
  selectCorpus,
  DEFAULT_MIN_CALLER_WORDS,
  type RawCallLogRow,
} from "../src/runtime/regression/corpusBuilder";

interface Args {
  agents: string[];
  from: string;
  to: string;
  out: string;
  worstFirst: boolean;
  limit?: number;
  chunkSize: number;
  minCallerWords: number;
}

const USAGE =
  "usage: tsx scripts/build-replay-corpus.ts --agents <slug,slug|all> " +
  "--from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <ignored dir> " +
  "[--worst-first] [--limit N] [--chunk-size N] [--min-caller-words N]";

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`${flag} must be a positive integer, got '${raw}'`);
      process.exit(2);
    }
    return n;
  };

  const agentsRaw = get("--agents");
  const from = get("--from");
  const to = get("--to");
  const out = get("--out");
  if (!agentsRaw || !from || !to || !out) {
    console.error(USAGE);
    process.exit(2);
  }
  for (const [label, value] of [["--from", from], ["--to", to]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      console.error(`${label} must be YYYY-MM-DD, got '${value}'`);
      process.exit(2);
    }
  }
  if (from > to) {
    console.error(`--from (${from}) is after --to (${to})`);
    process.exit(2);
  }
  const agents =
    agentsRaw === "all"
      ? []
      : agentsRaw.split(",").map((a) => a.trim()).filter(Boolean);
  if (agentsRaw !== "all" && agents.length === 0) {
    console.error("--agents needs at least one slug, or the word 'all'");
    process.exit(2);
  }
  // --min-caller-words 0 is meaningful ("keep every parseable call"), so it is
  // read directly rather than through num(), which floors at 1.
  const mcwRaw = get("--min-caller-words");
  const minCallerWords = mcwRaw === undefined ? DEFAULT_MIN_CALLER_WORDS : Number(mcwRaw);
  if (!Number.isInteger(minCallerWords) || minCallerWords < 0) {
    console.error(`--min-caller-words must be a non-negative integer, got '${mcwRaw}'`);
    process.exit(2);
  }

  return {
    agents,
    from,
    to,
    out,
    worstFirst: argv.includes("--worst-first"),
    limit: get("--limit") === undefined ? undefined : num("--limit", 0),
    chunkSize: num("--chunk-size", 200),
    minCallerWords,
  };
}

/** The real answer, from git itself — not a guess about what the path looks like. */
function gitIgnores(dir: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", dir], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Guard BEFORE touching the database: a run that would refuse to write should
  // fail in a second, not after pulling a day of transcripts into memory.
  assertOutputDirIsIgnored(args.out, gitIgnores);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required (the Operations Hub, which holds call_logs).");
    process.exit(2);
  }

  const pool = new Pool({ connectionString });
  let raw: RawCallLogRow[];
  try {
    // `id` on the wire is the call_sid: it is the key every other system uses
    // — tickets, voice_agent_api_logs — so a corpus row can be traced back to
    // its ticket. Falls back to the primary key when a row has no SID.
    const { rows } = await pool.query<RawCallLogRow>(
      `SELECT COALESCE(call_sid, id::text) AS id,
              transcript,
              ticket_number,
              transferred_to_human,
              total_turns,
              duration,
              grader_results
         FROM call_logs
        WHERE created_at >= $1::date
          AND created_at < ($2::date + interval '1 day')
          AND ($3::text[] IS NULL OR agent_used = ANY($3::text[]))
        ORDER BY created_at ASC`,
      [args.from, args.to, args.agents.length > 0 ? args.agents : null],
    );
    raw = rows;
  } finally {
    await pool.end();
  }

  const { rows, skipped } = selectCorpus(raw, {
    ordering: args.worstFirst ? "worst-first" : "chronological",
    minCallerWords: args.minCallerWords,
    limit: args.limit,
  });

  if (rows.length === 0) {
    console.error(
      `no replayable calls: ${raw.length} row(s) matched, all skipped ` +
        `(${JSON.stringify(skipped)}). Widen the dates, the agents, or --min-caller-words.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(args.out, { recursive: true });
  // Clear stale chunks: a smaller second run must not leave the first run's
  // tail behind for the reader to pick up as part of this corpus.
  for (const f of fs.readdirSync(args.out)) {
    if (/^chunk-.*\.jsonl$/.test(f)) fs.unlinkSync(path.join(args.out, f));
  }

  const chunks = chunkRows(rows, args.chunkSize);
  chunks.forEach((chunk, i) => {
    fs.writeFileSync(
      path.join(args.out, chunkFileName(i)),
      chunk.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
  });

  const manifest = buildManifest({
    agents: args.agents.length > 0 ? args.agents : ["all"],
    from: args.from,
    to: args.to,
    rows,
    chunkSize: args.chunkSize,
    ordering: args.worstFirst ? "worst-first" : "chronological",
    minCallerWords: args.minCallerWords,
    inputRows: raw.length,
    skipped,
    now: new Date(),
  });
  fs.writeFileSync(
    path.join(args.out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  console.log(
    `[CORPUS] ${manifest.calls} call(s) in ${manifest.chunks} chunk(s) -> ${args.out}\n` +
      `[CORPUS] from ${manifest.inputRows} row(s); skipped ` +
      `${skipped["no-transcript"]} no-transcript, ` +
      `${skipped["no-caller-turns"]} agent-only, ` +
      `${skipped["not-a-conversation"]} caller said <= ${manifest.minCallerWords} words\n` +
      `[CORPUS] ordering ${manifest.ordering}; manifest.json is committable, the chunks are not`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
