const TERMINAL_SIP_STATUSES = new Set([
  'completed',
  'failed',
  'busy',
  'no-answer',
  'canceled',
]);

export interface CallerRecoveryInput {
  sipCallSid: string | undefined;
  status: string | undefined;
  to: string | undefined;
  transferredToHuman: boolean;
}

export interface CallerRecoveryPlan {
  conferenceName: string;
}

/**
 * Tracks the two independently-created legs of a Twilio/OpenAI conference.
 *
 * The direct no-IVR path creates the SIP participant after returning the
 * caller's TwiML. Twilio therefore gives the two legs different CallSids and
 * either leg can end first. This registry makes cleanup symmetric while
 * keeping all decisions idempotent for duplicate Twilio callbacks.
 */
export class SipConferenceLifecycle {
  private readonly sipByConference = new Map<string, string>();
  private readonly conferenceBySip = new Map<string, string>();
  private readonly humanConferences = new Set<string>();
  private readonly callerRecoveryStarted = new Set<string>();

  registerSipLeg(conferenceName: string, sipCallSid: string): void {
    const previousSip = this.sipByConference.get(conferenceName);
    if (previousSip && previousSip !== sipCallSid) {
      this.conferenceBySip.delete(previousSip);
    }
    this.sipByConference.set(conferenceName, sipCallSid);
    this.conferenceBySip.set(sipCallSid, conferenceName);
  }

  takeSipLegForConference(conferenceName: string): string | undefined {
    const sipCallSid = this.sipByConference.get(conferenceName);
    if (!sipCallSid) return undefined;

    this.sipByConference.delete(conferenceName);
    this.conferenceBySip.delete(sipCallSid);
    return sipCallSid;
  }

  resolveConferenceName(sipCallSid: string | undefined, to: string | undefined): string | undefined {
    if (sipCallSid) {
      const mapped = this.conferenceBySip.get(sipCallSid);
      if (mapped) return mapped;
    }
    if (!to) return undefined;

    try {
      const queryStart = to.indexOf('?');
      if (queryStart === -1) return undefined;
      const params = new URLSearchParams(to.slice(queryStart + 1));
      return params.get('X-conferenceName') || undefined;
    } catch {
      return undefined;
    }
  }

  markHumanJoined(conferenceName: string | undefined): void {
    if (conferenceName) this.humanConferences.add(conferenceName);
  }

  markHumanLeft(conferenceName: string | undefined): void {
    if (conferenceName) this.humanConferences.delete(conferenceName);
  }

  canExecuteCallerRecovery(conferenceName: string, transferredToHuman: boolean): boolean {
    return !transferredToHuman && !this.humanConferences.has(conferenceName);
  }

  beginCallerRecovery(input: CallerRecoveryInput): CallerRecoveryPlan | null {
    if (!input.status || !TERMINAL_SIP_STATUSES.has(input.status)) return null;

    const conferenceName = this.resolveConferenceName(input.sipCallSid, input.to);
    if (!conferenceName) return null;

    if (input.sipCallSid) {
      this.conferenceBySip.delete(input.sipCallSid);
      if (this.sipByConference.get(conferenceName) === input.sipCallSid) {
        this.sipByConference.delete(conferenceName);
      }
    }

    if (
      !this.canExecuteCallerRecovery(conferenceName, input.transferredToHuman) ||
      this.callerRecoveryStarted.has(conferenceName)
    ) {
      return null;
    }

    this.callerRecoveryStarted.add(conferenceName);
    return { conferenceName };
  }

  clearConference(conferenceName: string | undefined): void {
    if (!conferenceName) return;
    const sipCallSid = this.sipByConference.get(conferenceName);
    if (sipCallSid) this.conferenceBySip.delete(sipCallSid);
    this.sipByConference.delete(conferenceName);
    this.humanConferences.delete(conferenceName);
    this.callerRecoveryStarted.delete(conferenceName);
  }
}
