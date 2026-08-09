/**
 * Gate B — replay stored answering-service calls through the new core and
 * grade both sides with the SAME deterministic referee
 * (reconstruction-plan.md §5, Gate B).
 *
 * Usage: OPENAI_API_KEY=offline tsx src/core/replay/gateBRunner.ts <corpusDir> <outDir>
 *
 * corpusDir: chunk-*.jsonl files, one JSON call_logs row per line
 *   {id, from, caller_name, patient_name, patient_dob, patient_found,
 *    ticket_number, transferred_to_human, total_turns, duration,
 *    grader_results, transcript}
 * outDir: tapes-<chunk>.jsonl + insert-<chunk>-<n>.sql + summary.json
 *
 * Honest-comparison rules:
 *  - Only transcript/outcome graders are compared (COMPARABLE set). Audio
 *    plumbing metrics (latency, interruptions, coverage, duration mismatch)
 *    cannot be reproduced by a text replay and are excluded on BOTH sides.
 *  - The old side's verdicts are its STORED production grader results — not
 *    re-derived — so the old core is judged by what actually happened.
 *  - Approximation (recorded on every tape): replayed callers answered the
 *    OLD core's questions; where the new core asks in a different order the
 *    turn pairing is approximate. The harvester makes most answers land
 *    regardless of order; tapes are for human judgment of exactly this.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CallGradingService } from '../../services/callGradingService';
import { replayStoredCall, type CorpusRow, type ReplayAgent } from './replayCall';

const AGENT = (process.env.REPLAY_AGENT ?? 'answering-service') as ReplayAgent;
const replayOne = (row: CorpusRow, grader: CallGradingService) => replayStoredCall(row, AGENT, grader);

function sqlLit(s: string): string {
  return `$tape$${s.replace(/\$tape\$/g, '')}$tape$`;
}

async function main() {
  const [corpusDir, outDir] = process.argv.slice(2);
  if (!corpusDir || !outDir) throw new Error('usage: gateBRunner <corpusDir> <outDir>');
  fs.mkdirSync(outDir, { recursive: true });
  const grader = new CallGradingService();

  const chunks = fs.readdirSync(corpusDir).filter((f) => /^chunk-.*\.jsonl$/.test(f)).sort();
  const summary = {
    calls: 0,
    parseFailures: 0,
    oldCriticalCalls: 0,
    newCriticalCalls: 0,
    better: 0,
    same: 0,
    worse: 0,
    byGraderOld: {} as Record<string, number>,
    byGraderNew: {} as Record<string, number>,
    worseIds: [] as string[],
  };

  for (const chunk of chunks) {
    const rows = fs
      .readFileSync(path.join(corpusDir, chunk), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CorpusRow);
    const tapes: NonNullable<Awaited<ReturnType<typeof replayOne>>>[] = [];
    for (const row of rows) {
      try {
        const tape = await replayOne(row, grader);
        if (!tape) {
          summary.parseFailures += 1;
          continue;
        }
        tapes.push(tape);
        summary.calls += 1;
        if (tape.old_critical.length) summary.oldCriticalCalls += 1;
        if (tape.new_critical.length) summary.newCriticalCalls += 1;
        summary[tape.verdict as 'better' | 'same' | 'worse'] += 1;
        if (tape.verdict === 'worse') summary.worseIds.push(tape.call_log_id);
        for (const g of tape.old_critical) summary.byGraderOld[g] = (summary.byGraderOld[g] ?? 0) + 1;
        for (const g of tape.new_critical) summary.byGraderNew[g] = (summary.byGraderNew[g] ?? 0) + 1;
      } catch (err) {
        summary.parseFailures += 1;
        console.error(`replay failed for ${row.id}:`, err);
      }
    }
    const tag = chunk.replace(/^chunk-/, '').replace(/\.jsonl$/, '');
    fs.writeFileSync(
      path.join(outDir, `tapes-${tag}.jsonl`),
      tapes.map((t) => JSON.stringify(t)).join('\n') + '\n',
    );
    // Ready-to-run inserts, 25 rows per file, dollar-quoted (PHI never in git).
    for (let i = 0; i < tapes.length; i += 25) {
      const batch = tapes.slice(i, i + 25);
      const values = batch
        .map(
          (t) =>
            `(${sqlLit(t.call_log_id)}, 'answering-service', ${sqlLit(t.new_transcript)}, ${sqlLit(
              JSON.stringify(t.new_grader_results),
            )}::jsonb, ${t.new_critical.length}, ${t.old_critical.length}, ${sqlLit(t.verdict)}, ${sqlLit(
              JSON.stringify(t.approximations),
            )}::jsonb)`,
        )
        .join(',\n');
      fs.writeFileSync(
        path.join(outDir, `insert-${tag}-${String(i / 25).padStart(2, '0')}.sql`),
        `insert into public.new_core_replays (call_log_id, agent, new_transcript, new_grader_results, new_critical_count, old_critical_count, verdict, approximations)\nselect x.call_log_id, x.agent, x.new_transcript, x.new_grader_results, x.new_critical_count, x.old_critical_count, x.verdict, (select array_agg(a) from jsonb_array_elements_text(x.approx) a)\nfrom (values\n${values}\n) as x(call_log_id, agent, new_transcript, new_grader_results, new_critical_count, old_critical_count, verdict, approx)\non conflict (call_log_id) do update set new_transcript = excluded.new_transcript, new_grader_results = excluded.new_grader_results, new_critical_count = excluded.new_critical_count, old_critical_count = excluded.old_critical_count, verdict = excluded.verdict, approximations = excluded.approximations;\n`,
      );
    }
    console.log(`${chunk}: ${tapes.length} tapes`);
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
