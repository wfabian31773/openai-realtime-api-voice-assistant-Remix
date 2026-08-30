/**
 * Build a Gate B replay corpus out of real production calls.
 *
 * Gate B has produced every comparison number we quote — answering service
 * 57.5% -> 19.1% critical, PCP 61.1% -> 28.6% — and `gateBRunner.ts` reads its
 * input from a directory of `chunk-*.jsonl` files. **Nothing in this repo has
 * ever produced that directory.** The 3,364-call corpus was exported by hand,
 * out of band, and deliberately never committed. So Gate B has been
 * unreproducible: the numbers exist, the corpus behind them does not.
 *
 * This module is the missing half. It is pure — the SQL and the filesystem live
 * in `scripts/build-replay-corpus.ts` — so the row mapping and, more
 * importantly, the PHI guard are testable without a database.
 *
 * ## The PHI guard is the point
 *
 * A corpus row carries a full call transcript: names, dates of birth, phone
 * numbers, what the patient said was wrong with their eye. `replayCall.ts:89`
 * states the rule as "PHI never in git", and it has held so far only because
 * nobody has run an export into the working tree. `.gitignore` did not stop it
 * — there was no rule covering `*.jsonl` at all until this change.
 *
 * So `assertOutputDirIsIgnored` refuses to write unless the destination is
 * genuinely ignored by git, checked against the real ignore rules rather than
 * a naming convention. A corpus that cannot be committed by accident is worth
 * more than a comment asking people not to.
 */

/** One `call_logs` row as the SQL hands it back, before mapping. */
export interface RawCallLogRow {
  id: string;
  from_number: string | null;
  caller_name: string | null;
  patient_name: string | null;
  patient_dob: string | null;
  patient_found: boolean | null;
  ticket_number: string | null;
  transferred_to_human: boolean | null;
  total_turns: number | null;
  duration: number | null;
  transcript: string | null;
  grader_results: unknown;
  tool_timeline: unknown;
}

/** The shape `replayStoredCall` consumes — mirrors `CorpusRow` in replayCall.ts. */
export interface CorpusRowOut {
  id: string;
  from: string | null;
  caller_name: string | null;
  patient_name: string | null;
  patient_dob: string | null;
  patient_found: boolean | null;
  ticket_number: string | null;
  transferred_to_human: boolean | null;
  total_turns: number | null;
  duration: number | null;
  grader_results?: { graders?: unknown[] } | null;
  transcript: string;
  tool_events?: Array<{ tool?: string; args?: unknown; outcome?: unknown }> | null;
}

/**
 * `tool_timeline` is an OBJECT — `{agentSlug, events, purpose, result,
 * toolCallCount}` — not an array.
 *
 * Worth stating because it has already cost a wrong answer: a query written as
 * `jsonb_array_elements(tool_timeline)` returns zero rows against every call in
 * the table, which reads as "no tools were ever called" rather than "the shape
 * is different". The events live one level down.
 */
export function extractToolEvents(
  toolTimeline: unknown,
): Array<{ tool?: string; args?: unknown; outcome?: unknown }> | null {
  if (!toolTimeline || typeof toolTimeline !== 'object') return null;
  const events = (toolTimeline as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  const mapped = events
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
    .map((e) => ({
      tool: typeof e.tool === 'string' ? e.tool : undefined,
      args: e.args,
      outcome: e.outcome,
    }))
    .filter((e) => e.tool !== undefined);
  return mapped.length > 0 ? mapped : null;
}

/** Grader results as stored: `{gradedAt, graders[], summary}`. */
export function extractGraders(graderResults: unknown): { graders?: unknown[] } | null {
  if (!graderResults || typeof graderResults !== 'object') return null;
  const graders = (graderResults as { graders?: unknown }).graders;
  return Array.isArray(graders) ? { graders } : null;
}

/**
 * How many graders marked this call a critical failure.
 *
 * `severity` is only populated on a FAILING grader, so counting rows where
 * `severity === 'critical'` and treating that as a rate gives 100% for every
 * grader — a denominator error, not a finding. Here the count is what we want:
 * an ordering key for "worst first", not a rate.
 */
export function criticalFailureCount(graderResults: unknown): number {
  const summary =
    graderResults && typeof graderResults === 'object'
      ? (graderResults as { summary?: { criticalFailures?: unknown } }).summary
      : undefined;
  const n = summary?.criticalFailures;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** A call with no transcript cannot be replayed — there are no caller turns to feed. */
export function isReplayable(row: RawCallLogRow): boolean {
  return typeof row.transcript === 'string' && row.transcript.trim().length > 0;
}

export function toCorpusRow(row: RawCallLogRow): CorpusRowOut {
  return {
    id: row.id,
    from: row.from_number,
    caller_name: row.caller_name,
    patient_name: row.patient_name,
    patient_dob: row.patient_dob,
    patient_found: row.patient_found,
    ticket_number: row.ticket_number,
    transferred_to_human: row.transferred_to_human,
    total_turns: row.total_turns,
    duration: row.duration,
    grader_results: extractGraders(row.grader_results),
    transcript: row.transcript ?? '',
    tool_events: extractToolEvents(row.tool_timeline),
  };
}

/** Split into `chunk-000.jsonl`-sized batches, preserving order. */
export function chunkRows<T>(rows: readonly T[], chunkSize: number): T[][] {
  if (chunkSize < 1) throw new Error(`chunkSize must be >= 1, got ${chunkSize}`);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    out.push(rows.slice(i, i + chunkSize));
  }
  return out;
}

export function chunkFileName(index: number): string {
  return `chunk-${String(index).padStart(3, '0')}.jsonl`;
}

/**
 * A manifest is what CAN be committed: counts and provenance, no call content.
 *
 * Without it a corpus is an unlabelled directory and a number derived from it
 * is unreproducible — which is exactly the position Gate B is in today.
 */
export interface CorpusManifest {
  agent: string;
  from: string;
  to: string;
  calls: number;
  chunks: number;
  chunkSize: number;
  ordering: 'worst-first' | 'chronological';
  callsWithCriticalFailure: number;
  skippedNoTranscript: number;
  builtAt: string;
}

export function buildManifest(input: {
  agent: string;
  from: string;
  to: string;
  rows: readonly CorpusRowOut[];
  chunkSize: number;
  ordering: 'worst-first' | 'chronological';
  skippedNoTranscript: number;
  now: Date;
}): CorpusManifest {
  return {
    agent: input.agent,
    from: input.from,
    to: input.to,
    calls: input.rows.length,
    chunks: chunkRows(input.rows, input.chunkSize).length,
    chunkSize: input.chunkSize,
    ordering: input.ordering,
    callsWithCriticalFailure: input.rows.filter(
      (r) => criticalFailureCount({ summary: summaryOf(r) }) > 0,
    ).length,
    skippedNoTranscript: input.skippedNoTranscript,
    builtAt: input.now.toISOString(),
  };
}

/** Recompute a summary from the retained grader list, since we only keep `graders`. */
function summaryOf(row: CorpusRowOut): { criticalFailures: number } {
  const graders = row.grader_results?.graders ?? [];
  const criticalFailures = graders.filter((g) => {
    if (!g || typeof g !== 'object') return false;
    const rec = g as { severity?: unknown; pass?: unknown };
    return rec.severity === 'critical' && rec.pass === false;
  }).length;
  return { criticalFailures };
}

/**
 * Refuse to write patient transcripts anywhere git would track them.
 *
 * `isIgnored` is injected so the caller supplies the real answer — in the CLI
 * that is `git check-ignore`, which consults the actual ignore rules rather
 * than guessing from the path. A guard that pattern-matches on "does the folder
 * sound temporary" is the kind that holds until the day someone picks a
 * different name.
 */
export function assertOutputDirIsIgnored(
  outDir: string,
  isIgnored: (dir: string) => boolean,
): void {
  if (!isIgnored(outDir)) {
    throw new Error(
      `refusing to write a replay corpus to '${outDir}': it is not ignored by git.\n` +
        'Corpus rows carry full call transcripts — names, dates of birth, phone numbers, ' +
        'and what the patient said was wrong. Point --out at an ignored path ' +
        "(the repo ignores 'replay-corpus/' and '*.jsonl'), or write outside the repo.",
    );
  }
}
