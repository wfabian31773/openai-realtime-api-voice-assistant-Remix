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
  /** Who is on the phone. Reaches the warm-transfer briefing (2026-09-08). */
  callerName?: string;
  /**
   * What we still did not know when we dialled, after the one round of intake
   * a transfer is allowed to cost (src/pcp/preTransferIntake.ts). Empty means
   * the office got a complete briefing.
   */
  briefingGaps?: string[];
  /** Whether that one round actually fired on this call. */
  askedBeforeDial?: boolean;
  /** The caller asked, in words, to speak to a person. */
  callerRequestedHuman?: boolean;
}

export const escalationDetailsMap = new Map<string, EscalationDetails>();
