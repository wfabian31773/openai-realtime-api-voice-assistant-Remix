// Shared escalation details store - separated to avoid circular dependencies
// Used by noIvrAgent.ts and voiceAgentRoutes.ts

export interface EscalationDetails {
  reason?: string;
  callerType?: string;
  patientFirstName?: string;
  patientLastName?: string;
  patientDob?: string;
  callbackNumber?: string;
  symptomsSummary?: string;
  providerInfo?: string;
}

export const escalationDetailsMap = new Map<string, EscalationDetails>();
