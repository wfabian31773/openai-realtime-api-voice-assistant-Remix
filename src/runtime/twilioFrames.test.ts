import { describe, it, expect } from "vitest";
import { parseTwilioInboundFrame } from "./twilioFrames";

/**
 * The invariant: a frame is accepted only with the nested shape its
 * consumers dereference. The stream endpoint is reachable before any token
 * is claimed, so an unauthenticated client could send `{"event":"start"}`
 * and crash the WebSocket message callback into the process-wide
 * uncaughtException handler, repeatably (Codex review, PR #227 round 15).
 * Structurally incomplete frames must be null — dropped like unknown
 * events, never a throw downstream.
 */
describe("parseTwilioInboundFrame — shape, not just event name", () => {
  it("rejects the bare start frame an unauthenticated client can forge", () => {
    // voiceRuntime reads frame.start.customParameters on this frame.
    expect(parseTwilioInboundFrame('{"event":"start"}')).toBeNull();
    expect(parseTwilioInboundFrame('{"event":"start","start":null}')).toBeNull();
    expect(parseTwilioInboundFrame('{"event":"start","start":"x"}')).toBeNull();
    // callSid is the claim key — without it the frame is not a start.
    expect(parseTwilioInboundFrame('{"event":"start","start":{}}')).toBeNull();
    // customParameters, when present, must be an object.
    expect(
      parseTwilioInboundFrame(
        '{"event":"start","streamSid":"MZ1","start":{"callSid":"CA1","customParameters":"tok"}}',
      ),
    ).toBeNull();
    // A start with valid credentials but NO top-level streamSid would
    // consume the one-time claim and then leave every outbound frame
    // addressed to an invalid stream — an authenticated call that can
    // never play audio (Codex, PR #227 round 16).
    expect(
      parseTwilioInboundFrame(
        '{"event":"start","start":{"callSid":"CA1","customParameters":{"token":"t"}}}',
      ),
    ).toBeNull();
  });

  it("accepts a real start frame, with or without customParameters", () => {
    const full = parseTwilioInboundFrame(
      '{"event":"start","streamSid":"MZ1","start":{"streamSid":"MZ1","callSid":"CA1","customParameters":{"token":"t"}}}',
    );
    expect(full?.event).toBe("start");
    // customParameters is optional in Twilio's reference; the consumer
    // already defaults it (`?? {}`), so its absence is a valid frame.
    const bare = parseTwilioInboundFrame(
      '{"event":"start","streamSid":"MZ1","start":{"streamSid":"MZ1","callSid":"CA1"}}',
    );
    expect(bare?.event).toBe("start");
  });

  it("rejects media and mark frames missing what the bridge dereferences", () => {
    // mediaStreamBridge reads frame.media.payload and frame.mark.name.
    expect(parseTwilioInboundFrame('{"event":"media"}')).toBeNull();
    expect(parseTwilioInboundFrame('{"event":"media","media":{}}')).toBeNull();
    expect(parseTwilioInboundFrame('{"event":"mark"}')).toBeNull();
    expect(parseTwilioInboundFrame('{"event":"mark","mark":{}}')).toBeNull();
  });

  it("accepts the real media, mark, connected, and stop frames", () => {
    expect(
      parseTwilioInboundFrame('{"event":"media","streamSid":"MZ1","media":{"payload":"AAEC"}}')
        ?.event,
    ).toBe("media");
    expect(
      parseTwilioInboundFrame('{"event":"mark","streamSid":"MZ1","mark":{"name":"utt-1"}}')
        ?.event,
    ).toBe("mark");
    expect(parseTwilioInboundFrame('{"event":"connected"}')?.event).toBe("connected");
    // stop carries no nested field any consumer dereferences.
    expect(parseTwilioInboundFrame('{"event":"stop","streamSid":"MZ1"}')?.event).toBe("stop");
  });

  it("drops garbage without throwing — unknown events included", () => {
    expect(parseTwilioInboundFrame("not json")).toBeNull();
    expect(parseTwilioInboundFrame("42")).toBeNull();
    expect(parseTwilioInboundFrame("null")).toBeNull();
    expect(parseTwilioInboundFrame('{"event":"dtmf"}')).toBeNull();
    expect(parseTwilioInboundFrame("{}")).toBeNull();
  });
});
