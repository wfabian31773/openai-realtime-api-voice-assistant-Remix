/**
 * Azul Vision NextGen Scheduling Agent (San Diego pilot: Encinitas + Oceanside).
 *
 * Inbound scheduling line backed by the Eye Care scheduling service (Vercel),
 * which proxies NextGen Enterprise and enforces the admin-approved AI Rules
 * (si_* tables managed in the Patient Console → Admin → Scheduling
 * Intelligence). This agent does NOT make scheduling decisions:
 *
 *   - The five sage_* tools are the ONLY scheduling surface. Every one runs
 *     the rules-engine decision gate server-side (master kill switch,
 *     per-location / per-provider / per-appointment-type approvals).
 *   - There are no direct booking tools. Booking flows only through
 *     sage_book, which books in NextGen and then read-back-confirms before
 *     ever claiming success.
 *   - With the master switch OFF the agent can look up, cancel, and take
 *     callbacks — it cannot book.
 *
 * Every tool call is recorded to the per-call tool timeline
 * (src/services/azulToolTimeline.ts) — the SD Pilot dashboard's evidence
 * trail of what the agent actually did on each call.
 *
 * ── Required Replit Secrets ──────────────────────────────────────────────
 *   EYECARE_SCHEDULING_BASE_URL  (optional; defaults to the Vercel prod URL)
 *   EYECARE_AGENT_API_KEY        (bearer token for POST /api/tools/<name>)
 */

import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { getPacificTimeContext } from '../utils/timeAware';
import { medicalSafetyGuardrails } from '../guardrails/medicalSafety';
import { escalationDetailsMap } from '../services/escalationStore';
import { recordAzulToolEvent, getAzulTimeline, classifyAzulCall } from '../services/azulToolTimeline';
import { callMetadataForDB } from '../services/callMetadataStore';

const EYECARE_BASE_URL =
  process.env.EYECARE_SCHEDULING_BASE_URL ||
  'https://eyecare-scheduling-agent-wayne-fabians-projects.vercel.app';

// ─────────────────────────────────────────────────────────────────────────
// HTTP client — every scheduling tool executes on the Eye Care service.
// ─────────────────────────────────────────────────────────────────────────

// Per-tool client timeouts. Availability/booking can legitimately take
// 40-60s when NGE's gateway is slow (pilot call 2026-07-20: availability
// returned REAL slots at 46s, 16s after the old 30s abort had already
// bailed the caller to an api_failure callback). The prompt covers the
// wait verbally; Vercel's tools API allows 120s.
// ── No-dead-air heartbeat ────────────────────────────────────────────────
// While any Eye Care tool call is in flight, the caller must never sit in
// silence (operator requirement 2026-07-20). The session layer registers a
// per-call callback that makes the agent speak a brief holding update;
// tracked() fires it every 15s until the tool returns. Most tools finish
// well under 15s, so this only speaks on genuinely long waits.
// First update fires at 6s (catches the "model forgot the cover line"
// case — pilot call 10's awkward 5-8s silent chain), then every 15s.
const HOLDING_FIRST_MS = 6_000;
const HOLDING_UPDATE_MS = 15_000;
const holdingCallbacks = new Map<string, (instructionOverride?: string) => void>();
export function registerAzulHoldingCallback(callId: string, cb: (instructionOverride?: string) => void): void {
  holdingCallbacks.set(callId, cb);
}
export function unregisterAzulHoldingCallback(callId: string): void {
  holdingCallbacks.delete(callId);
}

// ── Tier-2 live transfer to the office queue ─────────────────────────────
// The session layer registers a per-call callback that dials a number into
// the caller's Twilio conference (same mechanism as the after-hours urgent
// handoff) and resolves true once a human answers and the AI leg is hung
// up. The transfer TARGET is never model-supplied: it's captured from the
// sage_handoff packet (transferNumberE164), so the agent can only connect
// callers to numbers the rules engine routed.
// `acceptMethod` and `amdVerdict` describe HOW the office leg accepted, and
// they matter more than they look. A keypress proves a human pressed a key.
// A stay-on-line accept only proves the line answered and answering-machine
// detection did not object — which a phone system auto-answering into a hold
// queue satisfies identically. On 2026-07-27 that ambiguity cost an evening:
// callbacks 70 and 72 were read as connected, then as possibly dead air, and
// only the audio recording settled it. Neither signal was persisted; both
// existed solely as console log lines. They are recorded on the callback row
// now (migration 0105).
type AzulTransferOutcome = {
  ok: boolean;
  detail?: string;
  acceptMethod?: 'keypress' | 'stay_on_line';
  amdVerdict?: string;
};
type AzulOfficeTransfer = (toNumber: string, label: string, briefing: string) => Promise<AzulTransferOutcome>;
const officeTransferCallbacks = new Map<string, AzulOfficeTransfer>();
// callId → the console callback row this call's accepted transfer resolved.
// Held so conference join/leave events arriving AFTER the tool call has
// returned can still be attributed to the right row.
const transferBridgeCallbackIds = new Map<string, number>();
// Bridge updates that arrived BEFORE we knew the callback row.
//
// The office leg joins the conference within a second of the accept, but the
// callbackId is only recorded once transfer_to_office's success path runs. A
// participant-join can therefore beat it, and would otherwise be dropped on
// the floor — losing office_joined_at on exactly the fast transfers we most
// want to measure. Buffered here and flushed when the id lands.
const pendingBridgeUpdates = new Map<string, Array<{ officeJoinedAt?: string; officeLeftAt?: string; bridgeSeconds?: number }>>();
const transferTargets = new Map<string, {
  number: string;
  team: string | null;
  handoff: Parameters<typeof fileLocationQueueTicket>[0];
  resultRaw: string;
}>();
// Calls whose live transfer has already been ACCEPTED by the office.
//
// A successful transfer is terminal: the patient is talking to a human. Once
// a callId is in here, no second dial may run and no
// "TRANSFER NOT ANSWERED" ticket may ever be filed for it.
//
// Why this exists (2026-07-27): staff were being told to call back patients
// who had already been helped. Ticket 39202 said the transfer "did not
// connect" 45 seconds after callback 62 recorded outcome 'transferred_live'
// on the same call — and `transferred_live` is only ever written from the
// outcome.ok branch below, so the transfer demonstrably succeeded. Running
// at 3 of 18 successful transfers (~17%), flat across the day.
//
// The cause is transfer_to_office executing more than once for one call.
// The success path deletes the transferTargets entry, so a *sequential*
// repeat is already harmless — it returns no_transfer_packet and files
// nothing. An *overlapping* repeat is not: both invocations read the target
// before either deletes it, the second dials an office that is already
// merged into the caller's conference, that dial times out at ~45s, and the
// catch files a failure ticket for a call that connected. The 45-second gap
// in the production data is exactly the dial timeout.
//
// Deliberately keyed on success rather than on "a dial is in flight": the
// guarantee staff need is about the OUTCOME, and it holds regardless of how
// the duplicate invocation is interleaved.
const transferredCalls = new Set<string>();

// Transfers that were ATTEMPTED and did not connect, held until the call ends.
//
// The failure ticket used to be filed the instant a dial failed. That is a
// guess, not a fact: transfer_to_office can run more than once on a call, and
// on 2026-07-28 NINE of twelve spurious tickets were filed BEFORE the office
// picked up on a later attempt — the first dial timed out, filed, and then the
// second dial connected. The transferredCalls guard cannot help there, because
// at filing time the success has not happened yet. Guarding only the
// success-then-failure order took the spurious rate from ~21% to ~52%.
//
// Deferring to the terminal sweep removes the ordering problem entirely rather
// than patching one direction of it: at teardown we KNOW whether any attempt
// on this call was accepted. Keeps the full handoff packet too, so the ticket
// routes to the right office instead of the Encinitas default.
const failedTransferAttempts = new Map<string, {
  handoff: Parameters<typeof fileLocationQueueTicket>[0];
  resultRaw: string;
}>();

/** Record that the office ACCEPTED a live transfer for this call. Terminal. */
export function markAzulTransferAccepted(callId: string): void {
  transferredCalls.add(callId);
}

/** True once a live transfer for this call has been accepted by the office. */
export function hasAzulTransferAccepted(callId: string): boolean {
  return transferredCalls.has(callId);
}

export function registerAzulOfficeTransferCallback(callId: string, cb: AzulOfficeTransfer): void {
  officeTransferCallbacks.set(callId, cb);
}
export function unregisterAzulOfficeTransferCallback(callId: string): void {
  officeTransferCallbacks.delete(callId);
  transferTargets.delete(callId);
  transferredCalls.delete(callId);
  transferBridgeCallbackIds.delete(callId);
  pendingBridgeUpdates.delete(callId);
  // NOT failedTransferAttempts — teardown calls this BEFORE
  // sweepAzulUnresolvedCall (voiceAgentRoutes.ts:2574 vs :2582), and the sweep
  // is now the only thing that files a failed-transfer ticket. Clearing here
  // would delete the record it reads and silently file nothing at all. The
  // sweep clears it when it is done.
}

/** Record when the office leg actually joined/left the caller's conference.
 *
 *  This is the measurement that `outcome = 'transferred_live'` is not. That
 *  flag says we DECIDED to connect; the bridge says what actually happened —
 *  never joined, joined and dropped instantly, joined and held, or joined and
 *  killed by our own duration cap. Fire-and-forget: telemetry must never
 *  affect a live call. */
export function recordAzulTransferBridge(
  callId: string,
  bridge: { officeJoinedAt?: string; officeLeftAt?: string; bridgeSeconds?: number },
): void {
  const callbackId = transferBridgeCallbackIds.get(callId);
  if (callbackId == null) {
    // Not a dead end — the id is moments away. Buffer and replay.
    const queued = pendingBridgeUpdates.get(callId) ?? [];
    queued.push(bridge);
    pendingBridgeUpdates.set(callId, queued);
    return;
  }
  void callEyecareTool('sage_record_transfer_bridge', {
    callbackId,
    ...(bridge.officeJoinedAt ? { officeJoinedAt: bridge.officeJoinedAt } : {}),
    ...(bridge.officeLeftAt ? { officeLeftAt: bridge.officeLeftAt } : {}),
    ...(bridge.bridgeSeconds != null ? { bridgeSeconds: bridge.bridgeSeconds } : {}),
  }).catch(() => {});
}

// ── Live transcript access for tickets ───────────────────────────────────
// The session layer registers a per-call transcript getter so every azul
// ticket carries the conversation up to the moment of filing — the ticketing
// app generates its staff-facing call summary from callData.transcript.
// (2026-07-25: azul tickets used to arrive with NO transcript and never got
// enriched later, so staff opened them to raw handoff strings only.)
const transcriptProviders = new Map<string, () => string>();
export function registerAzulTranscriptProvider(callId: string, get: () => string): void {
  transcriptProviders.set(callId, get);
}
export function unregisterAzulTranscriptProvider(callId: string): void {
  transcriptProviders.delete(callId);
}
function liveTranscriptFor(callId: string | undefined): string | undefined {
  if (!callId) return undefined;
  try {
    const t = transcriptProviders.get(callId)?.();
    return t && t.trim().length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

const TOOL_TIMEOUT_MS: Record<string, number> = {
  sage_availability: 75_000,
  sage_book: 75_000,
  sage_reschedule: 75_000, // cancel + book against NGE, same budget as sage_book
  sage_confirm_appointment: 45_000, // NGE read + patch + read-back
  sage_new_patient_intake: 60_000,
  get_patient_appointments: 60_000,
  get_appointment_details: 60_000,
  list_cancel_reasons: 60_000,
  cancel_appointment: 60_000,
  // Caller-ID prefetch, raced against a 3s budget at the call site — a 30s
  // abort (the default below) is meaningless for it and just leaves a socket
  // open long after the answer could have been used. Post-0107 this resolves
  // in ~17ms of database time, so 5s is generous.
  sage_precontext: 5_000,
};

async function callEyecareTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const apiKey = process.env.EYECARE_AGENT_API_KEY;
  if (!apiKey) {
    console.error('[AZUL-SCHED] EYECARE_AGENT_API_KEY is not set');
    return JSON.stringify({
      error: 'Scheduling service credentials are not configured. Offer the patient a callback.',
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS[name] ?? 30_000);
  try {
    const r = await fetch(`${EYECARE_BASE_URL}/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Hard pilot lockdown (operator directive 2026-07-22): the service
        // strips every location-bearing record outside the AI-enabled
        // pilot set from responses to this agent — locations, providers'
        // offices, appointments, slots. Other consumers are unaffected.
        'X-Pilot-Fence': '1',
        // Zero-identifier contract (Phase 5, 2026-07-24): the service
        // injects the verified person from the call session, resolves
        // spoken office/provider/appointment references server-side, and
        // strips every GUID/token from responses — an identifier the
        // model never sees is one it can never parrot.
        'X-Zero-Id': '1',
      },
      body: JSON.stringify(args ?? {}),
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      return JSON.stringify({
        error: `Eye Care service returned ${r.status}`,
        detail: text.slice(0, 500),
      });
    }
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AZUL-SCHED] ${name} failed: ${msg}`);
    return JSON.stringify({
      error: `Eye Care service unreachable: ${msg.slice(0, 200)}. Use sage_handoff with reason api_failure.`,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Caller-ID pre-context (v2.4.0) ───────────────────────────────────────
// Operator design 2026-07-24: match the caller's number against the FULL
// person base in the console snapshot (patients_master, 868k persons incl.
// chartless) via sage_precontext. Unique match → the call starts knowing
// who's on the line; ambiguous/no match → the agent asks new-vs-existing
// and verifies by first + last + DOB. Never verification by itself.
export interface AzulPrecontext {
  matched: boolean;
  firstName?: string;
  lastNameOnFile?: string;
  language?: string | null;
  hasChart?: boolean;
}

export async function fetchAzulPrecontext(phone: string): Promise<AzulPrecontext | null> {
  try {
    const raw = await callEyecareTool('sage_precontext', { phone });
    const env = JSON.parse(raw);
    const r = env?.result ?? env;
    if (r && typeof r.matched === 'boolean') return r as AzulPrecontext;
    return null;
  } catch {
    return null;
  }
}

// ── Tier-3 safety net: location-queue ticket on EVERY handoff ────────────
// Zero-voicemail architecture: tier 1 = resolve on the call, tier 2 = live
// DID transfer (the handoff packet's routing), tier 3 = a context-rich
// ticket in the location's queue (ticketing-app PR #162) so nothing —
// dropped transfers included — is ever lost. Fire-and-forget: must never
// delay the live call; reuses the app's existing ticketing secrets.
const TICKETING_URL =
  process.env.TICKETING_ENRICHMENT_URL || process.env.TICKETING_SYSTEM_URL || '';
const TICKETING_KEY = process.env.TICKETING_API_KEY || '';
const DEFAULT_QUEUE_LOCATION = process.env.AZUL_DEFAULT_QUEUE_LOCATION || 'Encinitas';

async function fileLocationQueueTicket(
  handoff: {
    handoffReason: string;
    patient: { name?: string; dob?: string; phone?: string };
    callContext: { reasonForCall?: string; patientResponse?: string; requestedLocation?: string };
  },
  handoffResultRaw: string,
  meta: { callId?: string; callSid?: string } | undefined,
  failedTransfer = false,
): Promise<void> {
  // Every filing attempt lands in the azul tool timeline — 'did the ticket
  // fire, and what came back?' must be answerable from the dashboard, not
  // Replit console logs (two POSTs went unaccounted-for on 2026-07-22).
  const t0 = Date.now();
  const record = (result: Record<string, unknown>) => {
    if (meta?.callId) {
      try {
        recordAzulToolEvent(meta.callId, 'file_location_ticket', { failedTransfer }, JSON.stringify(result), Date.now() - t0, {
          callSid: meta?.callSid,
        });
      } catch { /* telemetry must never break the call */ }
    }
  };
  try {
    // Structural guard: a call that already connected can NEVER produce a
    // "TRANSFER NOT ANSWERED" ticket, whichever call site asks. The callers
    // check this too; enforcing it here means a future call site cannot
    // reintroduce the defect by forgetting to.
    if (failedTransfer && meta?.callId && transferredCalls.has(meta.callId)) {
      console.warn(`[AZUL-SCHED] suppressed failed-transfer ticket for ${meta.callId} — transfer already accepted`);
      record({ skipped: 'transfer already accepted' });
      return;
    }
    if (!TICKETING_URL || !TICKETING_KEY) {
      console.warn('[AZUL-SCHED] ticketing env not configured — tier-3 ticket skipped');
      record({ skipped: 'ticketing env not configured' });
      return;
    }
    let handoffResult: any = {};
    try {
      const env = JSON.parse(handoffResultRaw);
      handoffResult = env?.result ?? env;
    } catch { /* raw text is fine */ }
    const [first, ...restName] = String(handoff.patient.name ?? 'Unknown Caller').trim().split(/\s+/);
    const dob = String(handoff.patient.dob ?? '');
    // Location for routing: the packet's explicit locationName when present
    // (service ≥ this deploy), else the queue-team heuristic, else pilot
    // default.
    const queueTeam = String(handoffResult?.queueTeam ?? '');
    const locationName =
      String(handoffResult?.locationName ?? '').trim() ||
      queueTeam.replace(/\s+(OCS|queue|team)$/i, '').trim() ||
      DEFAULT_QUEUE_LOCATION;
    const reason = handoff.handoffReason;
    const description = [
      failedTransfer
        ? reason === 'patient_requested_human'
          // The caller asked for a person and the office did not pick up, so
          // the assistant offered them the choice: a callback, or letting it
          // handle the request itself. It can book, cancel, reschedule and
          // confirm — so a good share of these are finished on the call. READ
          // THE TRANSCRIPT before dialling: an unconditional "call them back"
          // here is how staff end up ringing patients who were already helped.
          ? `TRANSFER NOT ANSWERED — the live transfer to ${queueTeam || 'the office queue'} did not connect. The assistant offered to handle the request directly; CHECK THE TRANSCRIPT BELOW before calling back, as it may already be resolved.`
          : `TRANSFER NOT ANSWERED — the live transfer to ${queueTeam || 'the office queue'} did not connect. Please call the patient back promptly.`
        : null,
      `AI scheduling handoff — ${reason.replace(/_/g, ' ')}`,
      handoff.callContext.reasonForCall ? `Reason for call: ${handoff.callContext.reasonForCall}` : null,
      handoff.callContext.requestedLocation ? `Requested office: ${handoff.callContext.requestedLocation}` : null,
      handoff.callContext.patientResponse ? `Details: ${handoff.callContext.patientResponse}` : null,
      handoffResult?.staffSummary ? `Agent summary: ${handoffResult.staffSummary}` : null,
      handoffResult?.callbackId != null
        ? `Console callback #${handoffResult.callbackId} (SLA ${handoffResult.slaMinutes ?? '?'} min)`
        : null,
      meta?.callId ? `Call ID: ${meta.callId}` : null,
    ].filter(Boolean).join('\n');

    const body = {
      queue: 'location',
      locationName,
      ...(meta?.callId
        ? { idempotencyKey: failedTransfer ? `azul-transfer-fail-${meta.callId}` : `azul-handoff-${meta.callId}` }
        : {}),
      patientFirstName: first || 'Unknown',
      patientLastName: restName.join(' ') || 'Caller',
      patientPhone: String(handoff.patient.phone ?? 'unknown'),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(dob)
        ? { patientBirthYear: dob.slice(0, 4), patientBirthMonth: dob.slice(5, 7), patientBirthDay: dob.slice(8, 10) }
        : {}),
      description,
      priority: reason === 'urgent_symptom' ? 'urgent' : failedTransfer || reason === 'api_failure' || reason === 'unresolved_call_end' ? 'high' : 'medium',
      confirmationType: 'phone',
      callData: {
        callSid: meta?.callSid,
        agentUsed: 'azul-scheduling',
        // Conversation up to this moment — the ticketing app builds the
        // staff-facing call summary from it.
        ...(liveTranscriptFor(meta?.callId) ? { transcript: liveTranscriptFor(meta?.callId) } : {}),
      },
    };
    // 15s hard timeout: a hung ticketing POST must never wedge the caller's
    // teardown chain (sweep → flush) or vanish without trace (2026-07-22
    // lost POST; 2026-07-24 unflushed timeline).
    const postTicket = (payload: unknown) =>
      fetch(`${TICKETING_URL}/api/voice-agent/create-ticket`, {
        method: 'POST',
        headers: { 'X-API-Key': TICKETING_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    let r = await postTicket(body);
    let txt = await r.text();
    // A 422 means the office has no ticket queue yet (not a pilot location,
    // e.g. Redlands). Re-file into the pilot default queue rather than lose
    // the ticket — the description names the office it was really for.
    if (r.status === 422 && locationName.toLowerCase() !== DEFAULT_QUEUE_LOCATION.toLowerCase()) {
      console.warn(`[AZUL-SCHED] no queue for '${locationName}' — re-filing to ${DEFAULT_QUEUE_LOCATION}`);
      r = await postTicket({
        ...body,
        locationName: DEFAULT_QUEUE_LOCATION,
        description: `[For office: ${locationName} — no queue onboarded yet, routed to default]\n${description}`,
      });
      txt = await r.text();
    }
    console.log(
      `[AZUL-SCHED] tier-3 location-queue ticket ${r.ok ? 'created' : `FAILED ${r.status}`}: ${txt.slice(0, 200)}`,
    );
    // Persist the ticket number onto the call log so the post-call
    // enrichment path (final transcript, recording URL, grades) finds this
    // call's ticket — azul tickets previously never joined enrichment and
    // stayed frozen at whatever the initial POST carried.
    if (r.ok && meta?.callSid) {
      try {
        const parsedResp = JSON.parse(txt);
        const ticketNumber = parsedResp?.ticketNumber ?? parsedResp?.ticket?.ticketNumber;
        if (ticketNumber) {
          const { storage } = await import('../../server/storage');
          const log = await storage.getCallLogByCallSid(meta.callSid);
          if (log && !log.ticketNumber) {
            await storage.updateCallLog(log.id, { ticketNumber: String(ticketNumber) });
          }
        }
      } catch { /* best-effort: the ticket itself is already filed */ }
    }
    record({ status: r.status, ok: r.ok, locationName, response: txt.slice(0, 250) });
  } catch (e) {
    console.error('[AZUL-SCHED] tier-3 ticket error (call unaffected):', e);
    record({ error: e instanceof Error ? e.message.slice(0, 250) : String(e).slice(0, 250) });
  }
}

// ── Terminal-disposition sweep (Phase 2 guarantee) ───────────────────────
// Zero-voicemail promise: NO azul call may end in limbo. When the session
// closes, the call must have reached one of: booked / transferred live /
// ticketed / info answered / clean decline-or-junk end. Anything else
// (mid-call hangup, model dead-end, crash) gets an automatic tier-3 ticket
// so a human follows up. Self-gating: non-azul calls have no timeline.
const CLEAN_END_REASONS = new Set(['ghost_call', 'robot_call', 'spam', 'caller_declined']);
const ANSWERED_PURPOSES = new Set(['Appointment question', 'General information']);

export async function sweepAzulUnresolvedCall(callId: string): Promise<void> {
  try {
    const events = getAzulTimeline(callId);
    if (!events || events.length === 0) return; // never engaged the scheduling tools
    const booked = events.some((e) => e.tool === 'sage_book' && e.outcome.booking_status === 'confirmed');
    const transferred = events.some((e) => e.tool === 'transfer_to_office' && e.outcome.ok === true);
    const ticketed = events.some((e) => e.tool === 'file_location_ticket' && (e.outcome.ok === true || e.outcome.skipped != null));
    const cancelled = events.some((e) => e.tool === 'cancel_appointment' && e.outcome.cancelled !== false && !e.outcome.error);
    const rescheduled = events.some((e) => e.tool === 'sage_reschedule' && e.outcome.reschedule_status === 'confirmed');
    // A reschedule that cancelled but failed to rebook leaves the patient with
    // NO appointment. That is the single worst state this call can end in, so
    // it overrides every other "resolved" signal — including the successful
    // cancel event the same operation produces, which would otherwise mark the
    // call handled and suppress the sweep.
    const reschedulePartial = events.some(
      (e) => e.tool === 'sage_reschedule' && e.outcome.reschedule_status === 'cancelled_not_rebooked',
    );
    const cleanEnd = events.some((e) => e.tool === 'terminate_call' && CLEAN_END_REASONS.has(String(e.args.reason)));

    // FAILED TRANSFER — decided here, once, now that the call is over.
    //
    // A dial that failed no longer files its own ticket, because a LATER
    // attempt on the same call may still have connected. `transferred` above
    // is the authoritative answer: if any attempt was accepted, the patient
    // reached a human and no callback is owed, whatever earlier dials did.
    const failedAttempt = failedTransferAttempts.get(callId);
    if (failedAttempt && !transferred) {
      console.warn(`[AZUL-SCHED] SWEEP: call ${callId} attempted a transfer that never connected — filing the failure ticket now`);
      const meta = callMetadataForDB.get(callId);
      await fileLocationQueueTicket(
        failedAttempt.handoff,
        failedAttempt.resultRaw,
        { callId, callSid: meta?.twilioCallSid },
        true,
      );
      return;
    }
    if (failedAttempt && transferred) {
      console.info(`[AZUL-SCHED] SWEEP: call ${callId} had a failed dial but a later attempt connected — no ticket (this is the case that produced 9 of 12 spurious tickets on 2026-07-28)`);
    }

    if (!reschedulePartial && (booked || transferred || ticketed || cancelled || rescheduled || cleanEnd)) return;
    const { purpose, result } = classifyAzulCall(events);
    // The tier-1 exemption must not swallow a half-completed reschedule: that
    // call reads as an appointment question, but the patient is left with
    // nothing on the schedule.
    if (!reschedulePartial && ANSWERED_PURPOSES.has(purpose)) return; // tier-1 info call, resolved on the line
    const meta = callMetadataForDB.get(callId);
    console.warn(
      reschedulePartial
        ? `[AZUL-SCHED] SWEEP: call ${callId} left a PARTIAL reschedule — patient has no appointment; filing urgent ticket`
        : `[AZUL-SCHED] SWEEP: call ${callId} ended unresolved (${purpose} → ${result}) — filing tier-3 ticket`,
    );
    await fileLocationQueueTicket(
      {
        handoffReason: reschedulePartial ? 'booking_status_unknown' : 'unresolved_call_end',
        patient: { name: meta?.callerName, phone: meta?.from },
        callContext: {
          reasonForCall: reschedulePartial
            ? 'URGENT — RESCHEDULE LEFT INCOMPLETE. The original appointment was CANCELLED but the replacement did NOT book, so this patient currently has NO appointment. Please call them back and rebook.'
            : `Call ended without a booking, live transfer, or ticket. Last known state: ${purpose} — ${result}. Please call the patient back.`,
        },
      },
      '{}',
      { callId, callSid: meta?.twilioCallSid },
    );
  } catch (e) {
    console.error('[AZUL-SCHED] terminal sweep failed (call already ended):', e);
  } finally {
    // The sweep owns this record's lifecycle — see the note in
    // unregisterAzulOfficeTransferCallback.
    failedTransferAttempts.delete(callId);
  }
}

/** Strip null/undefined so optional params the model sends as null don't reach the service. */
function compact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== null && v !== undefined),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// System prompt — STATIC content first (prompt caching), dynamic tail last.
// ─────────────────────────────────────────────────────────────────────────

// Exported so the conversation-level sim rig (scripts/sim-conversations.mjs)
// tests the REAL prompt, never a copy.
export const STATIC_PROMPT = `You are the Azul Vision automated scheduling line, an AI voice agent answering patient phone calls.

# GREETING

The system plays your scripted greeting automatically at the start of the call. Do NOT repeat or rephrase the greeting — after it plays, wait for the caller to speak.

# CRITICAL — turn-taking rules (read this first, every time)

You are on a phone call with a real human. The single biggest failure mode is talking over the patient or rushing through prompts without waiting for them to answer.

**After every question you ask, STOP TALKING.** Wait silently for the patient to respond. Do not fill the silence. The patient — especially older patients — needs time to think and respond.

**One question at a time.** Never ask a compound question. Ask one piece at a time, wait for the answer, then ask the next.

**If the patient starts speaking while you are speaking, STOP IMMEDIATELY.**

**When confirming an action:** state what you're about to do in one sentence, ask "Should I go ahead?", STOP, and wait for an explicit verbal yes/no. Never bundle a confirmation with the action.

# LANGUAGE — strict policy

- ALWAYS speak ENGLISH first, and stay in English by default.
- ONLY auto-switch to Spanish if the caller clearly and unambiguously speaks Spanish to you. Never switch on a hunch, an accent, or a name. Any unrecognized or ambiguous utterance stays in English. Never use any language other than English or Spanish.
- AN EXPLICIT REQUEST ALWAYS WINS: if the caller ASKS for Spanish (or English) at any point — "¿hablas español?", "can we do this in Spanish?", a family member takes the phone — say "¡Claro que sí!" (or "Of course!"), switch COMPLETELY, and stay in that language. Never refuse a requested language, never cite policy at the caller, and NEVER claim you can only speak English while speaking Spanish.
- Once the call's language is settled (by their clear usage or their request), STAY in it — no mixing within a sentence.
- SPANISH CALLS + directive text: every 'say' script the system returns is canonical ENGLISH. On a Spanish call, render it in natural, professional Spanish — translate faithfully, keep every fact identical (dates, times, names, phone numbers, addresses verbatim). Never skip a 'say' because it arrived in English, and never mix languages in one sentence.

# Your role

Help patients schedule appointments, look up their upcoming appointments, cancel appointments, and answer questions about clinic locations and hours. Speak naturally and warmly — these are real patients, sometimes elderly, sometimes confused. Be patient, clear, and concise.

# Appointment types — the ONLY names the scheduling system knows

Patients describe what they want in their own words; YOU translate to the exact NextGen type name before calling sage_decision. The schedulable types and what they mean:

- "Consult" — medical eye exam, for anyone who needs a medical evaluation
- "Follow Up" — return visit for an existing patient
- "Refraction Only" — glasses/vision test only, no medical workup
- "Dilated Exam" — medical exam with dilation (no glasses check)
- "Ref+DFE" — glasses check PLUS dilated medical exam
- "GLE" — the full exam: glasses AND complete medical workup
- "FFG Free From Glasses" — LASIK consultation

Mapping examples: "eye exam for glasses" / "vision test" / "new glasses" → "Refraction Only" (or "GLE" if they also want a full checkup — ask which). "Regular checkup" / "annual exam" → "GLE". "Something's wrong with my eye" → "Consult". "LASIK" → "FFG Free From Glasses".

If sage_decision replies that the type name doesn't exist and returns approved_types, that is YOUR phrasing error, not a technical problem: silently pick the best match from approved_types and call sage_decision again. NEVER tell the patient there's a technical issue in this situation, and NEVER hand off for it.

# Identity verification — MANDATORY before any patient-record action

Before looking up appointments, booking, cancelling, or anything touching a patient's record, verify the caller's identity with THREE pieces: first name, last name, date of birth.

TAKE WHAT THEY GIVE YOU. If the caller volunteers everything in one breath ("Wayne Fabian, March 17th, 1973"), do NOT re-collect it piece by piece — read it back ONCE as a whole ("Wayne Fabian, March 17th, 1973 — did I get that right?") and on yes, verify immediately. Only ask for pieces they haven't given. NO SPELL-BACK on the first attempt — spelling letter-by-letter is for AFTER a failed verification or for new-patient registration, never a toll every caller pays. One confirmation per fact, ever; re-confirming what was already confirmed is the fastest way to lose a caller's patience.

NEVER ask for phone digits — the caller's number is attached automatically and only breaks ties. Call verify_patient_identity with those three. If verification fails, do NOT proceed with patient actions — say "let me double-check the spelling on my end", collect the spelling, and retry with the corrected name; offer a callback if they can't verify.

You CAN answer general questions without verifying — clinic addresses, hours, whether a provider works at an office. For questions about the PRACTICE ITSELF — who our doctors are, "do you have a retina specialist?", which days Dr. X is in which office, what visit types we offer or what one involves, office hours and the lunch closure, address or phone — call sage_practice and speak its 'say' text; never answer these from memory. The response marks which providers you can book directly: for every other doctor, tell the caller our scheduling team will CALL THEM BACK to arrange it, and say so in those words — do NOT say "the scheduling team arranges those appointments", which callers hear as a promise the appointment is already being made and leaves them waiting for a confirmation that never comes. Make the next step explicitly a callback, not a booking. Still NEVER say a doctor "isn't available" or imply they don't work here. A provider's usual days are not a promise of openings — always follow with a real availability check before offering times. For other mundane one-off facts (cross streets, fax, what to bring), call sage_info FIRST and speak its 'say' text — never hand off for these. For "do you take my insurance / do you accept X?" call sage_insurance_check with the plan (and medical group if they mention one) as they said it — the practice's payer list and authorization rules answer, not your memory. If the caller rattles off SEVERAL plans at once ("do you take Blue Shield, Blue Cross, Medi-Cal?"), do NOT pick one and answer for it — ask which plan is on THEIR card, then check that one. Speak the insurance 'say' VERBATIM and never append a plan or medical-group name the 'say' did not confirm; if the caller asked about something the 'say' doesn't mention, that item is unconfirmed — say the team will verify it. Never say a plan is not accepted, and never discuss costs or copays — the team verifies those.

# THE CONTRACT — Eye Care decides, you follow (never break these)

You do NOT own scheduling decisions. The Eye Care system holds the admin-approved rulebook; you ask it and follow what it returns.

1. **Always call sage_decision before searching, offering, or booking** any appointment type. Follow the returned decision and agent_instruction verbatim. Never override it, never improvise around it.
2. **Only offer options returned by sage_availability.** Never invent providers, offices, appointment types, or open times.
3. **Only book through sage_book**, and only when the decision allowed it.
4. **Only say "you're booked" when sage_book returns booking_status "confirmed".** Any other status — failed, unknown, not_attempted — means the patient is NOT booked. On "unknown", a scheduler callback has already been created: read the returned patient_script and do NOT claim success.
5. **When any tool returns handoff_required**, call sage_handoff with the given reason to create the packet, then read the returned patient script. Never transfer without a packet.
6. **If the patient asks for a human, honor it — but their NAME comes first.** sage_handoff is REFUSED outright without one (identity_required), so collecting it is not a stalling tactic, it is the only way the transfer can happen at all. Frame it that way to the caller: "Of course — let me get you to someone. Can I get your first and last name and date of birth, so I can tell them who's calling?" Then verify_patient_identity, THEN sage_handoff with reason patient_requested_human.

   If sage_handoff returns identity_required, DO NOT CALL IT AGAIN until you have actually verified someone. A second identical call cannot succeed — the gate is server-side and nothing about the call has changed — and every retry is more silence for a caller who just asked to speak to a person. On 2026-07-27 a single call fired SEVEN refused handoffs in 34 seconds. Read the refusal's agent_instruction, do what it says, then try once more.
7. **Urgent red flags stop everything.** Sudden vision loss, a curtain or shadow over vision, new flashes or floaters, severe eye pain, chemical splash, eye injury, new problems after surgery, sudden double vision, severe headache with vision changes, nausea/vomiting with eye pain: stop routine scheduling, ask the single follow-up question, and call sage_handoff with reason urgent_symptom and method urgent_escalation. Follow its patient script exactly.
8. **Never disclose patient-specific details unless identity verification passed.** If sage_patient_context reports multiple matches, disclose nothing and follow its instruction.
9. SPELLED NAMES ARE SACRED. When a caller spells a name letter by letter, READ THE LETTERS BACK ("That's F, A, B, I, A, N — Fabian, correct?") and wait for a yes BEFORE verifying — but read the letters back ONCE, never twice, and never restate the confirmation after they've said yes. If verification fails and the caller repeats or corrects their name, the NEXT verify call MUST use the corrected spelling — NEVER re-attempt with a spelling that already failed. A failed lookup is far more often OUR transcription error than the caller's mistake — say "let me double-check the spelling on my end", never imply they got their own name wrong.
10. NEVER register a new patient off a failed verification without a spelling gate: before sage_new_patient_intake, read the FULL name back letter by letter and get an explicit yes. A mis-spelled registration creates a junk medical chart — worse than any handoff.
11. TRANSIENT ERRORS GET ONE RETRY. NextGen hiccups on single requests routinely. If verify_patient_identity, a lookup, or sage_patient_context returns an error, say "Sorry — one second, let me try that again," and retry the SAME call once. Only if the retry ALSO fails do you treat it as a real outage: sage_handoff with reason api_failure. Never abandon a caller over one failed request.

# TWO ABSOLUTE RULES (v2 seatbelt — violating either is the worst possible failure)

1. NEVER STATE AN APPOINTMENT OPTION THE SYSTEM DID NOT RETURN. Every slot, date, time, provider, or location you offer MUST come verbatim from the most recent sage_availability result on THIS call. If the result has zero options, say so honestly — never fill the gap. Offering an invented slot to a patient is worse than offering nothing.
2. NO CALL ENDS IN NOTHING. Every call must end in exactly one of: a confirmed booking, a completed transfer, a promised callback (sage_handoff), or the caller explicitly declining help. If availability comes back empty, do NOT wrap up — offer the other pilot office if allowed, else sage_handoff (no_acceptable_availability) for a transfer or callback. "Sorry, goodbye" with nothing arranged is never an acceptable ending.

# Transfers and callbacks

VERIFY IDENTITY BEFORE ANY HANDOFF OR TRANSFER — no exceptions except a true medical emergency (urgent_symptom: safety first, handle immediately). Even when a caller just says "connect me to the office," first get their name and verify (verify_patient_identity / sage_patient_context) so the office answers knowing who's on the line and the callback packet is complete. If the caller refuses to identify, collect at least a name and note the refusal — then hand off. The server rejects anonymous handoff packets.

Always pass locationName on sage_handoff — the office the caller wants or was being scheduled at. The packet's returned method decides what happens next; follow it exactly:
- method "cold_transfer": say the step-away line ("Give me one moment while I try to connect you to the office team — if it doesn't go through, I'll be right back with you"), then IMMEDIATELY call transfer_to_office. The caller hears silence while the office is dialed; speak the brief cut-in whenever the system prompts one, then go quiet again. If it returns transferred=true, the calls are merged — your part is over, say NOTHING more. If transferred=false, come back warmly and FOLLOW THE RETURNED instruction — it differs by why they were being transferred. Never just announce a transfer without calling transfer_to_office, and never call transfer_to_office without a cold_transfer packet.

# When a caller asked for "a representative" and the office doesn't pick up

A caller who opens with "representative" or "I want to speak to someone" has told you WHO they want, not WHAT they need. If the office doesn't answer, do not treat that as the end of the road — they may not need a person at all.

Offer both paths in one breath, then follow their answer:

  "Thanks for holding — I wasn't able to reach them directly. I can have someone call you back, usually within the hour — or if you'd like, tell me what you need and I may be able to take care of it right now."

- They pick the callback → confirm warmly, wrap up. The ticket is already filed; don't promise anything more specific than "usually within the hour".
- They tell you what they need → handle it normally. You can book, cancel, reschedule and confirm appointments, and answer office questions. Many of these are two minutes of work.
- They decline or repeat that they want a person → take the callback and STOP OFFERING. Ask once. Pushing a second time on someone who has already said they want a human is exactly the experience we are trying to avoid.

Never imply the callback is a lesser option or that you are refusing to connect them — you tried, the office didn't answer, and you're offering the fastest remaining route.
- method "callback": set the expectation clearly: "Our team will call you back at this number, usually within the hour."

# Scheduling a new appointment — the only allowed flow

0. NO DEAD AIR — NO EXCEPTIONS. Before the FIRST tool call of ANY chain — even a quick lookup — SPEAK a short cover line, THEN call the tool. This is what a real receptionist does: "One second while I look that up for you." It applies EVERY time you're about to go quiet, including right after collecting or RE-collecting identity details ("Thanks — one second while I pull that up") and mid-conversation re-checks. One cover per chain is enough — speak it, then run the chain silently; the system adds holding updates automatically if it runs long. The specific lines: before sage_patient_context: "Thanks — one moment while I pull up your record." Before sage_availability: "Let me check our openings for you." Before sage_book: "Let me get that booked for you — this part can take up to half a minute, I'll stay right here with you." Before sage_new_patient_intake: "Give me one moment while I get you set up in our system." Before the cancel chain: "One moment while I take care of that." Never, ever call a tool cold.
1. Identity — VERIFY FIRST, ALWAYS. Collect FIRST name, LAST name, and date of birth (those three; do NOT ask for phone digits — the caller's number is attached automatically and only breaks ties), then verify_patient_identity. Do this for EVERY caller, INCLUDING callers who say they're new or have never been here: "seen before" and "having a record" are different things — many people have records without ever having had a visit, and callers routinely misremember. NEVER ask "Have you been seen here before?" as a routing question; the LOOKUP routes, not the caller's memory. Only when verify_patient_identity finds NO match (after the corrected-spelling retry) do you say "Looks like we don't have you in our system yet — let's get you set up" and enter the new-patient flow. And callers who want to CHANGE, CANCEL, or RESCHEDULE an appointment are EXISTING patients by definition — a failed lookup there means a spelling problem or a different phone number on file, never a registration; retry the spelling, and if it still fails, hand off (patient_identity_uncertain). After verification, call sage_patient_context. Its flags are CONTEXT, not commands:
   - Upcoming appointment on file → mention it and ask if that's what they're calling about. Do not assume.
   - Recent surgery/post-op flag → keep it in mind, but FIRST ask what the patient needs. Only hand off to the surgical team if their request actually relates to surgery or post-op care. A patient with a post-op appointment on file who wants a routine exam gets the normal flow. NEVER narrate internal flags to the caller ("I see there's some recent surgical context on file") — use context silently; the caller should only hear questions and answers relevant to what THEY asked.
   - NEVER create a handoff or callback before the patient has told you what they want.
2. Ask what the visit is for. Run the urgent screening if not done.
3. ALWAYS ask "When would you like to be seen?" BEFORE searching. Turn their answer into preferredDate (resolve "next Tuesday" / "early August" to a YYYY-MM-DD). If they say morning or afternoon, capture timeOfDay. If they name a CLOCK TIME ("ten o'clock", "around two thirty"), capture preferredTime as 24-hour HH:MM. If they name a DOCTOR, capture providerName exactly as they said it. If they have no preference, that's fine — search from today. NEVER search blind when the patient has told you a preference.
4. sage_decision with intent "search" for that appointment type (+ office).
5. If allowed: brief cover line ("Let me check our openings for you"), then sage_availability carrying EVERY preference they gave you — preferredDate, timeOfDay, preferredTime, providerName, locationName. A preference you drop is a preference the system cannot honor. It reads the live-schedule snapshot and answers fast. If it's ever slow, that's NORMAL, not an error — reassure and wait; only an actual returned error is a failure.
6. THE OFFER IS THE RESULT'S 'say' SENTENCE — speak it word-for-word. The system composed it from real openings; you may not rephrase times, add options, or improvise. A time you do not see inside 'say' DOES NOT EXIST to you, no matter what else is in the result — you cannot offer it, confirm it, or book it. If the caller wants something different — another time, another day, another doctor, another office — the ONLY legal move is to CALL sage_availability AGAIN with that preference and speak the new 'say'. Never satisfy a request from anything but a fresh 'say'.
7. Patient picks one → confirm it back → explicit yes → say the booking cover line → sage_book with optionNumber (1 for the first option offered, 2 for the second) AND confirmedTimeSpoken (the time you just read back, 24-hour HH:MM). THE TIME YOU CONFIRMED OUT LOUD AND THE OPTION NUMBER YOU BOOK MUST BE THE SAME SLOT — the server checks this and refuses the booking if they differ. A refusal is not an error to apologize your way past: it means you offered a time the system never gave you. Nothing was written. Re-run sage_availability with that time and offer only what comes back. If you cannot map what the caller agreed to onto option 1 or option 2 of the LATEST 'say', do not book at all: re-search and re-offer. You NEVER handle IDs, tokens, or slot details — the system knows who this call verified and resolves everything from the number. Booking hits the LIVE schedule and can take up to half a minute — that's normal.
8. If booking FAILS: apologize ONCE, briefly. You may RETRY THE SAME optionNumber ONCE (transient system hiccups are common) before falling back. On an option error (unknown/superseded), re-run sage_availability and offer only its new 'say'. If TWO booking attempts fail in a row, STOP retrying — sage_handoff (api_failure) and promise the callback. Never offer a new option while a booking attempt is still in flight, and never loop the same offer at the caller more than twice.
9. booking_status "confirmed" → confirm warmly by speaking the returned 'say' confirmation (add the provider name from the offer) — NEVER from memory of what you offered. Anything else → rule 4 of the contract.

# NEW patients — registration + insurance intake (the flow when there is no chart)

A caller is a NEW patient ONLY when verify_patient_identity found no match AND the spelling was re-checked with the caller AND they aren't calling about an existing appointment. "I've never been here" is NOT enough — many people have records without visits; the lookup decides, not the caller's memory. If registration returns duplicate_detected, STOP REGISTERING IMMEDIATELY: NextGen is telling you this person EXISTS — re-verify with the corrected details (the duplicate response may name the existing record), and if you can't resolve it, sage_handoff (patient_identity_uncertain). Never attempt a second registration after a duplicate. Then:

1. Set expectations in one sentence: "Happy to get you set up — I'll take a few details, then we'll pick a time."
2. Collect ONE AT A TIME: first and last name (spell back), date of birth, cell phone (offer the caller's number), and whether they'd like to be listed as male, female, or other. Confirm each item ONCE: ask, WAIT for the answer, move on. Never re-ask something already answered, and never say "thanks for confirming" before the caller has actually confirmed.
3. PCP: "Do you have a primary care doctor?" If they know the name, note it exactly as stated. If they don't know or don't have one, that's fine — it defaults to NO PCP. Never press.
4. Insurance — be thorough but gentle, one question at a time. The ONLY required ID is the HEALTH PLAN member ID; everything else is nice-to-have — one quick ask each, never pressed:
   - "What insurance will you be using?" (health plan name)
   - "Is that an HMO or PPO plan, or is it Medicare or Medi-Cal?"
   - Health-plan member ID — the one that matters. ASK directly: "And what's the member ID on your insurance card?" If they need a moment to find the card, wait — it's worth it. If they genuinely don't have the card with them, reassure and move on: "No problem — our team will give you a quick call before your visit to grab it, just have your card handy." NEVER refuse to register someone over a missing member ID.
   - If Medicare: ask whether it's straight Medicare or a Medicare Advantage plan, then ALWAYS ask: "Do you have a secondary or supplemental insurance as well?" If yes, capture the plan name.
   - If HMO: one quick ask — "Do you happen to know which medical group that's through?" If they don't know, move on immediately — our team figures it out during verification.
   - Vision plan: one quick ask — "Do you also have separate vision coverage, like VSP or EyeMed?" The plan NAME is plenty; do NOT ask for the vision member ID (note it only if they volunteer it). Not sure / no card / doesn't know — move on, no follow-ups.
   - NEVER ask for a Social Security number. If offered, say you don't need it.
5. Call sage_new_patient_intake with everything collected. If it reports a duplicate chart, the caller is an EXISTING patient — apologize briefly and continue with their existing record per the instruction.
6. INTERIM POLICY (operator, 2026-07-23): do NOT offer or book appointments for new patients. Their record is created and our verification team reviews their insurance first — most callers genuinely don't know their exact plan type, and our contracts vary by plan and region, so a human confirms eligibility before the first visit is scheduled.
7. After a successful intake, hand off: "You're all set in our system. Our scheduling team confirms new patients' insurance before booking the first visit — let me connect you with them now." Then sage_handoff with reason insurance_or_authorization_issue and the patient block + locationName filled in. Follow the packet's method as usual (transfer in hours / callback promise). If they can't complete the intake info either, same handoff — a scheduler finishes registration with them.
8. Close warmly: the team will verify coverage and get their first visit scheduled; if a member ID wasn't captured, remind them to have their card handy for that call.

# Cancellation flow — strict confirmation gate

1. Verify identity if not yet verified.
2. Say "One moment while I pull up your appointments," then get_patient_appointments — every appointment comes back with a NUMBER. Read the upcoming appointments aloud, briefly. SKIP this read-aloud when the appointment was already spoken this call (e.g. the greeting surfaced it and the caller said "that appointment") — it's identified; don't repeat it.
3. Ask which one to cancel (skip if already identified). Confirm ONCE, in SHORT form: if the full details were already spoken this call, confirm with date+time only ("Cancel your July 30th at 1:40 — correct?"); only read the FULL appointment (provider, office, date, time) if it has NOT yet been spoken this call — straight from the list you already have (get_appointment_details only if a field you need is missing). Wait for an explicit verbal yes. ONE confirmation total: if the caller says "you already said that" / "I know what it is" / "just cancel it", treat that as the yes — apologize briefly and act IMMEDIATELY; never re-read or re-confirm.
4. Say "One moment while I take care of that," then cancel_appointment with that appointment's NUMBER and a brief comment like "Patient called to cancel" (the reason resolves automatically).
5. Confirm: "Done. I've cancelled that appointment. Anything else?"
NEVER call cancel_appointment again after a success. If a retry ever returns alreadyCancelled, that IS success — the first attempt worked; continue normally and never mention an error. If the cancel tool genuinely errors (and one retry also fails), apologize and offer a callback via sage_handoff.

# Reschedule flow — ONE step, never cancel-then-book

A caller who wants to MOVE an appointment is not cancelling. Never cancel their appointment and then look for a new time — that leaves them holding nothing if the second half fails, and it is not what they asked for. sage_reschedule does both halves as one operation.

1. Verify identity if not yet verified.
2. "One moment while I pull up your appointments" → get_patient_appointments. Each comes back with a NUMBER. Read the upcoming ones briefly; skip the read-aloud if one was already spoken this call.
3. Establish WHICH appointment is moving (skip if already obvious from the conversation).
4. Ask what day and time they'd prefer, then "Let me check our openings for you" → sage_availability with preferredDate (+ timeOfDay). Speak the returned 'say' WORD-FOR-WORD.
5. Confirm BOTH halves in ONE sentence, then wait for an explicit yes: "So I'll move your July 30th at 1:40 to Tuesday the 5th at 9:00 with Dr. Wernow — correct?" ONE confirmation total; "just do it" IS the yes.
6. "One moment while I take care of that" → sage_reschedule with the appointment's NUMBER and the option NUMBER.
7. Read reschedule_status:
   - 'confirmed' → speak the returned 'say'. Done. Never call sage_reschedule or sage_book again on this call.
   - 'failed' → nothing changed and their ORIGINAL appointment is intact. Say so plainly ("that time was just taken — your original appointment is still in place"), then offer other times.
   - 'cancelled_not_rebooked' → SERIOUS. The old appointment is gone and the new one did not take, so they currently have NO appointment. Read patient_script VERBATIM, do NOT offer another time yourself, then sage_handoff (booking_status_unknown). Never tell them they're booked, and never tell them nothing happened.
   - 'unknown' → say nothing definite either way. Read patient_script, then sage_handoff (api_failure).

If they want to cancel outright with no replacement, that is the cancellation flow, not this one.

# Confirming an existing appointment

Many callers ring only to confirm they're coming. That is a complete answer on its own — handle it and close the call. Do NOT transfer or file a callback for it. You CAN record the confirmation for real: it writes the Confirmed flag the office reads off the appointment book.

1. Verify identity if not yet verified.
2. "One moment while I pull that up" → get_patient_appointments.
3. Read it back plainly: "Yes — you're all set for Tuesday, August 5th at 9:00 with Dr. Wernow at our Encinitas office." Then ask directly: "Can I mark you as confirmed for that?"
4. On a yes: sage_confirm_appointment with that appointment's NUMBER, then speak the returned 'say'. This ticks the same Confirmed box the office sees, so they know you're coming.
5. Ask if they need anything else, then close warmly.

If they have NO upcoming appointment, say so directly and offer to book one — do not imply one exists.

If the tool returns confirmed=false, tell them plainly what the reason says and never claim it went through. A cancelled or already-kept appointment cannot be confirmed — say so rather than pretending.

# NEVER RETRY A REFUSAL

Some tools return a REFUSAL rather than an error: identity_required,
appointment_reference_unknown, option_number_unknown, person_mismatch,
already_verified_existing. These are server-side gates, not transient
failures. Calling the same tool again with the same arguments CANNOT
succeed — it will be refused identically, and the caller hears silence
while you try.

Every refusal carries an agent_instruction telling you what to change first
(verify identity, list the appointments, re-run availability). Do that, then
call the tool ONCE more. If it refuses again, stop and offer a callback via
sage_handoff — never loop.

This is different from prompt rule 11's one-retry allowance, which is for
genuine transient errors (timeouts, 5xx). A refusal is not transient.

# WRITE-ONCE RULE (applies to EVERY write tool: sage_book, sage_reschedule, sage_confirm_appointment, cancel_appointment, sage_new_patient_intake)

A write that returned success is DONE — never call it again on the same call. Re-calling a successful registration creates duplicate-chart errors (21:01 call re-registered a just-created patient); re-calling a successful cancel, booking or reschedule creates confusing errors you'll then narrate at the caller. Success → move to the next step, immediately.

# Frustrated callers (ported from the answering-service agent's protocol)

TRIGGER — ALL must be true: the call has had at least one full exchange (NEVER trigger on a first sentence), AND the caller shows real frustration: raised voice, complaints about the service, "what are you doing", "hello? hello?", "I've been waiting".
WHEN TRIGGERED:
1. Acknowledge ONCE, in your own words ("I'm sorry about that — let's get this handled right now"). NEVER repeat the same apology twice in one call; if you already apologized, skip it and just fix the problem.
2. If the caller corrected you, say the corrected understanding back ("Got it — you want to cancel your appointment") and continue from THEIR correction, never your previous assumption.
3. Then keep moving with SHORT turns — no long explanations. Get to the outcome fast.
4. If things keep failing, never leave them empty-handed: sage_handoff with a callback so a human closes the loop.

# Corrections

If the caller corrects ANYTHING you said (a date, a name, an office, their intent), acknowledge the correction explicitly and continue from their version. Never restate your earlier wrong version, never re-verify what the correction didn't touch.

# Noise, interruptions, and recovering mid-sentence

- Phone lines are noisy: coughs, TV, traffic, someone talking in the background. If you get cut off mid-sentence and the caller didn't actually SAY anything, pick up right where you left off — finish your sentence or restate it briefly. Do NOT go silent, do NOT restart the conversation, do NOT re-verify anything.
- If a transcription seems garbled or contradicts what you already confirmed, ask ONE brief clarifying question about just that item — never redo the whole sequence.
- Dead silence is unnerving on a phone — the caller can't tell if the line dropped. If you've been silent for more than a few seconds for any reason, say something brief ("Still with you — one moment").

# Ghost calls, robots, and dead air

- BE PATIENT after your greeting: the caller's audio often connects a beat late, so they may have missed part of it. Wait a FULL 5 seconds of silence before saying anything more. First re-prompt = repeat the full greeting ("Thanks for calling Azul Vision — how can I help you today?"), NOT "is anyone there". If still silent, wait another 6+ seconds, then prompt once more. Only after that, say a brief goodbye and call terminate_call with reason ghost_call. NEVER stack prompts back-to-back.
- If you hear an automated system, IVR menu, or recorded message, call terminate_call with reason robot_call.
- If the call is clearly spam or telemarketing, call terminate_call with reason spam.
- Always say a short goodbye BEFORE calling terminate_call.
- Do NOT use terminate_call to end a normal, completed conversation — say goodbye and let the caller hang up. terminate_call is only for ghost/robot/spam calls or a truly stuck call.

# What you cannot do

- You cannot reschedule — cancel + book through the allowed flow, or hand off.
- You cannot update demographics.
- You cannot answer insurance/authorization questions — sage_handoff with reason insurance_or_authorization_issue.
- You cannot look up a different patient after verifying one — re-verification required.
- You are not a doctor: no medical advice, no diagnoses, no medication guidance — ever.

If a patient asks for something out of scope, say so directly and hand off.

# Speaking style for voice

Concise. No lists or headings — this is voice. One thought per sentence. Read addresses and dates naturally. Spell out phone digits one at a time. Pause between thoughts. If you don't understand, say so plainly.

The company is Azul Vision. If any tool result mentions the legacy brand "Atlantis Eyecare", say "Azul Vision" instead.

# Tone

Warm, professional, brief. You represent a busy ophthalmology practice. No lecturing, no excessive apologizing. When in doubt, ask a clear short question.`;

function buildDynamicTail(metadata?: AzulSchedulingMetadata): string {
  const parts: string[] = ['', getPacificTimeContext()];
  if (metadata?.callerPhone) {
    const last4 = metadata.callerPhone.replace(/\D/g, '').slice(-4);
    parts.push(
      `# Call context\n\nThe caller's phone number is ${metadata.callerPhone}. Offer it as the callback number ("Is this number ending in ${last4} the best one to reach you?") rather than making them read out digits.`,
    );
  }
  const pc = metadata?.precontext;
  if (pc?.matched && pc.firstName) {
    const first = pc.firstName;
    const last = pc.lastNameOnFile || '';
    parts.push(
      `# CALLER-ID PRE-CONTEXT (use this — do not make the caller spell their life out)\n\n` +
      `This phone number matches an existing patient on file: first name "${first}"${last ? `, last name on file "${last}"` : ''}. This is a STRONG hint, not verification.\n` +
      `- YOUR OPENING GREETING ALREADY ASKED "Am I speaking with ${first}?" — do NOT ask it a second time. When they confirm, go straight to their date of birth ("Thanks ${first} — and your date of birth?"), then call verify_patient_identity with firstName "${first}"${last ? `, lastName "${last}" (the ON-FILE spelling — never a transcribed respelling)` : ''} and that DOB. The caller-ID match plus DOB completes verification.\n` +
      `- If the conversation has moved on and identity is still needed later, ask it then — but only once.\n` +
      `- Do NOT ask them to spell their name. Do NOT mention we recognized their number — just greet warmly and confirm.\n` +
      `- If they say NO (calling for someone else / different person), run the standard verification flow for the actual patient.\n` +
      `- Disclose NOTHING from their record until verify_patient_identity returns verified.`,
    );
  }
  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Agent factory
// ─────────────────────────────────────────────────────────────────────────

export interface AzulSchedulingMetadata {
  callId?: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string;
  /** Caller-ID pre-context from the person base (sage_precontext): who this
   *  phone number likely belongs to. NEVER treated as verification. */
  precontext?: AzulPrecontext;
}

export const azulSchedulingAgentConfig = {
  slug: 'azul-scheduling',
  name: 'Azul Vision NextGen Scheduling Agent',
  description:
    'NextGen scheduling line (San Diego pilot) — rules-engine-gated booking via the Eye Care service; lookup, cancel, and handoff.',
  version: '2.23.0',
  greeting:
    "Thanks for calling Azul Vision, this is the automated scheduling assistant. How can I help you today?",
  voice: 'sage',
  language: 'en',
};

export function createAzulSchedulingAgent(
  handoffCallback?: () => Promise<void>,
  metadata?: AzulSchedulingMetadata,
): RealtimeAgent {
  console.log('[AZUL-SCHED] Creating agent v' + azulSchedulingAgentConfig.version, {
    callId: metadata?.callId,
    callSid: metadata?.callSid,
    dialedNumber: metadata?.dialedNumber,
  });

  /** Execute on the Eye Care service AND record to the pilot tool timeline. */
  const tracked = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const stampVerifiedIdentity = async (resultJson: string): Promise<void> => {
      const callLogId = metadata?.callLogId;
      if (!callLogId) return;
      try {
        let parsed: any = JSON.parse(resultJson);
        parsed = parsed?.result ?? parsed; // {tool, result} envelope
        if (parsed?.verified !== true) return;
        const full = [parsed.firstName, parsed.lastName].filter(Boolean).join(' ').trim();
        if (!full) return;
        const { storage } = await import('../../server/storage');
        await storage.updateCallLog(callLogId, {
          patientFound: true,
          patientName: full,
          ...(parsed.dateOfBirth ? { patientDob: String(parsed.dateOfBirth) } : {}),
        });
      } catch (e) {
        console.error('[AZUL-SCHED] verified-identity stamp failed:', e);
      }
    };

    const started = Date.now();
    const holdingCb =
      holdingCallbacks.get(String(metadata?.callId ?? '')) ??
      holdingCallbacks.get(String(metadata?.callSid ?? ''));
    const fire = () => {
      try {
        holdingCb!();
      } catch (e) {
        console.error('[AZUL-SCHED] holding update failed:', e);
      }
    };
    let heartbeat: NodeJS.Timeout | null = null;
    const firstBeat = holdingCb
      ? setTimeout(() => {
          fire();
          heartbeat = setInterval(fire, HOLDING_UPDATE_MS);
        }, HOLDING_FIRST_MS)
      : null;
    try {
      const result = await callEyecareTool(name, args);
      const ms = Date.now() - started;
      console.log(`[AZUL-SCHED] ${name} completed in ${ms}ms`);
      recordAzulToolEvent(metadata?.callId ?? metadata?.callSid ?? '', name, args, result, ms, {
        callSid: metadata?.callSid,
        callLogId: metadata?.callLogId,
      });
      // Stamp the VERIFIED identity onto the call log. Without this the console
      // shows caller_name — the telco CNAM string for the phone line, which is
      // whoever the carrier has on the account, not who called. The 07-28 16:54
      // call reads "[Lookup] JO WARD" in the call list while the transcript is a
      // verified Wayne Burley throughout, which reads like the agent addressed
      // the wrong person. It didn't; the console was showing the phone bill.
      if (name === 'verify_patient_identity') void stampVerifiedIdentity(result);
      return result;
    } finally {
      if (firstBeat) clearTimeout(firstBeat);
      if (heartbeat) clearInterval(heartbeat);
    }
  };

  // ── sage_* — the rules-engine-gated scheduling contract ────────────────

  const sageDecisionTool = tool({
    name: 'sage_decision',
    description:
      'MANDATORY GATE: ask Eye Care whether the AI may search, offer, or book a given appointment type (optionally at a location / with a provider). Call BEFORE any availability search or booking. Follow the returned decision and agent_instruction verbatim — never override it.',
    parameters: z.object({
      intent: z.enum(['search', 'offer', 'book']),
      eventName: z.string().describe("Appointment type name, e.g. 'Follow Up'."),
      locationName: z.string().optional().describe("The office AS THE CALLER SAID IT (e.g. 'Encinitas'). ONLY when the caller asked for a specific office — never volunteer one."),
    }),
    execute: async (args) => tracked('sage_decision', compact(args)),
  });

  const sagePatientContextTool = tool({
    name: 'sage_patient_context',
    description:
      'Consolidated patient context: identity match status, upcoming/last appointments, preferred office, and post-op flags — WITH instructions the agent must follow (multiple matches → disclose nothing; upcoming appointment → ask about it first; recent surgery → route to the surgical team).',
    parameters: z.object({}).describe('No parameters — runs for the identity THIS CALL verified.'),
    execute: async () => tracked('sage_patient_context', compact({ callId: metadata?.callId })),
  });

  const sageAvailabilityTool = tool({
    name: 'sage_availability',
    description:
      "Rules-gated availability from the live-schedule snapshot (fast). ALWAYS ask 'What days and times work best for you?' BEFORE calling and pass preferredDate (+ timeOfDay, + preferredTime whenever the caller names a clock time, + providerName whenever they name a doctor) — never search blind. THE RESULT IS A DIRECTIVE: speak the returned 'say' sentence WORD-FOR-WORD to make the offer — never phrase or invent your own, and never mention a time that is not inside it — and book ONLY by that offer's option NUMBER via sage_book (option 1 = the first time in 'say', option 2 = the second). The tool hands you ONLY the two speakable options; other openings exist but are withheld on purpose, so the ONLY way to reach a different day, time, provider or office is to call this tool AGAIN with that preference. The system knows who this call verified — you never pass IDs.",
    parameters: z.object({
      eventName: z.string(),
      preferredDate: z.string().optional().describe("YYYY-MM-DD from asking 'What days and times work best for you?'. Resolve relative answers ('next Tuesday') to a date. Covers that date + the following 6 days."),
      timeOfDay: z.enum(['AM', 'PM', 'ALL']).optional().describe('Morning (AM) / afternoon (PM) preference, when stated.'),
      preferredTime: z.string().optional().describe("The clock time the caller asked for, 24-hour HH:MM ('ten o'clock' -> '10:00', 'two thirty in the afternoon' -> '14:30'). Pass this EVERY time the caller names a time. Without it you are handed the earliest openings of the day and the caller's request is silently ignored."),
      locationName: z.string().optional().describe("The office AS THE CALLER SAID IT (e.g. 'Oceanside'). ONLY when the caller asked for a specific office."),
      providerName: z.string().optional().describe("The provider AS THE CALLER SAID IT (e.g. 'Dr. Wernow') when the caller wants a specific provider."),
      daysAhead: z.number().optional().describe('Provider-specific search window, default 21.'),
    }),
    execute: async (args) =>
      tracked('sage_availability', compact({ ...args, callId: metadata?.callId })),
  });

  const sageNewPatientIntakeTool = tool({
    name: 'sage_new_patient_intake',
    description:
      "Register a NEW patient (no existing chart): creates the NextGen chart with a real PCP (defaults to NO PCP when unknown) and opens an insurance-eligibility intake. Returns earliest_bookable_date — insurance verification needs a few business days, and availability/booking enforce it. Call ONLY after collecting full name, DOB, cell phone, sex, PCP (or confirmed unknown), and insurance details INCLUDING asking directly for the member ID on the card (proceed without it only if the caller doesn't have the card — the intake is flagged and staff call back for it). If it reports a duplicate chart, the caller is an EXISTING patient — follow the returned instruction.",
    parameters: z.object({
      firstName: z.string(),
      lastName: z.string(),
      dateOfBirth: z.string().describe('YYYY-MM-DD.'),
      cellPhone: z.string().describe("10+ digits — confirm the caller's number."),
      sex: z.string().describe('F | M | O.'),
      pcpName: z.string().optional().describe("PCP as stated. Omit if unknown — defaults to 'NO PCP'."),
      coverageType: z.string().optional().describe('HMO | PPO | Medicare | Medi-Cal | Medicare Advantage | other | unknown'),
      healthPlan: z.string().optional().describe('e.g. Blue Shield, Kaiser, IEHP, SCAN.'),
      medicalGroup: z.string().optional().describe("For HMO: one quick ask ('Do you happen to know which medical group?'). Nice-to-have — if they don't know, move on; staff determine it during verification."),
      memberId: z.string().optional().describe("HEALTH PLAN member/subscriber ID — the only required ID. ASK for it directly. Omit ONLY if the caller doesn't have their card — the intake is then flagged for staff follow-up."),
      visionPlan: z.string().optional().describe("Separate vision coverage — one quick ask ('Do you also have separate vision coverage, like VSP or EyeMed?'). Plan name is plenty; never press."),
      visionMemberId: z.string().optional().describe('ONLY if the caller volunteers it — do not ask for the vision member ID.'),
      secondaryCoverage: z.string().optional().describe("Secondary/supplemental insurance. For MEDICARE patients, always ask ('Do you have a secondary or supplemental insurance as well?')."),
      insuranceNotes: z.string().optional().describe('Anything else the caller shared about coverage.'),
    }),
    execute: async (args) => {
      const { coverageType, healthPlan, medicalGroup, memberId, visionPlan, visionMemberId, secondaryCoverage, insuranceNotes, ...rest } = args;
      return tracked('sage_new_patient_intake', compact({
        ...compact(rest),
        insurance: compact({
          coverageType, healthPlan, medicalGroup, memberId, visionPlan, visionMemberId, secondaryCoverage,
          notes: insuranceNotes,
        }),
        callId: metadata?.callId,
      }));
    },
  });

  const sageBookTool = tool({
    name: 'sage_book',
    description:
      "Rules-gated booking BY OPTION NUMBER: pass the number of the option the caller chose from the LATEST sage_availability offer, plus confirmedTimeSpoken — the time you read back to them. All slot details resolve server-side, and a slot without a live offer cannot be booked. The server REFUSES the booking when confirmedTimeSpoken doesn't match the option you picked ('confirmed_time_mismatch') — that means you offered a time the system never gave you; nothing was written, so re-run sage_availability with that time and offer only what comes back. Books in NextGen, then CONFIRMS the appointment exists before claiming success. The returned booking_status is the ONLY truth: 'confirmed' = booked (speak the returned 'say' confirmation); anything else means DO NOT tell the patient they are booked (on 'unknown' a scheduler callback has already been created — read the returned patient_script; on a token error, re-run sage_availability and offer only what it returns).",
    parameters: z.object({
      optionNumber: z.number().describe('The NUMBER of the option the caller chose from the LATEST availability offer: 1 for the first option, 2 for the second. The server resolves the slot AND the verified patient — you never handle IDs.'),
      confirmedTimeSpoken: z.string().describe("REQUIRED. The clock time you READ BACK to the caller and they agreed to, in 24-hour HH:MM ('10:00', '14:30'). Send what you actually said out loud — not the option's time copied from the result. If those two differ the booking is refused, which is exactly what protects a caller who agreed to 10:00 from being booked at 8:10."),
      description: z.string().optional(),
    }),
    execute: async (args) =>
      tracked('sage_book', compact({ ...args, callId: metadata?.callId })),
  });

  // MOVE an appointment in ONE write. Before this existed the only route was
  // cancel-then-book: two confirmations, two writes, and a window where the
  // caller held no appointment at all. An operator hit exactly that live —
  // the agent asked to cancel first and then rebook, which is not what anyone
  // means by "move my appointment". The service has done this atomically all
  // along (reschedule_appointment); azul simply never had the tool.
  const sageRescheduleTool = tool({
    name: 'sage_reschedule',
    description:
      "MOVE an existing appointment to a new time in ONE step. ALWAYS use this instead of cancelling and re-booking — never do those separately for a move. Prerequisites: get_patient_appointments (gives each appointment a NUMBER) and sage_availability (gives each new time an option NUMBER). Confirm BOTH in one sentence before calling ('move your July 30th 1:40 to Tuesday the 5th at 9am — correct?'). The returned reschedule_status is the ONLY truth: 'confirmed' = moved, speak the returned 'say'; 'cancelled_not_rebooked' = the OLD appointment IS GONE and the new one did NOT take — read patient_script VERBATIM and hand off, never claim either outcome; 'failed' = nothing changed, the original is intact, offer other times; 'unknown' = say nothing definite and hand off.",
    parameters: z.object({
      appointmentOrdinal: z.number().describe('The NUMBER of the appointment being moved, from the get_patient_appointments list on THIS call.'),
      optionNumber: z.number().describe('The NUMBER of the option the caller chose from the LATEST sage_availability offer. The server resolves the slot — you never handle IDs.'),
    }),
    execute: async (args) =>
      tracked('sage_reschedule', compact({ ...args, callId: metadata?.callId })),
  });

  // Writes the real NextGen "Confirmed" checkbox (appointmentConfirmed) — the
  // same flag Phreesia sets at pre-registration and the one staff read off the
  // appointment book. Verified against a live record 2026-07-28; it had been
  // wrongly reported as non-existent because get_appointment_details discards
  // every field it does not explicitly map.
  const sageConfirmAppointmentTool = tool({
    name: 'sage_confirm_appointment',
    description:
      "Mark an appointment CONFIRMED when the caller says they're coming — this ticks the same box the office sees in the appointment book. Prerequisite: get_patient_appointments, so the appointment has a NUMBER. THIS IS A WRITE: only after you have read a specific appointment back to them and they've confirmed attendance. Read the result's `confirmed`: true → speak the returned 'say'; false → read the reason plainly and never claim it was confirmed.",
    parameters: z.object({
      appointmentOrdinal: z.number().describe('The NUMBER of the appointment being confirmed, from the get_patient_appointments list on THIS call.'),
    }),
    execute: async (args) =>
      tracked('sage_confirm_appointment', compact({ ...args, callId: metadata?.callId })),
  });

  const sageHandoffTool = tool({
    name: 'sage_handoff',
    description:
      "Create a handoff packet and get routing (queue/team, transfer number, patient script, staff summary). ALWAYS call this before transferring or promising a callback — no transfer without a packet. ALWAYS pass locationName — the office the caller wants or was being scheduled at. The RESULT's method decides what happens next: 'cold_transfer' → tell the caller you're connecting them, then call transfer_to_office; 'callback' → promise the callback. Urgent symptoms use handoffReason 'urgent_symptom' with method 'urgent_escalation'.",
    parameters: z.object({
      handoffReason: z.enum([
        'patient_requested_human', 'urgent_symptom', 'no_acceptable_availability',
        'patient_frustrated', 'api_failure', 'booking_status_unknown',
        'insurance_or_authorization_issue', 'surgery_or_post_op_issue',
        'existing_appointment_conflict', 'multiple_patient_matches',
        'patient_identity_uncertain', 'provider_specific_request',
        'diagnostic_or_resource_scheduling', 'queue_transfer_failure',
      ]),
      locationName: z.string().optional().describe("Office the caller wants / was discussing (e.g. 'Encinitas', 'Oceanside'). Pass whenever known — routing picks the office's own queue from it."),
      method: z.enum(['callback', 'cold_transfer', 'urgent_escalation']).optional(),
      patientName: z.string().optional(),
      patientDob: z.string().optional(),
      patientPhone: z.string().optional(),
      reasonForCall: z.string().optional(),
      requestedLocation: z.string().optional(),
      requestedTimeframe: z.string().optional(),
      urgencyScreenResult: z.string().optional(),
      patientResponse: z.string().optional(),
    }),
    execute: async (args) => {
      const { patientName, patientDob, patientPhone,
        reasonForCall, requestedLocation, requestedTimeframe,
        urgencyScreenResult, patientResponse, ...rest } = args;
      const result = await tracked('sage_handoff', compact({
        ...rest,
        patient: compact({
          name: patientName,
          dob: patientDob,
          phone: patientPhone ?? metadata?.callerPhone,
          // personId injected server-side from the call session (zero-id)
        }),
        callContext: compact({
          reasonForCall, requestedLocation, requestedTimeframe,
          urgencyScreenResult, patientResponse, callId: metadata?.callId,
        }),
      }));

      const handoffContext = {
        handoffReason: args.handoffReason,
        patient: { name: patientName, dob: patientDob, phone: patientPhone ?? metadata?.callerPhone },
        callContext: { reasonForCall, patientResponse, requestedLocation },
      };
      // The service wraps every response as {tool, result: {...}} — unwrap
      // the envelope (pilot call 2026-07-22 18:50: parsing the envelope
      // directly made method/transferNumberE164 read as undefined, so the
      // transfer target was never captured and every cold_transfer
      // instantly fell back to the callback apology).
      let parsed: any = {};
      try {
        const env = JSON.parse(result);
        parsed = env?.result ?? env;
      } catch { /* raw text */ }

      if (parsed?.method === 'cold_transfer' && parsed?.transferNumberE164 && metadata?.callId) {
        // Tier 2: routing says connect the caller live. Capture the target
        // for transfer_to_office (the model never supplies numbers). The
        // tier-3 ticket is NOT filed yet — a successful transfer needs no
        // ticket; transfer_to_office files one if the office doesn't answer.
        transferTargets.set(metadata.callId, {
          number: String(parsed.transferNumberE164),
          team: parsed.queueTeam ? String(parsed.queueTeam) : null,
          handoff: handoffContext,
          resultRaw: result,
        });
      } else {
        // Tier 3 directly (callback / urgent routing) — fire-and-forget;
        // never delays the live call.
        void fileLocationQueueTicket(handoffContext, result, {
          callId: metadata?.callId,
          callSid: metadata?.callSid,
        });
      }

      // Urgent escalations additionally dial the on-call human into the
      // conference. The platform's handoff gate requires escalation details
      // with an allowed callerType — set them BEFORE invoking the callback.
      if (args.method === 'urgent_escalation' && handoffCallback && metadata?.callId) {
        const [first, ...restName] = (patientName ?? '').split(' ');
        escalationDetailsMap.set(metadata.callId, {
          reason: `Urgent symptom during scheduling call: ${urgencyScreenResult ?? reasonForCall ?? args.handoffReason}`,
          callerType: 'patient_urgent_medical',
          patientFirstName: first || undefined,
          patientLastName: restName.join(' ') || undefined,
          patientDob,
          callbackNumber: patientPhone ?? metadata?.callerPhone,
          symptomsSummary: urgencyScreenResult ?? patientResponse,
        });
        handoffCallback().catch((err) =>
          console.error('[AZUL-SCHED] urgent handoff dial failed:', err),
        );
      }
      return result;
    },
  });

  const transferToOfficeTool = tool({
    name: 'transfer_to_office',
    description:
      "Connect the caller LIVE to the office queue. Use ONLY after sage_handoff returned method 'cold_transfer'. BEFORE calling this, say the step-away line: \"Give me one moment while I try to connect you to the office team — if it doesn't go through, I'll be right back with you.\" THEN call this. The caller hears silence (never ringing) while the office is dialed for up to 45 seconds; the system prompts you with a brief cut-in every ~10 seconds — speak it, then go quiet again. transferred=true → the office answered and the calls are merged — your part is over, say NOTHING more. transferred=false → the office didn't pick up: come back warmly (\"Thanks for holding — I wasn't able to reach them directly\"), promise the callback (a high-priority ticket is filed for you automatically), and wrap up.",
    parameters: z.object({}),
    execute: async () => {
      const callId = metadata?.callId;
      // Already connected: a repeat invocation is a no-op, not a second dial.
      // Re-dialling an office that is already merged into this caller's
      // conference times out and files a failure ticket for a call that
      // succeeded — the spurious TRANSFER NOT ANSWERED staff were seeing.
      if (callId && transferredCalls.has(callId)) {
        return { transferred: true };
      }
      const target = callId ? transferTargets.get(callId) : undefined;
      if (!callId || !target) {
        return {
          transferred: false,
          error: 'no_transfer_packet',
          instruction: 'No cold_transfer packet exists for this call. Call sage_handoff first; if its method is callback, promise the callback instead.',
        };
      }
      const dial = officeTransferCallbacks.get(callId);
      if (!dial) {
        failedTransferAttempts.set(callId, { handoff: target.handoff, resultRaw: target.resultRaw });
        return {
          transferred: false,
          error: 'transfer_unavailable',
          instruction: 'Live transfer is not available on this call. Apologize and promise the callback — the office queue is notified automatically when the call ends.',
        };
      }
      // Reassurance while the office rings (up to 45s) — after-hours-style:
      // the agent's long connect line covers the first stretch, then these
      // injected updates keep a human voice over the ringback every ~10s.
      const RING_UPDATE =
        'You are still trying to connect the caller to the office (they hear silence, not ringing). Cut in with ONE short, warm reassurance (vary the wording), e.g. "Still trying the office for you — hang tight." Then go quiet again. Say nothing else, ask nothing.';
      const hb = holdingCallbacks.get(callId);
      let hbInterval: ReturnType<typeof setInterval> | undefined;
      const hbFirst = hb
        ? setTimeout(() => {
            hb(RING_UPDATE);
            hbInterval = setInterval(() => hb(RING_UPDATE), 10_000);
          }, 8_000)
        : undefined;
      const startedAt = Date.now();
      // Warm-transfer briefing (ship gate): the staffer hears WHO is calling
      // and WHY before accepting — the patient never repeats themselves.
      let parsedHandoff: any = {};
      try {
        const env = JSON.parse(target.resultRaw);
        parsedHandoff = env?.result ?? env;
      } catch { /* raw text */ }
      const briefing = [
        'This is the Azul Vision scheduling assistant with a live patient transfer.',
        target.handoff.patient.name ? `Caller: ${target.handoff.patient.name}.` : null,
        target.handoff.callContext.reasonForCall ? `Reason: ${target.handoff.callContext.reasonForCall}.` : null,
        parsedHandoff?.staffSummary ? `${String(parsedHandoff.staffSummary).split('\n')[0]}` : null,
      ].filter(Boolean).join(' ');
      try {
        console.log(`[AZUL-SCHED] tier-2 WARM transfer → ${target.team ?? 'office queue'} (${target.number})`);
        const outcome = await dial(target.number, target.team ?? 'office queue', briefing);
        recordAzulToolEvent(callId, 'transfer_to_office', { team: target.team, number: target.number }, JSON.stringify(outcome), Date.now() - startedAt, {
          callSid: metadata?.callSid,
          callLogId: metadata?.callLogId,
        });
        if (outcome.ok) {
          // Mark BEFORE clearing the target: a concurrent invocation that is
          // already past the target lookup must still be barred from filing a
          // failure ticket when its own dial times out.
          markAzulTransferAccepted(callId);
          transferTargets.delete(callId);
          // Accepted transfer = the promise is KEPT — resolve the console
          // callback so staff don't also call the patient back (Phase 1.5
          // double-callback fix). Fire-and-forget; the live call moves on.
          if (parsedHandoff?.callbackId != null) {
            const callbackId = Number(parsedHandoff.callbackId);
            // Remembered so late conference join/leave events can find the row.
            transferBridgeCallbackIds.set(callId, callbackId);
            // Replay anything the conference reported before we knew the row.
            const buffered = pendingBridgeUpdates.get(callId);
            if (buffered?.length) {
              pendingBridgeUpdates.delete(callId);
              for (const b of buffered) recordAzulTransferBridge(callId, b);
            }
            const how =
              outcome.acceptMethod === 'keypress'
                ? 'keypress'
                : outcome.acceptMethod === 'stay_on_line'
                  ? `stayed on the line (AMD: ${outcome.amdVerdict || 'no verdict'})`
                  : 'accepted';
            void callEyecareTool('sage_resolve_callback', {
              callbackId,
              outcome: 'transferred_live',
              detail: `Accepted by ${target.team ?? 'office queue'} (${target.number}) — ${how}`,
              ...(outcome.acceptMethod ? { acceptMethod: outcome.acceptMethod } : {}),
              ...(outcome.amdVerdict !== undefined ? { amdVerdict: outcome.amdVerdict } : {}),
            }).catch(() => {});
          }
          return { transferred: true };
        }
        throw new Error(outcome.detail || 'no_answer');
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // A concurrent invocation may have connected the caller while this
        // dial was timing out. The patient is with a human either way, so
        // report success and file nothing — telling staff to call back
        // someone who was already helped is the worse error.
        if (transferredCalls.has(callId)) {
          console.warn(`[AZUL-SCHED] tier-2 transfer errored (${detail}) but call already connected — suppressing failure ticket`);
          return { transferred: true };
        }
        console.warn(`[AZUL-SCHED] tier-2 transfer failed: ${detail} — deferring the ticket to the terminal sweep`);
        // Recorded, NOT filed. A later attempt on this same call may still
        // connect; the sweep decides once, at the end, when it knows.
        failedTransferAttempts.set(callId, { handoff: target.handoff, resultRaw: target.resultRaw });
        transferTargets.delete(callId);
        return {
          transferred: false,
          error: 'office_no_answer',
          detail,
          instruction:
            target.handoff.handoffReason === 'patient_requested_human'
              ? 'The office did not pick up. This caller asked for a person WITHOUT saying what they needed, so do NOT just promise a callback and hang up — OFFER THEM THE CHOICE, warmly and in one breath: "Thanks for holding — I wasn\'t able to reach them directly. I can have someone call you back, usually within the hour — or if you\'d like, tell me what you need and I may be able to take care of it right now." Then FOLLOW THEIR ANSWER. If they want the callback, confirm it warmly and wrap up — the office queue is notified automatically. If they tell you what they need, handle it normally — you can book, cancel, reschedule and confirm appointments. Ask ONCE; if they decline or repeat that they want a person, take the callback and stop offering.'
              : 'The office did not pick up. Apologize, promise the callback ("I was not able to reach them directly, so our team will call you back — usually within the hour"), and wrap up warmly. The office queue is notified automatically when the call ends.',
        };
      } finally {
        if (hbFirst) clearTimeout(hbFirst);
        if (hbInterval) clearInterval(hbInterval);
      }
    },
  });

  // ── read + cancel tools (identity-gated on the service side) ───────────

  const sageInfoTool = tool({
    name: 'sage_info',
    description:
      "Answer MUNDANE questions from the practice knowledge base: office address, cross streets, hours, phone/fax, services offered, insurance acceptance in general, what to bring. Call this FIRST for any such question — no identity verification needed, and NEVER hand off for these. Speak the returned 'say' text (facts verbatim). If it returns found=false, follow its instruction — do not invent an answer.",
    parameters: z.object({
      question: z.string().describe("The caller's question."),
      locationName: z.string().optional().describe("Office the question is about, if stated (e.g. 'Encinitas')."),
    }),
    execute: async (args) => tracked('sage_info', compact(args)),
  });

  const sageInsuranceCheckTool = tool({
    name: 'sage_insurance_check',
    description:
      "Answer 'do you take my insurance?' from the practice's payer master + authorization rules. Pass the plan (and medical group, if mentioned) AS THE CALLER SAID THEM. Speak the returned 'say' (facts verbatim). NEVER answer coverage questions from memory, never discuss costs/copays, and never say a plan is NOT accepted — unmatched plans get verified by the team.",
    parameters: z.object({
      plan: z.string().describe("The insurance/plan as the caller said it (e.g. 'Blue Shield', 'SCAN', 'Cal Optima')."),
      medicalGroup: z.string().optional().describe("Medical group / IPA if mentioned (e.g. 'Optum', 'Prospect', 'Monarch')."),
    }),
    execute: async (args) => tracked('sage_insurance_check', compact({ ...args, callId: metadata?.callId })),
  });

  const sagePracticeTool = tool({
    name: 'sage_practice',
    description:
      "Answer practice-familiarity questions from the practice's own records — never from memory: who our doctors are ('do you have a retina specialist?'), which days a provider is in which office, what visit types we offer and what they are, office hours and the lunch closure, office address/phone. No identity verification needed. Speak the returned 'say' (facts verbatim). CRITICAL: only offer to SCHEDULE with providers the response marks bookable — for every other doctor, say the scheduling team will CALL THE PATIENT BACK to arrange it, never phrasing it so the caller believes the appointment is already being made (never say a doctor 'isn't available' either).",
    parameters: z.object({
      topic: z.enum(['providers', 'provider_schedule', 'services', 'hours', 'location_info']),
      providerName: z.string().optional().describe("Provider as the caller said it (e.g. 'Dr. Nayer'). Required for provider_schedule."),
      locationName: z.string().optional().describe("Office as the caller said it (e.g. 'Encinitas'), when the question is about one office."),
      serviceWords: z.string().optional().describe("The visit type in the caller's words, when they ask what a service is."),
    }),
    execute: async (args) => tracked('sage_practice', compact(args)),
  });

  const verifyIdentityTool = tool({
    name: 'verify_patient_identity',
    description:
      "Verify a patient's identity using FIRST NAME + LAST NAME + DATE OF BIRTH — those three, nothing else. NEVER ask the caller for phone digits (their number is attached automatically and only breaks ties server-side). The result's note may give the ON-FILE spelling — use it from then on. On success the SYSTEM remembers who this call verified — you never pass IDs afterward. Follow matchSignal's guidance ('verified' = proceed; anything else = do not disclose records).",
    parameters: z.object({
      lastName: z.string().describe("Patient's last name."),
      firstName: z.string().optional().describe("Patient's first name — ALWAYS pass it (enables the caller-ID rescue when a spelled last name was mis-transcribed)."),
      dateOfBirth: z.string().describe('YYYY-MM-DD. Ask year, then month, then day; speak it back.'),
      phoneLast4: z.string().optional().describe('Last 4 digits of the phone number on file.'),
    }),
    execute: async (args) =>
      // callId stamps the verified identity on the server's call session —
      // sage_book/sage_new_patient_intake are gated to the person THIS call
      // verified (Phase 2 state machine).
      tracked('verify_patient_identity', compact({ ...args, inboundPhone: metadata?.callerPhone, callId: metadata?.callId })),
  });

  const getPatientAppointmentsTool = tool({
    name: 'get_patient_appointments',
    description:
      "The verified caller's appointments (upcoming + optionally recent past), newest first, each with a derived outcome field AND a NUMBER (ordinal). Refer to appointments by that number in later calls (details, cancel). Runs for the identity THIS CALL verified — no IDs.",
    parameters: z.object({
      includePast: z.boolean().optional().describe('Include past appointments. Default false.'),
    }),
    execute: async (args) => tracked('get_patient_appointments', compact({ ...args, callId: metadata?.callId })),
  });

  const getAppointmentDetailsTool = tool({
    name: 'get_appointment_details',
    description:
      "Full record of one of the caller's appointments, by its NUMBER from the get_patient_appointments list. Use before confirming a cancellation so you can read back exactly what is being cancelled.",
    parameters: z.object({
      appointmentOrdinal: z.number().describe('The appointment NUMBER from the get_patient_appointments list.'),
    }),
    execute: async (args) => tracked('get_appointment_details', compact({ ...args, callId: metadata?.callId })),
  });

  const cancelAppointmentTool = tool({
    name: 'cancel_appointment',
    description:
      'CANCEL one of the caller\'s appointments. WRITE OPERATION — only after the patient has explicitly confirmed, out loud, the exact appointment being cancelled. Pass the appointment NUMBER from the list; the cancellation reason resolves server-side from your words.',
    parameters: z.object({
      appointmentOrdinal: z.number().describe('The appointment NUMBER from the get_patient_appointments list.'),
      reasonName: z.string().optional().describe("Reason in plain words, e.g. 'patient cancel'. Defaults to the patient-initiated reason."),
      comment: z.string().optional().describe('Brief note, e.g. "Patient called to cancel".'),
    }),
    execute: async (args) => tracked('cancel_appointment', compact({ ...args, callId: metadata?.callId })),
  });

  const lookupLocationTool = tool({
    name: 'lookup_location',
    description:
      'Find Azul Vision clinics by name. Returns canonical name and full address — read these VERBATIM, never paraphrase.',
    parameters: z.object({
      name: z.string().describe('Location name fragment (case-insensitive).'),
    }),
    execute: async (args) => tracked('lookup_location', compact(args)),
  });

  const listLocationsTool = tool({
    name: 'list_locations',
    description:
      "List all schedulable Azul Vision clinics (names + cities). Use for 'what locations do you have'.",
    parameters: z.object({}),
    execute: async () => tracked('list_locations', {}),
  });

  const lookupProviderTool = tool({
    name: 'lookup_provider',
    description:
      'Find providers (clinicians) by name. Returns providerId + resourceId per match. When more than one provider matches, ask the patient to disambiguate.',
    parameters: z.object({
      name: z.string().describe('Provider name fragment (case-insensitive).'),
    }),
    execute: async (args) => tracked('lookup_provider', compact(args)),
  });

  const getProviderLocationsTool = tool({
    name: 'get_provider_locations',
    description:
      "Where a provider generally sees patients (per-location counts of upcoming appointments). Use for 'where does Dr. X work'. Pass the provider's NAME as the caller said it — it resolves server-side.",
    parameters: z.object({
      providerName: z.string().describe("The provider's name as the caller said it (e.g. 'Dr. Wernow')."),
    }),
    execute: async (args) => tracked('get_provider_locations', compact(args)),
  });

  // ── call control ───────────────────────────────────────────────────────

  const terminateCallTool = tool({
    name: 'terminate_call',
    description: `Terminate the call server-side immediately. Use this to actually end the call — do NOT rely solely on verbal goodbye.

USE FOR:
- ghost_call: caller not responding after 2-3 prompts
- robot_call: IVR bleed-through or automated system detected
- spam: spam/telemarketing detected
- max_turns_exceeded: call has gone on too long with no resolution
- caller_declined: the caller explicitly declined verification AND declined a callback — end politely; no ticket is created (their choice is respected)

Always say a brief goodbye phrase BEFORE calling this tool.`,
    parameters: z.object({
      reason: z
        .enum(['ghost_call', 'robot_call', 'spam', 'max_turns_exceeded', 'caller_declined'])
        .describe('Reason for terminating the call'),
    }),
    execute: async (params) => {
      const callId = metadata?.callId || metadata?.callSid || '';
      console.log(`[AZUL-SCHED] terminate_call - reason: ${params.reason}, callId: ${callId}`);
      recordAzulToolEvent(callId, 'terminate_call', { reason: params.reason }, '{}', 0, {
        callSid: metadata?.callSid,
        callLogId: metadata?.callLogId,
      });
      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return { success: false, error: 'missing_api_key' };
        }
        const response = await fetch(
          `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        if (response.ok) {
          return { success: true, reason: params.reason };
        }
        return { success: false, status: response.status };
      } catch (error) {
        console.error('[AZUL-SCHED] terminate_call error:', error);
        return { success: false, error: String(error) };
      }
    },
  });

  const agent = new RealtimeAgent({
    name: 'Azul Vision Scheduling Assistant',
    // Function form keeps the Pacific-time tail fresh; static prefix first
    // preserves prompt caching (same convention as afterHoursAgent).
    instructions: () => STATIC_PROMPT + buildDynamicTail(metadata),
    tools: [
      sageDecisionTool,
      sagePatientContextTool,
      sageAvailabilityTool,
      sageBookTool,
      sageRescheduleTool,
      sageConfirmAppointmentTool,
      sageHandoffTool,
      transferToOfficeTool,
      sageNewPatientIntakeTool,
      verifyIdentityTool,
      getPatientAppointmentsTool,
      getAppointmentDetailsTool,
      cancelAppointmentTool,
      lookupLocationTool,
      listLocationsTool,
      lookupProviderTool,
      getProviderLocationsTool,
      sageInfoTool,
      sageInsuranceCheckTool,
      sagePracticeTool,
      terminateCallTool,
    ],
  });

  // Agent-level guardrails (same attachment pattern as noIvrAgent) — the
  // session-wide guardrails apply too; this is defense in depth.
  agent.outputGuardrails = medicalSafetyGuardrails;

  return agent;
}
