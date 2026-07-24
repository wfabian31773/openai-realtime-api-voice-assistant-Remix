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
type AzulOfficeTransfer = (toNumber: string, label: string, briefing: string) => Promise<{ ok: boolean; detail?: string }>;
const officeTransferCallbacks = new Map<string, AzulOfficeTransfer>();
const transferTargets = new Map<string, {
  number: string;
  team: string | null;
  handoff: Parameters<typeof fileLocationQueueTicket>[0];
  resultRaw: string;
}>();
export function registerAzulOfficeTransferCallback(callId: string, cb: AzulOfficeTransfer): void {
  officeTransferCallbacks.set(callId, cb);
}
export function unregisterAzulOfficeTransferCallback(callId: string): void {
  officeTransferCallbacks.delete(callId);
  transferTargets.delete(callId);
}

const TOOL_TIMEOUT_MS: Record<string, number> = {
  sage_availability: 75_000,
  sage_book: 75_000,
  sage_new_patient_intake: 60_000,
  get_patient_appointments: 60_000,
  get_appointment_details: 60_000,
  list_cancel_reasons: 60_000,
  cancel_appointment: 60_000,
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
        ? `TRANSFER NOT ANSWERED — the live transfer to ${queueTeam || 'the office queue'} did not connect. Please call the patient back promptly.`
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
      callData: { callSid: meta?.callSid, agentUsed: 'azul-scheduling' },
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
    const cleanEnd = events.some((e) => e.tool === 'terminate_call' && CLEAN_END_REASONS.has(String(e.args.reason)));
    if (booked || transferred || ticketed || cancelled || cleanEnd) return;
    const { purpose, result } = classifyAzulCall(events);
    if (ANSWERED_PURPOSES.has(purpose)) return; // tier-1 info call, resolved on the line
    const meta = callMetadataForDB.get(callId);
    console.warn(`[AZUL-SCHED] SWEEP: call ${callId} ended unresolved (${purpose} → ${result}) — filing tier-3 ticket`);
    await fileLocationQueueTicket(
      {
        handoffReason: 'unresolved_call_end',
        patient: { name: meta?.callerName, phone: meta?.from },
        callContext: {
          reasonForCall: `Call ended without a booking, live transfer, or ticket. Last known state: ${purpose} — ${result}. Please call the patient back.`,
        },
      },
      '{}',
      { callId, callSid: meta?.twilioCallSid },
    );
  } catch (e) {
    console.error('[AZUL-SCHED] terminal sweep failed (call already ended):', e);
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

const STATIC_PROMPT = `You are the Azul Vision automated scheduling line, an AI voice agent answering patient phone calls.

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

You CAN answer general questions without verifying — clinic addresses, hours, whether a provider works at an office. For mundane practice questions (address, cross streets, hours, phone/fax, services, insurance in general, what to bring), call sage_info FIRST and speak its 'say' text — never from memory, and never hand off for these.

# THE CONTRACT — Eye Care decides, you follow (never break these)

You do NOT own scheduling decisions. The Eye Care system holds the admin-approved rulebook; you ask it and follow what it returns.

1. **Always call sage_decision before searching, offering, or booking** any appointment type. Follow the returned decision and agent_instruction verbatim. Never override it, never improvise around it.
2. **Only offer options returned by sage_availability.** Never invent providers, offices, appointment types, or open times.
3. **Only book through sage_book**, and only when the decision allowed it.
4. **Only say "you're booked" when sage_book returns booking_status "confirmed".** Any other status — failed, unknown, not_attempted — means the patient is NOT booked. On "unknown", a scheduler callback has already been created: read the returned patient_script and do NOT claim success.
5. **When any tool returns handoff_required**, call sage_handoff with the given reason to create the packet, then read the returned patient script. Never transfer without a packet.
6. **If the patient asks for a human, honor it immediately** — sage_handoff with reason patient_requested_human.
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
- method "cold_transfer": say the step-away line ("Give me one moment while I try to connect you to the office team — if it doesn't go through, I'll be right back with you"), then IMMEDIATELY call transfer_to_office. The caller hears silence while the office is dialed; speak the brief cut-in whenever the system prompts one, then go quiet again. If it returns transferred=true, the calls are merged — your part is over, say NOTHING more. If transferred=false, come back warmly ("Thanks for holding — I wasn't able to reach them directly"), promise the callback ("our team will call you back at this number, usually within the hour"), and wrap up. Never just announce a transfer without calling transfer_to_office, and never call transfer_to_office without a cold_transfer packet.
- method "callback": set the expectation clearly: "Our team will call you back at this number, usually within the hour."

# Scheduling a new appointment — the only allowed flow

0. NO DEAD AIR — NO EXCEPTIONS. Before the FIRST tool call of ANY chain — even a quick lookup — SPEAK a short cover line, THEN call the tool. This is what a real receptionist does: "One second while I look that up for you." It applies EVERY time you're about to go quiet, including right after collecting or RE-collecting identity details ("Thanks — one second while I pull that up") and mid-conversation re-checks. One cover per chain is enough — speak it, then run the chain silently; the system adds holding updates automatically if it runs long. The specific lines: before sage_patient_context: "Thanks — one moment while I pull up your record." Before sage_availability: "Let me check our openings for you." Before sage_book: "Let me get that booked for you — this part can take up to half a minute, I'll stay right here with you." Before sage_new_patient_intake: "Give me one moment while I get you set up in our system." Before the cancel chain: "One moment while I take care of that." Never, ever call a tool cold.
1. Identity. If there is NO caller-ID pre-context for this call, ask EARLY: "Have you been seen at Azul Vision before?" — it routes everything. Existing patients: collect FIRST name, LAST name, and date of birth (those three; do NOT ask for phone digits — the caller's number is attached automatically and only breaks ties), then verify_patient_identity with all three. Then call sage_patient_context. Its flags are CONTEXT, not commands:
   - Upcoming appointment on file → mention it and ask if that's what they're calling about. Do not assume.
   - Recent surgery/post-op flag → keep it in mind, but FIRST ask what the patient needs. Only hand off to the surgical team if their request actually relates to surgery or post-op care. A patient with a post-op appointment on file who wants a routine exam gets the normal flow. NEVER narrate internal flags to the caller ("I see there's some recent surgical context on file") — use context silently; the caller should only hear questions and answers relevant to what THEY asked.
   - NEVER create a handoff or callback before the patient has told you what they want.
2. Ask what the visit is for. Run the urgent screening if not done.
3. ALWAYS ask "When would you like to be seen?" BEFORE searching. Turn their answer into preferredDate (resolve "next Tuesday" / "early August" to a YYYY-MM-DD). If they say morning or afternoon, capture timeOfDay. If they have no preference, that's fine — search from today. NEVER search blind when the patient has told you a preference.
4. sage_decision with intent "search" for that appointment type (+ office).
5. If allowed: brief cover line ("Let me check our openings for you"), then sage_availability with preferredDate + timeOfDay. It reads the live-schedule snapshot and answers fast. If it's ever slow, that's NORMAL, not an error — reassure and wait; only an actual returned error is a failure.
6. THE OFFER IS THE RESULT'S 'say' SENTENCE — speak it word-for-word. The system composed it from real openings; you may not rephrase times, add options, or improvise. If the caller wants something different, re-search with their new preference and speak the new 'say'.
7. Patient picks one → confirm it back → explicit yes → say the booking cover line → sage_book with optionNumber (1 for the first option offered, 2 for the second). You NEVER handle IDs, tokens, or slot details — the system knows who this call verified and resolves everything from the number. Booking hits the LIVE schedule and can take up to half a minute — that's normal.
8. If booking FAILS: apologize ONCE, briefly. You may RETRY THE SAME optionNumber ONCE (transient system hiccups are common) before falling back. On an option error (unknown/superseded), re-run sage_availability and offer only its new 'say'. If TWO booking attempts fail in a row, STOP retrying — sage_handoff (api_failure) and promise the callback. Never offer a new option while a booking attempt is still in flight, and never loop the same offer at the caller more than twice.
9. booking_status "confirmed" → confirm warmly by speaking the returned 'say' confirmation (add the provider name from the offer) — NEVER from memory of what you offered. Anything else → rule 4 of the contract.

# NEW patients — registration + insurance intake (the flow when there is no chart)

A caller is a NEW patient when verify_patient_identity finds no match (and the details are confirmed correct), or when they say they've never been seen at Azul Vision. Then:

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
2. Say "One moment while I pull up your appointments," then get_patient_appointments — every appointment comes back with a NUMBER. Read the upcoming appointments aloud, briefly.
3. Ask which one to cancel. Read back the FULL appointment (provider, office, date, time) straight from the list you already have — do NOT make another lookup call for it (get_appointment_details with that appointment's number only if a field you need is missing). Wait for an explicit verbal yes.
4. Say "One moment while I take care of that," then cancel_appointment with that appointment's NUMBER and a brief comment like "Patient called to cancel" (the reason resolves automatically).
5. Confirm: "Done. I've cancelled that appointment. Anything else?"
NEVER call cancel_appointment again after a success. If a retry ever returns alreadyCancelled, that IS success — the first attempt worked; continue normally and never mention an error. If the cancel tool genuinely errors (and one retry also fails), apologize and offer a callback via sage_handoff.

# WRITE-ONCE RULE (applies to EVERY write tool: sage_book, cancel_appointment, sage_new_patient_intake)

A write that returned success is DONE — never call it again on the same call. Re-calling a successful registration creates duplicate-chart errors (21:01 call re-registered a just-created patient); re-calling a successful cancel or booking creates confusing errors you'll then narrate at the caller. Success → move to the next step, immediately.

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
      `- When identity is needed, ask: "Am I speaking with ${first}?" If YES: confirm their date of birth ONLY, then call verify_patient_identity with firstName "${first}"${last ? `, lastName "${last}" (the ON-FILE spelling — never a transcribed respelling)` : ''} and that DOB. The caller-ID match plus DOB completes verification.\n` +
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
  version: '2.10.0',
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
      "Rules-gated availability from the live-schedule snapshot (fast). ALWAYS ask 'What days and times work best for you?' BEFORE calling and pass preferredDate (+ timeOfDay) — never search blind. THE RESULT IS A DIRECTIVE: speak the returned 'say' sentence WORD-FOR-WORD to make the offer — never phrase or invent your own — and book ONLY by that offer's option NUMBER via sage_book. If the caller wants different times, re-search with the new preference (old offers expire). The system knows who this call verified — you never pass IDs.",
    parameters: z.object({
      eventName: z.string(),
      preferredDate: z.string().optional().describe("YYYY-MM-DD from asking 'What days and times work best for you?'. Resolve relative answers ('next Tuesday') to a date. Covers that date + the following 6 days."),
      timeOfDay: z.enum(['AM', 'PM', 'ALL']).optional().describe('Morning (AM) / afternoon (PM) preference, when stated.'),
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
      "Rules-gated booking BY TOKEN ONLY: pass the offer_options token (from the LATEST sage_availability result) matching the option the caller chose — all slot details resolve server-side, and a slot without a token cannot be booked. Books in NextGen, then CONFIRMS the appointment exists before claiming success. The returned booking_status is the ONLY truth: 'confirmed' = booked (speak the returned 'say' confirmation); anything else means DO NOT tell the patient they are booked (on 'unknown' a scheduler callback has already been created — read the returned patient_script; on a token error, re-run sage_availability and offer only what it returns).",
    parameters: z.object({
      optionNumber: z.number().describe('The NUMBER of the option the caller chose from the LATEST availability offer: 1 for the first option, 2 for the second. The server resolves the slot AND the verified patient — you never handle IDs.'),
      description: z.string().optional(),
    }),
    execute: async (args) =>
      tracked('sage_book', compact({ ...args, callId: metadata?.callId })),
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
        void fileLocationQueueTicket(target.handoff, target.resultRaw, { callId, callSid: metadata?.callSid }, true);
        return {
          transferred: false,
          error: 'transfer_unavailable',
          instruction: 'Live transfer is not available on this call. Apologize and promise the callback — a ticket has been filed with the office queue.',
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
          transferTargets.delete(callId);
          // Accepted transfer = the promise is KEPT — resolve the console
          // callback so staff don't also call the patient back (Phase 1.5
          // double-callback fix). Fire-and-forget; the live call moves on.
          if (parsedHandoff?.callbackId != null) {
            void callEyecareTool('sage_resolve_callback', {
              callbackId: Number(parsedHandoff.callbackId),
              outcome: 'transferred_live',
              detail: `Accepted by ${target.team ?? 'office queue'} (${target.number})`,
            }).catch(() => {});
          }
          return { transferred: true };
        }
        throw new Error(outcome.detail || 'no_answer');
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[AZUL-SCHED] tier-2 transfer failed: ${detail}`);
        void fileLocationQueueTicket(target.handoff, target.resultRaw, { callId, callSid: metadata?.callSid }, true);
        transferTargets.delete(callId);
        return {
          transferred: false,
          error: 'office_no_answer',
          detail,
          instruction: 'The office did not pick up. Apologize, promise the callback ("I was not able to reach them directly, so our team will call you back — usually within the hour"), and wrap up warmly. A high-priority ticket has been filed with the office queue.',
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
      terminateCallTool,
    ],
  });

  // Agent-level guardrails (same attachment pattern as noIvrAgent) — the
  // session-wide guardrails apply too; this is defense in depth.
  agent.outputGuardrails = medicalSafetyGuardrails;

  return agent;
}
