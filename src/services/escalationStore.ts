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
  /**
   * WHAT TO DO WHEN TWILIO TELLS US HOW THE BLIND DIAL ENDED.
   *
   * The `<Dial action>` callback lands minutes later on its own HTTP request,
   * long after the agent's session is gone, so there is no closure left to
   * run unless one was registered before the redirect. `runtimeTransfer`
   * SNAPSHOTS this into the pending-dial entry for the same reason it
   * snapshots `briefingGaps`: `attempt`'s own `finally` deletes this map,
   * because it holds a caller's name and callback number.
   *
   * Typed as a plain callback and NOT as anything PCP-shaped, so the runtime
   * stays a transport: it hands back what the dial did and the lane decides
   * what that means. Today only `pcpAgent` sets it, to move its ticket off
   * DIALING once the queue answers or rings out.
   */
  onBlindDialSettled?: (settlement: BlindDialSettlement) => void | Promise<void>;
}

/**
 * What Twilio's `<Dial action>` callback established about a blind transfer.
 *
 * Deliberately the RAW reading rather than a verdict: `queue_answered` means
 * the far end picked up, which against a call centre is an ACD and NOT a
 * person speaking. Rosa's 2026-09-08 vocabulary — `accepted` stays reserved
 * for the warm path's keypress, and `talkSeconds` is what later tells a real
 * conversation from a caller who gave up in hold music.
 */
export interface BlindDialSettlement {
  outcome: 'queue_answered' | 'no_answer' | 'failed';
  /** Twilio's own word, verbatim, so our reading can be checked against it. */
  status: string;
  /** The far end picked up. NOT proof a human did. */
  connected: boolean;
  /** Seconds the two legs were bridged. Present only when connected. */
  talkSeconds?: number;
  ringSeconds: number;
  dialedNumber?: string;
}

export const escalationDetailsMap = new Map<string, EscalationDetails>();
