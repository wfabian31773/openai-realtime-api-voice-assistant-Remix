/**
 * On-demand replay: feed a stored call's caller turns through a new-core
 * line module and grade both sides with the same referee.
 *
 * Used by the Gate B batch runner AND by the Observatory, which renders a
 * tape live when Wayne opens a call. Rendering live (instead of copying
 * transcripts into another table) means the tape always reflects the code
 * as it stands right now, and no patient transcript is duplicated anywhere.
 */
import { clearAllLedgers, seedLedger } from '../../services/callFactsLedger';
import { createAnsweringServiceLine } from '../answeringServiceLine';
import { createPcpLine, type ProfessionalLineServices } from '../pcpLine';
import { createSchedulingLine, type SchedulingLineServices, type AvailabilityOffer } from '../schedulingLine';
import { createTicketAgent } from '../ticketAgent';
import { callLogToFixture } from '../../shadow/callLogReplay';
import { CallGradingService, type GraderResult } from '../../services/callGradingService';
import type { CoreAction, TicketInput, TicketLineServices, ClassifyResult } from '../types';

export type ReplayAgent = 'answering-service' | 'no-ivr' | 'after-hours' | 'pcp' | 'azul-scheduling' | 'ticket-agent';

/** A tool event as recorded on the real call (call_logs.tool_timeline). */
export interface RecordedToolEvent {
  tool?: string;
  args?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
}

export interface CorpusRow {
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
  grader_results?: { graders?: GraderResult[] } | null;
  transcript: string;
  /** Filtered tool events from the real call — the SD replay's ground truth. */
  tool_events?: RecordedToolEvent[] | null;
}

/** "01:40 PM" / "9 AM" inside the server's offer sentence -> 24h HH:MM. */
export function parseOfferTimes(say: string): string[] {
  const out: string[] = [];
  const rx = /\b(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(say)) !== null) {
    let h = Number(m[1]);
    const min = m[2] ?? '00';
    const pm = m[3].toLowerCase() === 'p';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    out.push(`${String(h).padStart(2, '0')}:${min}`);
  }
  return out;
}

/**
 * SD services built from what the scheduling service ACTUALLY returned on
 * this call. The new core never invents an offer, so the replay must not
 * invent one either: it speaks the recorded `say` and books against the
 * recorded booking_status. Calls with no recorded availability event can
 * still be judged on identity/intent handling — flagged as such.
 */
function simulatedSchedulingServices(
  row: CorpusRow,
  used: { availability: number; book: number; confirmed: number; transfers: number; hadRecordedOffer: boolean },
): SchedulingLineServices {
  const events = row.tool_events ?? [];
  const offers = events.filter((e) => e.tool === 'sage_availability');
  const books = events.filter((e) => e.tool === 'sage_book');
  const verify = events.find((e) => e.tool === 'verify_patient_identity');
  return {
    async verifyIdentity() {
      if (verify?.outcome && typeof verify.outcome.verified === 'boolean') return Boolean(verify.outcome.verified);
      return Boolean(row.patient_found);
    },
    async availability(): Promise<AvailabilityOffer> {
      // One recorded offer per recorded lookup. When the new core asks MORE
      // times than the real call did (e.g. the earliest-opening fallback),
      // there is no evidence for what the service would have said — so we
      // return nothing rather than re-serving a stale offer, which would let
      // the replay book against a slot the service never offered.
      const rec = used.availability < offers.length ? offers[used.availability] : undefined;
      used.availability += 1;
      const say = typeof rec?.outcome?.say === 'string' ? (rec.outcome.say as string) : '';
      if (!say) {
        // No recorded offer for this call: the honest answer is "we cannot
        // know what the service would have said", surfaced as an empty offer
        // rather than a fabricated one.
        return { say: "I don't have anything matching that right now.", optionTimes: [], empty: true };
      }
      used.hadRecordedOffer = true;
      return { say, optionTimes: parseOfferTimes(say), empty: parseOfferTimes(say).length === 0 };
    },
    async book() {
      // No recorded sage_book for this attempt = no evidence it would have
      // succeeded. 'unknown' keeps the caller un-promised and keeps the
      // replay honest; claiming 'confirmed' invented bookings that never were.
      const rec = used.book < books.length ? books[used.book] : undefined;
      used.book += 1;
      const status = String(rec?.outcome?.booking_status ?? 'unknown');
      if (status === 'confirmed') used.confirmed += 1;
      return {
        status: status === 'confirmed' ? 'confirmed' : status === 'unknown' ? 'unknown' : 'failed',
        say: typeof rec?.outcome?.say === 'string' ? (rec.outcome.say as string) : undefined,
        patientScript: typeof rec?.outcome?.patient_script === 'string' ? (rec.outcome.patient_script as string) : undefined,
      };
    },
    async transfer() {
      used.transfers += 1;
      return { ok: Boolean(row.transferred_to_human) };
    },
  };
}

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

/** Which line module a corpus directory replays (set by AGENT env, default AS). */


const CLOSED_OFFICE = {
  en: "Our offices are closed right now — I'll take your information and make sure the right team member calls you back first thing.",
  es: 'Nuestras oficinas están cerradas en este momento — tomaré su información y me aseguraré de que el equipo le devuelva la llamada a primera hora.',
};

/** PCP simulated services: the queue answers as it did on the real call. */
function simulatedPcpServices(row: CorpusRow, routed: Array<Record<string, unknown>>, filed: Array<Record<string, unknown>>): ProfessionalLineServices {
  return {
    async routeToQueue(_callId, input) {
      routed.push(input as unknown as Record<string, unknown>);
      // The real call's outcome is the ground truth for whether a human picked up.
      return { connected: Boolean(row.transferred_to_human), ticketNumber: 'SIM-PCP' };
    },
    async fileTask(_callId, input) {
      filed.push(input as unknown as Record<string, unknown>);
      return { ok: true, ticketNumber: 'SIM-TASK' };
    },
  };
}

export async function replayStoredCall(row: CorpusRow, AGENT: ReplayAgent, grader = new CallGradingService()) {
  const parsed = callLogToFixture({ id: row.id, agentUsed: AGENT, transcript: row.transcript });
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
  const pcpRouted: Array<Record<string, unknown>> = [];
  const pcpFiled: Array<Record<string, unknown>> = [];
  const sdUsed = { availability: 0, book: 0, confirmed: 0, transfers: 0, hadRecordedOffer: false };
  const ticketAgentSubmits: Array<Record<string, unknown>> = [];
  const line =
    AGENT === 'ticket-agent'
      ? createTicketAgent({
          async verify() {
            return Boolean(row.patient_found);
          },
          async submit(_c, t) {
            ticketAgentSubmits.push(t as unknown as Record<string, unknown>);
            return { ok: true, ticketNumber: 'SIM-T' };
          },
        })
      : AGENT === 'pcp'
      ? createPcpLine(simulatedPcpServices(row, pcpRouted, pcpFiled))
      : AGENT === 'azul-scheduling'
        ? createSchedulingLine(simulatedSchedulingServices(row, sdUsed))
        : createAnsweringServiceLine(simulatedServices(row, filed), AGENT === 'no-ivr' ? { slug: 'no-ivr', humanBusy: CLOSED_OFFICE } : {});
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
  // End of call = the caller stopped talking. The hang-up safety net runs
  // here exactly as it does in production teardown.
  if (line.finalize) await line.finalize(callId).catch(() => undefined);
  line.release(callId);

  const newGraders = grader
    .runDeterministicGraders({
      callLogId: `replay-${row.id}`,
      transcript: newTranscript,
      transferredToHuman: AGENT === 'pcp' ? pcpRouted.length > 0 : AGENT === 'azul-scheduling' ? sdUsed.transfers > 0 : false,
      ticketNumber:
        (AGENT === 'pcp'
          ? pcpRouted.length + pcpFiled.length
          : AGENT === 'ticket-agent'
            ? ticketAgentSubmits.length
            : filed.length)
          ? 'SIM-1'
          : null,
      agentSlug: AGENT === 'ticket-agent' ? (process.env.REPLAY_AS_SLUG ?? 'answering-service') : AGENT,
      totalTurns: newLines.length,
      interruptionCount: 0,
      truncationCount: 0,
      toolCallCount: filed.length + pcpRouted.length + pcpFiled.length,
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
      agentSlug: AGENT === 'ticket-agent' ? (process.env.REPLAY_AS_SLUG ?? 'answering-service') : AGENT,
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
    tickets_filed: filed.length + pcpFiled.length + ticketAgentSubmits.length,
    ticket_intents: ticketAgentSubmits.map((t) => String((t as { intent?: string }).intent ?? '')),
    transfers: pcpRouted.length + sdUsed.transfers,
    book_attempts: sdUsed.book,
    booked: sdUsed.confirmed,
    had_recorded_offer: sdUsed.hadRecordedOffer,
    verdict,
    approximations: parsed.approximations.concat(
      "caller turns answered the old core's questions; replay re-pairs recorded turns to the new core's questions by state (content never invented)",
    ),
  };
}

