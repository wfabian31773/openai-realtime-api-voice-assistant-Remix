import {
  getPcpCallPurpose,
  type PcpCallPurposeSlug,
  type PcpDisposition,
  type PcpVerificationStatus,
} from './policy';

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

const PROFESSIONAL_FIELDS: Array<keyof PcpConversationState> = [
  'callerName', 'callerRole', 'callerOrganization', 'callerFacilityType', 'callbackNumber', 'callPurpose',
];
const PATIENT_FIELDS: Array<keyof PcpConversationState> = ['statedRelationship', 'patientFirstName', 'patientLastName', 'patientDob'];
const PROMPTS: Partial<Record<keyof PcpConversationState, string>> = {
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

  constructor(private readonly options: { pharmaHandoffEnabled?: boolean } = {}) {}

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

  clear(callId: string): void {
    this.states.delete(callId);
  }

  next(callId: string): PcpDirectorDecision {
    const state = this.get(callId);
    const required = [...PROFESSIONAL_FIELDS];
    const purpose = state.callPurpose ? getPcpCallPurpose(state.callPurpose) : undefined;

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

    const phiDisclosureAllowed = Boolean(purpose && (!purpose.containsPhi || state.verificationStatus !== 'failed'));
    const authoritativeToolAllowed = Boolean(source && !retryExhausted && (!purpose?.containsPhi || state.verificationStatus !== 'failed'));
    const handoffEligible = Boolean(purpose && disposition === 'HAND_OFF' && !missing && !handoffFailed);

    return {
      nextQuestion: missing ? { field: missing, prompt: PROMPTS[missing] ?? `Please provide ${String(missing)}.` } : undefined,
      disposition,
      phiDisclosureAllowed,
      authoritativeToolAllowed,
      handoffEligible,
      mustCreateFallbackTicket: Boolean(handoffFailed),
      mayTerminate: Boolean(disposition && state.dispositionRecorded === disposition),
    };
  }
}

export const pcpDirector = new PcpDirector({
  pharmaHandoffEnabled: process.env.PCP_PHARMA_HANDOFF_ENABLED === 'true',
});
