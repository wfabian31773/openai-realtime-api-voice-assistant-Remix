import { describe, it, expect, vi } from "vitest";
import {
  decodeToolOutput,
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
    requestResponse: vi.fn(),
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
    // requestResponse(), not speakNatural(): per-response instructions
    // OVERRIDE the session's, so any words here would generate the
    // caller's first sentence with the agent's prompt and the knowledge
    // pack switched off. The runtime supplies nothing at all.
    expect(h.session.requestResponse).toHaveBeenCalledTimes(1);
    expect(h.session.requestResponse).toHaveBeenCalledWith();
    // Nothing is handed to the caller as copy either: no media frame
    // exists before the model speaks.
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
  /** Guards passed: the agent reached its transport step, which 404s here. */
  function permitting() {
    return makeAgent({
      dispatch: vi.fn(async () => ({
        ok: true,
        output: JSON.stringify({ success: false, reason: "completed", status: 404 }),
      })),
    });
  }

  async function terminate(h: ReturnType<typeof makeBridge>) {
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "completed" });
    await Promise.resolve();
    await Promise.resolve();
  }

  it("waits for the goodbye still streaming, then gates on its mark", async () => {
    const h = makeBridge({ agent: permitting() });
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Thanks for calling. Goodbye.");
    h.handlers().onAudioDelta(b64(8000));
    await terminate(h);
    // Still speaking: no hangup, and no mark invented mid-utterance.
    expect(h.outcomes).toEqual([]);
    h.handlers().onAudioDone("Thanks for calling. Goodbye.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    expect(h.outcomes).toEqual([]);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.bridge.getTranscript()).toBe("AGENT: Thanks for calling. Goodbye.");
  });

  it("derives the fallback from the audio actually sent, never a constant", async () => {
    const h = makeBridge({ agent: permitting() });
    const bytes = 16_000; // 2 seconds of μ-law 8kHz
    h.newResponse();
    h.handlers().onAudioDelta(b64(bytes));
    await terminate(h);
    h.handlers().onAudioDone("Goodbye.");
    expect(h.bridge.lastArmedFinalFallbackMs).toBe(
      bytes / MULAW_BYTES_PER_MS + FINAL_MARK_GRACE_MS,
    );
  });

  it("hangs up on the fallback when the mark never echoes", async () => {
    const h = makeBridge({ agent: permitting() });
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    await terminate(h);
    h.handlers().onAudioDone("Goodbye.");
    expect(h.timers.fire(h.bridge.lastArmedFinalFallbackMs!)).toBe(true);
    expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("a revoked goodbye cannot be inherited by the NEXT response", async () => {
    // The barge-in cleared the final mark and its timer but left the
    // termination request standing, so the answer to the caller's new
    // question armed ITS mark as final and hung up on them (Codex review,
    // PR #227).
    const h = makeBridge({ agent: permitting() });
    h.newResponse();
    h.handlers().onAudioDelta(b64(8000));
    await terminate(h);
    h.handlers().onAudioDone("Goodbye.");
    h.handlers().onSpeechStarted(); // the caller cuts in with one more thing
    h.handlers().onSpeechStopped();
    // The agent answers the new question.
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Yes, we are open until five.");
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onAudioDone("Yes, we are open until five.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual([]);
  });

  it("a barge-in over the goodbye REVOKES the hangup — the caller is still talking", async () => {
    const h = makeBridge({ agent: permitting() });
    h.newResponse();
    h.handlers().onAudioDelta(b64(8000));
    await terminate(h);
    h.handlers().onAudioDone("Goodbye.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    // The hangup really was armed, so revoking it is a real revocation.
    expect(h.bridge.lastArmedFinalFallbackMs).not.toBeNull();
    h.handlers().onSpeechStarted();
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual([]);
  });
});

describe("VoiceCallBridge — the agent's own hangup guards (Codex review, PR #227)", () => {
  /** An agent whose terminate_call REFUSES: noIvrAgent does this while an
   * escalation is in flight, after a live 2026-08-04 call where the model
   * escalated and hung up one second later. pcpAgent does it until the
   * disposition is durably recorded. Both refusals are transport-
   * independent — replacing the tool wholesale bypasses them. */
  function refusingAgent() {
    return makeAgent({
      dispatch: vi.fn(async () => ({
        ok: true,
        output: JSON.stringify({
          success: false,
          error: "escalation_in_progress",
          say: "Stay on the line — I am connecting you with someone now.",
        }),
      })),
    });
  }

  /** Guards passed, so the agent reached its OpenAI POST — which 404s on
   * this transport. An HTTP `status` in the result is the generic proof
   * that the guards ran and let it through: in every agent the business
   * checks come BEFORE the fetch. */
  function permittingAgent() {
    return makeAgent({
      dispatch: vi.fn(async () => ({
        ok: true,
        output: JSON.stringify({ success: false, reason: "ghost_call", status: 404 }),
      })),
    });
  }

  it("runs the agent's terminate tool instead of replacing it", async () => {
    const agent = permittingAgent();
    const h = makeBridge({ agent });
    h.handlers().onToolCall("c1", "terminate_call", { reason: "ghost_call" });
    await Promise.resolve();
    await Promise.resolve();
    expect(agent.dispatch).toHaveBeenCalledWith("terminate_call", { reason: "ghost_call" });
  });

  it("does NOT hang up when the agent refuses — an escalation outranks a hangup", async () => {
    const h = makeBridge({ agent: refusingAgent() });
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onToolCall("c1", "terminate_call", { reason: "ghost_call" });
    await Promise.resolve();
    await Promise.resolve();
    h.handlers().onAudioDone("One moment.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual([]);
  });

  it("passes the agent's refusal back to the model, wording included", async () => {
    const h = makeBridge({ agent: refusingAgent() });
    h.handlers().onToolCall("c1", "terminate_call", { reason: "ghost_call" });
    await Promise.resolve();
    await Promise.resolve();
    const [, , output] = (h.session.sendToolResult as unknown as {
      mock: { calls: [string, boolean, Record<string, unknown>][] };
    }).mock.calls[0];
    expect(output.error).toBe("escalation_in_progress");
    expect(output.say).toMatch(/Stay on the line/);
  });

  it("hangs up once the agent's guards let the termination through", async () => {
    const h = makeBridge({ agent: permittingAgent() });
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onToolCall("c1", "terminate_call", { reason: "ghost_call" });
    await Promise.resolve();
    await Promise.resolve();
    h.handlers().onAudioDone("Goodbye.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("adopts an ALREADY-SENT goodbye mark rather than waiting for an utterance that will never come", async () => {
    // The normal ordering once the tool is dispatched: the goodbye's audio
    // finishes and its mark goes out BEFORE the tool result comes back. The
    // mark was not final when it was sent, so unless it is adopted its echo
    // only clears playback and the call runs to the ceiling.
    const h = makeBridge({ agent: permittingAgent() });
    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Thanks for calling. Goodbye.");
    h.handlers().onAudioDelta(b64(8000));
    h.handlers().onAudioDone("Thanks for calling. Goodbye.");
    const name = h.marks()[h.marks().length - 1].mark.name;
    h.handlers().onToolCall("c1", "terminate_call", { reason: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    // No NEW mark invented — the one already in flight is the one to gate on.
    expect(h.marks()[h.marks().length - 1].mark.name).toBe(name);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.bridge.getTranscript()).toBe("AGENT: Thanks for calling. Goodbye.");
  });

  it("derives the adopted mark's fallback from that utterance's own audio", async () => {
    const h = makeBridge({ agent: permittingAgent() });
    const bytes = 16_000;
    h.newResponse();
    h.handlers().onAudioDelta(b64(bytes));
    h.handlers().onAudioDone("Goodbye.");
    h.handlers().onToolCall("c1", "terminate_call", { reason: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.bridge.lastArmedFinalFallbackMs).toBe(
      bytes / MULAW_BYTES_PER_MS + FINAL_MARK_GRACE_MS,
    );
  });

  it("still ends a call whose goodbye already played and echoed", async () => {
    const h = makeBridge({ agent: permittingAgent() });
    const spoken = speakUtterance(h, "Take care now.");
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: spoken } });
    h.handlers().onToolCall("c1", "terminate_call", { reason: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    const name = h.marks()[h.marks().length - 1].mark.name;
    expect(name).not.toBe(spoken);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    expect(h.outcomes).toEqual(["agent_ended"]);
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
    // The answer reaches the wire layer as an OBJECT, because that layer
    // spreads it into the payload. Handing it the raw JSON string spreads
    // the string's characters and the model receives garbage — the bug the
    // end-to-end call test found.
    expect(h.session.sendToolResult).toHaveBeenCalledWith("call-9", false, {
      ok: false,
      error: "tool_failed",
    });
  });

  it("hands the wire layer an object, never the pre-encoded string", async () => {
    const h = makeBridge();
    h.handlers().onToolCall("c1", "create_ticket", {});
    await Promise.resolve();
    await Promise.resolve();
    const [, , output] = (h.session.sendToolResult as unknown as {
      mock: { calls: [string, boolean, unknown][] };
    }).mock.calls[0];
    expect(typeof output).toBe("object");
    expect(output).toEqual({ ticket: "VA-51121" });
  });

  it("gives a non-object tool answer a name rather than scattering it into characters", () => {
    expect(decodeToolOutput('{"ticket":"VA-1"}')).toEqual({ ticket: "VA-1" });
    expect(decodeToolOutput('"VA-1 filed"')).toEqual({ result: "VA-1 filed" });
    expect(decodeToolOutput("[1,2]")).toEqual({ result: [1, 2] });
    expect(decodeToolOutput("filed, no JSON")).toEqual({ result: "filed, no JSON" });
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
  it("covers the OPENING turn — a session that configures and never speaks is dead air", () => {
    // Found by a mutation sweep: deleting the watchdog arm on the
    // configured path left every test passing. Without it, an agent that
    // handshakes and then never produces its greeting leaves the caller in
    // silence until the ten-minute ceiling.
    const h = makeBridge({ deadAirMs: 30_000 });
    h.handlers().onConfigured();
    expect(h.timers.fire(30_000)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("clears once the opening line is actually delivered", () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    h.handlers().onConfigured();
    speakUtterance(h, "Thank you for calling Azul Vision.");
    expect([...h.timers.pending.values()].some((t) => t.ms === 30_000)).toBe(false);
  });

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
