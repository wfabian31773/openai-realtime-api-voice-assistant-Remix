/**
 * src/runtime/twilioFrames.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Twilio Media Streams wire protocol — the JSON frames Twilio sends over the
 * `<Connect><Stream>` WebSocket and the frames we send back. Shapes follow
 * Twilio's published Media Streams message reference (connected / start /
 * media / mark / stop inbound; media / mark / clear outbound).
 *
 * Ported unchanged from the 5Star DRS telephony layer, where these shapes
 * have carried live calls. The protocol is Twilio's; there is nothing
 * agent-specific or practice-specific in it, which is exactly why it ports
 * without a single edit.
 *
 * Audio format note: Twilio Media Streams telephony audio is 8kHz μ-law
 * (`audio/x-mulaw`), base64 in `media.payload`. The Grok session config
 * (grokSession.ts buildSessionConfig) declares `audio/pcmu` for both
 * directions — the same encoding — so the bridge passes payloads through
 * byte-for-byte in both directions with NO transcoding anywhere. This is
 * also the reason the runtime can host the SAME agent the OpenAI SIP core
 * hosts: the transport changed, the audio did not.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Inbound (Twilio -> us) ───────────────────────────────────────────────

export interface TwilioConnectedFrame {
  event: "connected";
  protocol?: string;
  version?: string;
}

export interface TwilioStartFrame {
  event: "start";
  sequenceNumber?: string;
  streamSid: string;
  start: {
    streamSid: string;
    accountSid?: string;
    callSid: string;
    tracks?: string[];
    customParameters?: Record<string, string>;
    mediaFormat?: { encoding: string; sampleRate: number; channels: number };
  };
}

export interface TwilioMediaFrame {
  event: "media";
  sequenceNumber?: string;
  streamSid: string;
  media: {
    track?: string;
    chunk?: string;
    timestamp?: string;
    /** base64 μ-law 8kHz audio. */
    payload: string;
  };
}

export interface TwilioMarkFrame {
  event: "mark";
  sequenceNumber?: string;
  streamSid: string;
  mark: { name: string };
}

export interface TwilioStopFrame {
  event: "stop";
  sequenceNumber?: string;
  streamSid: string;
  stop?: { accountSid?: string; callSid?: string };
}

export type TwilioInboundFrame =
  | TwilioConnectedFrame
  | TwilioStartFrame
  | TwilioMediaFrame
  | TwilioMarkFrame
  | TwilioStopFrame;

// ── Outbound (us -> Twilio) ──────────────────────────────────────────────

export interface TwilioOutboundMediaFrame {
  event: "media";
  streamSid: string;
  media: { payload: string };
}

/** Twilio echoes a mark frame back AFTER all audio queued before it has
 * actually been played to the caller — the only ground truth that audio
 * reached the caller's ear (sibling-repo production lesson). */
export interface TwilioOutboundMarkFrame {
  event: "mark";
  streamSid: string;
  mark: { name: string };
}

/** Discards Twilio's buffered outbound audio immediately (barge-in). */
export interface TwilioOutboundClearFrame {
  event: "clear";
  streamSid: string;
}

export type TwilioOutboundFrame =
  | TwilioOutboundMediaFrame
  | TwilioOutboundMarkFrame
  | TwilioOutboundClearFrame;

/** Parses one raw WebSocket text message into a known inbound frame, or
 * null for unparseable/unknown-event messages (Twilio adds events over
 * time — unknown ones are ignored, never a crash). */
export function parseTwilioInboundFrame(raw: string): TwilioInboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = (parsed as { event?: unknown }).event;
  if (
    event === "connected" ||
    event === "start" ||
    event === "media" ||
    event === "mark" ||
    event === "stop"
  ) {
    return parsed as TwilioInboundFrame;
  }
  return null;
}
