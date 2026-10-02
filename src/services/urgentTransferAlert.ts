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
import type { SyncAgentTicketParams } from './syncAgentService';
import { AFTER_HOURS_DEPARTMENT_ID, TRIAGE_OUTCOME_MAPPINGS } from '../config/afterHoursTicketing';
import { preferredCallbackNumber } from './handoffPolicy';

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
 * The urgent fallback ticket's payload. Moved verbatim from the old core's
 * `fileUrgentHandoffFallbackTicket`: After Hours department, the generic urgent
 * mapping, priority urgent, and a description that tells a staffer to call
 * back now and what was attempted.
 */
export function urgentFallbackTicketParams(input: {
  why: string;
  dialTarget?: string;
  escalationDetails?: Pick<
    EscalationDetails,
    'reason' | 'symptomsSummary' | 'patientFirstName' | 'patientLastName' | 'callbackNumber'
  >;
  callerId?: string | null;
  callSid?: string;
  agentUsed: string;
}): SyncAgentTicketParams {
  const d = input.escalationDetails;
  const urgentMapping = TRIAGE_OUTCOME_MAPPINGS['sudden_vision_loss']; // generic urgent
  // The number to CALL BACK is the one the patient gave, when they gave one
  // AND it is dialable. It is frequently not the phone they are calling from
  // — a spouse's mobile, a nurse's station, a caller on a landline who wants
  // their cell — but it arrives as free text, so an unvalidated preference
  // can swap a good caller ID for a fragment. The policy decides; see
  // preferredCallbackNumber (standing instruction 12; Codex review, PR #238).
  // `callData.callerPhone` below keeps the true inbound number regardless, so
  // nothing loses the provenance.
  const rawPhone = preferredCallbackNumber({ collected: d?.callbackNumber, callerId: input.callerId }) || '';
  const digits = rawPhone.replace(/\D/g, '');
  const formattedPhone = digits.length === 10 ? `+1${digits}` : rawPhone.startsWith('+') ? rawPhone : `+${digits}`;

  const descParts: string[] = [input.why, 'Please call the patient back immediately.'];
  if (input.dialTarget) descParts.push(`Attempted transfer to: ${input.dialTarget}`);
  if (d?.reason) descParts.push(`Reason: ${d.reason}`);
  if (d?.symptomsSummary) descParts.push(`Symptoms: ${d.symptomsSummary}`);

  return {
    departmentId: AFTER_HOURS_DEPARTMENT_ID,
    requestTypeId: urgentMapping.requestTypeId,
    requestReasonId: urgentMapping.requestReasonId,
    patientFirstName: d?.patientFirstName || 'Unknown',
    patientLastName: d?.patientLastName || 'Caller',
    patientPhone: formattedPhone,
    description: descParts.join('\n'),
    priority: 'urgent',
    callData: {
      callSid: input.callSid,
      callerPhone: input.callerId || undefined,
      agentUsed: input.agentUsed,
    },
  };
}

/** The `why` line when a transfer rang and nobody took it. Same words as the old core. */
export const URGENT_TRANSFER_NOT_ANSWERED =
  'URGENT TRANSFER NOT ANSWERED: The patient was transferred but no one picked up.';
