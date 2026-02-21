import type { RealtimeSession } from "@openai/agents/realtime";
import { callSessionService } from "../../services/callSessionService";

export interface CallMetadataEntry {
  agentSlug: string;
  campaignId?: string;
  contactId?: string;
  agentGreeting?: string;
  language?: string;
  ivrSelection?: '1' | '2' | '3' | '4';
}

export interface PendingAgentAddition {
  dialedNumber: string;
  agentSlug: string;
  addedAt: number;
}

export interface SIPWatchdog {
  conferenceName: string;
  sipCallSid: string;
  callToken: string;
  callerIDNumber: string;
  domain: string;
  timer: ReturnType<typeof setTimeout>;
  retryCount: number;
  createdAt: number;
  environment: string;
}

class VoiceAgentStateManager {
  readonly activeCallTasks = new Map<string, Promise<void>>();
  readonly activeSessions = new Map<string, RealtimeSession>();
  readonly callMetadata = new Map<string, CallMetadataEntry>();
  
  readonly callIDtoConferenceNameMapping: Record<string, string | undefined> = {};
  readonly ConferenceNametoCallerIDMapping: Record<string, string | undefined> = {};
  readonly ConferenceNametoCalledNumberMapping: Record<string, string | undefined> = {};
  readonly ConferenceNametoCallTokenMapping: Record<string, string | undefined> = {};
  readonly conferenceNameToCallID: Record<string, string | undefined> = {};
  readonly conferenceNameToTwilioCallSid: Record<string, string | undefined> = {};
  readonly conferenceSidToCallLogId: Record<string, string | undefined> = {};

  readonly callerReadyResolvers = new Map<string, () => void>();
  readonly callerReadyPromises = new Map<string, Promise<void>>();
  readonly handoffReadyResolvers = new Map<string, { resolve: () => void; reject: (err: Error) => void; openAiCallId: string }>();
  readonly pendingConferenceAgentAdditions = new Map<string, PendingAgentAddition>();
  readonly sipWatchdogs = new Map<string, SIPWatchdog>();

  getConferenceName(openAiCallId: string): string | undefined {
    const legacyResult = this.callIDtoConferenceNameMapping[openAiCallId];
    if (legacyResult) return legacyResult;
    return callSessionService.getConferenceNameByCallIdSync(openAiCallId);
  }

  getCallerNumber(conferenceName: string): string | undefined {
    const legacyResult = this.ConferenceNametoCallerIDMapping[conferenceName];
    if (legacyResult) return legacyResult;
    return callSessionService.getCallerByConferenceNameSync(conferenceName);
  }

  getTwilioCallSid(conferenceName: string): string | undefined {
    const legacyResult = this.conferenceNameToTwilioCallSid[conferenceName];
    if (legacyResult) return legacyResult;
    return callSessionService.getTwilioCallSidByConferenceNameSync(conferenceName);
  }

  getCallIdByConference(conferenceName: string): string | undefined {
    const legacyResult = this.conferenceNameToCallID[conferenceName];
    if (legacyResult) return legacyResult;
    return callSessionService.getCallIdByConferenceNameSync(conferenceName);
  }

  getCalledNumber(conferenceName: string): string | undefined {
    const legacyResult = this.ConferenceNametoCalledNumberMapping[conferenceName];
    if (legacyResult) return legacyResult;
    return callSessionService.getDialedNumberByConferenceNameSync(conferenceName);
  }

  cancelSIPWatchdog(conferenceName: string): void {
    const watchdog = this.sipWatchdogs.get(conferenceName);
    if (watchdog) {
      clearTimeout(watchdog.timer);
      this.sipWatchdogs.delete(conferenceName);
      console.info(`[WATCHDOG] ✓ Cancelled for ${conferenceName} - webhook received`);
    }
  }
}

export const voiceAgentState = new VoiceAgentStateManager();
