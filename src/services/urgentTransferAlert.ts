/**
 * THE URGENT-TRANSFER HEADS-UP AND ITS SAFETY NET — one copy for both pipelines.
 *
 * The old core (`voiceAgentRoutes.ts`) has done two things around every
 * clinical transfer since August, and the runtime did neither:
 *
 *   1. A text to URGENT_NOTIFICATION_NUMBER BEFORE the on-call phone rings,
 *      saying who is calling and why ("📞 INCOMING TRANSFER"). Operator,
 *      2026-08-05, after missing a transfer that rang with no context.
 *   2. An URGENT ticket in the After Hours queue when the transfer rang and
 *      nobody took it, so the caller exists somewhere a person has to work.
 *
 * The after-hours line moved to the runtime at ~00:23 UTC on 2026-10-01. The
 * first urgent escalation the runtime dialled, CA3a8fd9cc0f2f79eae30f5785ceba6d22
 * (2026-10-02 00:15 UTC), rang the on-call phone for 40 seconds with no text in
 * front of it, rang out, and left no ticket of any provenance. Operator, the
 * same night: "I was waiting for the sms and it never arrived. It was an urgent
 * call, I need those alert sms to let me know who is calling and why."
 *
 * Both pieces are PURE here — the body of the text and the payload of the
 * ticket — so the two pipelines cannot drift apart on what the operator reads.
 * Sending stays with each pipeline, because each owns its own Twilio client
 * and its own idea of the call.
 */
import type { EscalationDetails } from './escalationStore';
import type { SyncAgentService, SyncAgentTicketParams } from './syncAgentService';
import { AFTER_HOURS_DEPARTMENT_ID } from '../tools/afterHoursTaxonomy';
import { preferredCallbackNumber } from './handoffPolicy';
import { nameOrStandIn, STAND_IN_FIRST_NAME, STAND_IN_LAST_NAME, STAND_IN_NAME_NOTE } from './standInName';
import { normalizeDobParts } from '../tools/dobParts';

export interface UrgentTransferSmsOptions {
  callerNumber?: string;
  escalationDetails?: EscalationDetails;
  /** Extra context line for fallback paths, e.g. why this is a direct dial. */
  note?: string;
  /**
   * What this alert is actually announcing.
   *
   * 'transfer' (default) — a leg is being dialled TO THIS RECIPIENT; their
   * phone is about to ring and they should pick up.
   * 'callback' — nothing was dialled and nothing will be. The recipient has to
   * call out. Sending the 'transfer' wording here told them to expect an
   * inbound call that was never coming, so they would wait instead of dialling
   * the urgent patient (Codex review, PR #238).
   * 'routed' — the call is ringing SOMEWHERE ELSE, at the office queue the
   * rules engine chose. The recipient is being kept informed, not summoned:
   * during business hours the office takes it, and telling the on-call phone
   * "connecting patient to you now" left it waiting on a call ringing in
   * another building (Codex review, PR #238).
   */
  kind?: 'transfer' | 'callback' | 'routed';
  /** For 'routed': where it actually went, e.g. "Glendale Front". */
  routedTo?: string;
}

/** The time line at the top of the text, in the practice's own time zone. */
export function urgentAlertTime(now: Date = new Date()): string {
  return now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });
}

/** The text the operator reads. Moved verbatim from `voiceAgentRoutes.ts`. */
export function buildUrgentTransferSms(opts: UrgentTransferSmsOptions, callTime: string): string {
  const d = opts.escalationDetails;
  const callbackOnly = opts.kind === 'callback';
  const routedElsewhere = opts.kind === 'routed';
  let smsBody = callbackOnly
    ? `📵 NO TRANSFER — CALL THIS PATIENT - ${callTime}\n`
    : routedElsewhere
      ? `🏥 URGENT — ROUTED TO OFFICE - ${callTime}\n`
      : `📞 INCOMING TRANSFER - ${callTime}\n`;
  smsBody += `From: ${opts.callerNumber || 'Unknown'}\n`;
  if (opts.note) {
    smsBody += `\n⚠️ ${opts.note}\n`;
  }
  if (d) {
    if (d.callerType === 'healthcare_provider' && d.providerInfo) {
      smsBody += `\n👨‍⚕️ PROVIDER CALL\nProvider: ${d.providerInfo}\n`;
    } else if (d.callerType === 'patient_urgent') {
      smsBody += `\n🚨 URGENT PATIENT\n`;
    }
    if (d.patientFirstName) smsBody += `Patient: ${d.patientFirstName} ${d.patientLastName || ''}\n`;
    if (d.patientDob) smsBody += `DOB: ${d.patientDob}\n`;
    if (d.callbackNumber) smsBody += `Callback: ${d.callbackNumber}\n`;
    if (d.reason) smsBody += `\nReason: ${d.reason}\n`;
    if (d.symptomsSummary) smsBody += `Symptoms: ${d.symptomsSummary}\n`;
  }
  smsBody += callbackOnly
    ? `\n📱 Nobody is being connected to you. Please call this patient back now.`
    : routedElsewhere
      ? `\n📱 Ringing ${opts.routedTo || 'the office queue'} — not your phone. ` +
        `For your awareness; no action needed unless they do not pick it up.`
      : `\n📱 Connecting patient to you now...`;
  return smsBody;
}

/**
 * The department-8 pair for an attempted transfer to the on-call provider —
 * read from the Support Center's `request_reasons` for type 34 on 2026-10-02.
 */
export const ON_CALL_TRANSFER_REQUEST = { requestTypeId: 34, requestReasonId: 159 } as const;

/**
 * The urgent fallback ticket's payload, shared by both pipelines: After Hours,
 * priority urgent, and a description that tells a staffer to call back now and
 * what was attempted.
 *
 * IT WAS NOT REACHING AFTER HOURS, AND THE COMMENT HERE SAID IT WAS. Until
 * v89 it sent `config/afterHoursTicketing`'s AFTER_HOURS_DEPARTMENT_ID — which
 * is 3, Technicians Support — with the `sudden_vision_loss` triage mapping,
 * request type 12 / reason 53, a RETINAL SURGERY pair owned by department 2.
 * Three departments in one payload. Measured 2026-10-02 in the Support
 * Center: of the 17 "URGENT TRANSFER NOT ANSWERED" / "Transfer dial failed"
 * tickets since 2026-05-12, 14 landed in Technicians Support, 2 in the HVA Hub
 * and 1 in After Hours. Operator, the same day, of an urgent after-hours case:
 * "it should record an urgent ticket in after hours." Department 8, type 34,
 * reason 159 "Transferred to On-Call Provider" — which is what happened.
 */
export function urgentFallbackTicketParams(input: {
  why: string;
  dialTarget?: string;
  escalationDetails?: Pick<
    EscalationDetails,
    'reason' | 'symptomsSummary' | 'patientFirstName' | 'patientLastName' | 'patientDob' | 'callbackNumber'
  >;
  callerId?: string | null;
  callSid?: string;
  agentUsed: string;
}): SyncAgentTicketParams {
  const d = input.escalationDetails;
  const formattedPhone = fallbackCallbackPhone(d?.callbackNumber, input.callerId);
  const { first, last, standIn } = fallbackTicketName(d?.patientFirstName, d?.patientLastName);
  const descParts = fallbackDescriptionLines(input);
  if (standIn) {
    descParts.push(STAND_IN_NAME_NOTE);
  }
  const dob = d?.patientDob ? normalizeDobParts(d.patientDob) : null;
  if (d?.patientDob && !dob) {
    descParts.push(`DOB as collected: ${d.patientDob}`);
  }

  return {
    departmentId: AFTER_HOURS_DEPARTMENT_ID,
    requestTypeId: ON_CALL_TRANSFER_REQUEST.requestTypeId,
    requestReasonId: ON_CALL_TRANSFER_REQUEST.requestReasonId,
    patientFirstName: first,
    patientLastName: last,
    patientPhone: formattedPhone,
    description: descParts.join('\n'),
    priority: 'urgent',
    ...(dob
      ? {
          patientBirthMonth: dob.month,
          patientBirthDay: dob.day,
          patientBirthYear: dob.year,
        }
      : {}),
    callData: {
      callSid: input.callSid,
      callerPhone: input.callerId || undefined,
      agentUsed: input.agentUsed,
    },
  };
}

/**
 * VA-76222: "Unknown" + "Caller" is the pair `/submit-ticket` refuses and the
 * pair `/create-ticket` used to SAVE. A failed on-call transfer must never
 * file that pair — especially when we already hold the ANI. The stand-in is
 * the same one the connected-transfer record uses.
 */
function fallbackTicketName(
  first: string | undefined,
  last: string | undefined,
): { first: string; last: string; standIn: boolean } {
  const { fullName, standIn } = nameOrStandIn(first, last);
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || STAND_IN_FIRST_NAME,
    last: parts.slice(1).join(' ') || STAND_IN_LAST_NAME,
    standIn,
  };
}

/**
 * The number to CALL BACK is the one the patient gave, when they gave one AND
 * it is dialable. It is frequently not the phone they are calling from — a
 * spouse's mobile, a nurse's station, a caller on a landline who wants their
 * cell — but it arrives as free text, so an unvalidated preference can swap a
 * good caller ID for a fragment. The policy decides; see
 * preferredCallbackNumber (standing instruction 12; Codex review, PR #238).
 * The true inbound number travels separately as `callerPhone` on both payloads,
 * so nothing loses the provenance.
 */
function fallbackCallbackPhone(collected: string | undefined, callerId: string | null | undefined): string {
  const rawPhone = preferredCallbackNumber({ collected, callerId }) || '';
  const digits = rawPhone.replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : rawPhone.startsWith('+') ? rawPhone : `+${digits}`;
}

/** What happened, what to do, what was attempted — one copy for both payloads. */
function fallbackDescriptionLines(input: {
  why: string;
  dialTarget?: string;
  escalationDetails?: Pick<EscalationDetails, 'reason' | 'symptomsSummary'>;
}): string[] {
  const d = input.escalationDetails;
  const lines: string[] = [input.why, 'Please call the patient back immediately.'];
  if (input.dialTarget) lines.push(`Attempted transfer to: ${input.dialTarget}`);
  if (d?.reason) lines.push(`Reason: ${d.reason}`);
  if (d?.symptomsSummary) lines.push(`Symptoms: ${d.symptomsSummary}`);
  return lines;
}

/** The parameters `SyncAgentService.submitSimplifiedTicket` takes. */
export type UrgentRingOutBesideParams = Parameters<typeof SyncAgentService.submitSimplifiedTicket>[0];

/**
 * The line that ties a ring-out record to the caller's own request ticket.
 * Both tickets stand: the request is still the caller's request, and this one
 * is the only place the failed urgent transfer is written down.
 */
export function ringOutCrossReference(earlierTicket: string): string {
  return (
    `SEE ALSO ${earlierTicket}: the caller's request was filed earlier on this call. ` +
    `This record exists because the urgent transfer to the on-call provider was not ` +
    `answered — that ticket does not say so.`
  );
}

/**
 * THE RING-OUT RECORD FILED BESIDE A TICKET THE CALL ALREADY HOLDS.
 *
 * `urgentFallbackTicketParams` goes through `SyncAgentService.createTicket`,
 * whose per-call claim hands back the EXISTING ticket without posting anything
 * when the call already has one. So when the after-hours agent filed the
 * caller's request FIRST and the urgent transfer then rang out, the urgent
 * record was swallowed: the call's only ticket was the request — medium
 * priority, in whichever department the request routed to — and nothing told
 * After Hours that an urgent patient had been dialled to the on-call phone and
 * nobody answered.
 *
 * Measured over every failed runtime after-hours transfer from 2026-10-10 (v93
 * live) to 2026-10-11 17:20 UTC: 2 of 8 left only a medium HVA Hub ticket and no
 * urgent record — CAc9167374d847e9090f8f1872734d989a (VA-70426) and
 * CAe32e2450544737d1d77868f4c36aeebf (VA-70441). On both, `create_ticket` ran
 * before `escalate_to_human`, which is the order the shape needs.
 *
 * This is the v93 fix applied to the other arm. v93 files the CONNECTED
 * transfer's record beside an earlier refused-escalation ticket with
 * `secondTicketOnThisCall`; a ring-out is the arm where the record matters
 * more, because nobody is on the phone with the patient. Operator mandate
 * 2026-07-25: every urgent outcome leaves a record ticket in After Hours.
 *
 * Through `/submit-ticket`, because that is where `secondTicketOnThisCall`
 * lives and v93 has proven it in production with department 8, priority
 * urgent and the stand-in name. No reason hint, for v93's reason: the app
 * refuses 159 as a hint by design, so the description picks the reason.
 */
export function urgentRingOutBesideParams(input: {
  why: string;
  dialTarget?: string;
  escalationDetails?: Pick<
    EscalationDetails,
    'reason' | 'symptomsSummary' | 'patientFirstName' | 'patientLastName' | 'patientDob' | 'callbackNumber'
  >;
  callerId?: string | null;
  callSid: string;
  agentUsed: string;
  earlierTicket: string;
}): UrgentRingOutBesideParams {
  const d = input.escalationDetails;
  const { fullName, standIn } = nameOrStandIn(d?.patientFirstName, d?.patientLastName);
  const phone = fallbackCallbackPhone(d?.callbackNumber, input.callerId);
  const notes = [ringOutCrossReference(input.earlierTicket), standIn ? STAND_IN_NAME_NOTE : null]
    .filter(Boolean)
    .join('\n');
  return {
    patientFullName: fullName,
    patientDOB: d?.patientDob || 'Unknown',
    // `Request Type:` stays the first line of an after-hours description
    // (operator, 2026-07-25) — the same header the v93 record uses.
    reasonForCalling: ['Request Type: Urgent/Emergency Transfer', ...fallbackDescriptionLines(input)].join('\n'),
    preferredContactMethod: 'phone',
    ...(phone && phone !== '+' ? { patientPhone: phone } : {}),
    priority: 'urgent',
    departmentId: AFTER_HOURS_DEPARTMENT_ID,
    additionalDetails: notes,
    secondTicketOnThisCall: { keySuffix: 'urgent-ringout' },
    callSid: input.callSid,
    callerPhone: input.callerId || undefined,
    agentUsed: input.agentUsed,
  };
}

/** The `why` line when a transfer rang and nobody took it. Same words as the old core. */
export const URGENT_TRANSFER_NOT_ANSWERED =
  'URGENT TRANSFER NOT ANSWERED: The patient was transferred but no one picked up.';
