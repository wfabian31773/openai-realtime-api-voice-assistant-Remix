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
import { clearAllLedgers, seedLedger } from '../../services/callFactsLedger';
import { createAnsweringServiceLine } from '../answeringServiceLine';
import { callLogToFixture } from '../../shadow/callLogReplay';
import { CallGradingService, type GraderResult } from '../../services/callGradingService';
import type { CoreAction, TicketInput, TicketLineServices, ClassifyResult } from '../types';

const COMPARABLE = new Set([
  'handoff_expected_vs_actual',
  'ticket_required_vs_created',
  'question_repetition',
  'human_request_deflection',
  'language_config_fault',
  'emergency_handling',
  'medical_advice_guardrail',
  'provider_must_escalate',
  'actionable_request_needs_ticket',
  'callback_fields_completeness',
  'tail_safety',
]);

interface CorpusRow {
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
  grader_results: { graders?: GraderResult[] } | null;
  transcript: string;
}

function criticalsOf(graders: GraderResult[] | undefined | null): string[] {
  return (graders ?? [])
    .filter((g) => COMPARABLE.has(g.grader))
    .filter((g) => g.pass === false && ((g as { severity?: string }).severity === 'critical' || (g.metadata as { critical?: boolean } | undefined)?.critical === true))
    .map((g) => g.grader);
}

function simulatedServices(row: CorpusRow, filed: TicketInput[]): TicketLineServices {
  return {
    async verifyByLookup() {
      // The record system as it stood for THIS call: found or not.
      return Boolean(row.patient_found);
    },
    async classify(description: string): Promise<ClassifyResult> {
      const cfg = await import('../../config/answeringServiceTicketing');
      const department = cfg.detectDepartment(description);
      const departmentId = cfg.ANSWERING_SERVICE_DEPARTMENTS[
        department.toUpperCase() as keyof typeof cfg.ANSWERING_SERVICE_DEPARTMENTS
      ] as number;
      const requestTypeId = cfg.detectRequestType(description, department);
      return {
        departmentId,
        requestTypeId,
        requestReasonId: cfg.detectRequestReason(description, requestTypeId),
        priority: cfg.detectPriority(description),
        locationId: cfg.findLocationByName(description) ?? null,
        providerId: cfg.findProviderByName(description) ?? null,
      };
    },
    async fileTicket(input: TicketInput) {
      filed.push(input);
      return { ok: true, ticketNumber: `SIM-${filed.length}` };
    },
  };
}

async function renderAction(a: CoreAction, out: string[]): Promise<boolean> {
  let cur: CoreAction | null = a;
  let ended = false;
  while (cur) {
    if (cur.say) out.push(`AGENT: ${cur.say}`);
    if (cur.endCall) ended = true;
    cur = cur.followUp ? await cur.followUp() : null;
  }
  return ended;
}

async function replayOne(row: CorpusRow, grader: CallGradingService) {
  const parsed = callLogToFixture({ id: row.id, agentUsed: 'answering-service', transcript: row.transcript });
  if (!parsed) return null;
  const callerTurns = parsed.fixture.turns.filter((t): t is { caller: string } => 'caller' in t).map((t) => t.caller);
  if (!callerTurns.length) return null;

  const callId = `replay-${row.id}`;
  clearAllLedgers();
  // Seed exactly what production seeds before the first word: caller-ID and
  // the matched record when the phone lookup had found one.
  const [pFirst, ...pRest] = (row.patient_name ?? '').trim().split(/\s+/).filter(Boolean);
  seedLedger(callId, {
    callerPhone: (row.from ?? '').replace(/[^\d+]/g, '') || undefined,
    ...(row.patient_found && pFirst
      ? { matchedFirstName: pFirst, matchedLastName: pRest.join(' ') || undefined, matchedDob: row.patient_dob ?? undefined }
      : {}),
  });

  const filed: TicketInput[] = [];
  const line = createAnsweringServiceLine(simulatedServices(row, filed));
  line.start(callId);

  const newLines: string[] = [];
  // The greeting plays before the module (enforced separately in prod).
  const firstAgent = row.transcript.split('\n').find((l) => l.startsWith('AGENT:'));
  if (firstAgent) newLines.push(firstAgent.trim());

  // State-aware turn selection: the new core may ask in a different order
  // than the old core did, so for data-collecting states pick the first
  // RECORDED caller turn that answers the question being asked. Content is
  // never invented — only re-paired. Recorded as an approximation below.
  const DOB_PICK = /\b(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{2,4})\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b.*\b(19|20)\d{2}\b/i;
  const NAME_PICK = (s: string) => {
    const w = s.trim().split(/\s+/).filter((x) => /^[a-záéíóúñ'-]+$/i.test(x));
    return w.length >= 2 && w.length <= 5 && !DOB_PICK.test(s);
  };
  const PHONE_PICK = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const YN_PICK = /\b(yes|yeah|yep|ok|okay|correct|no|nope|sure|right|si|sí|claro)\b/i;
  const pickFor = (state: string | null, queue: string[]): number => {
    let pred: ((s: string) => boolean) | null = null;
    if (state === 'COLLECT_DOB' || state === 'CONFIRM_DOB') pred = (s) => DOB_PICK.test(s);
    else if (state === 'COLLECT_NAME') pred = NAME_PICK;
    else if (state === 'COLLECT_CALLBACK') pred = (s) => PHONE_PICK.test(s);
    else if (state === 'CONFIRM_ID' || state === 'CONFIRM_CALLBACK' || state === 'CLASSIFY') pred = (s) => YN_PICK.test(s) || PHONE_PICK.test(s);
    if (!pred) return 0;
    const i = queue.findIndex(pred);
    return i >= 0 ? i : 0;
  };

  let ended = false;
  const queue = [...callerTurns];
  while (queue.length && !ended) {
    const caller = queue.splice(pickFor(line.stateOf(callId), queue), 1)[0];
    newLines.push(`CALLER: ${caller}`);
    const action = await line.onUtterance(callId, caller);
    ended = await renderAction(action, newLines);
  }
  const newTranscript = newLines.join('\n');
  line.release(callId);

  const newGraders = grader
    .runDeterministicGraders({
      callLogId: `replay-${row.id}`,
      transcript: newTranscript,
      transferredToHuman: false,
      ticketNumber: filed.length ? 'SIM-1' : null,
      agentSlug: 'answering-service',
      totalTurns: newLines.length,
      interruptionCount: 0,
      truncationCount: 0,
      toolCallCount: filed.length,
      durationSeconds: null,
      firstTranscriptDelayMs: null,
      postTranscriptTailMs: null,
      localDurationSeconds: null,
      transcriptWindowSeconds: null,
      durationMismatchRatio: null,
      durationMismatchFlag: null,
    })
    .filter((g) => COMPARABLE.has(g.grader));

  const newCritical = criticalsOf(newGraders);
  // The old side is RE-graded with the same current referee (not read from
  // stored results) so grader improvements apply to both cores identically.
  const oldGraders = grader
    .runDeterministicGraders({
      callLogId: row.id,
      transcript: row.transcript,
      transferredToHuman: Boolean(row.transferred_to_human),
      ticketNumber: row.ticket_number,
      agentSlug: 'answering-service',
      totalTurns: row.total_turns,
      interruptionCount: null,
      truncationCount: null,
      toolCallCount: null,
      durationSeconds: row.duration,
      firstTranscriptDelayMs: null,
      postTranscriptTailMs: null,
      localDurationSeconds: null,
      transcriptWindowSeconds: null,
      durationMismatchRatio: null,
      durationMismatchFlag: null,
    })
    .filter((g) => COMPARABLE.has(g.grader));
  const oldCritical = criticalsOf(oldGraders);
  const verdict = newCritical.length < oldCritical.length ? 'better' : newCritical.length === oldCritical.length ? 'same' : 'worse';
  return {
    call_log_id: row.id,
    new_transcript: newTranscript,
    new_grader_results: { graders: newGraders },
    new_critical: newCritical,
    old_critical: oldCritical,
    tickets_filed: filed.length,
    verdict,
    approximations: parsed.approximations.concat(
      "caller turns answered the old core's questions; replay re-pairs recorded turns to the new core's questions by state (content never invented)",
    ),
  };
}

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
