/**
 * Azul scheduling agent — per-call tool timeline.
 *
 * The SD pilot needs evidence of WHAT the agent did on every call, not just
 * what was said: which appointment types it asked the rules engine about,
 * what the decisions were, which slots were offered, whether a booking
 * confirmed, what handoffs/callbacks were created. This module records one
 * event per tool call (in memory, keyed by the OpenAI callId), exposes the
 * live timeline for the SD Pilot dashboard, and flushes the finished
 * timeline onto call_logs.tool_timeline when the call ends.
 *
 * PHI discipline: we store tool names, coarse arguments (appointment type,
 * intent, reason — never DOB/phone), and outcome-relevant result fields.
 */

import { db } from '../../server/db';
import { callLogs } from '../../shared/schema';
import { eq } from 'drizzle-orm';

export interface AzulToolEvent {
  at: string;               // ISO timestamp
  tool: string;             // tool name, e.g. sage_book
  args: Record<string, unknown>;   // REDACTED subset of arguments
  outcome: Record<string, unknown>; // outcome-relevant subset of the result
  ms: number;               // tool latency
}

const timelines = new Map<string, { events: AzulToolEvent[]; callSid?: string; callLogId?: string }>();

/** Argument keys that are safe to persist per tool (everything else dropped). */
const SAFE_ARG_KEYS = new Set([
  'intent', 'eventName', 'locationId', 'providerId', 'resourceId', 'daysAhead',
  'slotDateTime', 'handoffReason', 'method', 'reasonForCall', 'requestedLocation',
  'requestedTimeframe', 'urgencyScreenResult', 'includePast', 'reason', 'name',
  'coverageType', 'healthPlan', 'medicalGroup', 'pcpName',
]);

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args ?? {}).filter(([k, v]) => SAFE_ARG_KEYS.has(k) && v != null),
  );
}

/** Pull the outcome-relevant fields out of a tool's JSON result string. */
function summarizeResult(tool: string, resultJson: string): Record<string, unknown> {
  let parsed: any;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return { unparsed: true };
  }
  const out: Record<string, unknown> = {};
  for (const k of [
    'decision', 'reason', 'booking_status', 'appointmentId', 'matchSignal',
    'callback_id', 'error', 'cancelled', 'rules_version',
    'status', 'verified', 'identityVerified', 'matchCount', 'recentSurgicalContext',
    'earliest_bookable_date', 'eligibility_due_date', 'intakeId', 'new_patient_earliest_date',
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
  return out;
}

export function recordAzulToolEvent(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  resultJson: string,
  ms: number,
  ids?: { callSid?: string; callLogId?: string },
): void {
  if (!callId) return;
  let entry = timelines.get(callId);
  if (!entry) {
    entry = { events: [] };
    timelines.set(callId, entry);
  }
  if (ids?.callSid) entry.callSid = ids.callSid;
  if (ids?.callLogId) entry.callLogId = ids.callLogId;
  entry.events.push({
    at: new Date().toISOString(),
    tool,
    args: redactArgs(args),
    outcome: summarizeResult(tool, resultJson),
    ms,
  });
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
  timelines.delete(key);
  if (!entry.callLogId && !entry.callSid) return;
  try {
    const { purpose, result } = classifyAzulCall(entry.events);
    const payload = { events: entry.events, purpose, result, toolCallCount: entry.events.length };
    if (entry.callLogId) {
      await db.update(callLogs)
        .set({ toolTimeline: payload, toolCallCount: entry.events.length })
        .where(eq(callLogs.id, entry.callLogId));
    } else if (entry.callSid) {
      await db.update(callLogs)
        .set({ toolTimeline: payload, toolCallCount: entry.events.length })
        .where(eq(callLogs.callSid, entry.callSid));
    }
    console.info(`[AZUL-TIMELINE] Flushed ${entry.events.length} tool event(s) (${purpose} → ${result})`);
  } catch (err) {
    console.error('[AZUL-TIMELINE] Flush failed:', err);
  }
}

/** Backstop: drop timelines older than 2h that never flushed. */
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [callId, entry] of timelines.entries()) {
    const first = entry.events[0];
    if (first && new Date(first.at).getTime() < cutoff) {
      void flushAzulTimeline(callId);
    }
  }
}, 15 * 60 * 1000).unref?.();
