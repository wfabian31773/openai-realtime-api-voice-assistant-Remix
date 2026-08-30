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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses one raw WebSocket text message into a known inbound frame, or
 * null for unparseable/unknown-event messages (Twilio adds events over
 * time — unknown ones are ignored, never a crash).
 *
 * Each event's REQUIRED nested shape is validated, not just the event
 * name: the stream endpoint is reachable before any token is claimed, so
 * an unauthenticated client could send `{"event":"start"}` and have the
 * connection handler dereference `frame.start.customParameters` — a throw
 * from the WebSocket message callback that lands in the process-wide
 * uncaughtException handler, repeatable at will (Codex review, PR #227
 * round 15). A structurally incomplete frame is null, same as an unknown
 * event. Only the fields consumers actually dereference are required;
 * everything optional in Twilio's reference stays optional here.
 */
export function parseTwilioInboundFrame(raw: string): TwilioInboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  switch (parsed.event) {
    case "connected":
      return parsed as unknown as TwilioConnectedFrame;
    case "start": {
      // The top-level streamSid is the address every OUTBOUND frame will
      // carry. A start frame without it would still consume the one-time
      // stream claim, and the authenticated call could then never play
      // audio — media, marks, and clears all sent with an invalid stream
      // SID (Codex review, PR #227 round 16).
      if (typeof parsed.streamSid !== "string") return null;
      const start = parsed.start;
      if (!isRecord(start)) return null;
      if (typeof start.callSid !== "string") return null;
      if (start.customParameters !== undefined && !isRecord(start.customParameters)) {
        return null;
      }
      return parsed as unknown as TwilioStartFrame;
    }
    case "media": {
      const media = parsed.media;
      if (!isRecord(media) || typeof media.payload !== "string") return null;
      return parsed as unknown as TwilioMediaFrame;
    }
    case "mark": {
      const mark = parsed.mark;
      if (!isRecord(mark) || typeof mark.name !== "string") return null;
      return parsed as unknown as TwilioMarkFrame;
    }
    case "stop":
      // `stop` carries no nested field any consumer dereferences.
      return parsed as unknown as TwilioStopFrame;
    default:
      return null;
  }
}
