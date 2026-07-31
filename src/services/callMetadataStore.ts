// Shared call metadata store — separated to avoid circular dependencies
// Used by voiceAgentRoutes.ts and agent tool handlers (noIvrAgent.ts, etc.)

export interface CallMetadata {
  dbCallLogId?: string;
  startTime: Date;
  agentSlug: string;
  agentVersion?: string;
  twilioCallSid?: string;
  from?: string;
  to?: string;
  transferredToHuman: boolean;
  audioInputMs: number;
  audioOutputMs: number;
  callerName?: string; // Patient name collected during the call
  transferTargetNumber?: string; // Actual number dialed on an accepted office transfer
  transferTargetLabel?: string; // Office/queue label for that number
  /** Carrier subscriber name (Twilio Lookup, "[Lookup] SMITH,JANE"), fetched
   *  at call start for azul so the pre-context surname can be sanity-checked
   *  before it is put in the agent's mouth. Reused by the end-of-call
   *  enrichment so the lookup is billed once, not twice. */
  carrierCallerName?: string;
}

export const callMetadataForDB = new Map<string, CallMetadata>();
