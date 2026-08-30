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
  /**
   * THE CALLER IS THE PATIENT, and it stays true once established.
   *
   * `callPurpose` is not safe to read for this. The records tool reclassifies
   * it to `patient_medical_records_request` the moment it runs, so a patient
   * asking for their OWN records stops looking like a patient at exactly the
   * point the ticket requirements check whether we know who the call is about
   * — and they get asked separately for "the patient's name". Set ONLY by
   * the model's explicit signal — `patient_caller` covers "a patient or their
   * family", and a family member is not the patient. It survives a purpose
   * change because nothing else writes it; the model may still correct it.
   */
  callerIsThePatient?: boolean;
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

/**
 * WHY `callPurpose` IS FIRST, and what it cost to have it last.
 *
 * It used to be sixth of six here and third of three in PATIENT_INTAKE_ORDER —
 * the LAST thing collected. It is also the field that FOUR tools refuse to run
 * without: handoff_to_pcp, create_pcp_task, lookup_patient_appointments and
 * record_automated_resolution. So the agent had to complete a six-question
 * interview before it was permitted to do anything at all, and until it did,
 * every tool it reached for came back `call_purpose_required`.
 *
 * Measured over the ten days to 2026-08-16: handoff_to_pcp was called 240
 * times and refused 211 of them — 88%. On 08-07 alone, 207 attempts, 199
 * refused, 180 of those on the missing purpose. The day before, with lighter
 * traffic through the same code, it was 23 attempts and 2 refusals. That
 * Friday is the one the operator described as "the disasters I was seeing",
 * and the line came off the following morning.
 *
 * There is a second cost, and it is the one a caller feels. `next()` decides
 * whether it is speaking to a PATIENT by `callPurpose === 'patient_caller'`.
 * With the purpose collected last, the director could not know a patient was a
 * patient until AFTER it had asked them their role, their organisation and
 * their facility type. The final call this line ever took (bd89b226, 08-14)
 * was a woman asking how long she could go without her serum drops; she was
 * asked "What is your role at Optum Clinic?"
 *
 * The greeting already asks "How can I help you today?" and callers already
 * answer it — every transcript reviewed states the purpose in the opening
 * sentence. Asking for it first costs nothing and unblocks everything.
 */
export const PROFESSIONAL_FIELDS: Array<keyof PcpConversationState> = [
  'callPurpose', 'callerName', 'callerRole', 'callerOrganization', 'callerFacilityType', 'callbackNumber',
];
export const PATIENT_FIELDS: Array<keyof PcpConversationState> = ['statedRelationship', 'patientFirstName', 'patientLastName', 'patientDob'];
/**
 * What the director asks a PATIENT for, in order — and what `next()` itself
 * uses, so the two cannot disagree.
 *
 * Exported so the PROMPT can render the same list. Until 2026-08-14 the prompt
 * told the model "ask the single next question record_pcp_intake gives you"
 * and never showed it the order — so the model invented one, the director
 * corrected it a turn later, and the caller heard both. The operator, on a
 * live call: "the sequencing is off... this is just all over the place."
 *
 * `next()` used to carry its own inline copy of this list. Two literals for
 * one order is the drift this file already warns about elsewhere; there is now
 * one.
 */
export const PATIENT_INTAKE_ORDER: Array<keyof PcpConversationState> = ['callPurpose', 'callerName', 'callbackNumber'];
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
    /**
     * A PLAIN ASSIGN, DELIBERATELY — and `callerIsThePatient` is the reason
     * this comment exists.
     *
     * An ABSENT key leaves the flag alone, which is all the stickiness that
     * was ever needed: the records tool patches only `callPurpose`, so the
     * flag survives the reclassification that started all of this.
     *
     * An explicit `false` DOES clear it, and that is on purpose. I first made
     * it refuse one, on the theory that a latch should never un-latch — but
     * the tool schema actively tells the model to send false for a family
     * member, so refusing the correction would make one early mis-classification
     * unrecoverable for the rest of the call and name the caller as the patient
     * on the ticket.
     *
     * IT NEVER COMES FROM THE PURPOSE. `patient_caller` covers "a patient OR
     * THEIR FAMILY", so setting it from that slug would tell the ticket that a
     * daughter calling about her mother IS the patient, and the mother's name
     * would never be asked for. Only the model's explicit signal writes it —
     * it is the one that knows which of the two is on the phone.
     */
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
    /**
     * One list, from PATIENT_INTAKE_ORDER.
     *
     * READ THE LATCH, NOT JUST THE PURPOSE. `handle_patient_medical_records_request`
     * reclassifies callPurpose to `patient_medical_records_request`, so a
     * purpose-only test flips a patient back to the PROFESSIONAL list mid-call
     * — and they get asked their role, their organisation, their facility type
     * and "the patient's first name" about themselves. That is the bd89b226
     * interrogation, arriving by a different door.
     *
     * It also matters for `askedForAPerson` below: with isPatient wrongly
     * false, a patient who asked for a person becomes handoff-eligible into
     * the PCP clinic queue, which policy.ts exists to prevent.
     *
     * Found on the SECOND review pass, 2026-08-17 — the first fix added the
     * latch and then only read it in one of the three places that needed it.
     */
    const isPatient = state.callPurpose === 'patient_caller' || Boolean(state.callerIsThePatient);
    const required: Array<keyof PcpConversationState> = isPatient
      ? [...PATIENT_INTAKE_ORDER]
      : [...PROFESSIONAL_FIELDS];

    // Purposes whose destination is a live human do not gate the transfer on patient
    // context: minimum professional identity is enough to connect. Details may be
    // collected for the record, but must not delay the connection — peer-to-peer
    // because it is time-sensitive, scheduling because this line cannot schedule at
    // all and the staffer taking the call collects what they need anyway. Blocking on
    // a DOB the caller may not have to hand is how a scheduling request silently
    // became a task instead of a transfer.
    const connectsToHuman = purpose?.defaultDisposition === 'HAND_OFF';
    /**
     * AND NOT TO A PATIENT, EITHER.
     *
     * PATIENT_FIELDS is `statedRelationship, patientFirstName, patientLastName,
     * patientDob` — the block a PROFESSIONAL supplies about someone else. Asked
     * of the patient themselves it opens with "What is your professional
     * relationship to this patient?", which is the bd89b226 interrogation
     * verbatim.
     *
     * The first two attempts at this fixed the BASE list and left this line
     * alone, so a latched patient whose purpose had been reclassified still
     * walked straight into it. Caught on the third review pass by running the
     * director rather than reading it, 2026-08-17.
     */
    if (!isPatient && purpose?.patientContextRequired && !connectsToHuman) required.push(...PATIENT_FIELDS);
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
    /**
     * A PATIENT IS NEVER DIALLED INTO THE PCP QUEUE — on either branch.
     *
     * `eligibleByAsk` has carried `&& !isPatient` since it was written. This
     * branch did not, and it did not need to while `isPatient` was false for
     * everyone whose purpose was not literally `patient_caller`: the long
     * professional field list guaranteed `missing` was truthy, so the branch
     * could not fire.
     *
     * Widening isPatient with `callerIsThePatient` (third review pass) removed
     * that accident. A self-identified patient on a HAND_OFF purpose now
     * completes the SHORT list, `missing` becomes undefined, and this branch
     * flips true — dialling them into a queue staffed to talk to clinics,
     * which the note on `patient_caller` in policy.ts exists to prevent.
     *
     * Caught on the fifth review pass by running the director rather than
     * reading it: `{callerIsThePatient, callerName, callbackNumber,
     * callPurpose:'reschedule_appointment'}` returned handoffEligible true
     * where the parent commit returned false.
     */
    const handoffEligible =
      eligibleByAsk || Boolean(!isPatient && purpose && disposition === 'HAND_OFF' && !missing && !handoffFailed);

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

/**
 * Deploy marker — printed once when this module loads.
 *
 * `callPurpose` moving to the front of both intake orders is the fix for the
 * refusal storm that took this line off the air: over 2026-08-06/07,
 * `handoff_to_pcp` was called 230 times and refused 199 (86.5%), 148 of them on
 * `call_purpose_required`, with another 34 across `create_pcp_task` and
 * `lookup_patient_appointments`. `record_pcp_intake` itself refused nothing —
 * the intake worked, and everything downstream of it was blocked.
 *
 * That fix is invisible from the outside: a build without it answers the phone
 * and sounds normal for one turn. Wayne republishes by pulling on Replit, and a
 * failed pull looks exactly like a failed fix (2026-08-11, a GitHub rate limit
 * at 00:34 cost a whole round of analysis on stale code).
 *
 * So this prints the order it actually resolved, not a version string. If the
 * line reads `callPurpose` first, the fix is live. If it reads `callerName`
 * first, the build is stale and no call on it proves anything.
 */
console.log(
  `[PcpDirector] intake order — professional: ${PROFESSIONAL_FIELDS.join(' -> ')}; ` +
    `patient: ${PATIENT_INTAKE_ORDER.join(' -> ')}`,
);
