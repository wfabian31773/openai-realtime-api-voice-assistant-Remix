/**
 * Per-call tool timeline — FLEET-WIDE.
 *
 * Records one event per tool call (in memory, keyed by the OpenAI callId),
 * exposes the live timeline for the SD Pilot dashboard, and flushes the
 * finished timeline onto call_logs.tool_timeline + tool_call_count when the
 * call ends. Evidence of WHAT the agent did, not just what it said.
 *
 * Built for azul (hence the original name, `azulToolTimeline`), and azul-only
 * until 2026-08-01. That limit is what made D11 undiagnosable: on 07-31, 60
 * answering-service calls promised the caller a callback and no ticket was
 * ever created, and because tool_call_count and tool_timeline were NULL on
 * every non-azul row — 83% of the day's volume — there was no way to tell
 * whether create_ticket was never called, called and failed, or pre-empted by
 * a hangup. You cannot fix what you cannot see. Now every agent records.
 *
 * PHI discipline: tool names, an ALLOW-LISTED subset of arguments (appointment
 * type, intent, reason, department — never a name, DOB, phone, or free-text
 * description), and outcome-relevant result fields. The allow-list is the
 * safety mechanism: an argument key that is not listed is dropped, so a new
 * tool leaks nothing by default.
 */

import { db } from '../../server/db';
import { callLogs } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { shadowTap } from '../shadow/tap'; // observation-only tap; no-op unless SHADOW_MODE_ENABLED
import { callMetadataForDB } from './callMetadataStore';
import type { DirectorAction } from '../director/director';

export interface AzulToolEvent {
  at: string;               // ISO timestamp
  tool: string;             // tool name, e.g. sage_book
  args: Record<string, unknown>;   // REDACTED subset of arguments
  outcome: Record<string, unknown>; // outcome-relevant subset of the result
  ms: number;               // tool latency
}

/**
 * One director intervention, in the only form that may leave the call.
 *
 * PHI discipline, and it is the whole reason this is a separate type rather
 * than the DirectorAction itself: `DirectorAction.text` and `.speak` quote the
 * caller back to themselves — "The caller already gave their date of birth:
 * \"October 5th, 1983\"" — so both are PHI and NEITHER is stored. What lands
 * in the database is the verdict only: how hard we pushed, why, and on which
 * FIELD NAME. `topic` is a field name from ASK_TOPICS ('date of birth', 'last
 * name', 'bundled'), never a field value.
 */
export interface DirectorTimelineAction {
  at: string;                                        // ISO timestamp
  enforcement: 'inject' | 'author' | 'force_exit';   // how hard the director pushed
  code: string;                                      // why, e.g. reask_answered_field
  topic: string;                                     // WHICH FIELD, never its value
}

const timelines = new Map<string, {
  events: AzulToolEvent[];
  callSid?: string;
  callLogId?: string;
  /** Which agent produced these events — picks the classifier at flush time.
   *  Absent means azul, which is the only agent that recorded before
   *  2026-08-01. */
  agentSlug?: string;
  /** How many events the last successful DB write persisted. A flush is a
   *  no-op when this still equals events.length. */
  flushedCount?: number;
  /** Director interventions on this call (2026-08-03). Kept beside `events`
   *  rather than inside it so tool_call_count, the purpose/result classifiers,
   *  the graders and the shadow replay all keep counting tool calls only. */
  directorActions?: DirectorTimelineAction[];
  /** Flush idempotence for the director block, mirroring flushedCount. */
  flushedDirectorCount?: number;
  /** When this entry was opened. The reaper used to date an entry by its first
   *  TOOL event, which leaks any entry that only ever held director actions. */
  startedAt: number;
}>();

type TimelineEntry = NonNullable<ReturnType<typeof timelines.get>>;

/** Get or open the entry for a call, and fold in whatever ids we were given. */
function entryFor(
  callId: string,
  ids?: { callSid?: string; callLogId?: string; agentSlug?: string },
): TimelineEntry {
  let entry = timelines.get(callId);
  if (!entry) {
    entry = { events: [], startedAt: Date.now() };
    timelines.set(callId, entry);
  }
  if (ids?.callSid) entry.callSid = ids.callSid;
  if (ids?.callLogId) entry.callLogId = ids.callLogId;
  if (ids?.agentSlug) entry.agentSlug = ids.agentSlug;
  return entry;
}

/** Argument keys that are safe to persist per tool (everything else dropped). */
const SAFE_ARG_KEYS = new Set([
  'intent', 'eventName', 'locationId', 'providerId', 'resourceId', 'daysAhead',
  'slotDateTime', 'handoffReason', 'method', 'reasonForCall', 'requestedLocation',
  'requestedTimeframe', 'urgencyScreenResult', 'includePast', 'reason', 'name',
  'coverageType', 'healthPlan', 'medicalGroup', 'pcpName',
  // Fleet tools (answering-service, no-ivr), 2026-08-01. Routing and shape
  // ONLY. Deliberately absent, and they must stay absent: first_name,
  // last_name, middle_initial, date_of_birth, callback_number, email,
  // subject, description, request_description, unresolved_info, value,
  // key_phrases — every one is either a direct identifier or free text the
  // caller's own words land in.
  'department_id', 'request_type_id', 'request_reason_id', 'priority',
  'confirmation_type', 'location_id', 'provider_id', 'decision_type',
]);

/** Booleans derived from arguments we must NOT store verbatim. "Did the agent
 *  flag a gap?" is the diagnostic question; the caller's phrasing of the gap
 *  is PHI-adjacent free text and never leaves the call. */
function derivedFlags(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (tool === 'create_ticket') {
    out.hasUnresolvedInfo = Boolean(args?.unresolved_info);
    // Whether the agent had the identity fields it needs, without storing them.
    out.hasPatientName = Boolean(args?.first_name && args?.last_name);
    out.hasCallbackNumber = Boolean(args?.callback_number);
  }
  return out;
}

function redactArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(args ?? {}).filter(([k, v]) => SAFE_ARG_KEYS.has(k) && v != null),
    ),
    ...derivedFlags(tool, args ?? {}),
  };
}

/** Pull the outcome-relevant fields out of a tool's JSON result string. */
function summarizeResult(tool: string, resultJson: string): Record<string, unknown> {
  let parsed: any;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return { unparsed: true };
  }
  // THE ENVELOPE, third strike (2026-07-24 21:04 call classified a CONFIRMED
  // booking as "attempted"): the service wraps every response as
  // {tool, result} — unwrap before reading outcome fields, same as the two
  // parsers this already bit on 07-22.
  parsed = parsed?.result ?? parsed;
  const out: Record<string, unknown> = {};
  for (const k of [
    'decision', 'reason', 'booking_status', 'appointmentId', 'matchSignal',
    'callback_id', 'error', 'cancelled', 'rules_version',
    'status', 'verified', 'identityVerified', 'matchCount', 'recentSurgicalContext',
    'earliest_bookable_date', 'eligibility_due_date', 'intakeId', 'new_patient_earliest_date',
    'ok', 'skipped', 'detail', 'transferred',
    // Fleet tools. ticket_number identifies the TICKET, not the patient, and
    // is the field D11 turns on: it is the difference between "the agent
    // promised a callback and filed it" and "promised and filed nothing".
    'success', 'ticket_number', 'ticketNumber', 'validationError',
    'department', 'requestType', 'escalated', 'patientFound',
    'say', // directive text — kept so the Phase 7 rubric can grade say-verbatim compliance
  ]) {
    if (parsed?.[k] !== undefined) out[k] = parsed[k];
  }
  if (Array.isArray(parsed?.upcomingAppointments)) {
    out.upcomingCount = parsed.upcomingAppointments.length;
  }
  if (Array.isArray(parsed?.approved_types)) {
    out.approvedTypesOffered = parsed.approved_types.length;
  }
  if (tool === 'sage_availability') {
    const opts = parsed?.options;
    const arr = Array.isArray(opts) ? opts : Array.isArray(opts?.slots) ? opts.slots : null;
    out.optionCount = arr ? arr.length : (parsed?.options ? 'unknown' : 0);
  }
  if (tool === 'sage_handoff') {
    if (parsed?.method) out.method = parsed.method;
    if (parsed?.queueTeam ?? parsed?.queue_team) out.queue = parsed.queueTeam ?? parsed.queue_team;
    if (parsed?.transferNumber ?? parsed?.transfer_number) out.transferNumber = parsed.transferNumber ?? parsed.transfer_number;
  }
  if (tool === 'get_patient_appointments' && Array.isArray(parsed?.appointments)) {
    out.appointmentCount = parsed.appointments.length;
  }
  // Field NAMES only — the values are the caller's data.
  if (Array.isArray(parsed?.missingFields)) {
    out.missingFields = parsed.missingFields.map(String);
  }
  return out;
}

export function recordAzulToolEvent(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  resultJson: string,
  ms: number,
  ids?: { callSid?: string; callLogId?: string; agentSlug?: string },
): void {
  if (!callId) return;
  const entry = entryFor(callId, ids);
  entry.events.push({
    at: new Date().toISOString(),
    tool,
    args: redactArgs(tool, args),
    outcome: summarizeResult(tool, resultJson),
    ms,
  });

  // Shadow tap (observation only, default off): copies the already-redacted
  // record. emit never throws or blocks; a shadow bug cannot break the call.
  const recorded = entry.events[entry.events.length - 1];
  shadowTap.emit(
    (recorded.outcome as Record<string, unknown>)?.error ? 'tool_failed' : 'tool_completed',
    callId,
    ids?.agentSlug ?? entry.agentSlug ?? 'unknown',
    { tool, args: recorded.args, outcome: recorded.outcome, ms },
    { sensitive: true, component: 'toolTimeline' },
  );
}

/** Fleet-neutral alias. New call sites should use this name; the azul-prefixed
 *  one is kept because it is threaded through the scheduling agent in a dozen
 *  places and renaming those adds risk without adding meaning. */
export const recordToolEvent = recordAzulToolEvent;

/** Wrap a tool's execute so the call is timed and recorded without every
 *  agent re-implementing the try/finally. Recording NEVER changes what the
 *  tool returns and never throws into the tool: a telemetry bug must not be
 *  able to break a patient's call. */
export function recordingExecute<A, R>(
  ctx: { callId?: string; callSid?: string; callLogId?: string; agentSlug: string },
  tool: string,
  fn: (args: A) => Promise<R> | R,
): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    const started = Date.now();
    let result: R;
    try {
      result = await fn(args);
    } catch (err) {
      try {
        recordToolEvent(
          ctx.callId ?? ctx.callSid ?? '',
          tool,
          (args ?? {}) as Record<string, unknown>,
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          Date.now() - started,
          { callSid: ctx.callSid, callLogId: ctx.callLogId, agentSlug: ctx.agentSlug },
        );
      } catch { /* telemetry must never mask the real error */ }
      throw err;
    }
    try {
      recordToolEvent(
        ctx.callId ?? ctx.callSid ?? '',
        tool,
        (args ?? {}) as Record<string, unknown>,
        typeof result === 'string' ? result : JSON.stringify(result ?? {}),
        Date.now() - started,
        { callSid: ctx.callSid, callLogId: ctx.callLogId, agentSlug: ctx.agentSlug },
      );
    } catch (e) {
      console.error(`[TOOL-TIMELINE] record failed for ${tool}:`, e);
    }
    return result;
  };
}

/**
 * Record a director intervention so it survives the call.
 *
 * Until now the director only console.warn'd, which meant the single question
 * that matters on the morning it went live — "is it actually ruling on turns?"
 * — could only be answered by scrolling a deploy log. Now every intervention
 * lands on the call row next to the tool timeline.
 *
 * Same contract as the tool recorder: never throws, never blocks, and cannot
 * change what the director did. This runs AFTER the action has been applied to
 * the session, so a telemetry failure costs a record, not an intervention.
 */
export function recordDirectorAction(
  callId: string,
  agentSlug: string,
  action: Pick<DirectorAction, 'enforcement' | 'code' | 'topic'>,
): void {
  try {
    if (!callId) return;
    // A call whose director fired before its first tool call has no entry yet,
    // and a director-only call never gets one from the tool path at all — so
    // resolve the ids here or the flush has nothing to write against.
    const meta = callMetadataForDB.get(callId);
    const entry = entryFor(callId, {
      callSid: meta?.twilioCallSid,
      callLogId: meta?.dbCallLogId,
      agentSlug: agentSlug || meta?.agentSlug,
    });
    (entry.directorActions ??= []).push({
      at: new Date().toISOString(),
      enforcement: action.enforcement,
      code: action.code,
      topic: action.topic,
    });
  } catch (e) {
    console.error('[DIRECTOR] timeline record failed:', e);
  }
}

/** Live view of director interventions (active calls + tests). */
export function getDirectorActions(callIdOrSid: string): DirectorTimelineAction[] {
  const direct = timelines.get(callIdOrSid);
  if (direct) return direct.directorActions ?? [];
  for (const entry of timelines.values()) {
    if (entry.callSid === callIdOrSid || entry.callLogId === callIdOrSid) {
      return entry.directorActions ?? [];
    }
  }
  return [];
}

/** Live view for the SD Pilot dashboard (active calls). */
export function getAzulTimeline(callIdOrSid: string): AzulToolEvent[] | null {
  const direct = timelines.get(callIdOrSid);
  if (direct) return direct.events;
  for (const entry of timelines.values()) {
    if (entry.callSid === callIdOrSid || entry.callLogId === callIdOrSid) return entry.events;
  }
  return null;
}

/** Derive the call's purpose + headline result from its timeline. */
export function classifyAzulCall(events: AzulToolEvent[]): { purpose: string; result: string } {
  const intake = events.find((e) => e.tool === 'sage_new_patient_intake');
  const booked = events.find((e) => e.tool === 'sage_book' && e.outcome.booking_status === 'confirmed');
  if (intake) {
    const registered = intake.outcome.status === 'created';
    const suffix = booked ? ' + booked' : registered ? ' (booking pending eligibility window)' : '';
    return {
      purpose: 'New patient registration',
      result: registered ? `Registered${suffix}` : `Registration ${String(intake.outcome.status ?? 'attempted').replace(/_/g, ' ')}`,
    };
  }
  if (booked) return { purpose: 'Schedule appointment', result: `Booked (${booked.args.eventName ?? 'appointment'})` };
  const bookTried = events.find((e) => e.tool === 'sage_book');
  if (bookTried) return { purpose: 'Schedule appointment', result: `Booking ${bookTried.outcome.booking_status ?? 'attempted'}` };
  const cancelled = events.find((e) => e.tool === 'cancel_appointment' && e.outcome.cancelled !== false && !e.outcome.error);
  if (cancelled) return { purpose: 'Cancel appointment', result: 'Cancelled' };
  const handoff = events.find((e) => e.tool === 'sage_handoff');
  if (handoff) {
    const reason = String(handoff.args.handoffReason ?? 'handoff').replace(/_/g, ' ');
    return { purpose: `Handoff — ${reason}`, result: handoff.outcome.transferNumber ? 'Transferred' : 'Callback created' };
  }
  const searched = events.find((e) => e.tool === 'sage_availability' || e.tool === 'sage_decision');
  if (searched) return { purpose: 'Schedule appointment', result: 'No booking completed' };
  const appts = events.find((e) => e.tool === 'get_patient_appointments');
  if (appts) return { purpose: 'Appointment question', result: 'Answered' };
  const info = events.find((e) => ['lookup_location', 'list_locations', 'lookup_provider', 'get_provider_locations'].includes(e.tool));
  if (info) return { purpose: 'General information', result: 'Answered' };
  return { purpose: 'Unclassified', result: events.length ? `${events.length} tool call(s)` : 'No tools used' };
}

/** Purpose + result for the ticket-filing agents (answering-service, no-ivr).
 *
 *  The distinction this exists to draw is D11's: an agent that TOLD the caller
 *  it would file something and then did not. "Promised, not filed" is a
 *  different failure from "nothing to file", and the old azul classifier
 *  called both of them "Unclassified". */
export function classifyFleetCall(events: AzulToolEvent[]): { purpose: string; result: string } {
  const ticket = events.find((e) => e.tool === 'create_ticket');
  const filed = events.find(
    (e) => e.tool === 'create_ticket' && (e.outcome.success === true || e.outcome.ticket_number || e.outcome.ticketNumber),
  );
  const escalated = events.find((e) => e.tool === 'escalate_to_human' && !e.outcome.error);
  if (filed) {
    const num = filed.outcome.ticket_number ?? filed.outcome.ticketNumber;
    return { purpose: 'Patient request', result: `Ticket filed${num ? ` (${num})` : ''}` };
  }
  if (ticket) {
    // Attempted and failed — the args/outcome say why (validationError,
    // missingFields), which is exactly what a callback-with-no-ticket needs.
    const why = ticket.outcome.validationError
      ? `validation: ${Array.isArray(ticket.outcome.missingFields) ? (ticket.outcome.missingFields as string[]).join(', ') : 'missing fields'}`
      : String(ticket.outcome.error ?? 'unknown error');
    return { purpose: 'Patient request', result: `Ticket FAILED — ${why}` };
  }
  if (escalated) return { purpose: 'Escalation', result: 'Escalated to a human' };
  const classified = events.find((e) => e.tool === 'classify_request');
  if (classified) {
    // Got as far as working out WHERE the request belongs, then stopped.
    return { purpose: 'Patient request', result: 'Classified but NO ticket created' };
  }
  const looked = events.find((e) => e.tool === 'lookup_schedule' || e.tool === 'check_open_tickets');
  if (looked) return { purpose: 'Appointment/ticket question', result: 'Answered from lookup, no ticket' };
  const terminated = events.find((e) => e.tool === 'terminate_call');
  if (terminated) return { purpose: 'Ghost/robot/spam', result: `Terminated (${terminated.args.reason ?? 'unspecified'})` };
  return { purpose: 'Unclassified', result: events.length ? `${events.length} tool call(s)` : 'No tools used' };
}

/** Agent-appropriate classifier. */
function classifyForAgent(agentSlug: string | undefined, events: AzulToolEvent[]) {
  return agentSlug && agentSlug !== 'azul-scheduling'
    ? classifyFleetCall(events)
    : classifyAzulCall(events);
}

/** Persist the finished timeline on the call log and free the memory.
 *  Accepts the OpenAI callId, the Twilio callSid, or the callLogId. */
export async function flushAzulTimeline(callIdOrSid: string): Promise<void> {
  let key = callIdOrSid;
  let entry = timelines.get(key);
  if (!entry) {
    for (const [k, v] of timelines.entries()) {
      if (v.callSid === callIdOrSid || v.callLogId === callIdOrSid) {
        key = k;
        entry = v;
        break;
      }
    }
  }
  if (!entry) return;
  if (!entry.callLogId && !entry.callSid) return;
  // NEVER delete the entry here. This used to `timelines.delete(key)` before
  // writing, which made the flush destructive in a way that silently gutted a
  // THIRD of the pilot's QA record (17 of 51 timelines on 2026-07-28).
  //
  // Two flushes race for every azul call: the lifecycle coordinator's
  // 'call-ended' backstop, and the observeCall teardown which first runs the
  // terminal sweep (up to 25s). Whichever lost the race found no entry, so the
  // late recorders — file_location_ticket from the sweep, transfer_to_office
  // from the async transfer callback — created a BRAND-NEW one-event entry,
  // and the second flush overwrote the complete timeline with it.
  //
  // The signature was a call with tool_call_count = 1 and events
  // [file_location_ticket], on a 4-minute call that had really verified
  // identity and run three availability searches. Read at face value it looks
  // exactly like an agent speaking PHI with no tool call behind it, and that
  // is how it was first read. The events were never lost in memory — only the
  // row was. Keeping the entry means late events append and every subsequent
  // flush writes a superset. The 2h reaper below owns deletion.
  const directorCount = entry.directorActions?.length ?? 0;
  if (entry.flushedCount === entry.events.length && (entry.flushedDirectorCount ?? 0) === directorCount) {
    return; // nothing new since last write
  }
  try {
    const { purpose, result } = classifyForAgent(entry.agentSlug, entry.events);
    // A/B carriage arm (Phase 7): stamped on call metadata at session
    // creation; persisted here so per-arm grade comparison reads one field.
    let abArm: string | undefined;
    try {
      const { callMetadataForDB } = await import('./callMetadataStore');
      abArm = (callMetadataForDB.get(key) as { abArm?: string } | undefined)?.abArm;
    } catch { /* optional */ }
    // Director block. Present only when the director actually intervened, so
    // `tool_timeline->'director' IS NOT NULL` is the "did the reasoning layer
    // do anything on this call?" query, and `maxEnforcement` is the severity
    // to sort a review queue by.
    const director = directorCount
      ? {
          count: directorCount,
          maxEnforcement: ['inject', 'author', 'force_exit'].reduce(
            (worst, level) =>
              entry!.directorActions!.some((a) => a.enforcement === level) ? level : worst,
            'inject',
          ),
          topics: [...new Set(entry.directorActions!.map((a) => a.topic))],
          actions: entry.directorActions,
        }
      : null;
    const payload = {
      events: entry.events,
      purpose,
      result,
      toolCallCount: entry.events.length,
      ...(entry.agentSlug ? { agentSlug: entry.agentSlug } : {}),
      ...(abArm ? { abArm } : {}),
      ...(director ? { director } : {}),
    };
    if (entry.callLogId) {
      await db.update(callLogs)
        .set({ toolTimeline: payload, toolCallCount: entry.events.length })
        .where(eq(callLogs.id, entry.callLogId));
    } else if (entry.callSid) {
      await db.update(callLogs)
        .set({ toolTimeline: payload, toolCallCount: entry.events.length })
        .where(eq(callLogs.callSid, entry.callSid));
    }
    entry.flushedCount = entry.events.length;
    entry.flushedDirectorCount = directorCount;
    console.info(
      `[TOOL-TIMELINE] ${entry.agentSlug ?? 'azul-scheduling'}: flushed ${entry.events.length} tool event(s) (${purpose} → ${result})` +
        (director ? ` + ${director.count} director action(s), max ${director.maxEnforcement}` : ''),
    );
    // Phase 7: rubric pass with the just-persisted events. Forced because
    // grade-then-flush ordering would otherwise leave a rubric graded with an
    // empty timeline; the gradeCall-side pass is forced too, so whichever
    // runs LAST folds in complete data (deterministic — re-runs are cheap).
    try {
      let rubricCallLogId = entry.callLogId;
      if (!rubricCallLogId && entry.callSid) {
        const row = await db.select({ id: callLogs.id }).from(callLogs).where(eq(callLogs.callSid, entry.callSid)).limit(1);
        rubricCallLogId = row[0]?.id ?? null;
      }
      if (rubricCallLogId) {
        const { callGradingService } = await import('./callGradingService');
        await callGradingService.runAndPersistDeterministicGraders(rubricCallLogId, true);
      }
    } catch (err) {
      console.error('[AZUL-TIMELINE] post-flush rubric pass failed:', err);
    }
  } catch (err) {
    console.error('[AZUL-TIMELINE] Flush failed:', err);
  }
}

/** Backstop + reaper. Flushes anything older than 2h that never made it to the
 *  DB, then frees it — the flush itself no longer deletes (see above), so this
 *  is now the ONLY thing that bounds the map. */
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [callId, entry] of timelines.entries()) {
    // Age by when the entry was OPENED, not by its first tool event: an entry
    // holding only director actions has no tool event to date it by, and the
    // old `!first → continue` left it in the map forever.
    if (entry.startedAt >= cutoff) continue;
    if (
      entry.flushedCount === entry.events.length &&
      (entry.flushedDirectorCount ?? 0) === (entry.directorActions?.length ?? 0)
    ) {
      timelines.delete(callId); // already durable — just free it
    } else {
      void flushAzulTimeline(callId).finally(() => timelines.delete(callId));
    }
  }
}, 15 * 60 * 1000).unref?.();
