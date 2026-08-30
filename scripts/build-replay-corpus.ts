/**
 * Export a Gate B replay corpus from production `call_logs`.
 *
 *   Usage:
 *     tsx scripts/build-replay-corpus.ts --agent answering-service \
 *       --from 2026-08-10 --to 2026-08-12 --out replay-corpus/as [--worst-first] [--limit 500]
 *
 *   Then:
 *     OPENAI_API_KEY=offline REPLAY_AGENT=answering-service \
 *       tsx src/core/replay/gateBRunner.ts replay-corpus/as replay-out/as
 *
 * `gateBRunner.ts` has always read `chunk-*.jsonl` from a directory that
 * nothing in this repo produced. That is why Gate B's numbers — the ones quoted
 * in CLAUDE.md — cannot be reproduced today: the corpus behind them was
 * exported by hand and never committed (correctly, it is full of PHI). This is
 * the missing half, so a Gate B run becomes a command rather than an
 * archaeology exercise.
 *
 * The logic lives in `src/core/replay/corpusBuilder.ts` and is tested there.
 * This file is the shell: argv, SQL, files.
 *
 * **It will refuse to write anywhere git does not ignore.** The check shells
 * out to `git check-ignore`, so it consults the real ignore rules rather than
 * trusting a directory name.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import {
  assertOutputDirIsIgnored,
  buildManifest,
  chunkFileName,
  chunkRows,
  criticalFailureCount,
  isReplayable,
  toCorpusRow,
  type RawCallLogRow,
} from '../src/core/replay/corpusBuilder';

interface Args {
  agent: string;
  from: string;
  to: string;
  out: string;
  worstFirst: boolean;
  limit: number;
  chunkSize: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const agent = get('--agent');
  const from = get('--from');
  const to = get('--to');
  const out = get('--out');
  if (!agent || !from || !to || !out) {
    console.error(
      'usage: tsx scripts/build-replay-corpus.ts --agent <slug> --from <YYYY-MM-DD> ' +
        '--to <YYYY-MM-DD> --out <dir> [--worst-first] [--limit N] [--chunk-size N]',
    );
    process.exit(2);
  }
  for (const [label, value] of [['--from', from], ['--to', to]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      console.error(`${label} must be YYYY-MM-DD, got '${value}'`);
      process.exit(2);
    }
  }
  return {
    agent,
    from,
    to,
    out,
    worstFirst: argv.includes('--worst-first'),
    limit: Number(get('--limit') ?? 1000),
    chunkSize: Number(get('--chunk-size') ?? 25),
  };
}

/** The real ignore rules, not a naming convention. Exit 1 from git means "not ignored". */
function gitIgnores(dir: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', dir], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Before touching the database: if we cannot write the result safely, do not
  // pull patient transcripts into this process at all.
  assertOutputDirIsIgnored(args.out, gitIgnores);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set — cannot read call_logs.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  let rawRows: RawCallLogRow[];
  try {
    const { rows } = await pool.query<RawCallLogRow>(
      `SELECT id,
              "from"                AS from_number,
              caller_name,
              patient_name,
              patient_dob,
              patient_found,
              ticket_number,
              transferred_to_human,
              total_turns,
              duration,
              transcript,
              grader_results,
              tool_timeline
         FROM call_logs
        WHERE agent_used = $1
          AND created_at >= $2::date
          AND created_at < ($3::date + interval '1 day')
          AND transcript IS NOT NULL
        ORDER BY created_at ASC
        LIMIT $4`,
      [args.agent, args.from, args.to, args.limit],
    );
    rawRows = rows;
  } finally {
    await pool.end();
  }

  const replayable = rawRows.filter(isReplayable);
  const skippedNoTranscript = rawRows.length - replayable.length;

  // Worst-first puts the calls that already failed a critical grader at the top,
  // so a truncated run still covers the cases most likely to expose a
  // regression. Ties break on id, so a run is reproducible.
  const ordered = args.worstFirst
    ? [...replayable].sort((a, b) => {
        const d = criticalFailureCount(b.grader_results) - criticalFailureCount(a.grader_results);
        return d !== 0 ? d : a.id.localeCompare(b.id);
      })
    : replayable;

  const corpus = ordered.map(toCorpusRow);
  const chunks = chunkRows(corpus, args.chunkSize);

  fs.mkdirSync(args.out, { recursive: true });
  chunks.forEach((chunk, i) => {
    const file = path.join(args.out, chunkFileName(i));
    fs.writeFileSync(file, chunk.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  });

  const manifest = buildManifest({
    agent: args.agent,
    from: args.from,
    to: args.to,
    rows: corpus,
    chunkSize: args.chunkSize,
    ordering: args.worstFirst ? 'worst-first' : 'chronological',
    skippedNoTranscript,
    now: new Date(),
  });
  fs.writeFileSync(
    path.join(args.out, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  console.log(
    `[corpus] ${manifest.calls} call(s) -> ${manifest.chunks} chunk(s) in ${args.out} ` +
      `(${manifest.callsWithCriticalFailure} with a critical failure, ` +
      `${manifest.skippedNoTranscript} skipped for no transcript, ${manifest.ordering})`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
