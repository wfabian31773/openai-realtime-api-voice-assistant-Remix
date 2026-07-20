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
import { recordAzulToolEvent } from '../services/azulToolTimeline';

const EYECARE_BASE_URL =
  process.env.EYECARE_SCHEDULING_BASE_URL ||
  'https://eyecare-scheduling-agent-wayne-fabians-projects.vercel.app';

// ─────────────────────────────────────────────────────────────────────────
// HTTP client — every scheduling tool executes on the Eye Care service.
// ─────────────────────────────────────────────────────────────────────────

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
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const r = await fetch(`${EYECARE_BASE_URL}/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
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

# Your role

Help patients schedule appointments, look up their upcoming appointments, cancel appointments, and answer questions about clinic locations and hours. Speak naturally and warmly — these are real patients, sometimes elderly, sometimes confused. Be patient, clear, and concise.

# Identity verification — MANDATORY before any patient-record action

Before looking up appointments, booking, cancelling, or anything touching a patient's record, verify the caller's identity with THREE pieces, gathered one at a time:
1. Last name
2. Date of birth (speak it back to confirm)
3. Last 4 digits of the phone number on file

Call verify_patient_identity with these. If verification fails, do NOT proceed with patient actions — apologize, ask them to double-check, and offer a callback if they can't verify.

You CAN answer general questions without verifying — clinic addresses, hours, whether a provider works at an office.

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
9. If Eye Care or NextGen is erroring, don't guess — sage_handoff with reason api_failure.

# Transfers and callbacks

When a handoff packet's routing includes a transfer number, tell the patient you're connecting them to the office. When routing is callback-only, set the expectation clearly: "Our team will call you back at this number, usually within the hour."

# Scheduling a new appointment — the only allowed flow

1. Verify identity. Then call sage_patient_context. Its flags are CONTEXT, not commands:
   - Upcoming appointment on file → mention it and ask if that's what they're calling about. Do not assume.
   - Recent surgery/post-op flag → keep it in mind, but FIRST ask what the patient needs. Only hand off to the surgical team if their request actually relates to surgery or post-op care. A patient with a post-op appointment on file who wants a routine exam gets the normal flow.
   - NEVER create a handoff or callback before the patient has told you what they want.
2. Ask what the visit is for. Run the urgent screening if not done.
3. sage_decision with intent "search" for that appointment type (+ office).
4. If allowed: sage_availability, then offer 2–3 of the returned options, one at a time.
5. Patient picks one → confirm it back → explicit yes → sage_book with the slot's fields VERBATIM.
6. booking_status "confirmed" → confirm warmly with date, time, office, provider. Anything else → rule 4 of the contract.

# NEW patients — registration + insurance intake (the flow when there is no chart)

A caller is a NEW patient when verify_patient_identity finds no match (and the details are confirmed correct), or when they say they've never been seen at Azul Vision. Then:

1. Set expectations in one sentence: "Happy to get you set up — I'll take a few details, then we'll pick a time."
2. Collect ONE AT A TIME: first and last name (spell back), date of birth, cell phone (offer the caller's number), and whether they'd like to be listed as male, female, or other.
3. PCP: "Do you have a primary care doctor?" If they know the name, note it exactly as stated. If they don't know or don't have one, that's fine — it defaults to NO PCP. Never press.
4. Insurance — be thorough but gentle, one question at a time:
   - "What insurance will you be using?" (health plan name)
   - "Is that an HMO or PPO plan, or is it Medicare or Medi-Cal?"
   - If HMO: "Which medical group is that through?" (important — always ask)
   - If Medicare: ask whether it's straight Medicare or a Medicare Advantage plan, and whether they have a supplement.
   - "If you have your insurance card handy, I can take the member ID — if not, no problem."
   - NEVER ask for a Social Security number. If offered, say you don't need it.
5. Call sage_new_patient_intake with everything collected. If it reports a duplicate chart, the caller is an EXISTING patient — apologize briefly and continue with their existing record per the instruction.
6. The result includes earliest_bookable_date. Explain it positively: "Since you're new, our team verifies your insurance before your first visit — the earliest I can offer is [date]." Then run the NORMAL scheduling flow (sage_decision → sage_availability with their personId → sage_book). Do not offer or book anything earlier — the system will refuse.
7. Close with: their insurance will be verified before the visit, and if anything needs clarifying, the team will call them.

# Cancellation flow — strict confirmation gate

1. Verify identity if not yet verified.
2. get_patient_appointments with their personId; read upcoming appointments aloud, briefly.
3. Ask which one to cancel. Read back the FULL appointment (provider, office, date, time). Wait for an explicit verbal yes.
4. list_cancel_reasons (pick the patient-initiated reason), then cancel_appointment with a brief comment like "Patient called to cancel".
5. Confirm: "Done. I've cancelled that appointment. Anything else?"
If the cancel tool errors, apologize and offer a callback via sage_handoff.

# Ghost calls, robots, and dead air

- If there is silence after your greeting, prompt twice ("Hello, is anyone there?"). After 2–3 unanswered prompts, say a brief goodbye and call terminate_call with reason ghost_call.
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
}

export const azulSchedulingAgentConfig = {
  slug: 'azul-scheduling',
  name: 'Azul Vision NextGen Scheduling Agent',
  description:
    'NextGen scheduling line (San Diego pilot) — rules-engine-gated booking via the Eye Care service; lookup, cancel, and handoff.',
  version: '1.2.0',
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
    const result = await callEyecareTool(name, args);
    const ms = Date.now() - started;
    console.log(`[AZUL-SCHED] ${name} completed in ${ms}ms`);
    recordAzulToolEvent(metadata?.callId ?? metadata?.callSid ?? '', name, args, result, ms, {
      callSid: metadata?.callSid,
      callLogId: metadata?.callLogId,
    });
    return result;
  };

  // ── sage_* — the rules-engine-gated scheduling contract ────────────────

  const sageDecisionTool = tool({
    name: 'sage_decision',
    description:
      'MANDATORY GATE: ask Eye Care whether the AI may search, offer, or book a given appointment type (optionally at a location / with a provider). Call BEFORE any availability search or booking. Follow the returned decision and agent_instruction verbatim — never override it.',
    parameters: z.object({
      intent: z.enum(['search', 'offer', 'book']),
      eventName: z.string().describe("Appointment type name, e.g. 'Follow Up'."),
      locationId: z.string().optional().describe('Optional location GUID.'),
      providerId: z.string().optional().describe('Optional provider GUID.'),
    }),
    execute: async (args) => tracked('sage_decision', compact(args)),
  });

  const sagePatientContextTool = tool({
    name: 'sage_patient_context',
    description:
      'Consolidated patient context: identity match status, upcoming/last appointments, preferred office, and post-op flags — WITH instructions the agent must follow (multiple matches → disclose nothing; upcoming appointment → ask about it first; recent surgery → route to the surgical team).',
    parameters: z.object({
      lastName: z.string().optional(),
      firstName: z.string().optional(),
      dateOfBirth: z.string().optional().describe('YYYY-MM-DD'),
      personId: z.string().optional().describe('If already verified.'),
    }),
    execute: async (args) => tracked('sage_patient_context', compact(args)),
  });

  const sageAvailabilityTool = tool({
    name: 'sage_availability',
    description:
      'Rules-gated availability search. Returns ONLY options the AI is permitted to offer (gate runs first; blocked types return no options). Slots come back book-ready — pass their fields to sage_book verbatim. ALWAYS pass personId once the patient is known — new patients with pending insurance verification get their earliest allowed date enforced here.',
    parameters: z.object({
      eventName: z.string(),
      locationId: z.string().optional().describe('Optional location GUID.'),
      resourceId: z.string().optional().describe('Optional provider resourceId for provider-specific search.'),
      daysAhead: z.number().optional().describe('Search window, default 21.'),
      personId: z.string().optional().describe("Patient's personId — REQUIRED for new patients (eligibility floor)."),
    }),
    execute: async (args) => tracked('sage_availability', compact(args)),
  });

  const sageNewPatientIntakeTool = tool({
    name: 'sage_new_patient_intake',
    description:
      "Register a NEW patient (no existing chart): creates the NextGen chart with a real PCP (defaults to NO PCP when unknown) and opens an insurance-eligibility intake. Returns earliest_bookable_date — insurance verification needs a few business days, and availability/booking enforce it. Call ONLY after collecting full name, DOB, cell phone, sex, PCP (or confirmed unknown), and as much insurance detail as the caller can give. If it reports a duplicate chart, the caller is an EXISTING patient — follow the returned instruction.",
    parameters: z.object({
      firstName: z.string(),
      lastName: z.string(),
      dateOfBirth: z.string().describe('YYYY-MM-DD.'),
      cellPhone: z.string().describe("10+ digits — confirm the caller's number."),
      sex: z.string().describe('F | M | O.'),
      pcpName: z.string().optional().describe("PCP as stated. Omit if unknown — defaults to 'NO PCP'."),
      pcpProviderId: z.string().optional().describe('Real provider GUID from lookup_provider, if resolved.'),
      coverageType: z.string().optional().describe('HMO | PPO | Medicare | Medi-Cal | Medicare Advantage | other | unknown'),
      healthPlan: z.string().optional().describe('e.g. Blue Shield, Kaiser, IEHP, SCAN.'),
      medicalGroup: z.string().optional().describe('For HMO: which medical group — always ask.'),
      memberId: z.string().optional().describe('Member/subscriber ID if the caller has the card handy.'),
      secondaryCoverage: z.string().optional(),
      insuranceNotes: z.string().optional().describe('Anything else the caller shared about coverage.'),
    }),
    execute: async (args) => {
      const { coverageType, healthPlan, medicalGroup, memberId, secondaryCoverage, insuranceNotes, ...rest } = args;
      return tracked('sage_new_patient_intake', compact({
        ...compact(rest),
        insurance: compact({
          coverageType, healthPlan, medicalGroup, memberId, secondaryCoverage,
          notes: insuranceNotes,
        }),
        callId: metadata?.callId,
      }));
    },
  });

  const sageBookTool = tool({
    name: 'sage_book',
    description:
      "Rules-gated booking. Runs the decision gate, books in NextGen, then CONFIRMS the appointment exists before claiming success. The returned booking_status is the ONLY truth: 'confirmed' = booked; anything else means DO NOT tell the patient they are booked (on 'unknown' a scheduler callback has already been created — read the returned patient_script).",
    parameters: z.object({
      personId: z.string().describe("Verified patient's personId."),
      eventName: z.string(),
      slotDateTime: z.string().describe('From the availability slot, verbatim.'),
      locationId: z.string(),
      resourceIds: z.array(z.string()).describe('From the slot, verbatim.'),
      categoryId: z.string().optional(),
      duration: z.number().optional(),
      description: z.string().optional(),
    }),
    execute: async (args) =>
      tracked('sage_book', compact({ ...args, callId: metadata?.callId })),
  });

  const sageHandoffTool = tool({
    name: 'sage_handoff',
    description:
      "Create a handoff packet and get routing (queue/team, transfer number, patient script, staff summary). ALWAYS call this before transferring or promising a callback — no transfer without a packet. Urgent symptoms use handoffReason 'urgent_symptom' with method 'urgent_escalation'.",
    parameters: z.object({
      handoffReason: z.enum([
        'patient_requested_human', 'urgent_symptom', 'no_acceptable_availability',
        'patient_frustrated', 'api_failure', 'booking_status_unknown',
        'insurance_or_authorization_issue', 'surgery_or_post_op_issue',
        'existing_appointment_conflict', 'multiple_patient_matches',
        'patient_identity_uncertain', 'provider_specific_request',
        'diagnostic_or_resource_scheduling', 'queue_transfer_failure',
      ]),
      locationId: z.string().optional(),
      method: z.enum(['callback', 'cold_transfer', 'urgent_escalation']).optional(),
      patientName: z.string().optional(),
      patientDob: z.string().optional(),
      patientPhone: z.string().optional(),
      personId: z.string().optional(),
      reasonForCall: z.string().optional(),
      requestedLocation: z.string().optional(),
      requestedTimeframe: z.string().optional(),
      urgencyScreenResult: z.string().optional(),
      patientResponse: z.string().optional(),
    }),
    execute: async (args) => {
      const { patientName, patientDob, patientPhone, personId,
        reasonForCall, requestedLocation, requestedTimeframe,
        urgencyScreenResult, patientResponse, ...rest } = args;
      const result = await tracked('sage_handoff', compact({
        ...rest,
        patient: compact({
          name: patientName,
          dob: patientDob,
          phone: patientPhone ?? metadata?.callerPhone,
          personId,
        }),
        callContext: compact({
          reasonForCall, requestedLocation, requestedTimeframe,
          urgencyScreenResult, patientResponse, callId: metadata?.callId,
        }),
      }));

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

  // ── read + cancel tools (identity-gated on the service side) ───────────

  const verifyIdentityTool = tool({
    name: 'verify_patient_identity',
    description:
      "Verify a patient's identity using last name + date of birth + last 4 digits of their phone. Required before any patient-record action. Returns the patient's personId on success plus a matchSignal field — follow its guidance ('verified' = proceed; anything else = do not disclose records).",
    parameters: z.object({
      lastName: z.string().describe("Patient's last name."),
      dateOfBirth: z.string().describe('YYYY-MM-DD. Ask year, then month, then day; speak it back.'),
      phoneLast4: z.string().optional().describe('Last 4 digits of the phone number on file.'),
    }),
    execute: async (args) =>
      tracked('verify_patient_identity', compact({ ...args, inboundPhone: metadata?.callerPhone })),
  });

  const getPatientAppointmentsTool = tool({
    name: 'get_patient_appointments',
    description:
      "Get a verified patient's appointments (upcoming + optionally recent past), newest first, each with a derived outcome field. Use after identity verification for 'what's my next appointment' or before a cancellation.",
    parameters: z.object({
      personId: z.string().describe("Patient's personId from verify_patient_identity."),
      includePast: z.boolean().optional().describe('Include past appointments. Default false.'),
    }),
    execute: async (args) => tracked('get_patient_appointments', compact(args)),
  });

  const getAppointmentDetailsTool = tool({
    name: 'get_appointment_details',
    description:
      'Full record of a single appointment by appointmentId. Use before confirming a cancellation so you can read back exactly what is being cancelled.',
    parameters: z.object({
      appointmentId: z.string().describe('GUID of the appointment.'),
    }),
    execute: async (args) => tracked('get_appointment_details', compact(args)),
  });

  const listCancelReasonsTool = tool({
    name: 'list_cancel_reasons',
    description:
      'List the cancellation reason codes available in NextGen ({id, name} pairs). Call before cancel_appointment; pick the patient-initiated reason.',
    parameters: z.object({}),
    execute: async () => tracked('list_cancel_reasons', {}),
  });

  const cancelAppointmentTool = tool({
    name: 'cancel_appointment',
    description:
      'CANCEL an existing appointment. WRITE OPERATION — only after the patient has explicitly confirmed, out loud, the exact appointment being cancelled.',
    parameters: z.object({
      appointmentId: z.string().describe('GUID of the appointment to cancel.'),
      cancelReasonId: z.string().describe('GUID from list_cancel_reasons.'),
      comment: z.string().optional().describe('Brief note, e.g. "Patient called to cancel".'),
    }),
    execute: async (args) => tracked('cancel_appointment', compact(args)),
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
      "Where a provider generally sees patients (per-location counts of upcoming appointments). Use for 'where does Dr. X work'.",
    parameters: z.object({
      providerId: z.string().describe("The provider's GUID from lookup_provider (NOT the resourceId)."),
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

Always say a brief goodbye phrase BEFORE calling this tool.`,
    parameters: z.object({
      reason: z
        .enum(['ghost_call', 'robot_call', 'spam', 'max_turns_exceeded'])
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
      sageNewPatientIntakeTool,
      verifyIdentityTool,
      getPatientAppointmentsTool,
      getAppointmentDetailsTool,
      listCancelReasonsTool,
      cancelAppointmentTool,
      lookupLocationTool,
      listLocationsTool,
      lookupProviderTool,
      getProviderLocationsTool,
      terminateCallTool,
    ],
  });

  // Agent-level guardrails (same attachment pattern as noIvrAgent) — the
  // session-wide guardrails apply too; this is defense in depth.
  agent.outputGuardrails = medicalSafetyGuardrails;

  return agent;
}
