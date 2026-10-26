/**
 * Build a runtime replay corpus out of real production calls.
 *
 * `regressionRunner.ts` reads `chunk-*.jsonl` from a directory, and until now
 * **nothing in this repo produced that directory.** The builder existed only on
 * an unmerged branch, and it imported `src/core/replay/`, a tree deleted on
 * 2026-09-01 — so the harness had no input and the branch could not be merged.
 * This module is that half, re-homed beside the runner it feeds.
 *
 * It is pure: SQL and the filesystem live in `scripts/build-replay-corpus.ts`,
 * so the row mapping, the conversation filter and the PHI guard are all
 * testable without a database.
 *
 * ## The corpus is narrower than the old Gate B one, on purpose
 *
 * `RegressionCorpusRow` needs id, transcript, ticket_number,
 * transferred_to_human, total_turns and duration. It does NOT need the caller's
 * name, the patient's name, or a date of birth, and the Operations Hub
 * `call_logs` table has no phone column at all — so those never enter the
 * corpus. The transcript still carries whatever the caller said about
 * themselves, which is why the guard below exists.
 *
 * ## The PHI guard is the point
 *
 * A row carries a full call transcript. `assertOutputDirIsIgnored` refuses to
 * write unless the destination is genuinely ignored by git, checked against the
 * real ignore rules rather than a naming convention. A corpus that cannot be
 * committed by accident is worth more than a comment asking people not to.
 */
import { callLogToFixture } from "../../shadow/callLogReplay";
import type { RegressionCorpusRow } from "./regressionRunner";

/** One `call_logs` row as the SQL hands it back, before mapping. */
export interface RawCallLogRow {
  id: string;
  transcript: string | null;
  ticket_number: string | null;
  transferred_to_human: boolean | null;
  total_turns: number | null;
  duration: number | null;
  grader_results: unknown;
}

/** Why a call was left out, so the manifest can account for every input row. */
export type SkipReason = "no-transcript" | "no-caller-turns" | "not-a-conversation";

/**
 * Wayne, 2026-09-03: *"use the calls 484 that we have or at least the ones that
 * actually were conversations."*
 *
 * A conversation is a call whose caller actually said something. The threshold
 * is the same predicate the 2026-09-02 forensic published for `AS-20` —
 * "caller never stated a request" is `caller_wc <= 6` — so the corpus and the
 * forensic agree on what counts, rather than each carrying its own idea.
 *
 * Counted from `callLogToFixture`'s parse rather than a local one: that parser
 * attaches continuation lines to the open turn. A parser that keeps only lines
 * beginning `CALLER:` silently drops every wrapped line, which is where the
 * substance of a long answer lives.
 */
export const DEFAULT_MIN_CALLER_WORDS = 6;

export function callerWordCount(transcript: string | null | undefined): number {
  const fixture = callLogToFixture({ id: "count", transcript: transcript ?? "" });
  if (!fixture) return 0;
  return fixture.fixture.turns
    .filter((t): t is { caller: string } => "caller" in t)
    .reduce((n, t) => n + t.caller.trim().split(/\s+/).filter(Boolean).length, 0);
}

/** Null when the call belongs in the corpus; otherwise why it does not. */
export function skipReasonFor(
  row: RawCallLogRow,
  minCallerWords: number = DEFAULT_MIN_CALLER_WORDS,
): SkipReason | null {
  if (typeof row.transcript !== "string" || row.transcript.trim().length === 0) {
    return "no-transcript";
  }
  // callLogToFixture returns null when nothing parses as a CALLER turn — an
  // agent-only transcript cannot be replayed, there is nothing to feed back.
  if (callLogToFixture({ id: row.id, transcript: row.transcript }) === null) {
    return "no-caller-turns";
  }
  if (callerWordCount(row.transcript) <= minCallerWords) return "not-a-conversation";
  return null;
}

export function toCorpusRow(row: RawCallLogRow): RegressionCorpusRow {
  return {
    id: row.id,
    transcript: row.transcript ?? "",
    ticket_number: row.ticket_number,
    transferred_to_human: row.transferred_to_human,
    total_turns: row.total_turns,
    duration: row.duration,
  };
}

/**
 * How many graders marked this call a critical failure — an ordering key for
 * "worst first", not a rate.
 *
 * `severity` is only populated on a FAILING grader, so counting rows where
 * `severity === 'critical'` and dividing gives 100% for every grader. That is a
 * denominator error, not a finding; see `.agents/memory/measurement-traps.md`.
 */
export function criticalFailureCount(graderResults: unknown): number {
  if (!graderResults || typeof graderResults !== "object") return 0;
  const summary = (graderResults as { summary?: { criticalFailures?: unknown } }).summary;
  const n = summary?.criticalFailures;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  const graders = (graderResults as { graders?: unknown }).graders;
  if (!Array.isArray(graders)) return 0;
  return graders.filter((g) => {
    if (!g || typeof g !== "object") return false;
    const rec = g as { severity?: unknown; pass?: unknown };
    return rec.severity === "critical" && rec.pass === false;
  }).length;
}

/** Split into `chunk-000.jsonl`-sized batches, preserving order. */
export function chunkRows<T>(rows: readonly T[], chunkSize: number): T[][] {
  if (chunkSize < 1) throw new Error(`chunkSize must be >= 1, got ${chunkSize}`);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) out.push(rows.slice(i, i + chunkSize));
  return out;
}

export function chunkFileName(index: number): string {
  return `chunk-${String(index).padStart(3, "0")}.jsonl`;
}

/**
 * Select and order the corpus in one place, so the manifest's counts and the
 * written rows can never disagree.
 */
export function selectCorpus(
  raw: readonly RawCallLogRow[],
  opts: { ordering: "worst-first" | "chronological"; minCallerWords?: number; limit?: number },
): { rows: RegressionCorpusRow[]; skipped: Record<SkipReason, number> } {
  const min = opts.minCallerWords ?? DEFAULT_MIN_CALLER_WORDS;
  const skipped: Record<SkipReason, number> = {
    "no-transcript": 0,
    "no-caller-turns": 0,
    "not-a-conversation": 0,
  };
  const kept: Array<{ raw: RawCallLogRow; row: RegressionCorpusRow }> = [];
  for (const r of raw) {
    const reason = skipReasonFor(r, min);
    if (reason) {
      skipped[reason] += 1;
      continue;
    }
    kept.push({ raw: r, row: toCorpusRow(r) });
  }
  if (opts.ordering === "worst-first") {
    // Stable: equal critical counts keep the SQL's chronological order, so two
    // runs of the same corpus replay in the same order.
    kept.sort((a, b) => criticalFailureCount(b.raw.grader_results) - criticalFailureCount(a.raw.grader_results));
  }
  const limited = typeof opts.limit === "number" ? kept.slice(0, opts.limit) : kept;
  return { rows: limited.map((k) => k.row), skipped };
}

/**
 * A manifest is what CAN be committed: counts and provenance, no call content.
 * Without it a corpus is an unlabelled directory and any number derived from it
 * is unreproducible — exactly the position Gate B has been in.
 */
export interface CorpusManifest {
  agents: string[];
  from: string;
  to: string;
  calls: number;
  chunks: number;
  chunkSize: number;
  ordering: "worst-first" | "chronological";
  minCallerWords: number;
  inputRows: number;
  skipped: Record<SkipReason, number>;
  builtAt: string;
}

export function buildManifest(input: {
  agents: string[];
  from: string;
  to: string;
  rows: readonly RegressionCorpusRow[];
  chunkSize: number;
  ordering: "worst-first" | "chronological";
  minCallerWords: number;
  inputRows: number;
  skipped: Record<SkipReason, number>;
  now: Date;
}): CorpusManifest {
  return {
    agents: [...input.agents].sort(),
    from: input.from,
    to: input.to,
    calls: input.rows.length,
    chunks: chunkRows(input.rows, input.chunkSize).length,
    chunkSize: input.chunkSize,
    ordering: input.ordering,
    minCallerWords: input.minCallerWords,
    inputRows: input.inputRows,
    skipped: input.skipped,
    builtAt: input.now.toISOString(),
  };
}

/**
 * Refuse to write patient transcripts anywhere git would track them.
 *
 * `isIgnored` is injected so the caller supplies the real answer — in the CLI
 * that is `git check-ignore`, which consults the actual ignore rules rather
 * than guessing from the path. A guard that pattern-matches on "does the folder
 * sound temporary" holds until the day someone picks a different name.
 */
export function assertOutputDirIsIgnored(
  outDir: string,
  isIgnored: (dir: string) => boolean,
): void {
  if (!isIgnored(outDir)) {
    throw new Error(
      `refusing to write a replay corpus to '${outDir}': it is not ignored by git.\n` +
        "Corpus rows carry full call transcripts — what the patient said was wrong, " +
        "and whatever they said about themselves. Point --out at an ignored path " +
        "(the repo ignores 'replay-corpus/', 'replay-out/' and '*.jsonl'), or write " +
        "outside the repo.",
    );
  }
}
