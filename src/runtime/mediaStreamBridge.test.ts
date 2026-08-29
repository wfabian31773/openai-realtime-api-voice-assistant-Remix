import { describe, it, expect, vi } from "vitest";
import {
  VoiceCallBridge,
  FINAL_MARK_GRACE_MS,
  MULAW_BYTES_PER_MS,
  type BridgeSession,
  type BridgeSessionHandlers,
  type CallOutcome,
  type VoiceCallRecord,
} from "./mediaStreamBridge";
import type { TwilioOutboundFrame } from "./twilioFrames";
import type { BoundAgent } from "./agentBinding";

/** A timer bank the tests fire by hand — no real clock anywhere. */
function makeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    /** Fire the timer armed for exactly `ms`. */
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
    /** Fire whichever timer is currently the only one armed. */
    fireOnly() {
      const entries = [...pending.entries()];
      expect(entries.length).toBe(1);
      const [id, t] = entries[0];
      pending.delete(id);
      t.fn();
    },
  };
}

function makeAgent(over: Partial<BoundAgent> = {}): BoundAgent {
  return {
    instructions: "agent prompt",
    tools: [],
    toolNames: ["create_ticket"],
    skipped: [],
    dispatch: vi.fn(async () => ({ ok: true, output: '{"ticket":"VA-51121"}' })),
    ...over,
  };
}

function b64(bytes: number): string {
  return Buffer.alloc(bytes, 0x7f).toString("base64");
}

function makeBridge(
  over: {
    agent?: BoundAgent;
    persistCallRecord?: (r: VoiceCallRecord) => Promise<void>;
    endCallToolNames?: string[];
    maxCallMs?: number;
    deadAirMs?: number;
  } = {},
) {
  const timers = makeTimers();
  const frames: TwilioOutboundFrame[] = [];
  const twilioClose = vi.fn();
  const outcomes: CallOutcome[] = [];
  let epoch = 0;

  const session = {
    appendAudio: vi.fn(),
    cancelResponse: vi.fn(),
    sendToolResult: vi.fn(),
    speakNatural: vi.fn(),
    close: vi.fn(),
    getResponseEpoch: () => epoch,
  } satisfies BridgeSession;

  let handlers!: BridgeSessionHandlers;
  const agent = over.agent ?? makeAgent();
  const bridge = new VoiceCallBridge({
    context: {
      callSid: "CA-test",
      streamSid: "MZ-test",
      slug: "optical",
      callerPhone: "+15551234567",
      dialedNumber: "+15559876543",
    },
    agent,
    twilio: {
      sendFrame: (f) => frames.push(f),
      close: twilioClose,
    },
    createSession: (h) => {
      handlers = h;
      return session;
    },
    onOutcome: (o) => outcomes.push(o),
    persistCallRecord: over.persistCallRecord,
    endCallToolNames: over.endCallToolNames,
    maxCallMs: over.maxCallMs ?? 600_000,
    deadAirMs: over.deadAirMs ?? 30_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  return {
    bridge,
    session,
    agent,
    frames,
    twilioClose,
    outcomes,
    timers,
    handlers: () => handlers,
    /** Advance the wire's response cycle, as `response.created` does. */
    newResponse: () => {
      epoch += 1;
    },
    marks: () => frames.filter((f) => f.event === "mark") as Array<{ mark: { name: string } }>,
    media: () => frames.filter((f) => f.event === "media"),
    clears: () => frames.filter((f) => f.event === "clear"),
  };
}

/** Drive one complete agent utterance: a new response, transcript, audio,
 * completion. Returns the mark name the bridge emitted for it. */
function speakUtterance(
  h: ReturnType<typeof makeBridge>,
  text: string,
  bytes = 800,
): string {
  h.newResponse();
  h.handlers().onAgentTranscriptDelta(text);
  h.handlers().onAudioDelta(b64(bytes));
  h.handlers().onAudioDone(text);
  const marks = h.marks();
  return marks[marks.length - 1].mark.name;
}

describe("VoiceCallBridge — audio path", () => {
  it("passes caller audio to the session untouched (no transcoding anywhere)", () => {
    const h = makeBridge();
    h.bridge.handleTwilioFrame({
      event: "media",
      streamSid: "MZ-test",
      media: { payload: "AAECAw==" },
    });
    expect(h.session.appendAudio).toHaveBeenCalledWith("AAECAw==");
  });

  it("forwards agent audio to Twilio as media frames on the call's streamSid", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAudioDelta("QUJD");
    expect(h.media()).toEqual([
      { event: "media", streamSid: "MZ-test", media: { payload: "QUJD" } },
    ]);
  });

  it("speaks no words of its own — the opening turn is requested, never scripted", () => {
    const h = makeBridge();
    h.handlers().onConfigured();
    expect(h.session.speakNatural).toHaveBeenCalledTimes(1);
    // Whatever the runtime says to the MODEL, it must never be handed to
    // the caller as copy: no media frame exists before the model speaks.
    expect(h.media()).toHaveLength(0);
  });
});

describe("VoiceCallBridge — barge-in", () => {
  it("sends BOTH signals together: cancel to the model and clear to Twilio", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onSpeechStarted();
    expect(h.session.cancelResponse).toHaveBeenCalledTimes(1);
    expect(h.clears()).toHaveLength(1);
  });

  it("does nothing when no audio is playing — a caller speaking into silence is not a barge-in", () => {
    const h = makeBridge();
    h.handlers().onSpeechStarted();
    expect(h.session.cancelResponse).not.toHaveBeenCalled();
    expect(h.clears()).toHaveLength(0);
  });

  it("DROPS the cancelled response's remaining audio instead of forwarding it after the clear", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onSpeechStarted();
    const before = h.media().length;
    // Deltas already in flight when the cancel was sent.
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onAudioDelta(b64(400));
    expect(h.media().length).toBe(before);
  });

  it("a cancelled utterance's late completion sends no mark and arms no hangup", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Let me look that up for");
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onSpeechStarted();
    const marksBefore = h.marks().length;
    h.handlers().onAudioDone("Let me look that up for you.");
    expect(h.marks().length).toBe(marksBefore);
    expect(h.bridge.lastArmedFinalFallbackMs).toBeNull();
  });

  it("records the partially heard line from the transcript deltas, marked [interrupted]", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Are you calling about ");
    h.handlers().onAgentTranscriptDelta("your glasses order");
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onSpeechStarted();
    expect(h.bridge.getTranscript()).toBe(
      "AGENT: Are you calling about your glasses order [interrupted]",
    );
  });

  it("a line whose audio finished but never echoed a mark is [interrupted], not delivered", () => {
    const h = makeBridge();
    speakUtterance(h, "One moment please.");
    // Audio done, mark sent, echo not back yet — still buffered at Twilio.
    h.handlers().onSpeechStarted();
    expect(h.bridge.getTranscript()).toBe("AGENT: One moment please. [interrupted]");
  });

  it("counts barge-ins for the call record", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onSpeechStarted();
    h.newResponse();
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onSpeechStarted();
    expect(h.session.cancelResponse).toHaveBeenCalledTimes(2);
  });
});

describe("VoiceCallBridge — marks are the only proof audio played", () => {
  it("commits an agent line only when its mark echoes back", () => {
    const h = makeBridge();
    const name = speakUtterance(h, "Good afternoon, Azul Vision.");
    expect(h.bridge.getTranscript()).toBe("");
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.bridge.getTranscript()).toBe("AGENT: Good afternoon, Azul Vision.");
  });

  it("prefers the wire's completed transcript over the accumulated deltas", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("partial gue");
    h.handlers().onAudioDelta(b64(200));
    h.handlers().onAudioDone("The complete, corrected line.");
    const name = h.marks()[0].mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.bridge.getTranscript()).toBe("AGENT: The complete, corrected line.");
  });

  it("an OLDER mark's echo while newer media is flowing does not end playback", () => {
    const h = makeBridge();
    const first = speakUtterance(h, "First line.");
    // A second utterance is already streaming when the first echoes.
    h.newResponse();
    h.handlers().onAudioDelta(b64(400));
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: first } });
    // Playback is still live, so a barge-in must still fire both signals.
    h.handlers().onSpeechStarted();
    expect(h.session.cancelResponse).toHaveBeenCalledTimes(1);
    expect(h.clears()).toHaveLength(1);
  });
});

describe("VoiceCallBridge — agent-requested hangup", () => {
  it("intercepts the OpenAI-SIP hangup tool instead of dispatching it to the agent", () => {
    const h = makeBridge();
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "spam" });
    expect(h.agent.dispatch).not.toHaveBeenCalled();
    expect(h.session.sendToolResult).toHaveBeenCalledWith("call-1", true, {
      success: true,
      ended_by: "voice_runtime",
    });
  });

  it("hangs up only when the goodbye's mark echoes back", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Thanks for calling. Goodbye.");
    h.handlers().onAudioDelta(b64(8000));
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "ghost_call" });
    // Still speaking: no hangup yet.
    expect(h.outcomes).toEqual([]);
    h.handlers().onAudioDone("Thanks for calling. Goodbye.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    expect(h.outcomes).toEqual([]);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.bridge.getTranscript()).toBe("AGENT: Thanks for calling. Goodbye.");
  });

  it("derives the fallback from the audio actually sent, never a constant", () => {
    const h = makeBridge();
    const bytes = 16_000; // 2 seconds of μ-law 8kHz
    h.newResponse();
    h.handlers().onAudioDelta(b64(bytes));
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "spam" });
    h.handlers().onAudioDone("Goodbye.");
    expect(h.bridge.lastArmedFinalFallbackMs).toBe(
      bytes / MULAW_BYTES_PER_MS + FINAL_MARK_GRACE_MS,
    );
  });

  it("hangs up on the fallback when the mark never echoes", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "spam" });
    h.handlers().onAudioDone("Goodbye.");
    expect(h.timers.fire(h.bridge.lastArmedFinalFallbackMs!)).toBe(true);
    expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("ends the call when the goodbye was already delivered before the tool call", () => {
    const h = makeBridge();
    const spoken = speakUtterance(h, "Take care now.");
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: spoken } });
    // Nothing is playing and nothing is coming — the hangup must not wait
    // on an utterance that will never arrive.
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "max_turns_exceeded" });
    const name = h.marks()[h.marks().length - 1].mark.name;
    expect(name).not.toBe(spoken);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("a barge-in over the goodbye REVOKES the hangup — the caller is still talking", () => {
    const h = makeBridge();
    h.newResponse();
    h.handlers().onAudioDelta(b64(8000));
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "ghost_call" });
    h.handlers().onAudioDone("Goodbye.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    h.handlers().onSpeechStarted();
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual([]);
  });
});

describe("VoiceCallBridge — tool dispatch", () => {
  it("answers every tool call, including one whose tool failed", async () => {
    const agent = makeAgent({
      dispatch: vi.fn(async () => ({
        ok: false,
        output: '{"ok":false,"error":"tool_failed"}',
        error: "boom",
      })),
    });
    const h = makeBridge({ agent });
    h.handlers().onToolCall("call-9", "create_ticket", { reason: "refill" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.session.sendToolResult).toHaveBeenCalledWith(
      "call-9",
      false,
      '{"ok":false,"error":"tool_failed"}',
    );
  });

  it("records the tool timeline by name and outcome — never by argument", async () => {
    const records: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void records.push(r) });
    h.handlers().onToolCall("c1", "create_ticket", { patient: "Wayne Fabian" });
    await Promise.resolve();
    await Promise.resolve();
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    await Promise.resolve();
    expect(records).toHaveLength(1);
    expect(records[0].toolEvents.map((e) => ({ name: e.name, ok: e.ok }))).toEqual([
      { name: "create_ticket", ok: true },
    ]);
    expect(JSON.stringify(records[0].toolEvents)).not.toContain("Wayne");
  });
});

describe("VoiceCallBridge — dead-air watchdog", () => {
  it("fires when the caller finishes a turn and nothing ever comes back", () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    h.handlers().onSpeechStopped();
    expect(h.timers.fire(30_000)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("is disarmed while the caller is speaking — thinking time is not dead air", () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    h.handlers().onSpeechStopped();
    h.handlers().onSpeechStarted();
    expect(h.timers.fire(30_000)).toBe(false);
  });

  it("restarts from every audio delta, so a long answer never trips it", () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    h.handlers().onSpeechStopped();
    h.newResponse();
    h.handlers().onAudioDelta(b64(400));
    // The old clock was replaced, not stacked: exactly one 30s timer plus
    // the max-duration ceiling remain.
    const armed = [...h.timers.pending.values()].filter((t) => t.ms === 30_000);
    expect(armed).toHaveLength(1);
  });

  it("a caller thinking about the answer never trips it — the agent already replied", () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    h.handlers().onSpeechStopped(); // a response is owed
    speakUtterance(h, "How can I help you today?"); // and the agent gave one
    expect([...h.timers.pending.values()].some((t) => t.ms === 30_000)).toBe(false);
  });

  it("a LATE completion does not disarm the clock protecting the caller's new turn", () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("What is your date of birth?");
    h.handlers().onAudioDelta(b64(400));
    // The caller answers while the tail of that line is still landing, so
    // a response is owed BEFORE the utterance's completion event arrives.
    h.handlers().onSpeechStopped();
    h.handlers().onAudioDone("What is your date of birth?");
    expect(h.timers.fire(30_000)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("clears once a full utterance is delivered and nothing is owed", () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    speakUtterance(h, "How can I help?");
    expect([...h.timers.pending.values()].some((t) => t.ms === 30_000)).toBe(false);
  });
});

describe("VoiceCallBridge — exactly-once teardown", () => {
  it("records one outcome however many triggers race", () => {
    const h = makeBridge();
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    h.bridge.handleSocketClosed();
    h.handlers().onClosed();
    h.handlers().onError(new Error("late"));
    expect(h.outcomes).toEqual(["caller_hangup"]);
  });

  it("closes the session and the socket, and never throws when both are already dead", () => {
    const h = makeBridge();
    h.session.close.mockImplementation(() => {
      throw new Error("already closed");
    });
    h.twilioClose.mockImplementation(() => {
      throw new Error("already closed");
    });
    expect(() => h.bridge.handleSocketClosed()).not.toThrow();
    expect(h.outcomes).toEqual(["caller_hangup"]);
  });

  it("ends a call that stops conversing at the max-duration ceiling", () => {
    const h = makeBridge({ maxCallMs: 600_000 });
    expect(h.timers.fire(600_000)).toBe(true);
    expect(h.outcomes).toEqual(["max_duration"]);
  });

  it("hands the persister the measured record", async () => {
    const records: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void records.push(r) });
    const name = speakUtterance(h, "Hello.");
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    await Promise.resolve();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      callSid: "CA-test",
      slug: "optical",
      outcome: "caller_hangup",
      transcript: "AGENT: Hello.",
      agentTurns: 1,
      interruptions: 0,
    });
  });

  it("a persister that rejects does not break teardown", async () => {
    const h = makeBridge({ persistCallRecord: async () => Promise.reject(new Error("db down")) });
    expect(() => h.bridge.handleSocketClosed()).not.toThrow();
    await Promise.resolve();
    expect(h.outcomes).toEqual(["caller_hangup"]);
  });

  it("ignores Twilio frames after the call ended", () => {
    const h = makeBridge();
    h.bridge.handleSocketClosed();
    h.bridge.handleTwilioFrame({
      event: "media",
      streamSid: "MZ-test",
      media: { payload: "AAAA" },
    });
    expect(h.session.appendAudio).not.toHaveBeenCalled();
  });
});
