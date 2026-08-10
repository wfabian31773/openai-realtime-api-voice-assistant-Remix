/**
 * CALL CONCLUSION TRACKER — did WE end this session on purpose?
 *
 * Why (2026-08-10). The operator's phone was ringing with "TECH FALLBACK —
 * assistant disconnected mid-call" transfers several times a day. Pulling the
 * transcripts showed the opposite of a mid-call drop: every one of those calls
 * had FINISHED — "Take care, goodbye", "¡Hasta luego!", "Have a good night" —
 * the agent hung up its OpenAI leg (terminate_call, or the dead-air watchdog),
 * and the CALLER simply hadn't hung up yet. recoverCallerAfterSipTermination
 * only knew "SIP leg gone, caller still connected", assumed a crash, and dialed
 * the on-call number: finished ghost calls were being warm-transferred to a
 * human at all hours.
 *
 * The OpenAI `/hangup` endpoint ends only the SIP leg; the Twilio caller leg is
 * a separate call in the conference. So every deliberate hangup must be
 * recorded here, and SIP recovery must consult this before treating a
 * terminated SIP leg as a failure. Concluded call → hang the caller leg up.
 * Not concluded → genuine mid-call loss → transfer to a human (with SMS).
 *
 * Entries expire after 10 minutes: this only needs to outlive the seconds
 * between our hangup and the recovery check, and must not grow unbounded.
 */

const TTL_MS = 10 * 60 * 1000;

const concluded = new Map<string, { at: number; reason: string }>();

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, v] of concluded) {
    if (v.at < cutoff) concluded.delete(id);
  }
}

/** Record that we deliberately ended the session for this OpenAI call ID. */
export function markCallConcluded(openAiCallId: string, reason: string): void {
  if (!openAiCallId) return;
  concluded.set(openAiCallId, { at: Date.now(), reason });
  if (concluded.size > 500) sweep();
}

/**
 * Conference → OpenAI callId aliases. SIP recovery runs ~750ms after the SIP
 * status callback, by which time session teardown may already have deleted the
 * live conference→callId maps — exactly on the deliberate-hangup path this
 * module exists for. Register the link at session creation so recovery can
 * still resolve the callId after teardown. TTL is generous (calls are capped
 * around 20 minutes).
 */
const LINK_TTL_MS = 60 * 60 * 1000;
const conferenceLinks = new Map<string, { at: number; callId: string }>();

export function linkConferenceToCall(conferenceName: string, openAiCallId: string): void {
  if (!conferenceName || !openAiCallId) return;
  conferenceLinks.set(conferenceName, { at: Date.now(), callId: openAiCallId });
  if (conferenceLinks.size > 500) {
    const cutoff = Date.now() - LINK_TTL_MS;
    for (const [k, v] of conferenceLinks) {
      if (v.at < cutoff) conferenceLinks.delete(k);
    }
  }
}

export function callIdForConference(conferenceName: string | undefined): string | undefined {
  if (!conferenceName) return undefined;
  const v = conferenceLinks.get(conferenceName);
  if (!v || Date.now() - v.at > LINK_TTL_MS) return undefined;
  return v.callId;
}

/** Was this session ended on purpose (terminate_call, dead-air watchdog, …)? */
export function getCallConclusion(openAiCallId: string | undefined): { reason: string } | undefined {
  if (!openAiCallId) return undefined;
  const v = concluded.get(openAiCallId);
  if (!v) return undefined;
  if (Date.now() - v.at > TTL_MS) {
    concluded.delete(openAiCallId);
    return undefined;
  }
  return { reason: v.reason };
}
