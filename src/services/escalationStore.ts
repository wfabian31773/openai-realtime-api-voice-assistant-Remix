// Shared escalation details store - separated to avoid circular dependencies
// Used by noIvrAgent.ts and voiceAgentRoutes.ts

export interface EscalationDetails {
  agentSlug?: string;
  reason?: string;
  callerType?: string;
  patientFirstName?: string;
  patientLastName?: string;
  patientDob?: string;
  callbackNumber?: string;
  symptomsSummary?: string;
  providerInfo?: string;
  /** The caller asked, in words, to speak to a person. */
  callerRequestedHuman?: boolean;
}

export const escalationDetailsMap = new Map<string, EscalationDetails>();
