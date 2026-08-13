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
import { markCallConcluded } from '../services/callConclusion';
import { recordAzulToolEvent, getAzulTimeline, classifyAzulCall, type AzulToolEvent } from '../services/toolTimeline';
import { callMetadataForDB } from '../services/callMetadataStore';
import { callerSpeech, guardIdentityArgs, surnameDisagrees, lastIdentityAttempt } from '../services/identityArgGuard';
// The prompt lives in its own module so a test can load it without a database.
// See the header of azulSchedulingPrompt.ts for why that matters.
import { buildAzulSchedulingPrompt } from './azulSchedulingPrompt';
import type { AzulPrecontext, AzulSchedulingMetadata } from './azulSchedulingPrompt';
export { buildAzulSchedulingPrompt } from './azulSchedulingPrompt';
export type { AzulPrecontext, AzulSchedulingMetadata } from './azulSchedulingPrompt';
import { checkAppointmentOrdinal, checkHandoffIdentity, handoffIdentity, refusalJson } from '../services/azulToolGuards';
import { checkIdentityGrounding } from '../services/identityGrounding';
import { director, directorEnabledFor } from '../director/director';

const EYECARE_BASE_URL =
  process.env.EYECARE_SCHEDULING_BASE_URL ||
  'https://eyecare-scheduling-agent-wayne-fabians-projects.vercel.app';

/** Declared to the service on every tool call (X-Agent-Version), which is how
 *  server-side gates can tighten for new builds without breaking old ones.
 *  `azulSchedulingAgentConfig.version` below is the same value — this constant
 *  exists only because the config object is defined further down the file. */
const AZUL_AGENT_VERSION = '2.28.0';

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

/**
 * Calls where verify_patient_identity came back verified. The server injects the
 * personId for these from its own call session, so sage_handoff must NOT also
 * send a patient name — see the patientName param description.
 */
const azulVerifiedCalls = new Set<string>();
/** sage_handoff refusals for want of identity, per call. */
const handoffIdentityRefusals = new Map<string, number>();

export function releaseAzulCallState(callId: string | undefined): void {
  if (!callId) return;
  azulVerifiedCalls.delete(callId);
  handoffIdentityRefusals.delete(callId);
}

/**
 * How many appointments the caller's own lookup returned on THIS call, or null
 * if no successful get_patient_appointments has run.
 *
 * The appointment-ordinal tools (sage_reschedule, sage_confirm_appointment,
 * get_appointment_details, cancel_appointment) all resolve their target from an
 * ordinal in that list, and the server answers `appointment_reference_unknown`
 * when it cannot. That refusal cost 15 blocked calls between 07-27 and 08-03,
 * and sage_reschedule alone burned 34 invocations across 9 calls — the model
 * re-sending an ordinal that could never resolve, roughly two seconds of caller
 * silence each time.
 *
 * The count is already in the timeline: get_patient_appointments records
 * `appointmentCount` in its outcome. So the precondition is answerable locally,
 * before the network call, exactly like guardIdentityArgs does for verification.
 */
function appointmentCountForCall(callId: string | undefined): number | null {
  if (!callId) return null;
  const events = getAzulTimeline(callId);
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.tool !== 'get_patient_appointments') continue;
    const n = (e.outcome as Record<string, unknown> | undefined)?.appointmentCount;
    if (typeof n === 'number') return n;
  }
  return null;
}

/**
 * Thin wrapper: look up this call's appointment count, then apply the pure
 * policy in services/azulToolGuards. Returns a tool-result string to return
 * INSTEAD of calling the service, or null to proceed.
 */
function guardAppointmentOrdinal(
  callId: string | undefined,
  tool: string,
  ordinal: unknown,
): string | null {
  const refusal = checkAppointmentOrdinal(appointmentCountForCall(callId), ordinal);
  return refusal ? refusalJson(tool, refusal) : null;
}
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

// AUTH-OUTAGE ALARM (2026-07-29). On 2026-07-28 the service rejected every
// call with 401 "cross-origin requests require EYECARE_AGENT_API_KEY" from
// 06:27 to 06:51 — the key had been rotated and this app still held the old
// one. Three consecutive callers were turned away, one of them four times in 24
// minutes, and nothing anywhere raised its voice: each failure was a single
// line in a per-call log. The agent is blind to a pattern that spans calls, so
// the transport counts it.
let authFailureCount = 0;
let authFailureFirstAt = 0;
let authAlarmRaised = false;

function noteAuthFailure(tool: string, status: number, detail: string): void {
  const now = Date.now();
  if (authFailureCount === 0) authFailureFirstAt = now;
  authFailureCount++;
  console.error(
    `[AZUL-SCHED] AUTH FAILURE ${status} on ${tool} (#${authFailureCount} since ${new Date(authFailureFirstAt).toISOString()}): ${detail.slice(0, 200)}`,
  );
  if (authFailureCount >= 3 && !authAlarmRaised) {
    authAlarmRaised = true;
    console.error(
      `[AZUL-SCHED] *** AUTH OUTAGE *** ${authFailureCount} consecutive ${status} responses from the Eye Care service since ` +
        `${new Date(authFailureFirstAt).toISOString()}. EVERY azul call is failing identity verification and handoff right now. ` +
        `Almost certainly EYECARE_AGENT_API_KEY is stale in this deployment — check it against the service and Vercel, then republish.`,
    );
  }
}

function resetAuthFailures(): void {
  if (authFailureCount > 0) {
    console.info(`[AZUL-SCHED] auth recovered after ${authFailureCount} failure(s)`);
  }
  authFailureCount = 0;
  authAlarmRaised = false;
}

export async function callEyecareTool(
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
        // Which build is calling (2026-07-29). The service's read-back gate
        // needs to distinguish "this agent forgot to read the time back" from
        // "this agent predates the parameter" — the first must block the
        // booking, the second must not, and without a version they look
        // identical. Sending it here is what lets that gate close without a
        // coordinated deploy: an older build sends no header and keeps failing
        // open, this build sends one and gets held to the rule.
        'X-Agent-Version': AZUL_AGENT_VERSION,
      },
      body: JSON.stringify(args ?? {}),
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      // Auth failures get the richer treatment (count, outage alarm); every
      // OTHER non-OK status used to return an error to the model and leave no
      // server-side trace at all, so a 500 from the service was invisible here
      // and only visible over there. Same lesson as the fire-and-forget POSTs:
      // if it can fail, it has to say so on our side too.
      if (r.status === 401 || r.status === 403) noteAuthFailure(name, r.status, text);
      else console.error(`[AZUL-SCHED] ${name} HTTP ${r.status}: ${text.slice(0, 300)}`);
      return JSON.stringify({
        error: `Eye Care service returned ${r.status}`,
        detail: text.slice(0, 500),
        ...(r.status === 401 || r.status === 403
          ? {
              fatal_auth: true,
              agent_instruction:
                "This is an authentication failure on OUR side, not a hiccup. DO NOT RETRY — a retry cannot fix it. Tell the caller plainly that you're having a system problem on your end, then call sage_handoff (reason api_failure) so a callback is created, and tell them someone will call them back at this number. NEVER tell the caller to phone the office themselves.",
            }
          : {}),
      });
    }
    resetAuthFailures();
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

/** Last-resort read of a timeline the flush already persisted. Only used when
 *  the in-memory copy has gone — see the note at the top of the sweep. */
async function readPersistedTimeline(
  callLogId: string | undefined,
  callSid: string | undefined,
): Promise<AzulToolEvent[] | null> {
  if (!callLogId && !callSid) return null;
  try {
    const { db } = await import('../../server/db');
    const { callLogs } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select({ toolTimeline: callLogs.toolTimeline })
      .from(callLogs)
      .where(callLogId ? eq(callLogs.id, callLogId) : eq(callLogs.callSid, callSid!))
      .limit(1);
    const events = (rows[0]?.toolTimeline as { events?: AzulToolEvent[] } | null)?.events;
    return Array.isArray(events) ? events : null;
  } catch (e) {
    console.error('[AZUL-SCHED] persisted-timeline read failed:', e);
    return null;
  }
}

/** Below this, a call with no tool events is a hangup or a wrong number and
 *  files nothing. Above it, someone was on the line long enough to be failed.
 *  Calibrated against 2026-07-29: the ghost call ran 19s, the two real dead
 *  ends ran 125s and 482s. */
const ZERO_TOOL_DEAD_END_SECONDS = 45;

export async function sweepAzulUnresolvedCall(callId: string): Promise<void> {
  try {
    // The sweep's whole job is deciding whether this caller was left with
    // nothing, so "I can't see the timeline" must never be read as "nothing to
    // do". It was: the old flush DELETED the in-memory entry before writing it,
    // and the coordinator's 'call-ended' flush races the teardown that calls
    // this sweep. When the flush won, getAzulTimeline returned null here and the
    // sweep filed NOTHING — which is how five callers on 2026-07-28, two of them
    // clinical (post-op out of drops; active eye infection), ended with no
    // booking, no transfer and no ticket, recorded nowhere.
    //
    // The flush no longer deletes (2.22.0), so the memory read should now
    // always hit. This fallback exists so a future ordering change can never
    // reopen the same hole silently: if memory is empty we read the persisted
    // timeline back off the call log before concluding anything.
    let events = getAzulTimeline(callId);
    if (!events || events.length === 0) {
      const metaForRead = callMetadataForDB.get(callId);
      const persisted = await readPersistedTimeline(metaForRead?.dbCallLogId, metaForRead?.twilioCallSid);
      if (persisted && persisted.length > 0) {
        console.warn(`[AZUL-SCHED] SWEEP: timeline missing from memory for ${callId} — recovered ${persisted.length} event(s) from the call log`);
        events = persisted;
      }
    }
    // ZERO-TOOL CALLS ARE NOT EXEMPT (2026-07-29). This used to be a bare
    // `return`, on the reasoning that a call which never touched the
    // scheduling tools had nothing to resolve. Two calls this morning proved
    // that backwards. 18:30: the caller said "Representative" six times, was
    // asked for a name and date of birth each time, refused three times, and
    // the call ended after 125 seconds — no tool call, no handoff, no ticket,
    // no record that anyone had rung. 18:24: a verified patient asked to be
    // connected, heard "still trying the office for you — hang tight", and
    // the call ended at eight minutes with the same silence.
    //
    // An agent that talks to someone for a minute and calls NOTHING is the
    // strongest dead-end signal there is, not an exemption from the check.
    // The old guard read "no evidence" as "nothing happened", which is the
    // same mistake the deleted-timeline bug made.
    //
    // A genuine hangup still files nothing: the floor is the difference
    // between a caller who never engaged and one who was failed. Today's
    // ghost call ran 19 seconds; the two real dead ends ran 125 and 482.
    if (!events || events.length === 0) {
      const metaForEmpty = callMetadataForDB.get(callId);
      // A ticket already exists for this call → the caller was NOT left with
      // nothing, whatever the timeline says. On 2026-07-30 this sweep told
      // staff to call Luis Navarro back "because nothing was done", while
      // ticket VA-46844 from that same call was already in their queue.
      if (metaForEmpty?.dbCallLogId) {
        try {
          const { storage } = await import('../../server/storage');
          const existing = await storage.getCallLog(metaForEmpty.dbCallLogId);
          if (existing?.ticketNumber) {
            console.info(`[AZUL-SCHED] SWEEP: call ${callId} has no tool events but already produced ticket ${existing.ticketNumber} — nothing to file`);
            return;
          }
        } catch { /* fall through: a store hiccup must not suppress a real dead end */ }
      }
      // Wall clock from call start to sweep time is NOT the caller's time on
      // the line — the realtime session lingers after they hang up and caps
      // out, which is why every one of the 07-30 false tickets read exactly
      // "601 seconds". Prefer the transcript window; fall back to wall clock
      // only to apply the floor, and never quote a number we can't stand
      // behind.
      const wallSeconds = metaForEmpty?.startTime
        ? (Date.now() - metaForEmpty.startTime.getTime()) / 1000
        : 0;
      if (wallSeconds < ZERO_TOOL_DEAD_END_SECONDS) return; // ghost call / immediate hangup
      console.warn(
        `[AZUL-SCHED] SWEEP: call ${callId} called NOTHING — ` +
          `the caller was spoken to and nothing was done for them; filing a ticket`,
      );
      await fileLocationQueueTicket(
        {
          handoffReason: 'unresolved_call_end',
          patient: { name: metaForEmpty?.callerName, phone: metaForEmpty?.from },
          callContext: {
            reasonForCall:
              `The scheduling assistant took NO action on this call — no lookup, no booking, no transfer, ` +
              `no ticket. The caller was talking to someone and got nowhere. ` +
              `Please call them back and find out what they needed.`,
          },
        },
        '{}',
        { callId, callSid: metaForEmpty?.twilioCallSid },
      );
      return;
    }
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


// ─────────────────────────────────────────────────────────────────────────
// Agent factory
// ─────────────────────────────────────────────────────────────────────────


export const azulSchedulingAgentConfig = {
  slug: 'azul-scheduling',
  name: 'Azul Vision NextGen Scheduling Agent',
  description:
    'NextGen scheduling line (San Diego pilot) — rules-engine-gated booking via the Eye Care service; lookup, cancel, and handoff.',
  version: AZUL_AGENT_VERSION,
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

  /** Calls whose identity the SERVER confirmed. Drives the sage_handoff
   *  fallback below; independent of the director, which can be switched off. */
  const verifiedThisCall = (): boolean =>
    !!metadata?.callId && azulVerifiedCalls.has(metadata.callId);

  /** Execute on the Eye Care service AND record to the pilot tool timeline. */
  const tracked = async (name: string, args: Record<string, unknown>): Promise<string> => {
    /**
     * Tell the director the SERVER verified this caller.
     *
     * Synchronous, and deliberately NOT inside stampVerifiedIdentity: that one
     * returns early without a callLogId and awaits a DB write, while this must
     * land before the agent's very next line. Until 2026-08-04 the director had
     * no access to this verdict at all — it inferred identity from a regex over
     * the transcript and cancelled the agent mid-sentence at `author` when the
     * inference disagreed with the server. It disagreed on 22 of 54 verified
     * calls on 08-03 and 3 of 6 on 08-04.
     */
    const markDirectorVerified = (resultJson: string): void => {
      const callId = metadata?.callId;
      if (!callId) return;
      try {
        let parsed: any = JSON.parse(resultJson);
        parsed = parsed?.result ?? parsed; // {tool, result} envelope
        if (parsed?.verified !== true) return;
        // Record the verdict FIRST and unconditionally. sage_handoff's identity
        // fallback depends on it, and DIRECTOR_AGENTS is a kill switch that must
        // not take unrelated behaviour down with it.
        azulVerifiedCalls.add(callId);
        // Call-facts ledger (CP-2): identity becomes a locked constant.
        void import('../services/callFactsLedger').then(({ updateLedger }) =>
          updateLedger(callId, { firstName: parsed.firstName, lastName: parsed.lastName, identityVerified: true }),
        );
        if (!directorEnabledFor('azul-scheduling')) return;
        // The ON-FILE spelling too: the prompt tells the agent to adopt it from
        // then on, and the caller may never have pronounced it.
        director.markIdentityVerified(callId, 'azul-scheduling', [
          parsed.firstName,
          parsed.lastName,
        ]);
      } catch (e) {
        console.error('[AZUL-SCHED] director identity mark failed:', e);
      }
    };

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
      if (name === 'verify_patient_identity') {
        markDirectorVerified(result);
        void stampVerifiedIdentity(result);
      }
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
    execute: async (args) => {
      const raw = await tracked('sage_availability', compact({ ...args, callId: metadata?.callId }));
      // S6: day-mismatch admission comes FIRST (rewrites the 'say' directive).
      const { acknowledgeDayMismatch } = await import('../services/toolDirection');
      return acknowledgeDayMismatch(raw, (args as { preferredDate?: string }).preferredDate);
    },
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
      guardAppointmentOrdinal(metadata?.callId, 'sage_reschedule', args.appointmentOrdinal) ??
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
      guardAppointmentOrdinal(metadata?.callId, 'sage_confirm_appointment', args.appointmentOrdinal) ??
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
      patientName: z.string().optional().describe('ONLY when identity could NOT be verified this call (e.g. caller gave a name but verification failed). For a VERIFIED caller, OMIT — the server injects the verified identity itself and re-collecting it from the caller is the loop this system is being hardened against.'),
      patientDob: z.string().optional().describe('ONLY for unverified callers, and only if already given. NEVER re-ask a verified caller for their date of birth at handoff.'),
      patientPhone: z.string().optional().describe('Only if the caller gave a DIFFERENT callback number — their caller ID is attached automatically.'),
      reasonForCall: z.string().optional().describe('ALWAYS write in English, even if the caller speaks another language (forwarded to English-speaking staff).'),
      requestedLocation: z.string().optional(),
      requestedTimeframe: z.string().optional(),
      urgencyScreenResult: z.string().optional().describe('ALWAYS write in English regardless of the caller\'s language.'),
      patientResponse: z.string().optional().describe('ALWAYS write in English regardless of the caller\'s language — summarize/translate what the caller said.'),
    }),
    execute: async (args) => {
      const { patientName, patientDob, patientPhone,
        reasonForCall, requestedLocation, requestedTimeframe,
        urgencyScreenResult, patientResponse, ...rest } = args;

      // IDENTITY FOR THE PACKET. The server rejects an anonymous handoff with
      // `identity_required` — 24 refusals between 07-24 and 08-03, every one of
      // them a caller who had asked for a person and got silence instead. The
      // policy, and the catch-22 behind it, is in services/azulToolGuards.
      const verified = verifiedThisCall();
      const { name: effectiveName, dob: effectiveDob } = handoffIdentity({
        verified,
        patientName,
        patientDob,
        attempt: metadata?.callId ? lastIdentityAttempt(metadata.callId) ?? null : null,
      });

      const identityRefusal = checkHandoffIdentity({
        verified,
        name: effectiveName,
        priorRefusals: metadata?.callId ? handoffIdentityRefusals.get(metadata.callId) ?? 0 : 0,
      });
      if (identityRefusal) return refusalJson('sage_handoff', identityRefusal);

      const result = await tracked('sage_handoff', compact({
        ...rest,
        patient: compact({
          name: effectiveName,
          dob: effectiveDob,
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
        patient: { name: effectiveName, dob: effectiveDob, phone: patientPhone ?? metadata?.callerPhone },
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

      // Remember an identity refusal so the next identical attempt is stopped
      // here rather than costing the caller another round trip of silence.
      if (parsed?.error === 'identity_required' && metadata?.callId) {
        handoffIdentityRefusals.set(
          metadata.callId,
          (handoffIdentityRefusals.get(metadata.callId) ?? 0) + 1,
        );
      }

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
        try {
          await handoffCallback();
        } catch (err) {
          console.error('[AZUL-SCHED] urgent handoff dial failed:', err);
          // Surface the failed dial to the model instead of implying the
          // on-call human is being connected. The tier-3 urgent ticket was
          // already filed above, so the patient request is not lost.
          return {
            ...(typeof result === 'object' && result !== null ? result : { result }),
            urgentEscalationDialed: false,
            error: 'urgent_escalation_dial_failed',
            instruction:
              'The on-call transfer could NOT be completed. Do not tell the caller they are being transferred. Tell them the on-call doctor will be paged with their message and will call them back, confirm their callback number, and advise calling 911 for emergencies.',
          };
        }
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
    execute: async (args) => {
      // Guard the ARGUMENTS before they leave, against the caller's own words.
      // Two things this stops, both from call 817162bf (2026-07-31): a date of
      // birth the model reassembled out of the caller's digits, and a retry
      // that resent a value which had already failed. Neither is detectable
      // downstream — the service only ever sees a name and a date that look
      // perfectly well-formed.
      // Grounding verdict: are these names traceable to the caller or to the
      // record the phone matched? Recorded as a NON-PHI code so the shadow
      // (which never receives names) can flag wrong-patient risk. afb1e688.
      try {
        const grounding = checkIdentityGrounding(
          { firstName: args.firstName, lastName: args.lastName },
          callerSpeech(liveTranscriptFor(metadata?.callId)),
          metadata?.precontext,
        );
        if (grounding.code !== 'grounded') {
          recordAzulToolEvent(
            metadata?.callId ?? metadata?.callSid ?? '',
            'identity_grounding',
            {},
            JSON.stringify({
              decision: grounding.code,
              status: `${grounding.firstNameSource}/${grounding.lastNameSource}`,
            }),
            0,
            { callSid: metadata?.callSid, callLogId: metadata?.callLogId, agentSlug: 'azul-scheduling' },
          );
        }
      } catch { /* telemetry must never block a verification */ }

      const verdict = guardIdentityArgs(metadata?.callId, args, liveTranscriptFor(metadata?.callId));
      if (verdict.blocked) {
        console.warn(
          `[AZUL-SCHED] identity guard blocked verify (${verdict.telemetry.dobConflict ? 'dob-conflict' : 'repeat-attempt'}) on call ${metadata?.callId}`,
        );
        recordAzulToolEvent(
          metadata?.callId ?? metadata?.callSid ?? '',
          'verify_patient_identity',
          compact(args),
          JSON.stringify({ blocked: true, ...verdict.telemetry }),
          0,
          { callSid: metadata?.callSid, callLogId: metadata?.callLogId },
        );
        return JSON.stringify({
          verified: false,
          matchSignal: 'not-sent',
          agent_instruction: verdict.instruction,
        });
      }
      // callId stamps the verified identity on the server's call session —
      // sage_book/sage_new_patient_intake are gated to the person THIS call
      // verified (Phase 2 state machine).
      const raw = await tracked(
        'verify_patient_identity',
        compact({ ...args, inboundPhone: metadata?.callerPhone, callId: metadata?.callId }),
      );
      if (!verdict.note) return raw;
      try {
        return JSON.stringify({ ...JSON.parse(raw), agent_instruction: verdict.note });
      } catch {
        return raw;
      }
    },
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
    execute: async (args) =>
      guardAppointmentOrdinal(metadata?.callId, 'get_appointment_details', args.appointmentOrdinal) ??
      tracked('get_appointment_details', compact({ ...args, callId: metadata?.callId })),
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
    execute: async (args) =>
      guardAppointmentOrdinal(metadata?.callId, 'cancel_appointment', args.appointmentOrdinal) ??
      tracked('cancel_appointment', compact({ ...args, callId: metadata?.callId })),
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
          // Deliberate, successful hangup — SIP recovery must not transfer
          // this finished call; marked only on hangup success.
          markCallConcluded(callId, `terminate_call:${params.reason}`);
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
    instructions: () => buildAzulSchedulingPrompt(metadata),
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
