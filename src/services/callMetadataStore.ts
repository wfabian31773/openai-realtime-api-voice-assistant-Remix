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
}

export const callMetadataForDB = new Map<string, CallMetadata>();
