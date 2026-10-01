import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { withToolDirection } from '../services/toolDirection';
import { medicalSafetyGuardrails } from "../guardrails/medicalSafety";
import { 
  scheduleLookupService, 
  PatientScheduleContext 
} from "../services/scheduleLookupService";
// LAZY IMPORT: callerMemoryService and SyncAgentService are loaded dynamically inside 
// agent factory/tool handlers to prevent module initialization errors during agent 
// instantiation (ticketingApiClient validation triggers in production)
import type { CallerMemory } from "../services/callerMemoryService";
import { URGENT_SYMPTOMS, getCurrentDateTimeContext } from "../config/knowledgeBase";
// The three presentations the symptom list above cannot express, because two
// of its entries are conditionals written as prose. See afterHoursTriage.ts.
import { renderTriagePrompt } from "../tools/afterHoursTriage";
import { recordingExecute } from "../services/toolTimeline";
// The queue lanes' "ask once, then file anyway" ruling (operator, 2026-09-04),
// which this lane never reached because it builds create_ticket by hand.
import { decideDobEscape, dobStatusNote, dobEscapeMarker, type DobStatus } from "../tools/dobEscape";
// One retry per call on a ticket-API timeout; keyed on the call SID like every
// other bounded ask in this repo.
import { gateRefusalsSoFar, noteGateRefusal } from "../tools/gateAttempts";
import { missingFieldsFromRefusal, spokenMissingFields } from "../services/missingFieldsRefusal";
import { AZUL_VISION_KNOWLEDGE, buildCompactLocationReference } from "../config/azulVisionKnowledge";
import { buildNoIvrGrokBody, noIvrPromptShape } from "./noIvrPromptForGrok";
import { getNextBusinessDayContext } from "../utils/timeAware";
import { type TriageOutcome } from "../config/afterHoursTicketing";
import { storage } from "../../server/storage";
import { escalationDetailsMap } from "../services/escalationStore";
import { judgeEscalation } from "../services/afterHoursEscalationGate";
import { corroborate } from "../services/symptomCorroboration";
import { markCallConcluded } from "../services/callConclusion";
import { callMetadataForDB } from "../services/callMetadataStore";

/**
 * AN EMAIL PREFERENCE WITHOUT AN ADDRESS IS A QUESTION, NOT A FAILURE.
 *
 * `CA42f5b35d3924b8a1e5e66c00ee927742`, no-ivr, 2026-09-27 20:48 UTC, 217 s,
 * 14 caller lines. A reschedule request; the caller asked to be reached by
 * email and spelled the address out on the call. The model called
 * `create_ticket` with `preferred_contact: "email"` and no `email` argument.
 * The ticketing app requires `patientEmail` when the contact method is email
 * (its `voice-agent-ticket-service.ts`), refused the POST with HTTP 400, and
 * the refusal reached this handler in the app's own spelling — "Missing
 * required fields" — which nothing here matched. So it fell to the generic
 * branch and the agent said *"I'm experiencing a technical issue on my end
 * right now. I have your information and our team will call you back."* No
 * ticket of any provenance exists for that call.
 *
 * 14-day control, `voice_agent_api_logs`: of the no-ivr POSTs carrying an
 * email preference, 8 were accepted (every one with an address) and 2 were
 * refused for `patientEmail`. Small, and each one is a request lost after a
 * caller has spent three minutes on the phone.
 *
 * THE ASK IS BOUNDED THE WAY THE DATE-OF-BIRTH ASK IS: once per call, keyed on
 * the CallSid through `gateAttempts`, and on the next attempt the request
 * FILES — for a phone callback at the number already on it, with a note for
 * the staffer. A missing email must never hold a request; the callback number
 * is required on every call and the app accepts a phone preference with it.
 * The caller's words never reach the note; the recording has them.
 *
 * THE NOTE SAYS WHAT THE CODE KNOWS AND NO MORE (Codex P2, #335): on the
 * corpus call the caller DID spell the address out, and the model sent no
 * `email` argument anyway. This handler cannot tell "the caller never gave
 * one" from "the model dropped it", so the note says no address reached the
 * TICKET and points the staffer at the recording, rather than claiming the
 * address was absent from the call — a claim that was false on the very call
 * this was written for, and that would have sent a staffer past an address
 * sitting in the recording.
 */
export const EMAIL_ASK_ONCE =
  "Missing required information: email address. The caller asked to be reached by EMAIL " +
  "and no address was sent, so the request cannot be filed that way yet. Ask ONCE, in " +
  "these words: \"What email address should we use? Please spell it out for me, letter " +
  "by letter.\" Then call create_ticket again with the address in the email field. If " +
  "they would rather not, or cannot, call create_ticket again with preferred_contact set " +
  "to \"phone\" — the callback number is already on the request. Nothing has failed: do " +
  "not apologise and do not say there was a problem.";

export const EMAIL_ESCAPE_NOTE =
  "CONTACT PREFERENCE: the caller asked to be reached by EMAIL, but no address reached " +
  "this ticket — filed for a PHONE callback at the number on this ticket. The caller may " +
  "well have given the address on the call; the recording has what they said.";

export function emailEscapeMarker(callSid: string): string {
  return `[EMAIL ESCAPE] create_ticket: asked once and still no email address reached the tool — `
    + `filing for a phone callback instead (${callSid})`;
}

const CONTEXT_LOOKUP_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const safePromise = promise.catch((err) => {
    console.error('[withTimeout] Promise rejected after potential timeout:', err);
    return fallback;
  });
  
  return Promise.race([
    safePromise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function phoneLast4(phone?: string): string {
  return phone ? `***${phone.slice(-4)}` : 'unknown';
}

function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : digits;
}

export type NoIvrAgentVariant = 'production' | 'development';

export interface NoIvrAgentMetadata {
  callId: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string; // Database call log ID for patient context updates
  variant?: NoIvrAgentVariant; // Production or development variant
  /** Caller-ID pre-context from the full person base (sage_precontext): who
   *  this number likely belongs to. A HINT for the opening turn — never
   *  verification, and never a substitute for what the caller tells us. */
  precontext?: import('./azulSchedulingAgent').AzulPrecontext;
  /** Live transcript up to the moment of filing — lets the ticketing app generate its staff-facing summary at creation instead of waiting for post-call enrichment. */
  getTranscript?: () => string;
  /** Set by the Grok runtime (voiceRuntime.ts) and by nothing else. Picks the
   *  prompt body written for that pipeline — see noIvrPromptForGrok.ts. */
  pipeline?: 'runtime';
}

// Operator mandate 2026-07-25: department-by-call-content, urgents-only in
// the After Hours queue. This agent (the PRODUCTION after-hours line) has
// always submitted through /api/voice-agent/submit-ticket, where the
// ticketing app's own router decides the department — but it never forwarded
// the triage category it collects, leaving routing to keyword guessing. A
// "Request Type:" header pins the unambiguous cases so the app's PRIORITY-1
// database lookup wins. Labels must match the afterHoursAgent map exactly.
/**
 * A REFUSED ESCALATION FILES THE TICKET.
 *
 * Operator, 2026-09-29: "fix the no-ivr refused escalation so it files a
 * ticket." The corpus is CA05daa62fd6c7156a322ea4810d590923 (00:09 UTC that
 * morning, 417 seconds, 26 caller lines): escalate_to_human was refused twice
 * by the gate in under 3 ms, the agent then said TWICE that it would connect
 * the caller with the on-call team, create_ticket never ran, and the call
 * ended on terminate_call with no ticket of any provenance. Over the fourteen
 * days before it, 9 after-hours calls had an escalation refused and 3 of them
 * left no ticket — every one of the 3 spoke a promise to connect and never
 * called create_ticket. The refusal's directive already SAID "call
 * create_ticket now"; a directive is a sentence the model may obey. So the
 * refusal now files the ticket itself, from the escalation's own arguments
 * plus caller ID, and its result tells the model what has ALREADY happened
 * and what to say — never a transfer it cannot make.
 *
 * WHAT IT FILES: the reason the model gave (with symptoms and provider lines
 * where it gave them), the name and date of birth if collected, the callback
 * number or the caller ID, and a note in additionalDetails saying the
 * escalation was asked for and not sanctioned. Never at the head of
 * reasonForCalling: the `Request Type:` header rule (operator, 2026-07-25).
 * On `symptoms_not_stated_by_caller` the reason is NOT the model's — that
 * arm exists because the model wrote symptoms the caller never said, and
 * the on-call provider acts on what is written — so the ticket says the
 * claims were uncorroborated and points a staffer at the recording.
 *
 * WHAT IT DOES NOT DO: it does not make the escalation succeed (the three
 * cases are the operator's, unchanged), it does not page anybody, and it
 * does not open a second ticket beside one the model already filed —
 * submitSimplifiedTicket sends `idempotencyKey: call-<sid>`, so a call that
 * already holds a ticket gets that ticket's number back. A later
 * create_ticket on the same call returns the same cached ticket; the
 * post-call sync then carries the whole transcript onto it, so nothing the
 * caller says afterwards is lost to the team.
 *
 * WHAT IT SAYS: the spoken line carries no promise of a connection and names
 * where the callback goes — the number they gave, this number, or a question
 * for one when neither is known (a withheld caller ID arrives as a WORD, the
 * v40 lesson, so "known" means ten digits and not a truthy string).
 */
export type RefusedEscalationCode =
  | 'communication_failure'
  | 'administrative_request'
  | 'symptoms_not_stated_by_caller';

export const REFUSED_ESCALATION_WHY: Record<RefusedEscalationCode, string> = {
  communication_failure:
    'not being able to collect a detail is not an emergency, and this line does not transfer for it',
  administrative_request:
    'this is a routine request however urgently the caller phrased it, and this line transfers only for ' +
    'an eye emergency or a clinician calling about a patient',
  symptoms_not_stated_by_caller:
    'the caller did not describe the symptoms you wrote, and the on-call provider acts on what you write',
};

export const REFUSED_ESCALATION_LINE = {
  gave:
    "I'm not able to put you through to the on-call team for this, but I've logged your message and " +
    'our team will call you back at the number you gave me.',
  callerId:
    "I'm not able to put you through to the on-call team for this, but I've logged your message and " +
    'our team will call you back at this number.',
  none:
    "I'm not able to put you through to the on-call team for this, but I've logged your message. " +
    'What is the best number to reach you on?',
} as const;

export function refusedEscalationNote(code: RefusedEscalationCode): string {
  return (
    `ESCALATION REQUESTED, NOT SANCTIONED (${code}): the caller asked for the on-call team. ` +
    'This line transfers only for an eye emergency or a clinician calling about a patient. ' +
    'Filed automatically at the refusal so the request is not lost.'
  );
}

/** Ten digits or nothing — "anonymous" is a word, not a number (v40). */
export function knownNumber(value: string | undefined): boolean {
  return (value ?? '').replace(/\D/g, '').length >= 10;
}

export type RefusedEscalationFiling =
  | { ok: true; ticketNumber?: string }
  | { ok: false; error?: string };

/**
 * The tool result for a refused escalation. `message` is this agent's
 * model-facing channel (its quoted sentences are what gets spoken — see
 * noIvrFalseFailure.test.ts's control), so it carries the instruction, the
 * line to say, and never a promise of a connection.
 */
export function refusedEscalationResult(args: {
  code: RefusedEscalationCode;
  filed: RefusedEscalationFiling;
  number: 'gave' | 'callerId' | 'none';
}): {
  success: false;
  refused: RefusedEscalationCode;
  ticket_filed: boolean;
  ticketNumber?: string;
  message: string;
} {
  const { code, filed, number } = args;
  const why = REFUSED_ESCALATION_WHY[code];
  const noPromise =
    'Do NOT say you will connect, transfer or put anyone through — no transfer is happening.';
  const onceMore =
    code === 'symptoms_not_stated_by_caller'
      ? ' Ask ONE question at a time and wait for a real answer; if the caller then describes an ' +
        'emergency in their own words — vision loss, severe pain, an injury, chemical exposure — ' +
        'you may call escalate_to_human once more.'
      : '';
  if (filed.ok) {
    const ticket = filed.ticketNumber ? ` (${filed.ticketNumber})` : '';
    const afterLine =
      number === 'none'
        ? ' When they give a number, read it back one digit at a time; it reaches the team with ' +
          "this call's transcript."
        : '';
    return {
      success: false,
      refused: code,
      ticket_filed: true,
      ...(filed.ticketNumber ? { ticketNumber: filed.ticketNumber } : {}),
      message:
        `Escalation is not available: ${why}. A ticket has ALREADY been filed for this caller with ` +
        `what you gave me${ticket}. Do NOT call create_ticket for this request. ${noPromise} ` +
        `Say: "${REFUSED_ESCALATION_LINE[number]}"${afterLine} Then ask if there is anything else.` +
        onceMore,
    };
  }
  const error = filed.error ? ` (${filed.error})` : '';
  return {
    success: false,
    refused: code,
    ticket_filed: false,
    message:
      `Escalation is not available: ${why}. The ticket could NOT be filed automatically${error}, so ` +
      `nothing is on record yet. ${noPromise} Call create_ticket now with whatever you have, and ` +
      'only after it returns success=true tell the caller their message is going to the team and ' +
      'someone will call them back.' +
      onceMore,
  };
}

/**
 * THE URGENT TRANSFER RECORD BESIDE A REFUSED-ESCALATION TICKET (Codex P1 on
 * #339, 2026-09-29).
 *
 * A refusal files under the call's own key, and that key is what makes a later
 * `create_ticket` return the same ticket. It would ALSO have made the
 * sanctioned path's urgent record return it: `submitSimplifiedTicket`'s
 * per-call claim hands back the existing number without posting. So a caller
 * refused first (a symptom the agent invented, a detail it could not collect)
 * who then described the emergency in their own words and WAS connected would
 * have ended the call with ONE ticket — the refusal's, reading NOT SANCTIONED
 * at normal priority, with no word that a transfer happened. Measured
 * 2026-09-29 over thirty days of no-ivr: 26 calls had an escalation refused,
 * and 3 of them went on to a sanctioned transfer on the same call.
 *
 * So the record files BESIDE the earlier ticket, under its own key, and says
 * what the earlier one still is: on the uncorroborated-symptoms arm the
 * model's own sentence, now superseded; on the other two arms the caller's
 * request, which still stands. Keyed on the call id like the escalation map;
 * ticket numbers and codes only, never a caller's words.
 */
export interface RefusedEscalationRecord {
  ticketNumber: string;
  code: RefusedEscalationCode;
}

const refusedEscalationTicketByCall = new Map<string, RefusedEscalationRecord>();
const REFUSED_ESCALATION_TICKETS_CAP = 500;

export function rememberRefusedEscalationTicket(callId: string, record: RefusedEscalationRecord): void {
  if (refusedEscalationTicketByCall.size >= REFUSED_ESCALATION_TICKETS_CAP) {
    const oldest = refusedEscalationTicketByCall.keys().next().value;
    if (oldest !== undefined) refusedEscalationTicketByCall.delete(oldest);
  }
  refusedEscalationTicketByCall.set(callId, record);
}

export function refusedEscalationTicketFor(callId: string): RefusedEscalationRecord | undefined {
  return refusedEscalationTicketByCall.get(callId);
}

/** What the urgent record says about the ticket the refusal already filed. */
export function transferRecordCrossReference(earlier: RefusedEscalationRecord): string {
  const t = earlier.ticketNumber;
  if (earlier.code === 'symptoms_not_stated_by_caller') {
    return (
      `SUPERSEDES ${t}: that ticket was filed automatically when a first escalation attempt was refused ` +
      'because the symptoms the agent wrote were not corroborated. The caller then described the emergency ' +
      `in their own words and WAS connected to the on-call provider. No callback is needed on ${t}.`
    );
  }
  return (
    `SEE ALSO ${t}: the caller's own request on this call, filed automatically when a first escalation ` +
    `attempt was refused (${earlier.code}). That request still stands and should be read with this one; ` +
    'this ticket records only that the caller was later connected to the on-call provider.'
  );
}

const CATEGORY_TO_REQUEST_TYPE: Partial<Record<string, string>> = {
  // Appointment family → Appointment Request (routes per the app's taxonomy).
  new_appointment: 'Appointment Request',
  confirm_appointment: 'Appointment Request',
  appointment_request: 'Appointment Request',
  reschedule_appointment: 'Appointment Request',
  cancel_appointment: 'Appointment Request',
  // Medication family → Medication Refill (routes to Technicians).
  medication_refill: 'Medication Refill',
  prescription_question: 'Medication Refill',
  // billing/insurance/general/test_results/message_for_provider/follow_up_care:
  // no header — the app's keyword router (incl. multilingual tables) decides.
};

function expandTwoDigitYear(shortYear: string): string {
  const yearNum = parseInt(shortYear, 10);
  return yearNum <= 29 ? `20${shortYear.padStart(2, '0')}` : `19${shortYear.padStart(2, '0')}`;
}

function parseDateOfBirth(dobString: string): {
  month?: string;
  day?: string;
  year?: string;
  raw: string;
  iso?: string;
} {
  const result: { month?: string; day?: string; year?: string; raw: string; iso?: string } = {
    raw: dobString,
  };

  // Standard m/d/y with slash, dash, space, or period separators
  const mmddyyyy = dobString.match(
    /(\d{1,2})[\/\-\s\.](\d{1,2})[\/\-\s\.](\d{2,4})/,
  );
  if (mmddyyyy) {
    result.month = mmddyyyy[1].padStart(2, "0");
    result.day = mmddyyyy[2].padStart(2, "0");
    result.year = mmddyyyy[3].length === 2 ? expandTwoDigitYear(mmddyyyy[3]) : mmddyyyy[3];
    result.iso = `${result.year}-${result.month}-${result.day}`;
    return result;
  }

  // STT-merged patterns: "112.37" or "112 37" → 1/12/37
  // Handles cases where STT drops the slash: "1/12/37" becomes "112.37"
  const mergedDotYear = dobString.trim().match(/^(\d{2,3})[\.\s](\d{2,4})$/);
  if (mergedDotYear) {
    const front = mergedDotYear[1];
    const back  = mergedDotYear[2];
    const fullYear = back.length === 4 ? back : expandTwoDigitYear(back);
    if (front.length === 3) {
      const month = front[0].padStart(2, '0');
      const day   = front.slice(1).padStart(2, '0');
      const m = parseInt(month, 10);
      const d = parseInt(day, 10);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        result.month = month; result.day = day; result.year = fullYear;
        result.iso = `${fullYear}-${month}-${day}`;
        return result;
      }
    }
  }

  // Six-digit run-together: MMDDYY e.g. "011237"
  const sixDigit = dobString.trim().match(/^(\d{6})$/);
  if (sixDigit) {
    const raw = sixDigit[1];
    const month = raw.slice(0, 2);
    const day   = raw.slice(2, 4);
    const year  = expandTwoDigitYear(raw.slice(4, 6));
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      result.month = month; result.day = day; result.year = year;
      result.iso = `${year}-${month}-${day}`;
      return result;
    }
  }

  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04",
    jun: "06", jul: "07", aug: "08", sep: "09",
    oct: "10", nov: "11", dec: "12",
  };

  const writtenDate = dobString
    .toLowerCase()
    .match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/);
  if (writtenDate) {
    result.month = months[writtenDate[1]] || writtenDate[1];
    result.day = writtenDate[2].padStart(2, "0");
    result.year = writtenDate[3];
    if (result.month && result.day && result.year) {
      result.iso = `${result.year}-${result.month}-${result.day}`;
    }
    return result;
  }

  return result;
}

function toIsoDob(dobString: string): string | undefined {
  const parsed = parseDateOfBirth(dobString);
  return parsed.iso;
}

/**
 * A schedule context that was matched on the calling number alone. The
 * pre-call lookup is always by phone (`lookupByPhone`), and the person-base
 * rung marks the same thing as `identityUnconfirmed`; either means nobody
 * has confirmed the caller is the patient on file.
 */
export function phoneMatchIsUnconfirmed(context: PatientScheduleContext): boolean {
  return context.matchedBy === 'phone' || context.identityUnconfirmed === true;
}

export function buildNoIvrSystemPrompt(
  metadata: NoIvrAgentMetadata,
  scheduleContext?: PatientScheduleContext,
  variant: NoIvrAgentVariant = 'production',
  callerMemory?: CallerMemory | null,
  callerHistorySection: string = "",
): string {
  const nextBizDay = getNextBusinessDayContext();
  const timeContext = getCurrentDateTimeContext();
  const { callerPhone } = metadata;
  const isProduction = variant === 'production';
  const versionString = isProduction ? '1.14.0' : '1.14.0-dev';

  let precontextSection = "";
  const pc = metadata.precontext;
  if (pc?.matched && pc.firstName) {
    precontextSection = `
===== CALLER-ID PRE-CONTEXT (a hint, NOT verification) =====
This phone number matches ONE person on file: first name "${pc.firstName}".

- DO NOT OPEN WITH A NAME CONFIRMATION, AND DO NOT SPEAK OVER THE GREETING.
  It carries the two things this line exists to say: that offices are closed,
  and that a medical emergency means calling 911 — plus the recording
  disclosure. On 2026-08-01 12:21 UTC this block caused the greeting to be cut
  off after the words "Thank you for calling", so a caller was never told to
  dial 911 in an emergency and was never told the call was recorded. That must
  never happen again. Never shorten it, never paraphrase it, and never say it
  a second time.
- This is an AFTER-HOURS MESSAGE-TAKING line, not a check-in desk. Do not
  open with an identity interview. Let the caller say why they are calling
  first, and handle urgency first if there is any.
- WHEN YOU DO NEED THEIR IDENTITY for the message or ticket, NEVER ask "could
  I get your name?" — you already have it. Say "am I speaking with
  ${pc.firstName}?" On the 13:35 UTC call the agent asked for the name cold
  even though this block was present; that is the failure mode to avoid.
  Then take the last name AND the date of birth IN ONE question, never one
  and then the other.
- CONFIRMING A FIRST NAME DOES NOT CONFIRM A LAST NAME. Take the last name in
  their own words. If it differs from what you expected, this number matched
  the WRONG person — use what THEY said and ignore this block from then on.
- READ THE DATE OF BIRTH BACK once you have it. A caller-ID match tells you
  nothing about a date of birth.
- Do NOT say we recognized their number. Do NOT speak a last name first.
- If they say NO, or are calling for someone else, discard this block and
  collect everything fresh for the ACTUAL patient.
- Disclose nothing from anyone's record on the strength of this match.
`;
  }

  let scheduleContextSection = "";
  if (scheduleContext?.patientFound && phoneMatchIsUnconfirmed(scheduleContext)) {
    /**
     * A PHONE MATCH IS A CANDIDATE, NOT AN IDENTITY — so the appointment
     * stays OUT of the prompt.
     *
     * Measured 2026-09-17 over nine days of substantive no-ivr calls (365):
     * the agent read an appointment on 81, and on 44 of those it did so
     * BEFORE any identity question at all — "I just wanna know my
     * appointment" answered with the date, time, office and doctor of
     * whoever the schedule matched to the calling number. The section this
     * replaces put those details in the prompt with "AFTER IDENTITY
     * CONFIRMED (in Phase 4): You MAY answer" underneath, and three of three
     * hand-read calls show the model reading the details first and asking
     * (or never asking) afterwards. A sequencing instruction was not a
     * gate. Withholding the text is.
     *
     * RULE ZERO step 2 and standing instruction 6: several people share a
     * phone, and an unvalidated candidate is not a match. The identity
     * standard is Phase 4's own — confirm the name from the schedule, then
     * the date of birth — and the details come back through lookup_schedule
     * once that is done, from the tool result rather than from memory.
     */
    const firstName = (scheduleContext.patientName ?? '').trim().split(/\s+/)[0] || 'the patient on file';
    console.log('[No-IVR Agent] PHONE MATCH IS A CANDIDATE — appointment details withheld from the prompt until the name and date of birth are confirmed');
    scheduleContextSection = `
===== PATIENT CONTEXT (PHONE MATCH — UNCONFIRMED, a candidate only) =====
This caller's number matched a patient record for a patient whose first name is ${firstName}.
That is a CANDIDATE, not an identity: several people share a phone, and nobody has
confirmed that the CALLER is that person. The appointment details are deliberately
NOT loaded here.

TO ANSWER ANY QUESTION ABOUT AN APPOINTMENT, A VISIT, A DOCTOR OR AN OFFICE:
1. Confirm identity first — "I was able to pull up a record. Is this for ${firstName}?",
   then their FULL name in their own words, then their date of birth (month, then
   day, then year) and read it back.
2. THEN call lookup_schedule(first_name, last_name, date_of_birth).
3. Read the appointment from the TOOL RESULT, never from memory.
If they say no, or are asking about someone else, collect THAT person's full name
and date of birth and look them up the same way. Never state a date, a time, an
office or a doctor's name before step 2 has returned.`;
  } else if (scheduleContext?.patientFound) {
    const formattedSchedule = scheduleLookupService.formatContextForAgent(scheduleContext);
    scheduleContextSection = `
===== PATIENT CONTEXT (LOADED - use as reference only) =====
${formattedSchedule}

NOTE: This data is ALREADY LOADED. Do NOT call lookup_schedule again unless identity was corrected.
Identity confirmation happens in Phase 4 per the workflow - do not repeat here.

AFTER IDENTITY CONFIRMED (in Phase 4):
- You MAY answer questions using this data (e.g., "Your appointment is on [date] at [time] with Dr. [provider]")
- Auto-populate location/provider preferences silently`;
  }

  // Format full phone for confirmation (e.g., "626-222-9400")
  const formatFullPhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    } else if (digits.length === 11 && digits.startsWith('1')) {
      return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return phone;
  };
  
  const phoneContext = callerPhone
    ? `CALLER PHONE: ${callerPhone} (formatted: ${formatFullPhone(callerPhone)})
This is the caller's phone number from caller ID. 
- Use this as the callback_number when calling create_ticket
- DO NOT ask "is that correct?" for the callback number during info gathering
- Only confirm the callback number ONCE - in Phase 5 as part of the final summary
- Always pass the full 10-digit number: "${callerPhone}"`
    : "CALLER PHONE: not available from caller ID. You must ask for their full 10-digit callback number.";

  // Patient lookup fallback for both production and dev
  const nameDobFallbackSection = `
===== MANDATORY SCHEDULE LOOKUP =====
⚠️ CRITICAL: You MUST call lookup_schedule when:
1. No CONFIRMED patient record was loaded at call start (the PATIENT CONTEXT section is
   missing, or says the phone match is UNCONFIRMED), AND
2. You have collected the patient's NAME and DATE OF BIRTH

TRIGGER PHRASES that require lookup_schedule:
- "the last doctor I saw" / "my usual doctor" / "the doctor I normally see"
- "my last appointment" / "when was my last visit"
- "I want to see the same doctor" / "I don't remember the doctor's name"

IMMEDIATELY after collecting name+DOB, if caller mentions past visits:
→ Call lookup_schedule(first_name: "[name]", last_name: "[name]", date_of_birth: "[DOB]")
→ WAIT for the result before responding about their history
→ Use the returned last_provider_seen and last_location_seen in your response

Example: caller gives a first name, a last name and a date of birth, then says
"I want to see the last doctor I saw"
→ Call lookup_schedule(first_name, last_name, date_of_birth) with what they said
→ If found: "I can see your last visit was with Dr. [provider] at [location]. I'll request that for you."
→ If not found: Follow the PATIENT NOT FOUND RECOVERY steps below.

**PATIENT NOT FOUND RECOVERY (when lookup_schedule returns found: false)**
When name+DOB lookup fails, DO NOT immediately say "I can't find you." Instead:

1. Ask: "Just to confirm — are you a new patient with us, or have you been seen at one of our offices before?"

2. IF EXISTING PATIENT:
   - Say: "Let me try looking you up again. Could you please give me your date of birth, starting with the month, then the day, then the year?"
   - Wait for them to say each part separately (e.g. "January... twelfth... nineteen thirty-seven")
   - Also retry with phone: lookup_schedule(phone: callerPhone)
   - If EITHER lookup succeeds → confirm their name and continue normally
   - If both fail → note "existing patient — not found in system, staff please verify" in the ticket details, and include their phone number

3. IF NEW PATIENT:
   - Do NOT attempt another lookup — proceed to collect their request details
   - Create the ticket normally; new patients do not need to be found in the system

⚠️ ALWAYS ask for the date of birth in parts — "starting with the month, then
the day, then the year". Said whole, the phone's speech recognition merges the
digits.

DO NOT say "the team can find it" or "based on your history" - USE THE TOOL to find it yourself!
`;

  // v1.11.0 Mandatory Ticket Enforcement - FORBIDDEN PHRASES block, explicit tool call sequence
  // v1.10.0 Simplified Enhancements - business logic now handled by tools
  const productionEnhancementsSection = `
===== CONVERSATION ENHANCEMENTS =====

📅 APPOINTMENT QUESTIONS (ANTI-REPETITION):
When schedule data is loaded, you CAN answer appointment questions directly:
- Confirmations: "Yes, your appointment is [date] at [time] with [provider]."
- No upcoming: "I don't see upcoming appointments. Would you like us to call you to schedule?"

⚠️ CRITICAL: Once you've stated appointment details, DO NOT REPEAT THEM.
- If caller asks again: "That's the same appointment I mentioned - [brief date only]."
- If caller corrects you: TRUST THE CALLER over your data. Say: "Thanks for clarifying."
- If data conflicts (you say Jan 12, they say April 22): Accept caller's info as correct.
- NEVER re-read the full appointment details more than once per call.

📋 OPEN TICKETS:
Use check_open_tickets tool before creating new tickets to avoid duplicates.
If caller has pending tickets, acknowledge them first.

🗣️ LANGUAGE:
- You speak English and Spanish. Start in English. Never assume a language
  from a name — read it from the caller's first substantive words (not
  "hello" or "hi").
- When the caller speaks Spanish, or asks for Spanish, continue in Spanish for
  the rest of the call — every question, confirmation and the wait line before
  create_ticket.
- Switch only if the caller switches. An English tool result, a medication
  name, a number or a word you did not catch is not a switch.
- Keep every tool ARGUMENT in English (names, dates, yes/no) whatever language
  you are speaking.
- Any other language — French, Chinese, Vietnamese, unrecognised, ambiguous —
  say in English that this line can help in English or Spanish, and continue
  in English.
- If asked "Do you speak Spanish?" in English → Ask: "Would you like to continue in Spanish?"

🚫 GHOST CALL & ROBOT/SPAM DETECTION — END THESE CALLS, NEVER ESCALATE:

⚠️ CRITICAL: Ghost calls and robot/spam calls MUST be ended gracefully. NEVER escalate them to the human agent. Waking up a human doctor at 1 AM for a robocall is unacceptable.

ROBOT/SPAM CALL INDICATORS (any 1 of these = end immediately):
- You hear IVR/automated system phrases: "press 1", "press 1 for", "press the pound sign", "for delivery options", "leave a message after the tone", "your call is important to us", "please hold", "for English press", "to speak to a representative", "our menu options have changed"
- The audio is clearly a pre-recorded message or another automated phone system bleeding through
- Caller produces completely random disconnected words with no coherent meaning across 3+ turns (e.g. "The ceiling" / "Seagulls" / "virus" / "in Michigan" — no sentence structure, no request, no coherence — not just an accent or ESL caller)
- Audio switches rapidly between 3+ languages with zero coherent message or request

ROBOT/SPAM PROTOCOL: say "We were unable to connect. Goodbye." then call
terminate_call with reason "robot_call".

GHOST CALL INDICATORS (any 2+ of these = ghost call):
- Only heard single syllables: "mm", "uh", "ok", "hi", background noise
- Caller hasn't stated any actual request or question
- Caller doesn't respond to direct questions
- Total conversation is just greetings with no substance after 3 prompts

GHOST CALL PROTOCOL — three turns, then out:
1. After first unclear response: "What can I help you with today?"
2. After second unclear response: "I'm having trouble hearing you. If you need assistance, please call back."
3. After third unclear response: say "Take care, goodbye." then call terminate_call with reason "ghost_call"

FOR BOTH: never create a ticket, and NEVER escalate to a human — not once, not
ever. A human cannot help someone who is not communicating, and a robocall must
never wake anyone. Never run either kind of call past 2-3 turns.

`;

  // Check for open tickets from caller memory (production and dev)
  const openTicketsContext = callerMemory?.openTickets?.length 
    ? `
===== OPEN TICKETS FOR THIS CALLER =====
This caller has ${callerMemory.openTickets.length} pending ticket(s): ${callerMemory.openTickets.join(', ')}
If they're calling about the same issue, acknowledge you see their previous request is being processed.
Avoid creating duplicate tickets for the same issue.
` : '';

  // THE GROK PIPELINE GETS THE PROMPT WRITTEN FOR IT (v76). Same rulings, the
  // shape xAI's Prompting Guide prescribes, under half the size; the body
  // below stays for the OpenAI SIP core until that pipeline is retired.
  // noIvrPromptShapeForGrok.test.ts holds both bodies to one list of rulings.
  if (noIvrPromptShape(metadata) === 'grok') {
    return buildNoIvrGrokBody({
      versionString,
      timeContext,
      nextBusinessDayPhrase: nextBizDay.contextPhrase,
      phoneContext,
      callerHistorySection,
      openTicketsContext,
      scheduleContextSection,
      precontextFirstName: pc?.matched && pc.firstName ? pc.firstName : null,
      urgentSymptomsList: URGENT_SYMPTOMS.symptoms.map((s) => `• ${s}`).join("\n"),
      triageBlock: renderTriagePrompt(),
    });
  }

  // PROMPT CACHING: Static content FIRST (cacheable prefix), dynamic context LAST
  return `You are the AFTER-HOURS AGENT for Azul Vision. VERSION: ${versionString}

===== INTERNAL WORKFLOW PLAYBOOK (FOLLOW THIS EXACTLY) =====

You have an internal checklist to track. Execute these phases IN ORDER. Track your progress silently.

PHASE 1: UNDERSTAND THE REQUEST
GOAL: Find out WHY they're calling
IF caller states need: Acknowledge and proceed to Phase 2
IF caller just says "hi": Ask "What can I help you with?"

🟢 SIMPLE QUESTION? (hours, location, fax) →
Answer directly, ask "Anything else?", END CALL
(Skip all remaining phases - no info collection needed)

🎤 IF CALLER ASKS FOR "VOICEMAIL":
Many callers expect old-fashioned voicemail systems.
REASSURE THEM: "I'm here to help! This call is being
recorded, and I'll make sure your message gets to the
right person. What would you like us to know?"
Then continue with the workflow to gather their info.

✓ EXIT when you know the reason OR simple question answered

PHASE 2: DETECT CALLER TYPE & THIRD-PARTY CALLS
LISTEN for these phrases (don't ask upfront):

🔴 THIRD-PARTY TRIGGER PHRASES:
"my mother", "my father", "my husband", "my wife"
"my daughter", "my son", "my child", "my parent"
"calling for [someone's name]", "calling about my..."

IF DETECTED → Confirm: "Are you calling on behalf of
someone else? What is the patient's name?"
→ Collect BOTH: Caller's name + Patient's name/DOB

🔴 PROVIDER CALL — IMMEDIATE ESCALATION REQUIRED:
Detect ANY of these signals immediately:
• Caller says "Dr.", "doctor", "nurse", "NP", "PA"
• "calling from a hospital / clinic / ER / office"
• "I need to page Dr. [name]" / "paging"
• "peer-to-peer" / "peer to peer"
• "I'm calling from [medical facility name]"
• Any caller identifying as a healthcare professional

⚡ DO NOT wait until you have collected all patient info.
The moment you detect a provider call:
1. Say: "I'll connect you with our on-call team now."
2. Call escalate_to_human(caller_type: "healthcare_
provider") immediately — pass whatever info you have.
Provider calls are time-sensitive — every second matters.

🟡 B2B / BUSINESS CALLER (optical lab, referring office,
outside vendor, other clinic or pharmacy):
"I'm calling from [lab/optical/office]", "this is [name]
at [business]", "we are a lab", "Bartley Optical",
"we need an invoice", "tint density", "lens order"

B2B PROTOCOL — DOB IS OPTIONAL FOR BUSINESS CALLERS:
- Collect: caller name, business name, patient name,
specific request/question, callback number
- If they don't have patient DOB: that's okay — note it
in the ticket as "DOB not available — B2B inquiry from
[business name]"
- DO NOT refuse to help or escalate just because DOB is
missing for B2B callers
- DO NOT keep asking for DOB after caller says they don't
have it — accept that and proceed to create the ticket

✓ EXIT when you know WHO the call is about

PHASE 3: ASSESS URGENCY (HANDLE MOST CALLS YOURSELF)

🚨 ESCALATE — type: healthcare_provider — NO EXCEPTIONS
Any healthcare provider — the Phase 2 signals — gets an IMMEDIATE handoff.
Full stop. Do not create a ticket instead.
→ Say: "I'll connect you with our on-call team now."
→ Call escalate_to_human immediately with whatever info you have.
  Do NOT delay to collect more info.

🚨 ESCALATE — type: patient_urgent_medical
TRUE MEDICAL EMERGENCIES ONLY — the URGENT SYMPTOMS list below is the list.

✅ HANDLE YOURSELF (create ticket — do NOT escalate):
• Appointments (confirm, schedule, reschedule, cancel)
• Medication refills, prescription questions
• Billing, insurance, payment questions
• General questions, office info, directions
• Leave a message FOR a doctor
• Follow-up appointments, post-op questions

⚠️  A PATIENT ASKING FOR A HUMAN OR FOR THE ON-CALL DOCTOR IS NOT AN
EMERGENCY — however they phrase it, however frustrated they sound.
Respond: "I understand. I can make sure the on-call doctor receives your
message and can call you back. Let me take down your information."
Then collect info and create a ticket. Do NOT escalate.

✓ Log with emit_decision tool (urgent/non-urgent)

PHASE 4: GATHER & CONFIRM PATIENT INFO
REQUIRED FIELDS for any action:
□ Patient FULL NAME (first AND last in ONE question)
□ Date of birth (REQUIRED for patients; OPTIONAL for B2B)
□ Callback number
□ Reason for call
□ Preferred contact method (phone, text, or email)
□ Request-specific details (ONLY if caller mentioned them)

⚠️ B2B CALLERS: If they say they don't have the patient DOB,
DO NOT keep asking — proceed with ticket using available
info and note "DOB unavailable — B2B call"

🟢 NAME COLLECTION - EFFICIENT APPROACH:
Ask: "What is your full name?" (NOT first, then last)
IF schedule data exists: "I was able to pull up a record.
Is this for [Name from schedule]?" then get DOB
IF name wrong: "What is your full name?"

📞 PREFERRED CONTACT METHOD:
Ask: "Would you prefer we call, text, or email you back?"
Use caller's answer in create_ticket contact_method field
IF EMAIL: "What email address should we use? Please spell
it out for me, letter by letter." → create_ticket email field.
No address = it cannot go by email: ask once, then offer a
phone callback instead. Never say anything failed.
IF caller history shows preference, confirm: "Last time
we reached you by [method]. Is that still best?"

🔵 IF THIRD-PARTY CALL:
Collect: Caller's name AND Patient's full name/DOB
"And what is YOUR name so we know who to ask for?"

⚠️  DO NOT assume or add details caller didn't mention!
If they said "appointment" - don't ask about pharmacy
If they said "refill" - then ask about medication/pharmacy

✓ EXIT when all required fields are gathered

PHASE 5: FINAL SUMMARY & VALIDATION
BEFORE calling create_ticket or escalate_to_human:

STEP 1 - CHECK (silently):
✓ Name? (first and last)
✓ DOB? (month, day, year)
✓ Callback? (full 10-digit number)
✓ Reason? (what they need)
✓ Contact preference? (phone, text, or email)
✓ Details? (medication name, appointment type, etc.)

IF ANY MISSING → Ask naturally: "I just need..."

STEP 2 - ONE FINAL SUMMARY (the ONLY confirmation):
"Alright, I have [Name], date of birth [DOB], callback
[phone], you prefer [contact method], and you need
[reason]. I'll pass this along."

⚠️  DO NOT ask "Is that correct?" or "Does that sound right?"
⚠️  Just state the summary and proceed to Phase 6
The caller will interrupt if something is wrong

DO NOT PROCEED until all fields are complete!

PHASE 6: TAKE ACTION (CREATE TICKET FOR 99% OF CALLS)
DEFAULT ACTION → create_ticket (handles all routine calls)
RARE EXCEPTION → escalate_to_human (TRUE emergencies only)

BEFORE TICKET
1. Call check_open_tickets to avoid duplicates
2. Then call create_ticket with collected info
3. WAIT for the tool response - it returns success/failure

AFTER create_ticket TOOL RESPONSE
⚠️ You MUST check the tool response before confirming:

IF tool returns success=true:
→ Say: "Your request has been submitted. Our [team] will
call you back at [phone]. Anything else?"
→ DO NOT read out the ticket number (it's too long)

IF tool returns success=false or error:
→ A failed tool is NOT an escalation case. See TICKET CONFIRMATION RULES
  below: missing fields means ask once and retry; a technical error means
  apologise, promise the callback, and end; a result that says another
  attempt is already in progress, or asks you to call it ONCE more, means
  do exactly that and say nothing about a failure. Never wake the on-call
  team because a tool failed.

❌ NEVER say "request submitted" or "passed your message"
UNLESS the tool returned success=true

ESCALATION — EXACTLY THREE CASES, NOTHING ELSE
1. A provider's office calling about a patient
2. A hospital, ER or urgent care calling about a patient
3. A TRUE eye emergency happening now: vision loss, severe
pain, injury, chemical exposure, flashes or floaters,
post-surgical trouble

NOT a transfer, however the caller phrases it:
❌ "urgent" appointment, refill, glasses, authorization, fax
❌ billing, insurance, records, office hours
❌ you could not hear them, could not get a date of birth,
could not understand the language, they would not answer
→ ALL of these are create_ticket with whatever you have.
Filing a partial ticket IS the job. Waking the on-call
provider because you missed a detail is not.

Call escalate_to_human FIRST — ONCE, never twice on one call — and
say nothing about connecting anyone until it answers. If it returns
success=true, say: "Based on what you're describing, I'm connecting you
with our on-call team right now." If it is refused, it has ALREADY filed
a ticket for the caller: say exactly what its message tells you to say,
and never say you will connect, transfer or put anyone through.

CLOSING (CRITICAL: SAY THIS ONLY ONCE)
After a SUCCESSFUL ticket, give the success line above — once. Promise only
that the right team will follow up. Never promise a recording, and never
promise what any individual will do.

If caller says no/goodbye/thanks/ok:
→ Give ONE short goodbye: "Great, have a good day!"
→ STOP - do NOT repeat ticket details or callback number

⚠️ ANTI-REPETITION: Once confirmed, NEVER repeat:
- Ticket details  - Callback number  - "We'll contact you"

===== URGENT SYMPTOMS (see Phase 3 for handling) =====
${URGENT_SYMPTOMS.symptoms.map((s) => `• ${s}`).join("\n")}
(Use emit_decision tool in Phase 3 when urgency is classified)

${renderTriagePrompt()}

===== REQUEST-SPECIFIC QUESTIONS =====

MEDICATION REFILL (always ask):
- "Which medication do you need refilled?"
- "And which pharmacy should we send it to?"

APPOINTMENT REQUESTS:
- "Are you calling to schedule a NEW appointment, reschedule an existing appointment, or confirm an EXISTING one?"

MESSAGE FOR PROVIDER:
- "Which doctor is this message for?"
- "What would you like me to include in the message?"

===== COMMUNICATION STYLE =====
- DO NOT narrate or explain your process to the caller
- WRONG: "Let me create a ticket for you" or "I'm going to transfer you now"
- RIGHT: Just do it naturally, confirm the outcome only
- ONE MANDATORY EXCEPTION — the create_ticket wait: immediately before EVERY create_ticket call you MUST say "Give me one moment while I get this submitted for you." Never call the tool silently. One line only, no system talk beyond it.
- When confirming details, do it conversationally (not as a checklist)
- Example: "Alright, I have you down as ${"{name}"}, date of birth ${"{DOB}"}, needing ${"{reason}"}. I'll pass this along."
- NEVER explain internal processes, handoffs, or system actions
- NEVER invent commitments — do not promise recordings, that "the doctor will receive" anything, or any specific staff action. The ONLY promise you make is that the right team will follow up / call back.

⚠️ CRITICAL - TICKET CREATION IS MANDATORY ⚠️
You MUST call create_ticket tool before ending non-urgent
calls. The tool call is what actually saves the request.
Saying "submitted" without calling the tool = PATIENT
REQUEST LOST FOREVER. This is a medical liability.

FORBIDDEN PHRASES (NEVER say without tool call)
❌ "Your request has been submitted"
❌ "I'll pass this along"
❌ "The staff will contact you"
❌ "Your message will be sent"
❌ "I've noted your request"
❌ "We'll get back to you"

CORRECT SEQUENCE (MUST FOLLOW)
1. Collect all required info (name, DOB, callback, reason)
2. Call check_open_tickets tool
3. Call create_ticket tool ← THIS IS NOT OPTIONAL
4. WAIT for tool response
5. IF success=true THEN say "Your request has been..."
IF error THEN follow TICKET CONFIRMATION RULES below — do NOT escalate

⚠️ YOU CANNOT SKIP STEP 3. The patient's request will be
lost if you don't call create_ticket before saying
anything about submission or staff contact.

TICKET CONFIRMATION RULES:
- ONLY say "your request has been submitted" AFTER create_ticket returns success=true
- NEVER claim success before calling the tool or if the tool returns an error
- If the create_ticket result says another attempt for this call is ALREADY IN PROGRESS, or asks you to call it ONCE more: that is NOT a failure. Do exactly what the result says, say nothing about a problem, and never speak the technical-issue line on that result.
- If create_ticket fails due to a TECHNICAL ERROR (system_error, api_timeout, validation error):
  → DO NOT escalate to human. This is a technical issue, not a medical emergency.
  → Say: "I'm sorry, I'm having a technical issue on my end right now. I have your information and our team will call you back at [callback number] as soon as possible."
  → Then end the call. Do NOT transfer to the on-call staff.
- If create_ticket fails due to MISSING REQUIRED FIELDS only:
  → Ask for the missing information and try once more
  → If it fails again, use the apologize-and-end approach above
- DO NOT read out the ticket number - just confirm submission

===== CONVERSATION RECOVERY =====
If audio is unclear: "I'm sorry, I didn't quite catch that. Could you please repeat?"
If unsure what they said: Don't guess - ask for clarification.

===== INTERRUPTION RECOVERY (CRITICAL) =====
When you're interrupted mid-sentence:
1. STOP speaking immediately and listen
2. REMEMBER what question you were asking (mentally note: "I need DOB")
3. After they finish, RETURN to your pending question if it wasn't answered
4. Track which required fields you still need - don't skip any

Example flow:
- You: "And what is your date of—"
- Caller: (interrupts) "I need to see my doctor as soon as possible"
- You: (acknowledge) "I understand. And what is your date of birth?"

NEVER just accept the interruption and move on if your question wasn't answered.
Keep a mental checklist: □ Name □ DOB □ Callback □ Reason □ Contact preference

===== CONFUSION & TIMEOUT GUARDRAILS =====
If caller seems confused, cannot answer basic questions, or is incoherent:

ASK FOR ALL FOUR: name + DOB + callback number + reason. They are what makes a
ticket useful — but a missing one is never a reason to lose the request. If you
cannot get one, file with what you have (see Phase 6).
MINIMUM FOR ESCALATION: caller must be a real human with a genuine need

- After 2 failed attempts to get the same information (2 asks TOTAL — the
  second already phrased differently; a THIRD ask is the loop callers hang
  up inside, and the server now counts your asks and will intervene):
  IF you have all 4 required fields (name, DOB, callback, reason):
    → "Let me note what you've shared." → call create_ticket → close
  ELSE IF caller has shown ANY coherent intent (mentioned a doctor, appointment, surgery, eye issue):
    → call escalate_to_human, and say nothing about connecting anyone until it
      answers: if it is refused it has ALREADY filed a ticket and tells you what to say
  ELSE (no coherent intent, just noise/gibberish/random words):
    → "We were unable to connect. Goodbye." → END THE CALL (do NOT escalate)

- A REFUSAL is an answer. If the caller declines to give an item ("No", "I
  don't want to"), that item is CLOSED for the rest of the call — never ask
  again. File the ticket with what you have (their phone number is attached
  automatically from caller ID) rather than losing the caller entirely.

- When the caller has ANSWERED a question, never ask it again — not to
  re-confirm their role, not "just to be sure", not in different words.

- If a "SERVER STATE CHECK" system message appears mid-call, it is the
  server's ledger of what you already asked — follow it exactly.

- If conversation goes in circles for 5+ minutes without progress:
  Same logic as above — escalate only if caller has shown genuine human intent

- If caller is speaking multiple languages or unintelligibly but has stated a real need:
  "I'm sorry, I'm having difficulty understanding. Can you try speaking slowly?"
  → After 2 more failed attempts: escalate_to_human (human can use other methods)
  
- If caller is speaking nonsense/random words with NO coherent need established:
  → This is a ghost call or robot call — END THE CALL, do NOT escalate

⚠️ NEVER abandon a real human caller who has a coherent medical or scheduling need
⚠️ DO end calls for robot callers, ghost calls, and spam — do NOT wake up humans for these
⚠️ A missing field is NOT a reason to escalate and NOT a reason to file nothing — file the partial ticket

===== HARD RULES =====
1. Follow 6-phase workflow (exit early only for simple questions)
2. Speak first before tool calls - never transfer silently
3. Match caller's language (default English)
4. ONE question at a time
5. NEVER provide medical advice, repeat greeting, or hand off to AI
6. ALWAYS ask "Anything else?" before ending
7. Don't confirm with "Is that correct?" - just state and proceed
8. Don't invent details caller didn't mention
9. Ask for FULL NAME in one question (not first/last separately)

===== ANTI-NARRATION (NEVER SAY THESE) =====
❌ "Let me take care of the next steps"
❌ "Now let me..." / "I'm going to..."
❌ "I've noted your information"
❌ "Let me create a ticket for you"
❌ "I'm looking up your information"
❌ "Let me check that for you"

✅ INSTEAD: do it silently, then state the RESULT — e.g. after a lookup,
"I can see your last visit was with Dr. [provider] at [location]."
The caller does not need to know HOW you are doing things, only the outcome.
(The ONE exception is the create_ticket wait line above, which you always say.)

===== STYLE =====
- Calm, warm, professional
- Brief responses (no filler)
- Patient and reassuring
- Never robotic
- Natural conversation flow

===== OFFICE LOCATIONS REFERENCE =====
When asked about office locations, addresses, or phone numbers, use ONLY the following verified data:

${buildCompactLocationReference()}

Hours, every office: ${AZUL_VISION_KNOWLEDGE.businessHours.standard}. When a caller asks when an office opens or closes, answer from the practice facts, including the office's own opening and closing time, exactly as written there. No ticket for an hours question. Every office is closed right now.

===== CURRENT CALL CONTEXT =====
${callerHistorySection}
${nameDobFallbackSection}
${productionEnhancementsSection}
${openTicketsContext}

${phoneContext}

TIME CONTEXT:
${timeContext}
Non-urgent callbacks will be made ${nextBizDay.contextPhrase}.
${precontextSection}${scheduleContextSection}`;
}

export async function createNoIvrAgent(
  handoffToHuman: () => Promise<void>,
  metadata: NoIvrAgentMetadata,
): Promise<RealtimeAgent> {
  // Lazy import callerMemoryService to prevent module initialization errors in production
  // Wrapped in try/catch to ensure agent factory NEVER throws - agent must always be created
  let callerMemoryService: typeof import("../services/callerMemoryService")["callerMemoryService"] | null = null;
  try {
    const module = await import("../services/callerMemoryService");
    callerMemoryService = module.callerMemoryService;
  } catch (err) {
    console.error("[No-IVR Agent] Failed to load callerMemoryService, continuing without caller memory:", err);
  }
  
  const { callId, callerPhone } = metadata;
  const phoneRef = phoneLast4(callerPhone);

  // D11 (2026-08-01): fleet-wide tool timeline. See the note in
  // answeringServiceAgent — this line recorded nothing before today, so a
  // call that promised a ticket and filed none was indistinguishable from one
  // that had nothing to file. Arguments are allow-listed in the timeline
  // module; recording cannot alter a tool's return value or throw into it.
  const timelineCtx = {
    callId,
    callSid: metadata.callSid,
    callLogId: metadata.callLogId,
    agentSlug: 'no-ivr',
  };
  const recordedTool: typeof tool = ((def: any) =>
    tool({
      ...def,
      // CP-3: the approved next line rides inside the tool result (script-listing §6).
      execute: withToolDirection('no-ivr', callId, def.name, recordingExecute(timelineCtx, def.name, def.execute)),
    })) as typeof tool;

  let scheduleContext: PatientScheduleContext | undefined;
  let callerMemory: CallerMemory | null = null;

  if (callerPhone) {
    console.log(`[No-IVR Agent] Parallel context lookup with ${CONTEXT_LOOKUP_TIMEOUT_MS}ms timeout for caller ${phoneRef}`);
    
    const emptySchedule: PatientScheduleContext = {
      patientFound: false,
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 0,
    };

    const [scheduleResult, memoryResult] = await Promise.allSettled([
      withTimeout(
        scheduleLookupService.lookupByPhone(callerPhone),
        CONTEXT_LOOKUP_TIMEOUT_MS,
        emptySchedule
      ),
      callerMemoryService 
        ? withTimeout(
            callerMemoryService.getCallerMemory(callerPhone),
            CONTEXT_LOOKUP_TIMEOUT_MS,
            null
          )
        : Promise.resolve(null),
    ]);

    if (scheduleResult.status === 'fulfilled' && scheduleResult.value?.patientFound) {
      scheduleContext = scheduleResult.value;
      console.log(`[No-IVR Agent] Schedule context loaded for ${phoneRef}:`, {
        upcomingCount: scheduleContext.upcomingAppointments.length,
        pastCount: scheduleContext.pastAppointments.length,
        hasLocation: !!scheduleContext.lastLocationSeen,
        hasProvider: !!scheduleContext.lastProviderSeen,
      });
      
      // Until v53 the phone match was written to the call row HERE as
      // patientFound + patientName — a CANDIDATE recorded as an identity
      // (RULE ZERO step 2; v47 withholds the same match from the prompt) —
      // and it never once landed anyway: `metadata.callLogId` is a getter the
      // transport backfills after session.connect(), so at factory time it
      // read undefined on every call (0 of 297 substantive no-ivr calls with
      // patient_found in the seven days to 2026-09-17). The row is written
      // from create_ticket, once a name and a date of birth have confirmed
      // who this is — see "THE RECORD REACHES THE AFTER-HOURS CALL ROW".
    } else {
      console.log(`[No-IVR Agent] No schedule context for ${phoneRef} (timeout or not found)`);
    }

    if (memoryResult.status === 'fulfilled' && memoryResult.value) {
      callerMemory = memoryResult.value;
      console.log(`[No-IVR Agent] Caller memory loaded for ${phoneRef}:`, {
        totalCalls: callerMemory.totalCalls,
        hasOpenTickets: callerMemory.openTickets.length > 0,
      });
    }
  }

  // Determine variant from metadata (default to production for backward compatibility)
  const variant: NoIvrAgentVariant = metadata.variant || 'production';
  const isProduction = variant === 'production';
  const versionString = isProduction ? '1.14.0' : '1.14.0-dev';
  const agentTag = isProduction ? 'NO-IVR-PROD' : 'NO-IVR-DEV';
  
  // Environment identification tag for call tracing
  const envTag = process.env.DOMAIN?.includes('replit.app') ? 'PRODUCTION-SERVER' : 'DEVELOPMENT-SERVER';
  const domainShort = process.env.DOMAIN?.substring(0, 40) || 'unknown';
  
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`[${agentTag} v${versionString}] AGENT JOINING CALL`);
  console.log(`[${agentTag} v${versionString}] Agent Variant: ${variant.toUpperCase()}`);
  console.log(`[${agentTag} v${versionString}] Server Environment: ${envTag}`);
  console.log(`[${agentTag} v${versionString}] Domain: ${domainShort}...`);
  console.log(`[${agentTag} v${versionString}] CallId: ${callId}`);
  if (isProduction) {
    console.log(`[${agentTag} v${versionString}] ✓ Name+DOB fallback lookup ENABLED`);
  }
  console.log("═══════════════════════════════════════════════════════════════");
  
  console.log("[No-IVR Agent] Creating agent:", {
    callId,
    hasCallerPhone: !!callerPhone,
    hasScheduleContext: !!scheduleContext?.patientFound,
    hasCallerMemory: !!callerMemory,
    previousCalls: callerMemory?.totalCalls || 0,
  });

  console.log(`[${agentTag}] CHECKPOINT 1: Creating tool definitions...`);

  const lookupScheduleTool = recordedTool({
    name: "lookup_schedule",
    description: `Look up patient appointment context by first name + last name + date of birth, or by phone.

WHEN TO USE:
- The caller has confirmed their full name and date of birth and asks about an
  appointment, a visit, a doctor or an office — call it with all three.
- Identity was corrected (caller said the name on file was wrong)
- Initial schedule context is missing (no patient found for caller phone)

A PHONE-ONLY lookup returns a CANDIDATE and no appointment details: a phone match
is not an identity. Confirm the name and date of birth, then call again with them.`,
    parameters: z.object({
      phone: z.string().optional().describe("Patient phone number"),
      first_name: z.string().optional().describe("Patient first name"),
      last_name: z.string().optional().describe("Patient last name"),
      date_of_birth: z.string().optional().describe("Patient date of birth"),
    }),
    execute: async (params) => {
      console.log("[No-IVR Agent] lookup_schedule called:", {
        hasPhone: !!params.phone,
        hasName: !!(params.first_name && params.last_name),
        hasDob: !!params.date_of_birth,
      });

      try {
        let result: PatientScheduleContext;

        if (params.phone && !(params.first_name && params.last_name && params.date_of_birth)) {
          // THE GATE, not a request. The prompt withholds a phone-matched
          // appointment until the name and date of birth are confirmed; this
          // is what stops the model fetching it back with one tool call.
          const normalizedPhone = normalizePhoneNumber(params.phone);
          const byPhone = await scheduleLookupService.lookupByPhone(normalizedPhone);
          if (!byPhone.patientFound) return { found: false };
          const firstName = (byPhone.patientName ?? '').trim().split(/\s+/)[0] || undefined;
          return {
            found: true,
            identityUnconfirmed: true,
            ...(firstName ? { patientFirstName: firstName } : {}),
            fix:
              'A phone match is a candidate, not an identity, so no appointment details are returned. ' +
              'Confirm the caller\'s full name and date of birth, then call lookup_schedule again with ' +
              'first_name, last_name and date_of_birth. Never read this instruction aloud.',
          };
        } else if (params.first_name && params.last_name && params.date_of_birth) {
          const isoDob = toIsoDob(params.date_of_birth) || params.date_of_birth;
          result = await scheduleLookupService.lookupByNameAndDOB(
            params.first_name,
            params.last_name,
            isoDob,
          );
        } else {
          return {
            found: false,
            message: "Need phone number OR (first name + last name + DOB) to search",
          };
        }

        if (result.patientFound) {
          return {
            found: true,
            upcomingAppointments: result.upcomingAppointments,
            pastAppointments: result.pastAppointments.slice(0, 3),
            lastLocationSeen: result.lastLocationSeen,
            lastProviderSeen: result.lastProviderSeen,
            lastVisitDate: result.lastVisitDate,
          };
        }

        return { found: false };
      } catch (error) {
        console.error("[No-IVR Agent] Schedule lookup error:", error);
        return { found: false, error: "lookup_failed" };
      }
    },
  });

  const checkOpenTicketsTool = recordedTool({
    name: "check_open_tickets",
    description: `Check if this caller has any open/pending tickets from recent calls.
    
Call this BEFORE creating a new ticket to:
- Avoid creating duplicate tickets for the same issue
- Acknowledge pending tickets from earlier calls
- Provide better context about what the caller is following up on

Returns a list of open tickets with their reason and creation date.`,
    parameters: z.object({}),
    execute: async () => {
      console.log("[No-IVR Agent] check_open_tickets called");
      
      if (!metadata.callerPhone) {
        return { 
          checked: true, 
          hasOpenTickets: false, 
          message: "No caller phone available to check tickets" 
        };
      }

      try {
        // Lazy import to avoid module initialization during agent bootstrap
        const { SyncAgentService } = await import("../services/syncAgentService");
        const openTickets = await SyncAgentService.checkOpenTickets(metadata.callerPhone);
        
        if (openTickets.length === 0) {
          return { 
            checked: true, 
            hasOpenTickets: false, 
            openTickets: [] 
          };
        }

        return {
          checked: true,
          hasOpenTickets: true,
          openTickets: openTickets.map(t => ({
            ticketNumber: t.ticketNumber,
            reason: t.reason,
            daysAgo: t.daysAgo,
            createdWhen: t.daysAgo === 0 ? 'today' : 
                         t.daysAgo === 1 ? 'yesterday' : 
                         `${t.daysAgo} days ago`,
          })),
          message: `Caller has ${openTickets.length} open ticket(s). Consider acknowledging before creating new.`,
        };
      } catch (error) {
        console.error("[No-IVR Agent] check_open_tickets error:", error);
        return { checked: false, error: "Failed to check open tickets" };
      }
    },
  });

  const emitDecisionTool = recordedTool({
    name: "emit_decision",
    description: `Log an internal decision point for tracing and quality review. Call this when you make key decisions:
- When you identify caller type (patient vs healthcare provider)
- When you classify urgency (urgent vs non-urgent)
- When you detect a red-flag symptom
- Key phrases that influenced your decision

This does NOT affect the call - it's purely for internal tracking.`,
    parameters: z.object({
      decision_type: z
        .enum([
          "caller_type_identified",
          "urgency_classified",
          "provider_identified",
          "red_flag_symptom",
          "escalation_triggered",
          "ticket_created",
        ])
        .describe("Type of decision being logged"),
      value: z
        .string()
        .describe('The decision value (e.g., "provider", "patient", "urgent", "non-urgent")'),
      reason: z
        .string()
        .optional()
        .describe("Brief explanation of why this decision was made"),
      key_phrases: z
        .array(z.string())
        .optional()
        .describe("Specific phrases from caller that influenced decision"),
    }),
    execute: async (params) => {
      console.log(`[NO-IVR DECISION] ${params.decision_type}:`, {
        value: params.value,
        reason: params.reason,
        keyPhrases: params.key_phrases,
        callId: metadata.callId,
        timestamp: new Date().toISOString(),
      });
      return { logged: true };
    },
  });

  const createTicketTool = recordedTool({
    name: "create_ticket",
    description: `Create a ticket in the EXTERNAL TICKETING SYSTEM for non-urgent after-hours requests. 
This is NOT the callback queue - it creates a ticket that will be processed by staff.

Call this ONLY when you have collected ALL required fields:
- first_name (2+ characters)
- last_name (2+ characters)  
- date_of_birth (month, day, year)
- callback_number (10+ digits)
- request_summary (what they need)

The ticket will include schedule context (last appointment info) automatically.`,
    parameters: z.object({
      first_name: z.string().describe("Patient first name (required)"),
      last_name: z.string().describe("Patient last name (required)"),
      date_of_birth: z
        .string()
        .describe('Full date of birth as spoken (e.g., "January 15, 1980" or "01/15/1980"). For B2B/business callers who don\'t have the patient DOB, pass "DOB not available" — the ticket will still be created.'),
      callback_number: z.string().describe("Callback phone number (10+ digits)"),
      request_category: z
        .enum([
          "new_appointment",
          "confirm_appointment",
          "appointment_request",
          "reschedule_appointment",
          "cancel_appointment",
          "medication_refill",
          "prescription_question",
          "billing_question",
          "insurance_question",
          "general_question",
          "message_for_provider",
          "test_results",
          "follow_up_care",
        ])
        .describe("Category - use 'new_appointment' for NEW appointments, 'confirm_appointment' for CONFIRMING existing. 'appointment_request' is legacy, prefer new_appointment."),
      request_summary: z.string().describe("Summary of what the patient needs"),
      preferred_contact: z
        .enum(["phone", "text", "email"])
        .optional()
        .describe("How they prefer to be contacted"),
      email: z.string().optional().describe("Email address if provided"),
      doctor_name: z.string().optional().describe("Doctor they want to see or usually see"),
      location: z.string().optional().describe("Location they prefer or usually visit"),
      appointment_time: z.string().optional().describe("Relevant appointment date/time if applicable"),
      requires_callback: z.boolean().optional().describe("Whether staff needs to call the patient back. Set to FALSE for simple confirmations where the patient's request was fully handled. Defaults to TRUE."),
    }),
    execute: async (params) => {
      // Lazy import to avoid module initialization during agent bootstrap
      const { SyncAgentService } = await import("../services/syncAgentService");
      
      // Auto-determine callback requirement based on category if not explicitly set
      const requiresCallback = params.requires_callback !== undefined 
        ? params.requires_callback 
        : SyncAgentService.requiresCallback(params.request_category as TriageOutcome);
      
      const callbackNormalized = normalizePhoneNumber(params.callback_number);
      
      console.log("[No-IVR Agent] create_ticket called:", {
        category: params.request_category,
        requiresCallback,
        hasScheduleContext: !!scheduleContext?.patientFound,
        callbackPhone: phoneLast4(callbackNormalized),
      });

      // CODE-ENFORCED: Check for open tickets before creating new one
      if (metadata.callerPhone) {
        try {
          const existingTickets = await SyncAgentService.checkOpenTickets(metadata.callerPhone);
          if (existingTickets.length > 0) {
            console.log(`[No-IVR Agent] Open tickets found for caller ${phoneLast4(metadata.callerPhone)}: ${existingTickets.length}`);
          }
        } catch (checkErr) {
          console.error("[No-IVR Agent] Failed to check open tickets:", checkErr);
        }
      }

      // B2B callers may not have patient DOB — accept placeholder values and skip validation
      const dobLower = params.date_of_birth?.toLowerCase() || '';
      const isB2bNoDob = dobLower.includes('not available') || dobLower.includes('n/a') || 
                         dobLower.includes('unknown') || dobLower.includes('b2b') ||
                         dobLower.includes('unavailable') || dobLower.includes('none') ||
                         dobLower === '';
      
      let parsedDOB = isB2bNoDob ? null : parseDateOfBirth(params.date_of_birth);
      // ASK ONCE, THEN FILE ANYWAY. Until 2026-09-17 this refusal had no
      // counter, no key and no escape, so it could be returned on every
      // invocation for the life of the call — measured on 2026-09-16 as the
      // fifteen-ask loop, on the lane that takes all overnight volume. The
      // queue lanes have bounded the same gate at one ask per call since
      // 2026-09-04 (`decideDobEscape`, keyed on the call SID); this is that
      // ruling reaching the after-hours line. The value the placeholder
      // sends ('Unknown') is the one the B2B path below has always sent and
      // the ticket API has accepted on every POST.
      let dobEscapeStatus: DobStatus | null = null;
      if (!isB2bNoDob && (!parsedDOB?.month || !parsedDOB?.day || !parsedDOB?.year)) {
        const escape = decideDobEscape(
          metadata.callSid ?? '',
          'create_ticket',
          (params.date_of_birth ?? '').trim(),
        );
        if (escape.askAgain) {
          return {
            success: false,
            validation_errors: ["complete date of birth (month, day, and year)"],
            message: "Missing required information: complete date of birth (month, day, and year)",
          };
        }
        dobEscapeStatus = escape.status;
        console.info(dobEscapeMarker('create_ticket', dobEscapeStatus, metadata.callSid ?? ''));
        // A partial parse must not feed the name+DOB lookup below — the
        // secondary lookup is guarded on parsedDOB being usable.
        parsedDOB = null;
      }
      
      if (isB2bNoDob) {
        console.log("[No-IVR Agent] B2B caller — skipping DOB validation, proceeding without DOB");
      }

      // ASK FOR THE EMAIL ONCE, THEN FILE FOR A PHONE CALLBACK. The app
      // refuses an email preference with no address; until 2026-09-27 that
      // refusal arrived here in a spelling nothing matched and was spoken as
      // a technical failure (CA42f5b35d3924b8a1e5e66c00ee927742). Checked
      // BEFORE the schedule lookup so the question comes back in
      // milliseconds and no lookup is spent on a payload that cannot file.
      // See EMAIL_ASK_ONCE above for the measurement.
      const wantsEmail = params.preferred_contact === 'email';
      const emailGiven = (params.email ?? '').trim();
      let emailEscaped = false;
      if (wantsEmail && !emailGiven) {
        if (gateRefusalsSoFar(metadata.callSid, 'create_ticket', 'email') < 1) {
          noteGateRefusal(metadata.callSid, 'create_ticket', 'email');
          return {
            success: false,
            validation_errors: ["email address"],
            message: EMAIL_ASK_ONCE,
          };
        }
        emailEscaped = true;
        console.info(emailEscapeMarker(metadata.callSid ?? ''));
      }

      // SECONDARY LOOKUP: Enrich schedule context using name+DOB
      // This catches cases where caller phone doesn't match patient record (family member calling)
      let enrichedContext = scheduleContext;
      if (parsedDOB && (!scheduleContext?.patientFound || scheduleContext.matchedBy === 'phone')) {
        console.log("[No-IVR Agent] Performing secondary schedule lookup...");
        try {
          const dobForLookup = parsedDOB.iso || `${parsedDOB.year}-${parsedDOB.month}-${parsedDOB.day}`;
          const secondaryLookup = await scheduleLookupService.lookupByNameAndDOB(
            params.first_name,
            params.last_name,
            dobForLookup
          );
          if (secondaryLookup.patientFound) {
            enrichedContext = secondaryLookup;
            console.log("[No-IVR Agent] Secondary lookup: patient found with schedule context");
          } else {
            console.log("[No-IVR Agent] Secondary lookup: no records found");
          }
        } catch (lookupError) {
          console.error("[No-IVR Agent] Secondary lookup error:", lookupError);
        }
      }

      // THE RECORD REACHES THE AFTER-HOURS CALL ROW — only once it is CERTAIN
      // (v53). A phone match is a candidate (`phoneMatchIsUnconfirmed`, v47);
      // a name + date-of-birth match is the identity this lane's Phase 4
      // collects for every ticket anyway. `metadata.callLogId` is read HERE,
      // minutes into the call, because it is a getter the transport backfills
      // after session.connect(); the factory-time read that used to sit beside
      // the phone lookup saw undefined on every call. Not awaited — the
      // caller is waiting on the ticket, not on telemetry.
      // Codex P2 on #321 (sixth pass): a name + date-of-birth query that
      // matches SEVERAL people still comes back `patientFound: true`, with
      // `identity.unique: false` and the newest person's rows as the primary
      // context — writing that would record an arbitrary patient's name as
      // this caller's identity. One person, or nothing.
      if (
        enrichedContext?.patientFound &&
        !phoneMatchIsUnconfirmed(enrichedContext) &&
        enrichedContext.identity?.unique !== false
      ) {
        const liveCallLogId = metadata.callLogId;
        const confirmedDob = parsedDOB
          ? parsedDOB.iso || `${parsedDOB.year}-${parsedDOB.month}-${parsedDOB.day}`
          : undefined;
        if (liveCallLogId) {
          void storage.updateCallLog(liveCallLogId, {
            patientFound: true,
            patientName: enrichedContext.patientName || undefined,
            patientDob: confirmedDob,
            lastProviderSeen: enrichedContext.lastProviderSeen || undefined,
            lastLocationSeen: enrichedContext.lastLocationSeen || undefined,
          }).then(
            () => console.log(`[No-IVR Agent] confirmed identity written to call row ${liveCallLogId}`),
            (err) => console.error(`[No-IVR Agent] Failed to write the confirmed identity to the call row:`, err),
          );
        } else {
          console.warn(`[No-IVR Agent] identity confirmed but the call row has no id yet — not recorded for ${metadata.callId}`);
        }
      }

      // Prepend [NO CALLBACK NEEDED] tag to summary when callback is not required
      const taggedSummary = requiresCallback
        ? params.request_summary
        : `[NO CALLBACK NEEDED] ${params.request_summary}`;

      // Pin the department route for unambiguous categories (operator
      // mandate 2026-07-25) — first line wins the app's database lookup.
      const requestTypeHeader = CATEGORY_TO_REQUEST_TYPE[params.request_category];
      const finalSummary = requestTypeHeader
        ? `Request Type: ${requestTypeHeader}\n${taggedSummary}`
        : taggedSummary;
      
      // Build full patient name for simplified endpoint
      const patientFullName = `${params.first_name} ${params.last_name}`;

      // Map preferred_contact to simplified endpoint format
      const contactMethodMap: Record<string, 'phone' | 'sms' | 'email'> = {
        'phone': 'phone',
        'text': 'sms',
        'email': 'email',
      };
      const preferredContactSimplified = params.preferred_contact
        ? contactMethodMap[params.preferred_contact] || 'phone'
        : 'phone';

      // WHAT WE THINK THIS IS, sent alongside — never instead of.
      //
      // This endpoint maps everything server-side, which is why nothing below
      // names a department or a reason. That mapping is currently putting 413
      // of this agent's 687 department-8 tickets on reason 159, "Transferred
      // to On-Call Provider", when they are office-hours questions and broken
      // glasses. Type 34's first reason is 159; that is the whole mechanism.
      //
      // We do not take the mapping over. Doing that would mean this file
      // choosing the DEPARTMENT for every overnight call, which is the entire
      // answering-service classification problem on the line that carries the
      // night — a bad trade for fixing a label. So we send our own
      // classification as a hint and leave the decision where it is.
      //
      // Inert until the ticketing app reads it. No behaviour changes here.
      const { classifyAfterHoursRequest } = await import('../tools/afterHoursTaxonomy');
      const ahHint = classifyAfterHoursRequest(finalSummary);

      // Use NEW SIMPLIFIED ENDPOINT - more reliable, all mapping done server-side
      const result = await SyncAgentService.submitSimplifiedTicket({
        patientFullName,
        patientDOB: (isB2bNoDob || dobEscapeStatus) ? 'Unknown' : params.date_of_birth, // B2B callers may not have DOB; the escape never sends unreadable words in a date field
        reasonForCalling: finalSummary,
        // An email preference the caller could not complete files for a PHONE
        // callback — the number is on every request — never as an email
        // ticket with no address, which the app refuses.
        preferredContactMethod: emailEscaped ? 'phone' : preferredContactSimplified,
        patientPhone: callbackNormalized,
        // Never an empty string: the app reads `.trim()` and refuses a blank,
        // while an absent key is simply no email.
        patientEmail: emailGiven || undefined,
        lastProviderSeen: params.doctor_name || enrichedContext?.lastProviderSeen,
        locationOfLastVisit: params.location || enrichedContext?.lastLocationSeen,
        // The status note goes HERE and not at the head of reasonForCalling:
        // the `Request Type:` header must stay the first line of that field
        // (operator, 2026-07-25). The note never carries the caller's words.
        additionalDetails: [
          dobEscapeStatus ? dobStatusNote(dobEscapeStatus) : null,
          emailEscaped ? EMAIL_ESCAPE_NOTE : null,
          params.appointment_time ? `Appointment: ${params.appointment_time}` : null,
        ].filter(Boolean).join('\n') || undefined,
        callSid: metadata.callSid,
        callerPhone: metadata.callerPhone,
        dialedNumber: metadata.dialedNumber,
        agentUsed: 'no-ivr',
        ...(ahHint.isCatchAll
          ? {}
          : {
              suggestedRequestTypeId: ahHint.classification.requestTypeId,
              suggestedRequestReasonId: ahHint.classification.requestReasonId,
              suggestedRequestReason: ahHint.classification.requestReason,
              suggestedUrgent: Boolean(ahHint.classification.urgent),
            }),
        callStartTime: new Date().toISOString(),
        // Transcript deliberately NOT sent at filing.
        //
        // The intent was to get the staff-facing summary written immediately.
        // Measured across 14 days it costs the CALLER instead: the ticketing
        // app generates that summary inline, before it responds, so the 304
        // calls (10%) carrying one averaged 7,806ms against 4,245ms for those
        // that did not — roughly 3.5 seconds of extra silence, mid-call.
        //
        // It also buys a worse summary. At filing the call is still going, so
        // the transcript is partial; those tickets average 269 characters of
        // summary against 302 for the rest. The post-call update sends the
        // COMPLETE transcript, and all 2,249 tickets that sent nothing here
        // still ended up with a summary — 100%. Nothing is lost by waiting.
      });

      // A FIELD REFUSAL IS A QUESTION, in whichever spelling it arrived. The
      // sink normalises the app's wording now, and this reads the field list
      // again so the model is told WHAT to ask for in words rather than in the
      // app's column names — and is told plainly that nothing failed, because
      // the branch below this one speaks the technical-issue apology, and on
      // CA42f5b35d3924b8a1e5e66c00ee927742 that is what a refusal became.
      const missingFromApi = missingFieldsFromRefusal(result.error);
      if (missingFromApi) {
        console.log("[No-IVR Agent] VALIDATION FAILED:", result.error);
        return {
          success: false,
          validation_errors: missingFromApi,
          message:
            `Missing required information: ${spokenMissingFields(missingFromApi)}. Ask the caller ` +
            "for it — one field per question, with the format in the question — then call " +
            "create_ticket again with it. Nothing has failed: do not apologise and do not say " +
            "there was a technical issue.",
        };
      }

      // TWO REFUSALS BELOW ARE NOT FAILURES, AND UNTIL 2026-09-17 BOTH FELL
      // INTO THE "technical system error… end the call" BRANCH AT THE BOTTOM.
      //
      // CA…11e362485f (2026-09-16 14:54): the model fired create_ticket twice,
      // overlapping. The first attempt filed VA-60434; the second lost the
      // per-call lock, waited 3s, found no ticket number written back yet, and
      // came back "Concurrent ticket creation in progress" 0.4s BEFORE the
      // first returned success. The caller — twenty minutes late for an 8:00
      // appointment — was told we had a technical issue while her ticket sat
      // in the queue. A duplicate attempt losing the lock means the OTHER
      // attempt is in flight; its result is the one to speak.
      if (result.error === 'Concurrent ticket creation in progress') {
        console.warn(`[TICKET CREATE] duplicate attempt on ${metadata.callSid} lost the lock — the other attempt's result stands`);
        return {
          success: false,
          error: result.error,
          message:
            "Another create_ticket call for this same request is already in progress on this " +
            "call, and its result is on its way to you. Nothing has failed. Do NOT apologise and " +
            "do NOT tell the caller there was a problem. Say nothing about it — wait for that " +
            "other result and read the caller the ticket number it carries. Do not call " +
            "create_ticket again.",
        };
      }

      // CA…7074e29c0c (2026-09-16 03:13): create_ticket hit the 15,000ms
      // client timeout while the ticketing app finished the insert at the
      // same instant — VA-60429 exists. A timeout is not a proven failure.
      // submitSimplifiedTicket sends `idempotencyKey: call-<sid>` and the app
      // answers a key it has seen with the cached result, so ONE retry cannot
      // open a second ticket and usually returns the number. Bounded to one
      // per call; a SECOND timeout is a real outage and falls through to the
      // apology below.
      if (/timeout/i.test(result.error ?? '')) {
        const retriedAlready = gateRefusalsSoFar(metadata.callSid, 'create_ticket', 'api_timeout') > 0;
        if (!retriedAlready) {
          noteGateRefusal(metadata.callSid, 'create_ticket', 'api_timeout');
          console.warn(`[TICKET CREATE] ticket API timed out on ${metadata.callSid} — asking for ONE retry (the app dedupes on this call)`);
          return {
            success: false,
            error: result.error,
            message:
              "The ticketing system did not answer in time, but it may still have filed the " +
              "request. Call create_ticket ONCE more right now with exactly the same details — " +
              "the system recognises this call and will not open a second ticket. Do not tell " +
              "the caller anything failed.",
          };
        }
        console.error(`[TICKET CREATE] ticket API timed out TWICE on ${metadata.callSid} — reporting the failure`);
      }

      if (result.success && result.ticketNumber) {
        console.log(`[TICKET CREATE] ✓ SUCCESS for call ${metadata.callSid}: ${result.ticketNumber}`);
        console.log(`[TICKET CREATE]   Patient: ${params.first_name} ${params.last_name}, Category: ${params.request_category}`);
        
        // Write caller name back to call metadata so it is persisted at call-end
        const resolvedName = [params.first_name, params.last_name].filter(Boolean).join(' ').trim();
        if (resolvedName && metadata.callId) {
          const callMeta = callMetadataForDB.get(metadata.callId);
          if (callMeta && !callMeta.callerName) {
            callMeta.callerName = resolvedName;
          }
        }

        // Log any lookup warnings
        if (result.lookupWarnings && result.lookupWarnings.length > 0) {
          console.warn(`[TICKET CREATE] Lookup warnings: ${result.lookupWarnings.join(', ')}`);
        }
        
        return { 
          success: true, 
          message: "Request submitted successfully. Confirm to patient that their request has been submitted and they will receive a callback."
        };
      } else {
        const errorMsg = result.error || "ticket_creation_failed";
        console.error(`[TICKET CREATE] ✗ FAILED for call ${metadata.callSid}: ${errorMsg}`);
        console.error(`[TICKET CREATE]   Patient: ${params.first_name} ${params.last_name}, Category: ${params.request_category}`);
        return { 
          success: false, 
          error: errorMsg,
          message: "FAILED to submit request due to a technical system error. Apologize sincerely: 'I'm sorry, I'm experiencing a technical issue on my end right now. I have your information and our team will call you back at your callback number as soon as possible.' Then end the call gracefully. DO NOT escalate to human — this is a backend system error, not a patient emergency."
        };
      }
    },
  });

  const terminateCallTool = recordedTool({
    name: "terminate_call",
    description: `Terminate the call server-side immediately. Use this to actually end the call — do NOT rely solely on verbal goodbye.

USE FOR:
- ghost_call: caller not responding after 3 prompts
- robot_call: IVR bleed-through or automated system detected
- spam: spam/telemarketing detected
- max_turns_exceeded: call has gone on too long with no resolution

Always say a brief goodbye phrase BEFORE calling this tool.`,
    parameters: z.object({
      reason: z
        .enum(["ghost_call", "robot_call", "spam", "max_turns_exceeded"])
        .describe("Reason for terminating the call"),
    }),
    execute: async (params) => {
      console.log(`[TOOL] terminate_call - reason: ${params.reason}, callId: ${callId}`);

      // NEVER hang up on a call that is being handed to a human.
      //
      // 2026-08-04 03:55:09 the agent called escalate_to_human ("caller is
      // speaking incoherently ... not progressing"), and ONE SECOND LATER
      // called terminate_call(ghost_call) on the same call. transferred_to_human
      // came out false: it decided the caller needed a person, then killed the
      // line before the transfer could land. That one really was a ghost call,
      // so nobody was harmed — but the race is indifferent to who is on the
      // phone, and the same second would hang up on sudden vision loss.
      //
      // An escalation is a one-way door. Once it is open, ending the call is
      // the transfer's job (or the fallback ticket's), never the model's.
      if (escalationDetailsMap.has(callId)) {
        console.warn(
          `[TOOL] terminate_call REFUSED for ${callId} — escalate_to_human already fired ` +
            `(reason given: ${params.reason}). A handoff in flight outranks a hangup.`,
        );
        return {
          success: false,
          error: 'escalation_in_progress',
          say: 'Stay on the line — I am connecting you with someone now.',
        };
      }

      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          console.error("[TOOL] terminate_call - missing OPENAI_API_KEY");
          return { success: false, error: "missing_api_key" };
        }
        const response = await fetch(
          `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        if (response.ok) {
          console.log(`[TOOL] terminate_call ✓ Call ${callId} terminated (${params.reason})`);
          // Deliberate, successful hangup — SIP recovery must hang up the
          // lingering caller leg, not "rescue" a finished call by transferring
          // it to a human. Marked only after the guard above and only on a
          // successful hangup, so escalations-in-flight and failed hangups
          // still get the transfer safety net.
          markCallConcluded(callId, `terminate_call:${params.reason}`);
          return { success: true, reason: params.reason };
        } else {
          const text = await response.text().catch(() => "");
          console.warn(`[TOOL] terminate_call ⚠️ Hangup returned ${response.status}: ${text}`);
          return { success: false, status: response.status };
        }
      } catch (error) {
        console.error("[TOOL] terminate_call error:", error);
        return { success: false, error: String(error) };
      }
    },
  });

  /**
   * File the ticket a refused escalation stands for. Same endpoint and shape
   * as the sanctioned path's record ticket below, same idempotency key as
   * create_ticket (call-<sid>), so it can never open a second ticket beside
   * one this call already holds. Returns what happened; never throws. The
   * ticket it files is remembered per call so a LATER sanctioned transfer's
   * record files BESIDE it instead of being swallowed by it — see
   * transferRecordCrossReference.
   */
  async function fileRefusedEscalationTicket(
    params: {
      reason: string;
      patient_first_name?: string;
      patient_last_name?: string;
      patient_dob?: string;
      callback_number?: string;
      symptoms_summary?: string;
      provider_info?: string;
    },
    code: RefusedEscalationCode,
    uncorroborated: string[],
  ): Promise<RefusedEscalationFiling> {
    try {
      const { SyncAgentService } = await import("../services/syncAgentService");
      const { classifyAfterHoursRequest } = await import('../tools/afterHoursTaxonomy');
      const name =
        [params.patient_first_name, params.patient_last_name].filter(Boolean).join(' ').trim() ||
        'Unknown Caller';
      const phone = normalizePhoneNumber(params.callback_number || metadata.callerPhone || '');
      const reasonForCalling =
        code === 'symptoms_not_stated_by_caller'
          ? 'Caller asked to reach the on-call team. The symptoms the agent wrote ' +
            `(${uncorroborated.join(', ') || 'unspecified'}) were NOT stated by the caller — ` +
            'read the recording for what they actually said.'
          : [
              params.reason,
              params.symptoms_summary ? `Symptoms: ${params.symptoms_summary}` : null,
              params.provider_info ? `Provider: ${params.provider_info}` : null,
            ]
              .filter(Boolean)
              .join('\n');
      const ahHint = classifyAfterHoursRequest(reasonForCalling);
      const result = await SyncAgentService.submitSimplifiedTicket({
        patientFullName: name,
        patientDOB: params.patient_dob || 'Unknown',
        reasonForCalling,
        preferredContactMethod: 'phone',
        patientPhone: phone || undefined,
        // The note goes HERE and not at the head of reasonForCalling — the
        // `Request Type:` header rule (operator, 2026-07-25).
        additionalDetails: refusedEscalationNote(code),
        callSid: metadata.callSid,
        callerPhone: metadata.callerPhone,
        dialedNumber: metadata.dialedNumber,
        agentUsed: 'no-ivr',
        ...(ahHint.isCatchAll
          ? {}
          : {
              suggestedRequestTypeId: ahHint.classification.requestTypeId,
              suggestedRequestReasonId: ahHint.classification.requestReasonId,
              suggestedRequestReason: ahHint.classification.requestReason,
              suggestedUrgent: Boolean(ahHint.classification.urgent),
            }),
        callStartTime: new Date().toISOString(),
      });
      if (result.success) {
        console.info(
          `[HANDOFF] refused escalation (${code}) filed as ${result.ticketNumber ?? 'a ticket'} on ${metadata.callSid}`,
        );
        if (result.ticketNumber) rememberRefusedEscalationTicket(callId, { ticketNumber: result.ticketNumber, code });
        return { ok: true, ...(result.ticketNumber ? { ticketNumber: result.ticketNumber } : {}) };
      }
      console.error(
        `[HANDOFF] refused escalation (${code}) could NOT be filed on ${metadata.callSid}: ${result.error}`,
      );
      return { ok: false, ...(result.error ? { error: result.error } : {}) };
    } catch (err) {
      console.error(`[HANDOFF] refused escalation (${code}) filing threw on ${metadata.callSid}:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const escalateToHumanTool = recordedTool({
    name: "escalate_to_human",
    description: `Transfer the call to a human on-call provider. 

⚠️ USE ONLY FOR THESE SPECIFIC SITUATIONS:
1. TRUE MEDICAL EMERGENCIES: Vision loss, severe pain, eye injury, chemical exposure, trauma
2. HEALTHCARE PROVIDER CALLS: Doctors, nurses, hospitals calling about a patient
3. PATIENT CONFUSION: After 3+ failed attempts to communicate AND you cannot create a ticket

❌ NEVER ESCALATE FOR:
- Appointment confirmations, scheduling, rescheduling, cancellations
- Medication refills or prescription questions  
- Billing or insurance questions
- General questions about office hours, locations, fax numbers
- Patient frustration or impatience (be patient, handle it yourself)
- "I want to speak to someone / the on-call doctor / a human" — WITHOUT emergency symptoms
  → These are patient preferences. Take their message and create a ticket.
  → Respond: "I can make sure the on-call doctor gets your message and calls you back. Let me take your information."

PATIENT REQUESTING ON-CALL DOCTOR = TAKE A MESSAGE, NOT A TRANSFER.
Only escalate if the patient has actual emergency symptoms (vision loss, severe pain, injury, etc.)

## OFFICE HOURS — ANSWER THE COMMON QUESTION, TIMES INCLUDED

"Are you open today?" is the single most common question on this line and it
must NOT become a ticket. On 2026-08-01 13:35 UTC a caller asked exactly
that, got a hedge, and had a callback ticket filed for it. That is worse
service than answering, and it puts junk in the staff queue.

ANSWER DIRECTLY, no tool needed, no ticket:
- "Are you open right now / today?" → Every office is closed right now — that
  is why they reached the after-hours service. Say so plainly.
- Weekends and holidays → Our offices are closed on weekends and holidays.
- "When does <office> open / close?" → answer from the practice facts,
  including the office's own opening and closing time, exactly as written
  there. Never hedge an hours question: the hours in the practice facts are
  the practice's own, and every other line states them. (An earlier version
  of this section withheld the exact times because the table was thought to
  disagree with live data; on 2026-10-01 the operator rang this line, asked
  when an office opens, was told "I don't want to give you the wrong time for
  that office", and confirmed every office keeps the same hours.)

NEVER file a ticket whose only content is "caller asked about office hours".
A ticket is for something a human must DO.

PREREQUISITE: For medical emergencies — collect caller info BEFORE calling this tool.
For healthcare provider calls — escalate immediately with whatever info you have.`,
    parameters: z.object({
      reason: z.string().describe("Specific urgent symptoms or provider details - NOT general frustration. ALWAYS write in English, even if the caller speaks another language (this goes to English-speaking staff via SMS)."),
      /**
       * `patient_unresponsive` REMOVED 2026-08-15.
       *
       * It sanctioned "cannot communicate after 3 attempts" as grounds for a
       * transfer, and it became the single largest escalation bucket on this
       * line — 14 of 33 over 14 days, six of which rang the on-call provider:
       * "unable to understand caller's language", "repeated difficulty
       * capturing medication details", "unable to confirm date of birth".
       *
       * Operator: "I've been getting all kinds of different messages — 'I
       * couldn't hear the patient' and all different kinds of weird stuff
       * lately. That has to stop."
       *
       * He is right, and the category was a category error. This agent's whole
       * purpose is that it can file a ticket with whatever it managed to
       * collect. Failing to catch a medication name is the ordinary case for
       * taking a message, not for waking a doctor at 2am.
       */
      caller_type: z
        .enum(["patient_urgent_medical", "healthcare_provider"])
        .describe("patient_urgent_medical=a true eye emergency happening now, healthcare_provider=a doctor, nurse, hospital, ER or clinic calling about a patient. There is no third option: if you could not understand the caller or could not collect a detail, that is create_ticket, never this tool."),
      patient_first_name: z.string().optional().describe("Patient first name if collected"),
      patient_last_name: z.string().optional().describe("Patient last name if collected"),
      patient_dob: z.string().optional().describe("Patient date of birth if collected"),
      callback_number: z.string().optional().describe("Callback number if collected"),
      symptoms_summary: z.string().optional().describe("Summary of urgent symptoms if applicable. ALWAYS write in English regardless of the caller's language."),
      provider_info: z.string().optional().describe("Provider name/facility if healthcare provider call. ALWAYS write in English regardless of the caller's language."),
    }),
    execute: async (params) => {
      console.info("[HANDOFF] escalate_to_human tool called:", {
        callerType: params.caller_type,
        reason: params.reason?.substring(0, 100),
        hasSymptoms: !!params.symptoms_summary,
        hasProviderInfo: !!params.provider_info,
        callId,
      });

      /**
       * ONE TRANSFER PER CALL.
       *
       * Nothing refused a second escalation. On 08-08 11:28 one call fired
       * three, on 08-04 17:51 another fired two — each one dialling the
       * on-call provider and each one filing its own record ticket. That is
       * most of the "all kinds of different messages" the operator has been
       * receiving: not many calls, the same call several times.
       */
      if (escalationDetailsMap.has(callId)) {
        console.warn(`[HANDOFF] duplicate escalate_to_human refused for ${callId} — already escalated`);
        return {
          success: false,
          message:
            'You have already transferred this call — the on-call provider has been reached once and must not be ' +
            'paged again. If there is more to record, call create_ticket. Otherwise stay with the caller.',
        };
      }

      /**
       * THE THREE CASES, ENFORCED SERVER-SIDE.
       *
       * The prompt already said "RARE - TRUE EMERGENCIES ONLY" and this tool's
       * own description already said "NEVER ESCALATE FOR ... patient
       * frustration". Prose did not hold: 18 of 33 escalations over 14 days
       * were outside the operator's three cases and 11 connected a human.
       *
       * judgeEscalation reads the arguments the model actually sent and is
       * ALLOW-BY-DEFAULT — a refusal has to be positively matched, because a
       * needless transfer costs a phone call and a wrongly refused one could
       * cost somebody their sight.
       */
      // What the caller actually said, so a symptom the AGENT supplied
      // cannot page the on-call provider. See symptomCorroboration.
      const corroboration = corroborate(
        callId,
        [params.reason, params.symptoms_summary].filter(Boolean).join(' '),
      );
      const verdict = judgeEscalation({
        callerType: params.caller_type,
        reason: params.reason,
        symptomsSummary: params.symptoms_summary,
        providerInfo: params.provider_info,
        corroboration,
      });
      if (!verdict.allowed) {
        console.warn(
          `[HANDOFF] escalation refused for ${callId} — ${verdict.code}: ${params.reason?.substring(0, 120)}`,
        );
        // A REFUSED ESCALATION FILES THE TICKET — see the rules above
        // CATEGORY_TO_REQUEST_TYPE. The directive alone was a sentence the
        // model could ignore, and on 3 of 9 refusals in fourteen days it did.
        const filed = await fileRefusedEscalationTicket(params, verdict.code, corroboration.unsupported);
        const number: 'gave' | 'callerId' | 'none' = knownNumber(params.callback_number)
          ? 'gave'
          : knownNumber(metadata.callerPhone)
            ? 'callerId'
            : 'none';
        return refusedEscalationResult({ code: verdict.code, filed, number });
      }
      console.info(`[HANDOFF] escalation sanctioned for ${callId} — basis: ${verdict.basis}`);

      const escalationDetails = {
        agentSlug: 'no-ivr',
        reason: params.reason,
        callerType: params.caller_type,
        patientFirstName: params.patient_first_name,
        patientLastName: params.patient_last_name,
        patientDob: params.patient_dob,
        callbackNumber: params.callback_number,
        symptomsSummary: params.symptoms_summary,
        providerInfo: params.provider_info,
      };
      escalationDetailsMap.set(callId, escalationDetails);

      try {
        await handoffToHuman();
        console.info("[HANDOFF] ✓ handoffToHuman() completed successfully");

        // Operator mandate 2026-07-25: every urgent outcome leaves a record
        // ticket pinned to the After Hours queue. On a successful transfer
        // the caller is already with the on-call human, so this runs
        // fire-and-forget — a ticket failure must never fail the handoff.
        // (Failed transfers are covered by addHumanAgent's fallback ticket;
        // the per-callSid claim lock dedupes if both paths ever race.)
        void (async () => {
          try {
            const { SyncAgentService } = await import("../services/syncAgentService");
            const name = [params.patient_first_name, params.patient_last_name]
              .filter(Boolean).join(' ').trim() || 'Unknown Caller';
            const phone = normalizePhoneNumber(params.callback_number || metadata.callerPhone || '');
            // A refusal earlier on this call may already have filed a ticket under
            // the call's key; the record must not be swallowed by it (Codex P1,
            // #339). See transferRecordCrossReference.
            const earlier = refusedEscalationTicketFor(callId);
            const result = await SyncAgentService.submitSimplifiedTicket({
              patientFullName: name,
              patientDOB: params.patient_dob || 'Unknown',
              reasonForCalling: [
                'Request Type: Urgent/Emergency Transfer',
                `URGENT TRANSFER (record ticket — caller connected to on-call): ${params.reason}`,
                params.symptoms_summary ? `Symptoms: ${params.symptoms_summary}` : null,
                params.provider_info ? `Provider: ${params.provider_info}` : null,
              ].filter(Boolean).join('\n'),
              preferredContactMethod: 'phone',
              patientPhone: phone || undefined,
              // Every sanctioned escalation is now urgent by construction:
              // the only two caller types left are a live eye emergency and a
              // provider calling about a patient. The 'medium' branch existed
              // solely for patient_unresponsive, which no longer exists.
              priority: 'urgent',
              ...(earlier
                ? {
                    additionalDetails: transferRecordCrossReference(earlier),
                    secondTicketOnThisCall: { keySuffix: 'urgent-transfer' },
                  }
                : {}),
              callSid: metadata.callSid,
              callerPhone: metadata.callerPhone,
              dialedNumber: metadata.dialedNumber,
              agentUsed: 'no-ivr',
              callStartTime: new Date().toISOString(),
              // No transcript at filing — same reason as the primary create
              // path above. The post-call update carries the complete one.
            });
            if (result.success) {
              console.info(
                `[HANDOFF] ✓ Urgent transfer record ticket: ${result.ticketNumber}${earlier ? ` (beside ${earlier.ticketNumber})` : ''}`,
              );
            } else {
              console.error(`[HANDOFF] ✗ Urgent transfer record ticket failed: ${result.error}`);
            }
          } catch (recordErr) {
            console.error('[HANDOFF] ✗ Exception creating urgent transfer record ticket:', recordErr);
          }
        })();

        return { success: true, message: "Call transferred to on-call provider." };
      } catch (handoffError) {
        console.error("[HANDOFF] ✗ handoffToHuman() threw error:", handoffError);
        return { success: false, message: "Transfer failed - please take a message instead." };
      }
    },
  });

  console.log(`[${agentTag}] CHECKPOINT 2: All tools created, building prompt...`);

  const callerHistorySection = (callerMemory && callerMemoryService)
    ? callerMemoryService.buildContextForPrompt(callerMemory)
    : "";

  console.log(`[${agentTag}] CHECKPOINT 3: Building system prompt...`);
  const instructions = buildNoIvrSystemPrompt(metadata, scheduleContext, variant, callerMemory, callerHistorySection);
  console.log(`[${agentTag}] CHECKPOINT 4: Prompt built (${instructions.length} chars), creating RealtimeAgent...`);

  const agent = new RealtimeAgent({
    name: isProduction ? "No-IVR After-Hours Agent (PROD)" : "No-IVR After-Hours Agent (DEV)",
    handoffDescription:
      "Unified after-hours agent that handles all call types through natural conversation - no IVR menu.",
    instructions,
    tools: [
      lookupScheduleTool,
      checkOpenTicketsTool,
      emitDecisionTool,
      createTicketTool,
      escalateToHumanTool,
      terminateCallTool,
    ],
  });

  console.log(`[${agentTag}] CHECKPOINT 5: RealtimeAgent created, adding guardrails...`);
  agent.outputGuardrails = medicalSafetyGuardrails;

  console.log(`[${agentTag}] ✓ Agent created with tools:`, [
    "lookup_schedule",
    "check_open_tickets",
    "emit_decision",
    "create_ticket",
    "escalate_to_human",
    "terminate_call",
  ]);
  console.log(`[${agentTag}] ✓ Version: ${versionString}`);

  return agent;
}

export const noIvrAgentConfig = {
  slug: "no-ivr",
  name: "No-IVR After-Hours Agent",
  description: "Single agent that answers all calls directly without IVR menu. Uses conversation to determine caller type and urgency. Transfers to human for urgent cases.",
  // THIS is the value stamped on call_logs.agent_version (the registry reads
  // it via src/config/agents.ts); the versionString constants below only feed
  // the prompt text and logs. The 2026-07-30 test calls stamped 1.13.0 while
  // running 1.14.0 code because only those were bumped — keep all three in
  // step or rollout verification lies.
  version: "1.20.0",
  greeting: "Thank you for calling Azul Vision, all of our offices are currently closed, you have reached the after hours call service. If this is a medical emergency, please dial 911. All calls are being recorded for quality assurance purposes, how can I help you?",
  voice: "sage",
  language: "en", // Default to English - prompt handles language detection/switching
  /** The languages this line SPEAKS. An old-core-era rule the operator has
   *  not revisited: English and Spanish only, any other language answered in
   *  English. On the runtime this renders into the pipeline's own language
   *  block (src/runtime/languageMechanism.ts); the queue lanes declare no
   *  list and follow the caller into any language. */
  spokenLanguages: ["en", "es"] as const,
};
