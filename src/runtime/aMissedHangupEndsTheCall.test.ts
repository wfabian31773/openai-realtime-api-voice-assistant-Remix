/**
 * A MISSED HANG-UP ENDS THE CALL — v181.
 *
 * On four calls in the fourteen days to 2026-11-05, Twilio stopped sending the
 * caller's audio at exactly its own call duration, sent no `stop` frame, and
 * never closed the socket. The bridge sat on a socket that carried nothing
 * until the ten-minute ceiling and recorded `max_duration` (call_logs and
 * caller_audio_summary, measured 2026-11-06):
 *
 *   CA2bd3ba6a5b85a7471a8d5747ff0c58db  optical  Twilio 16 s    797 frames   ours 601 s
 *   CA5567f94d1f03a8cc3f39b8032322d873  tech     Twilio 76 s  3,800 frames   ours 601 s
 *   CAbfb34d58a4040bf962664078560e4f19  pcp      Twilio 13 s    606 frames   ours 601 s
 *   CA633a0ee81d4feb905d0fa2e529df8e7b  surgery  Twilio 40 s  1,938 frames   ours 601 s
 *
 * Fifty frames a second, to the second. The control is a LIVE call that said
 * nothing for ten minutes: CA2934ce30d26c006d6ed5e3567e7f4eb4 delivered 30,067
 * frames in 601 s, so silence on the line is not silence on the wire.
 *
 * Driven against the real bridge with a fake clock. No transcript or caller
 * data is used: the defect is in the frames, and the frames carry nothing
 * but μ-law silence here.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MEDIA_GAP_MS,
  mediaGapFromEnv,
  type VoiceCallRecord,
  type BridgeSessionHandlers,
} from "./mediaStreamBridge";
import { followUpEvent } from "./followUpTelemetry";

const GAP = 15_000;
const TICK = GAP / 3;
const MAX_CALL = 600_000;

function makeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    fire(ms: number) {
      for (const [id, t] of pending) {
        if (t.ms === ms) {
          pending.delete(id);
          t.fn();
          return true;
        }
      }
      return false;
    },
    armed(ms: number) {
      return [...pending.values()].filter((t) => t.ms === ms).length;
    },
  };
}

async function call(over: { mediaGapMs?: number; slug?: string; callSid?: string } = {}) {
  const { VoiceCallBridge } = await import("./mediaStreamBridge");
  const timers = makeTimers();
  const outcomes: string[] = [];
  const records: VoiceCallRecord[] = [];
  let socketClosed = 0;
  let epoch = 0;
  const session = {
    appendAudio: vi.fn(),
    cancelResponse: vi.fn(),
    sendToolResult: vi.fn(),
    requestResponse: vi.fn(),
    speakNatural: vi.fn(() => {
      epoch += 1;
    }),
    speak: vi.fn(() => {
      epoch += 1;
    }),
    close: vi.fn(),
    getResponseEpoch: () => epoch,
    isResponseActive: () => false,
    setSpokenLanguage: vi.fn(),
  };
  let handlers!: BridgeSessionHandlers;
  const bridge = new VoiceCallBridge({
    context: {
      callSid: over.callSid ?? "CA000000000000000000000000000000gp",
      streamSid: "MZ-test",
      slug: over.slug ?? "tech",
      callerPhone: "+15551234567",
      dialedNumber: "+15559876543",
    },
    agent: {
      instructions: "lane",
      tools: [],
      skipped: [],
      dispatch: async () => ({ ok: true, output: {} }),
      guardrails: [],
    } as never,
    twilio: {
      sendFrame: () => undefined,
      close: () => {
        socketClosed += 1;
      },
    },
    createSession: (h: BridgeSessionHandlers) => {
      handlers = h;
      return session as never;
    },
    onOutcome: (o: string) => outcomes.push(o),
    persistCallRecord: async (r: VoiceCallRecord) => {
      records.push(r);
    },
    maxCallMs: MAX_CALL,
    deadAirMs: 30_000,
    silencePromptMs: 12_000,
    ...(over.mediaGapMs !== undefined ? { mediaGapMs: over.mediaGapMs } : { mediaGapMs: GAP }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  } as never);
  void handlers;
  const frame = () =>
    bridge.handleTwilioFrame({ event: "media", media: { payload: "//////////8=" } } as never);
  /** One tick of a live call: frames arrived during it, then the tick fires. */
  const liveTick = () => {
    frame();
    frame();
    return timers.fire(TICK);
  };
  return { bridge, timers, outcomes, records, session, frame, liveTick, socketClosed: () => socketClosed };
}

const CORPUS = [
  { sid: "CA2bd3ba6a5b85a7471a8d5747ff0c58db", slug: "optical", twilioSeconds: 16 },
  { sid: "CA5567f94d1f03a8cc3f39b8032322d873", slug: "tech", twilioSeconds: 76 },
  { sid: "CAbfb34d58a4040bf962664078560e4f19", slug: "pcp", twilioSeconds: 13 },
  { sid: "CA633a0ee81d4feb905d0fa2e529df8e7b", slug: "surgery", twilioSeconds: 40 },
];

describe("the corpus: frames stop, no stop frame, no socket close", () => {
  for (const c of CORPUS) {
    it(`${c.sid} (${c.slug}, Twilio ${c.twilioSeconds} s) ends as a hang-up, not at the ceiling`, async () => {
      const t = await call({ slug: c.slug, callSid: c.sid });
      // Frames for the length of Twilio's call, a tick at a time.
      for (let s = 0; s < c.twilioSeconds; s += TICK / 1000) t.liveTick();
      expect(t.outcomes).toEqual([]);
      // Then nothing: no frame, no stop, no close. Three empty ticks is the gap.
      expect(t.timers.fire(TICK)).toBe(true);
      expect(t.timers.fire(TICK)).toBe(true);
      expect(t.outcomes).toEqual([]);
      expect(t.timers.fire(TICK)).toBe(true);
      expect(t.outcomes).toEqual(["caller_hangup"]);
      expect(t.outcomes).not.toContain("max_duration");
      expect(t.records).toHaveLength(1);
      expect(t.records[0].outcome).toBe("caller_hangup");
      expect(t.records[0].mediaGapHangup).toBe(true);
      expect(t.records[0].teardownReason).toBe("media_gap");
      // The ceiling is cleared with everything else, never fires afterwards.
      expect(t.timers.armed(MAX_CALL)).toBe(0);
      expect(t.timers.armed(TICK)).toBe(0);
    });
  }
});

describe("the control: a live call that says nothing is never cut", () => {
  it("CA2934ce30d26c006d6ed5e3567e7f4eb4: frames for ten minutes, nothing voiced, ends at the ceiling", async () => {
    const t = await call({ callSid: "CA2934ce30d26c006d6ed5e3567e7f4eb4" });
    // 601 s of frames, ~120 ticks, the watchdog never fires.
    for (let i = 0; i < 120; i++) t.liveTick();
    expect(t.outcomes).toEqual([]);
    t.timers.fire(MAX_CALL);
    expect(t.outcomes).toEqual(["max_duration"]);
    expect(t.records[0].mediaGapHangup).toBe(false);
  });

  it("one frame inside a gap resets it: two empty ticks, a frame, two more empty ticks is still live", async () => {
    const t = await call();
    t.liveTick();
    t.timers.fire(TICK);
    t.timers.fire(TICK);
    t.frame();
    t.timers.fire(TICK); // the frame is counted here
    t.timers.fire(TICK);
    t.timers.fire(TICK);
    expect(t.outcomes).toEqual([]);
    t.timers.fire(TICK);
    expect(t.outcomes).toEqual(["caller_hangup"]);
  });

  it("a stream that never delivered a frame never arms the watchdog", async () => {
    const t = await call();
    expect(t.timers.armed(TICK)).toBe(0);
    t.frame();
    expect(t.timers.armed(TICK)).toBe(1);
  });

  it("the watchdog re-arms once per tick, not once per frame", async () => {
    const t = await call();
    for (let i = 0; i < 200; i++) t.frame();
    expect(t.timers.armed(TICK)).toBe(1);
  });

  it("a stop frame still ends the call at once, and clears the watchdog", async () => {
    const t = await call();
    t.liveTick();
    t.bridge.handleTwilioFrame({ event: "stop" } as never);
    expect(t.outcomes).toEqual(["caller_hangup"]);
    expect(t.records[0].mediaGapHangup).toBe(false);
    expect(t.records[0].teardownReason).toBeUndefined();
    expect(t.timers.armed(TICK)).toBe(0);
  });

  it("a socket close still ends the call at once, and clears the watchdog", async () => {
    const t = await call();
    t.liveTick();
    t.bridge.handleSocketClosed();
    expect(t.outcomes).toEqual(["caller_hangup"]);
    expect(t.records[0].mediaGapHangup).toBe(false);
    expect(t.timers.armed(TICK)).toBe(0);
  });
});

describe("the revert lever", () => {
  it("mediaGapMs 0 switches the watchdog off: the corpus shape runs to the ceiling as before", async () => {
    const t = await call({ mediaGapMs: 0 });
    t.frame();
    // No watchdog timer of ANY length: a zero-length one would tick at once
    // and end a live call within three event-loop turns.
    expect(t.timers.armed(TICK)).toBe(0);
    expect(t.timers.armed(0)).toBe(0);
    t.timers.fire(MAX_CALL);
    expect(t.outcomes).toEqual(["max_duration"]);
  });

  it("RUNTIME_MEDIA_GAP_MS: unset is 15 s, 0 is off, junk is 15 s, and the clamp is 5 to 120 s", () => {
    expect(mediaGapFromEnv(undefined)).toBe(15_000);
    expect(mediaGapFromEnv("")).toBe(15_000);
    expect(mediaGapFromEnv("0")).toBe(0);
    expect(mediaGapFromEnv("abc")).toBe(15_000);
    expect(mediaGapFromEnv("1000")).toBe(5_000);
    expect(mediaGapFromEnv("999999")).toBe(120_000);
    expect(mediaGapFromEnv("20000")).toBe(20_000);
  });

  it("the production default, read at import, is the 15 s gap unless the environment says otherwise", () => {
    expect(MEDIA_GAP_MS).toBe(mediaGapFromEnv(process.env.RUNTIME_MEDIA_GAP_MS));
  });
});

describe("it is countable", () => {
  it("a call ended by the watchdog writes a follow_up_summary row saying so, even with nothing else owed", () => {
    const ev = followUpEvent({
      outcome: "caller_hangup",
      mediaGapHangup: true,
    } as never);
    expect(ev).not.toBeNull();
    expect(ev!.data.mediaGapHangup).toBe(true);
    expect(ev!.data.outcome).toBe("caller_hangup");
  });

  it("an ordinary quiet call still writes no row", () => {
    expect(followUpEvent({ outcome: "caller_hangup" } as never)).toBeNull();
  });
});
