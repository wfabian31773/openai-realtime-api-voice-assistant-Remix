import {
  getPcpCallPurpose,
  type PcpCallPurposeSlug,
  type PcpDisposition,
  type PcpVerificationStatus,
} from './policy';
import { isLunchClosure } from '../utils/timeAware';

export const PCP_FACILITY_TYPES = [
  'pcp_office', 'referring_provider', 'health_plan', 'ipa_medical_group',
  'hospital_medical_facility', 'pharmacy', 'pharmaceutical_representative',
  'other_healthcare_organization',
] as const;
export type PcpFacilityType = (typeof PCP_FACILITY_TYPES)[number];

export interface PcpConversationState {
  callerName?: string;
  callerRole?: string;
  callerOrganization?: string;
  callerFacilityType?: PcpFacilityType;
  callbackNumber?: string;
  statedRelationship?: string;
  callPurpose?: PcpCallPurposeSlug;
  patientFirstName?: string;
  patientLastName?: string;
  patientDob?: string;
  patientMrn?: string;
  verificationStatus: PcpVerificationStatus;
  toolFailures: Record<string, number>;
  completedTools: string[];
  dispositionRecorded?: PcpDisposition;
  handoffStatus?: 'HANDOFF_UNAVAILABLE' | 'NO_ANSWER' | 'FAILED' | 'CONNECTED';
  handoffFailureReason?: string;
  /**
   * The caller asked, in words, for a person. Operator directive 2026-08-09:
   * on this line that reaches the office queue during business hours, whatever
   * the call is about and whatever intake is still missing — the staffer who
   * picks up collects what they need. Interviewing a surgery-center nurse
   * before connecting her is the behavior being removed.
   */
  callerRequestedHuman?: boolean;
}

export interface PcpDirectorDecision {
  nextQuestion?: { field: keyof PcpConversationState; prompt: string };
  disposition?: PcpDisposition;
  phiDisclosureAllowed: boolean;
  authoritativeToolAllowed: boolean;
  handoffEligible: boolean;
  mustCreateFallbackTicket: boolean;
  mayTerminate: boolean;
}

export const PROFESSIONAL_FIELDS: Array<keyof PcpConversationState> = [
  'callerName', 'callerRole', 'callerOrganization', 'callerFacilityType', 'callbackNumber', 'callPurpose',
];
export const PATIENT_FIELDS: Array<keyof PcpConversationState> = ['statedRelationship', 'patientFirstName', 'patientLastName', 'patientDob'];
/**
 * What the director asks a PATIENT for, in order. Mirrors `next()`.
 *
 * Exported so the PROMPT can render the same list. Until 2026-08-14 the prompt
 * told the model "ask the single next question record_pcp_intake gives you"
 * and never showed it the order — so the model invented one, the director
 * corrected it a turn later, and the caller heard both. The operator, on a
 * live call: "the sequencing is off... this is just all over the place."
 */
export const PATIENT_INTAKE_ORDER: Array<keyof PcpConversationState> = ['callerName', 'callbackNumber', 'callPurpose'];
export const PROMPTS: Partial<Record<keyof PcpConversationState, string>> = {
  callerName: 'May I have your full name?',
  callerRole: 'What is your role?',
  callerOrganization: 'Which organization are you calling from?',
  callerFacilityType: 'What type of healthcare organization is that?',
  callbackNumber: 'What is the best callback number?',
  callPurpose: 'What are you calling about today?',
  statedRelationship: 'What is your professional relationship to this patient?',
  patientFirstName: "What is the patient's first name?",
  patientLastName: "What is the patient's last name?",
  patientDob: "What is the patient's date of birth?",
};

export class PcpDirector {
  private states = new Map<string, PcpConversationState>();

  constructor(private readonly options: { pharmaHandoffEnabled?: boolean; /** Injected by tests; production reads the Pacific clock. */ lunchClosure?: () => boolean } = {}) {}

  get(callId: string): PcpConversationState {
    let state = this.states.get(callId);
    if (!state) {
      state = { verificationStatus: 'pending', toolFailures: {}, completedTools: [] };
      this.states.set(callId, state);
    }
    return state;
  }

  update(callId: string, patch: Partial<Omit<PcpConversationState, 'toolFailures'>>): PcpConversationState {
    const state = this.get(callId);
    Object.assign(state, patch);
    return state;
  }

  recordToolFailure(callId: string, tool: string): void {
    const state = this.get(callId);
    state.toolFailures[tool] = (state.toolFailures[tool] ?? 0) + 1;
  }

  recordToolSuccess(callId: string, tool: string): void {
    const state = this.get(callId);
    if (!state.completedTools.includes(tool)) state.completedTools.push(tool);
  }

  recordDisposition(callId: string, disposition: PcpDisposition): void {
    this.get(callId).dispositionRecorded = disposition;
  }

  recordHandoffResult(callId: string, result: { status: PcpConversationState['handoffStatus']; reason?: string }): void {
    const state = this.get(callId);
    state.handoffStatus = result.status;
    state.handoffFailureReason = result.reason;
  }

  /** Record that the caller explicitly asked to speak to a person. */
  markCallerRequestedHuman(callId: string): void {
    this.get(callId).callerRequestedHuman = true;
  }

  clear(callId: string): void {
    this.states.delete(callId);
  }

  next(callId: string): PcpDirectorDecision {
    const state = this.get(callId);
    const purpose = state.callPurpose ? getPcpCallPurpose(state.callPurpose) : undefined;

    // A PATIENT IS NOT ASKED FOR A ROLE, AN ORGANISATION OR A FACILITY TYPE.
    //
    // PROFESSIONAL_FIELDS is the right intake for a clinic calling about a
    // mutual patient and absurd for the patient themselves: "What type of
    // healthcare organization is that?" is not a question a person ringing
    // about their own eye drops can answer, and the transcripts show those
    // calls dying in the intake.
    //
    // What a callback actually needs from a patient is a name, a number and
    // what they want. That is the whole list.
    const isPatient = state.callPurpose === 'patient_caller';
    const required: Array<keyof PcpConversationState> = isPatient
      ? ['callerName', 'callbackNumber', 'callPurpose']
      : [...PROFESSIONAL_FIELDS];

    // Purposes whose destination is a live human do not gate the transfer on patient
    // context: minimum professional identity is enough to connect. Details may be
    // collected for the record, but must not delay the connection — peer-to-peer
    // because it is time-sensitive, scheduling because this line cannot schedule at
    // all and the staffer taking the call collects what they need anyway. Blocking on
    // a DOB the caller may not have to hand is how a scheduling request silently
    // became a task instead of a transfer.
    const connectsToHuman = purpose?.defaultDisposition === 'HAND_OFF';
    if (purpose?.patientContextRequired && !connectsToHuman) required.push(...PATIENT_FIELDS);
    const missing = required.find((field) => !state[field]);

    let disposition = purpose?.defaultDisposition;
    if (state.callPurpose === 'pharmaceutical_representative' && this.options.pharmaHandoffEnabled) {
      disposition = 'HAND_OFF';
    }
    if (purpose?.containsPhi && disposition === 'AUTOMATE' && state.verificationStatus === 'failed') disposition = 'CREATE_TASK';
    const handoffFailed = state.handoffStatus && state.handoffStatus !== 'CONNECTED';
    if (handoffFailed) disposition = 'CREATE_TASK';
    const source = purpose?.authoritativeSource;
    const retryExhausted = source ? (state.toolFailures[source] ?? 0) >= 2 : false;
    if (retryExhausted) disposition = 'CREATE_TASK';
    // LUNCH CLOSURE, 12:00-13:00 Pacific weekdays (operator directive
    // 2026-08-06): the desk is unstaffed, so a transfer can only ring out
    // while the caller holds. Downgraded HERE, in the director, rather than
    // only at the dial — the prompt tells the agent that the director decides
    // handoff eligibility, so turning it off here means the agent offers a
    // callback instead of promising "one moment while I connect you" and then
    // failing. handoffPolicy refuses the dial too, as the backstop.
    //
    // Administrative PCP traffic only. The clinical/urgent path does not pass
    // through this director and is deliberately never gated on lunch.
    const lunchClosure = this.options.lunchClosure?.() ?? isLunchClosure();
    if (lunchClosure && disposition === 'HAND_OFF') disposition = 'CREATE_TASK';

    const phiDisclosureAllowed = Boolean(purpose && (!purpose.containsPhi || state.verificationStatus !== 'failed'));
    const authoritativeToolAllowed = Boolean(source && !retryExhausted && (!purpose?.containsPhi || state.verificationStatus !== 'failed'));
    // An explicit ask for a person is eligible on its own: no purpose
    // required, no completed intake required. Lunch closure and a previously
    // failed handoff still apply — those are about whether anyone can pick up.
    //
    // NOT for a patient, however plainly they ask. The destination is the PCP
    // queue — staffed to talk to clinics — and dialling a patient into it is
    // worse than the honest answer that this line will take a message and the
    // right team will call back. 117 of 419 callers asked for a person on this
    // line, and a large share of them were patients.
    const askedForAPerson = Boolean(state.callerRequestedHuman) && !isPatient;
    /**
     * WHERE THIS GRANT LEADS, and the deadlock it caused on 2026-08-14.
     *
     * An explicit ask from a professional grants HAND_OFF whatever the purpose
     * — operator directive, and deliberately so: "the staffer who picks up
     * collects what they need."
     *
     * But the purpose's own allowedDispositions still gate the TICKET. On the
     * operator's test call CA62a1245d that combination locked every exit:
     *
     *   handoff_to_pcp  -> durable_ticket_required_before_handoff
     *   create_pcp_task -> disposition_not_allowed: HAND_OFF is not allowed
     *                      for PCP purpose check_patient_scheduled
     *   terminate_call  -> durable_disposition_required   (x4)
     *
     * 188 seconds, no ticket, no transfer, and the agent could not even hang
     * up. Each guard was individually correct; together they had no floor.
     *
     * The grant stays (it is the ruling). What changed is downstream: the
     * durable ticket a handoff files is no longer rejected for carrying the
     * disposition the director just granted, and mayTerminate below no longer
     * demands that a recorded disposition still match a recomputed one.
     */
    const eligibleByAsk = askedForAPerson && !handoffFailed && !lunchClosure;
    if (eligibleByAsk && disposition !== 'HAND_OFF') disposition = 'HAND_OFF';
    const handoffEligible =
      eligibleByAsk || Boolean(purpose && disposition === 'HAND_OFF' && !missing && !handoffFailed);

    return {
      nextQuestion: missing ? { field: missing, prompt: PROMPTS[missing] ?? `Please provide ${String(missing)}.` } : undefined,
      disposition,
      phiDisclosureAllowed,
      authoritativeToolAllowed,
      handoffEligible,
      mustCreateFallbackTicket: Boolean(handoffFailed),
      /**
       * A RECORDED DISPOSITION IS ENOUGH. It no longer has to be the one the
       * director happens to compute at this instant.
       *
       * The old rule was `dispositionRecorded === disposition`, which reads as
       * "we did the thing we currently intend". But `disposition` is
       * recomputed every turn from live state, so anything that moves it after
       * a disposition is recorded — a late "can I speak to someone", a purpose
       * reclassification — retroactively invalidates a record that is already
       * durable, and the call can never be ended.
       *
       * That is what CA62a1245d hit: terminate_call refused four times on a
       * call where work HAD been recorded. The caller sat through it.
       *
       * The guarantee this check exists to give is "no PCP call ends without a
       * durable record of what happened". A recorded disposition satisfies
       * that, whatever the director would choose now. Belt and braces with the
       * fix above: that one stops the mismatch arising, this one stops any
       * future mismatch trapping a live caller.
       */
      mayTerminate: Boolean(state.dispositionRecorded),
    };
  }
}

export const pcpDirector = new PcpDirector({
  pharmaHandoffEnabled: process.env.PCP_PHARMA_HANDOFF_ENABLED === 'true',
});
