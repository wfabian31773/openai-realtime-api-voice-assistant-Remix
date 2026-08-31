import { describe, it, expect, vi } from "vitest";
import {
  decodeToolOutput,
  VoiceCallBridge,
  FINAL_MARK_GRACE_MS,
  MULAW_BYTES_PER_MS,
  TOOL_DISPATCH_GRACE_MS,
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
    guardrails: [],
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
    greeting?: string | null;
    persistCallRecord?: (r: VoiceCallRecord) => Promise<void>;
    endCallToolNames?: string[];
    maxCallMs?: number;
    deadAirMs?: number;
    guardrailMode?: "enforce" | "log";
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
    // A guardrail's safe replacement creates a response of its own, so the
    // cut line's epoch is genuinely behind it.
    speakNatural: vi.fn(() => {
      epoch += 1;
    }),
    // A scripted say creates a response, and GrokVoiceSession advances the
    // epoch on its `response.created`. The greeting's line is bound to that
    // epoch, so a fake that never advanced it modelled the greeting as
    // arriving on the response BEFORE its own.
    speak: vi.fn(() => {
      epoch += 1;
    }),
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
    greeting: over.greeting,
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
    guardrailMode: over.guardrailMode,
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

/** The name of the most recent mark the bridge emitted. */
function lastMarkName(h: ReturnType<typeof makeBridge>): string {
  const marks = h.marks();
  return marks[marks.length - 1].mark.name;
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

  it("asks the agent to continue after a tool — a tool result does not start a turn by itself", async () => {
    // Submitting function_call_output adds a conversation item; it does not
    // make the model speak. Without an explicit request the caller hears
    // nothing after create_ticket until the dead-air watchdog fires
    // (Codex review, PR #227).
    const h = makeBridge();
    h.newResponse();
    h.handlers().onToolCall("c1", "create_ticket", { reason: "refill" });
    h.handlers().onResponseDone(); // the carrying response finished delivering
    await Promise.resolve();
    await Promise.resolve();
    expect(h.session.requestResponse).toHaveBeenCalledTimes(1);
  });

  it("a response carrying TWO tool calls gets exactly ONE follow-up, after both outputs", async () => {
    // A request per tool did two wrong things: each extra queued request
    // released another unsolicited reply after the first one's
    // response.done, and a slower tool saw the first reply begin before its
    // output existed (Codex, PR #227 round 14).
    let releaseSlow!: (v: { ok: boolean; output: string }) => void;
    const slow = new Promise<{ ok: boolean; output: string }>((r) => (releaseSlow = r));
    const h = makeBridge({
      agent: makeAgent({
        dispatch: async (name: string) =>
          name === "slow_lookup" ? slow : { ok: true, output: '{"ok":1}' },
      }),
    });
    h.newResponse();
    h.handlers().onToolCall("c1", "create_ticket", {});
    h.handlers().onToolCall("c2", "slow_lookup", {});
    h.handlers().onResponseDone();
    await new Promise((r) => setTimeout(r, 0));

    // The fast tool's output is in, but the reply must WAIT for the slow
    // one — speaking now would answer with half the facts.
    expect(h.session.sendToolResult).toHaveBeenCalledTimes(1);
    expect(h.session.requestResponse).not.toHaveBeenCalled();

    releaseSlow({ ok: true, output: '{"ok":2}' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session.sendToolResult).toHaveBeenCalledTimes(2);
    expect(h.session.requestResponse).toHaveBeenCalledTimes(1);
  });

  it("a fast tool settling BEFORE its sibling's event arrives still yields one follow-up", async () => {
    // The round-14 counter alone touched zero twice here — the wire had
    // not yet delivered the second function-call event of the SAME
    // response when the first dispatch settled — queuing two follow-ups
    // and recreating the unsolicited reply (Codex, PR #227 round 17).
    // Only the carrying response's done event proves the turn is whole.
    const h = makeBridge();
    h.newResponse();
    h.handlers().onToolCall("c1", "create_ticket", {});
    await new Promise((r) => setTimeout(r, 0));
    // First dispatch fully settled; its sibling has not even arrived.
    expect(h.session.sendToolResult).toHaveBeenCalledTimes(1);
    expect(h.session.requestResponse).not.toHaveBeenCalled();

    h.handlers().onToolCall("c2", "create_ticket", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session.sendToolResult).toHaveBeenCalledTimes(2);
    // Still nothing: the response boundary has not been seen.
    expect(h.session.requestResponse).not.toHaveBeenCalled();

    h.handlers().onResponseDone();
    expect(h.session.requestResponse).toHaveBeenCalledTimes(1);
  });

  it("does NOT ask for another turn after a termination the guards allowed", async () => {
    const h = makeBridge({
      agent: makeAgent({
        dispatch: vi.fn(async () => ({
          ok: true,
          output: JSON.stringify({ success: false, status: 404 }),
        })),
      }),
    });
    h.handlers().onToolCall("c1", "terminate_call", { reason: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.session.requestResponse).not.toHaveBeenCalled();
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

  it("a tool call RESTARTS the clock with headroom — the tool's budget is not billed against the model's", () => {
    // The window armed at speech-stop was for the model to ACT, and a
    // function-call event is the model acting. The queue filing tools are
    // allowed up to 30 seconds of their own — the same span as this
    // watchdog — so a clock still ticking from speech-stop tears down a
    // valid dispatch as dead_air moments before its result lands (Codex,
    // PR #227 round 19). And an EQUAL fresh window still loses the race
    // to a tool that legitimately exhausts its own timeout, because it is
    // armed before dispatch reaches the tool — hence the grace
    // (round 21).
    const h = makeBridge({
      deadAirMs: 30_000,
      agent: makeAgent({ dispatch: () => new Promise(() => {}) as never }),
    });
    h.handlers().onSpeechStopped();
    expect([...h.timers.pending.values()].filter((t) => t.ms === 30_000)).toHaveLength(1);
    h.newResponse();
    h.handlers().onToolCall("c1", "create_ticket", {});
    // The caller-turn clock is GONE; the tool holds a longer fresh window.
    expect(h.timers.fire(30_000)).toBe(false);
    const toolWindow = [...h.timers.pending.values()].filter(
      (t) => t.ms === 30_000 + TOOL_DISPATCH_GRACE_MS,
    );
    expect(toolWindow).toHaveLength(1);
    // A longer bound is a budget, never immunity: a dispatch that
    // exhausts window AND grace is still dead air.
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("an utterance completing while its response's tool still runs leaves the watchdog armed", () => {
    // "Let me file that for you" and create_ticket in ONE response, the
    // function-call event first: the spoken line completes, but the TURN
    // is not delivered until the tool settles and its follow-up speaks.
    // Clearing on the utterance left the hung tool bounded only by the
    // ten-minute ceiling (Codex, PR #227 round 19).
    const h = makeBridge({
      deadAirMs: 30_000,
      agent: makeAgent({ dispatch: () => new Promise(() => {}) as never }),
    });
    h.newResponse();
    h.handlers().onToolCall("c1", "create_ticket", {});
    h.handlers().onAgentTranscriptDelta("Let me file that for you.");
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onAudioDone("Let me file that for you.");
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("the follow-up after a tool gets the MODEL's window, not the tail of the tool's", async () => {
    const h = makeBridge({ deadAirMs: 30_000 });
    h.newResponse();
    h.handlers().onToolCall("c1", "create_ticket", {});
    await new Promise((r) => setTimeout(r, 0));
    // Dispatch settled; the boundary has not been seen, so the pending
    // clock is still the tool window armed at the function-call event.
    const beforeBoundary = [...h.timers.pending.entries()].filter(
      ([, t]) => t.ms === 30_000 + TOOL_DISPATCH_GRACE_MS,
    );
    expect(beforeBoundary).toHaveLength(1);
    h.handlers().onResponseDone();
    expect(h.session.requestResponse).toHaveBeenCalledTimes(1);
    // The follow-up waits on the MODEL, so its window is the plain span.
    const afterFollowUp = [...h.timers.pending.entries()].filter(([, t]) => t.ms === 30_000);
    expect(afterFollowUp).toHaveLength(1);
    // A follow-up the model never answers is dead air, not a ceiling wait.
    expect(h.timers.fire(30_000)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("a transfer wait widens the watchdog to span the accept window — 45s tears down a live dial", () => {
    // The handoff runs as an ordinary tool dispatch, but its legitimate
    // span is the office dial plus the briefing-and-keypress wait. On the
    // tool budget alone the bridge recorded dead_air at 45 seconds and
    // onOutcome abandoned the office leg — a staffer who answered near
    // the 40-45s ring limit was disconnected mid-briefing before they
    // could press a key (Codex, PR #230 round 3).
    const h = makeBridge({
      deadAirMs: 30_000,
      agent: makeAgent({ dispatch: () => new Promise(() => {}) as never }),
    });
    h.handlers().onSpeechStopped();
    h.newResponse();
    h.handlers().onToolCall("c1", "transfer_to_office", {});
    h.bridge.noteTransferWaitStarting(120_000);
    // The tool window alone must NOT fire…
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS)).toBe(false);
    // …the armed window carries the wait's span on top of the tool's.
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS + 120_000)).toBe(true);
    // A budget, never immunity: a wait that exhausts even that is dead air.
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("the widened budget survives the spoken 'connecting you' line completing mid-wait", () => {
    // The utterance-done re-arm for a still-pending tool would otherwise
    // shrink the window straight back to the 45-second tool budget — the
    // wait's span must be a state on the bridge, not a one-shot re-arm.
    const h = makeBridge({
      deadAirMs: 30_000,
      agent: makeAgent({ dispatch: () => new Promise(() => {}) as never }),
    });
    h.newResponse();
    h.handlers().onToolCall("c1", "transfer_to_office", {});
    h.bridge.noteTransferWaitStarting(120_000);
    h.handlers().onAgentTranscriptDelta("One moment while I connect you.");
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onAudioDone("One moment while I connect you.");
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS)).toBe(false);
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS + 120_000)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("a settled attempt restores the normal budget — the failure line is owed on the model's clock", () => {
    const h = makeBridge({
      deadAirMs: 30_000,
      agent: makeAgent({ dispatch: () => new Promise(() => {}) as never }),
    });
    h.newResponse();
    h.handlers().onToolCall("c1", "transfer_to_office", {});
    h.bridge.noteTransferWaitStarting(120_000);
    h.bridge.noteTransferWaitSettled();
    // The wait is over: the widened window is gone and the plain tool
    // window is what stands between the caller and dead air again.
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS + 120_000)).toBe(false);
    expect(h.timers.fire(30_000 + TOOL_DISPATCH_GRACE_MS)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });
});

describe("VoiceCallBridge — a transfer is not a hangup", () => {
  it("records `transferred` when the stream dies after the redirect mark", () => {
    // The warm transfer's redirect ENDS the Media Stream; the resulting
    // stop/close looked exactly like a caller hangup, so every successful
    // runtime handoff persisted with transferred_to_human=false (Codex,
    // PR #230 round 2).
    const h = makeBridge();
    h.bridge.noteTransferStarting();
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    expect(h.outcomes).toEqual(["transferred"]);
  });

  it("a FAILED redirect unmarks it — the caller never moved", () => {
    const h = makeBridge();
    h.bridge.noteTransferStarting();
    h.bridge.noteTransferFailed();
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    expect(h.outcomes).toEqual(["caller_hangup"]);
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

  it("measures the call from when the stream was claimed, not from its own construction", async () => {
    // The bridge is built after the pre-context lookup, the agent factory
    // and the call-row insert — seconds during which Twilio is already
    // streaming and billing (Codex review, PR #227).
    const records: VoiceCallRecord[] = [];
    const claimedAt = Date.now() - 5_000;
    const timers = makeTimers();
    let handlers!: BridgeSessionHandlers;
    const bridge = new VoiceCallBridge({
      context: {
        callSid: "CA-clock",
        streamSid: "MZ",
        slug: "optical",
        callerPhone: "+1",
        dialedNumber: "+2",
      },
      startedAtMs: claimedAt,
      agent: makeAgent(),
      twilio: { sendFrame: () => {}, close: () => {} },
      createSession: (h) => {
        handlers = h;
        return {
          appendAudio: vi.fn(),
          cancelResponse: vi.fn(),
          sendToolResult: vi.fn(),
          requestResponse: vi.fn(),
          speakNatural: vi.fn(),
    speak: vi.fn(),
          close: vi.fn(),
          getResponseEpoch: () => 0,
        };
      },
      onOutcome: () => {},
      persistCallRecord: async (r) => void records.push(r),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    void handlers;
    bridge.handleSocketClosed();
    await Promise.resolve();
    expect(records).toHaveLength(1);
    expect(records[0].startedAtMs).toBe(claimedAt);
    // ~5s of real call, not ~0.
    expect(records[0].endedAtMs - records[0].startedAtMs).toBeGreaterThanOrEqual(4_900);
  });

  it("stamps the first and last transcript, for the latency columns", async () => {
    const records: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void records.push(r) });
    h.handlers().onCallerTranscript("I need a refill", "item-1");
    speakUtterance(h, "Let me file that for you.");
    h.bridge.handleSocketClosed();
    await Promise.resolve();
    expect(records[0].firstTranscriptAtMs).toBeGreaterThan(0);
    expect(records[0].lastTranscriptAtMs).toBeGreaterThanOrEqual(
      records[0].firstTranscriptAtMs!,
    );
  });

  it("leaves the transcript stamps unset when nothing was ever transcribed", async () => {
    const records: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void records.push(r) });
    h.bridge.handleSocketClosed();
    await Promise.resolve();
    expect(records[0].firstTranscriptAtMs).toBeUndefined();
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

describe("VoiceCallBridge — output guardrails", () => {
  /** The shape the agents actually declare: a regex predicate over the text. */
  function diagnosisGuardrail() {
    return {
      name: "No diagnosis",
      policyHint: "Do not diagnose or clinically interpret symptoms.",
      execute: async ({ agentOutput }: { agentOutput: string }) => ({
        tripwireTriggered: /you have glaucoma/i.test(agentOutput),
        outputInfo: {},
      }),
    };
  }

  function guarded(mode?: "enforce" | "log") {
    return makeBridge({
      agent: makeAgent({ guardrails: [diagnosisGuardrail()] }),
      guardrailMode: mode,
    });
  }

  /** Guardrail verdicts land on the microtask queue; flush them. */
  const verdicts = () => Promise.resolve().then(() => Promise.resolve());

  it("cuts a violating line mid-air: cancel, clear, and a safe replacement turn", async () => {
    const h = guarded();
    h.newResponse();
    h.handlers().onAudioDelta(b64(800)); // the caller is already hearing it
    h.handlers().onAgentTranscriptDelta("Based on that, you have glaucoma");
    await verdicts();

    expect(h.session.cancelResponse).toHaveBeenCalledTimes(1);
    expect(h.clears()).toHaveLength(1);
    expect(h.session.speakNatural).toHaveBeenCalledTimes(1);
    const instruction = (h.session.speakNatural as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    // The rule corrects in its own terms, and never invites a repeat.
    expect(instruction).toContain("Do not diagnose");
    expect(instruction).toContain("do not repeat");
    // The record says what was heard and why it stopped.
    expect(h.bridge.getTranscript()).toContain("[cut by guardrail: No diagnosis]");
  });

  it("lets clean text play untouched", async () => {
    const h = guarded();
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onAgentTranscriptDelta("Let me file that request for the care team.");
    await verdicts();

    expect(h.session.cancelResponse).not.toHaveBeenCalled();
    expect(h.clears()).toHaveLength(0);
    expect(h.session.speakNatural).not.toHaveBeenCalled();
  });

  it("interrupts once per utterance, however many deltas follow the violation", async () => {
    const h = guarded();
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onAgentTranscriptDelta("you have glaucoma");
    h.handlers().onAgentTranscriptDelta(" and it is serious");
    h.handlers().onAgentTranscriptDelta(" so you should worry");
    await verdicts();

    expect(h.session.cancelResponse).toHaveBeenCalledTimes(1);
    expect(h.session.speakNatural).toHaveBeenCalledTimes(1);
  });

  it("in log mode records the trip and cuts nothing", async () => {
    const h = guarded("log");
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onAgentTranscriptDelta("you have glaucoma");
    await verdicts();

    expect(h.session.cancelResponse).not.toHaveBeenCalled();
    expect(h.clears()).toHaveLength(0);
    expect(h.session.speakNatural).not.toHaveBeenCalled();
  });

  it("in log mode a tripped utterance is not re-checked on every later delta", async () => {
    // In enforce mode the cut itself stops further checks (the utterance is
    // gone). In log mode the utterance keeps streaming, so without the
    // dedup every subsequent delta would re-run the rule and re-log the
    // same violation — dozens of times per line. The first mutation sweep
    // missed this: the enforce-mode test could not see it.
    let executions = 0;
    const counting = {
      name: "No diagnosis",
      execute: async ({ agentOutput }: { agentOutput: string }) => {
        executions += 1;
        return { tripwireTriggered: /glaucoma/.test(agentOutput) };
      },
    };
    const h = makeBridge({
      agent: makeAgent({ guardrails: [counting] }),
      guardrailMode: "log",
    });
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onAgentTranscriptDelta("you have glaucoma");
    await verdicts();
    expect(executions).toBe(1);

    h.handlers().onAgentTranscriptDelta(" which is a serious condition");
    h.handlers().onAgentTranscriptDelta(" of the optic nerve");
    await verdicts();
    // Already tripped: the later deltas do not re-run the rule.
    expect(executions).toBe(1);
  });

  it("ignores a verdict that lands after a barge-in already cancelled the line", async () => {
    // The caller interrupted while the guardrail was still deciding. Acting
    // on the late verdict would cancel the NEXT line — the same stale-epoch
    // hazard as late audio, handled with the same discipline.
    let release!: (v: { tripwireTriggered: boolean }) => void;
    const slow = {
      name: "Slow rule",
      execute: () =>
        new Promise<{ tripwireTriggered: boolean }>((resolve) => {
          release = resolve;
        }),
    };
    const h = makeBridge({ agent: makeAgent({ guardrails: [slow] }) });
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onAgentTranscriptDelta("anything at all");
    h.handlers().onSpeechStarted(); // barge-in: cancels this epoch
    expect(h.session.cancelResponse).toHaveBeenCalledTimes(1);

    release({ tripwireTriggered: true });
    await verdicts();

    // The late verdict changed nothing: no second cancel, no correction.
    expect(h.session.cancelResponse).toHaveBeenCalledTimes(1);
    expect(h.session.speakNatural).not.toHaveBeenCalled();
  });

  it("a guardrail that throws does not take the call down — and the next check still runs", async () => {
    const throwing = {
      name: "Broken rule",
      execute: async () => {
        throw new Error("regex engine on fire");
      },
    };
    const h = makeBridge({
      agent: makeAgent({ guardrails: [throwing, diagnosisGuardrail()] }),
    });
    h.newResponse();
    h.handlers().onAudioDelta(b64(800));
    h.handlers().onAgentTranscriptDelta("you have glaucoma");
    await verdicts();

    // The broken rule died alone; the working one still cut the line.
    expect(h.session.cancelResponse).toHaveBeenCalledTimes(1);
    expect(h.session.speakNatural).toHaveBeenCalledTimes(1);
  });

  it("a trip during the goodbye revokes the armed hangup", async () => {
    const permitting = makeAgent({
      guardrails: [diagnosisGuardrail()],
      dispatch: vi.fn(async () => ({
        ok: true,
        output: JSON.stringify({ success: true }),
      })),
    });
    const h = makeBridge({ agent: permitting });
    h.newResponse();
    h.handlers().onAudioDelta(b64(8000));
    h.handlers().onToolCall("call-1", "terminate_call", { reason: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    h.handlers().onAgentTranscriptDelta("Goodbye — and remember, you have glaucoma");
    await verdicts();
    const marks = h.marks();
    if (marks.length > 0) {
      const name = marks[marks.length - 1].mark.name;
      h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } });
    }
    // The goodbye violated a safety rule mid-air; the hangup it carried is
    // revoked exactly as a barge-in revokes one.
    expect(h.outcomes).toEqual([]);
  });
});

describe("VoiceCallBridge — transcript timing is caller-anchored", () => {
  /**
   * `first_transcript_delay_ms` is defined as "Ms from session start to first
   * CALLER transcript" (shared/schema.ts). On every normal call the agent's
   * greeting completes before the caller says a word, so stamping the first
   * timestamp from the agent's completion scores greeting generation instead
   * of caller transcription — making the documented cutover metric
   * systematically optimistic (Codex, PR #227 round 11).
   */
  it("the caller's first line opens the window", async () => {
    const persisted: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void persisted.push(r) });

    // Greeting first, as on every call — then the caller speaks.
    speakUtterance(h, "Thank you for calling Azul Vision.");
    h.handlers().onCallerTranscript("I need a refill.", "item-1");
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    await Promise.resolve();

    expect(persisted[0]?.firstTranscriptAtMs).toBeDefined();
    expect(persisted[0]?.lastTranscriptAtMs).toBeDefined();
  });

  it("a call where the caller never speaks records no first-transcript time at all", async () => {
    const persisted: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void persisted.push(r) });
    speakUtterance(h, "Hello? Is anyone there?");
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    await Promise.resolve();

    // No caller transcript ever arrived: a greeting-only call must not
    // fabricate a caller-latency number.
    expect(persisted[0]?.firstTranscriptAtMs).toBeUndefined();
    // But the tail window still knows when the last words were spoken.
    expect(persisted[0]?.lastTranscriptAtMs).toBeDefined();
  });

  it("an INTERRUPTED line stamps the clock when it is committed", async () => {
    // A cancelled response may never emit its transcript.done, so the
    // barge-in commit is the interrupted line's only chance to move
    // `lastTranscriptAtMs`. Without it, a greeting interrupted before any
    // completed transcript produced a transcript with no tail metric at
    // all, and later interruptions measured the tail from an older line
    // (Codex, PR #227 round 13).
    const persisted: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void persisted.push(r) });

    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Thank you for calling ");
    h.handlers().onAudioDelta(b64(400));
    h.handlers().onSpeechStarted(); // barge-in mid-greeting, nothing completed yet
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    await Promise.resolve();

    expect(persisted[0]?.transcript).toContain("[interrupted]");
    expect(persisted[0]?.lastTranscriptAtMs).toBeDefined();
    // Still no caller line — the interrupted AGENT words must not open
    // the caller-latency window.
    expect(persisted[0]?.firstTranscriptAtMs).toBeUndefined();
  });

  it("a caller who hangs up mid-greeting still gets a tail measurement", async () => {
    // Same invariant on the teardown commit: audio was playing right up to
    // the hangup, so the line committed there stamps the clock too.
    const persisted: VoiceCallRecord[] = [];
    const h = makeBridge({ persistCallRecord: async (r) => void persisted.push(r) });

    h.newResponse();
    h.handlers().onAgentTranscriptDelta("Hello? Is anyone ");
    h.handlers().onAudioDelta(b64(400));
    // No onAudioDone, no barge-in — the caller just hangs up.
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    await Promise.resolve();

    expect(persisted[0]?.transcript).toContain("[interrupted]");
    expect(persisted[0]?.lastTranscriptAtMs).toBeDefined();
  });

  it("a cancelled response's LATE completion does not move the clock", async () => {
    // The interrupted line was stamped when the barge-in committed it. Its
    // late `transcript.done` delivers no words, so stamping there would
    // move `lastTranscriptAtMs` forward and understate the tail for every
    // interrupted call (Codex, PR #227 round 14).
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const persisted: VoiceCallRecord[] = [];
      const h = makeBridge({ persistCallRecord: async (r) => void persisted.push(r) });

      h.newResponse();
      h.handlers().onAgentTranscriptDelta("Thank you for ");
      h.handlers().onAudioDelta(b64(400));
      h.handlers().onSpeechStarted(); // barge-in commits + stamps at t=1,000,000

      vi.setSystemTime(1_060_000); // a minute later the discarded completion lands
      h.handlers().onAudioDone("Thank you for calling.");
      h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
      await Promise.resolve();

      expect(persisted[0]?.lastTranscriptAtMs).toBe(1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the practice greets the caller before the agent takes a turn", () => {
  /**
   * Why this is a bridge concern and not the agent's.
   *
   * The queue prompts are written for the SIP path, where the greeting has
   * already played by the time the agent is handed the call. Optical's says
   * so outright: "Your greeting has already played. Do NOT greet again. Go
   * straight to confirming: Am I speaking with …?". This runtime never
   * played it, so the agent followed an instruction whose premise was false
   * and opened cold on the caller's own first name — three live calls,
   * 2026-08-31, before anyone worked out it was not the model's doing.
   */
  // Ends in a QUESTION, as every real greeting does — optical's live text is
  // "…but I can take a message and they will follow up with you. How can I
  // help you today?". The fixture used to be declarative, which meant the
  // "waits for the caller" tests below were asserting that behaviour against
  // a greeting that never asks anything: the caller was not holding the turn
  // and nobody was. Found when the declarative case got a rule of its own.
  const GREETING = "Thank you for calling Azul Vision optical. How can I help you today?";

  it("speaks the greeting and then waits for the caller", () => {
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    expect(h.session.speak).toHaveBeenCalledWith(GREETING, { interruptible: false });
    // The greeting ends in a question. Taking a turn here speaks a second
    // opening over one already asked — and on PCP it answers before the
    // call purpose the greeting just requested has been given.
    expect(h.session.requestResponse).not.toHaveBeenCalled();
  });

  it("does not take a turn when the greeting's own response completes either", () => {
    // The earlier version of this fix owed the agent a turn and released it
    // here. That is the bug this test exists to keep out: the caller is
    // mid-answer, and the next voice must be theirs.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAgentTranscriptDelta?.("Thank you for calling");
    h.handlers().onAudioDone(GREETING);
    h.handlers().onResponseDone();

    expect(h.session.requestResponse).not.toHaveBeenCalled();
  });

  it("lets a caller take their time answering it", () => {
    // Nothing is owed once a line is delivered, so the window is clear and
    // a slow answer cannot trip dead air. Firing the timer proves the clock
    // is actually down rather than merely re-armed somewhere else.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAgentTranscriptDelta?.("Thank you for calling");
    h.handlers().onAudioDone(GREETING);
    h.handlers().onResponseDone();

    expect(h.timers.fire(30_000)).toBe(false);
    expect(h.outcomes).toEqual([]);
  });

  it("speaks it scripted, never as an instruction the model rephrases", () => {
    // speakNatural hands the model a meaning to phrase; speak hands it words.
    // A greeting that varies call to call is the thing being fixed, so the
    // distinction is the fix, not a detail.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    expect(h.session.speakNatural).not.toHaveBeenCalled();
  });

  it("does not let a caller talk over the greeting", () => {
    // The operator asked for this in these words — the opening should not be
    // barge-able — and it is a safety rule on the after-hours line, whose
    // greeting carries the closed-office notice, the 911 direction and the
    // recording disclosure. noIvrAgent requires all of it before anything
    // else. A caller saying "hello" over it used to cancel the response and
    // send Twilio a `clear`, discarding whatever was still buffered.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");

    h.handlers().onSpeechStarted(); // "hello?" over the opening

    // The two things that truncate it, neither of which may happen here.
    expect(h.session.cancelResponse).not.toHaveBeenCalled();
    expect(h.clears()).toEqual([]);
  });

  it("takes the lock off once Twilio confirms the greeting played", () => {
    // Released on the MARK ECHO, not on onAudioDone: audio-done means the
    // provider finished sending, with the tail still in Twilio's buffer.
    // Unlocking there would leave the last seconds discardable, which on the
    // after-hours line is exactly where the recording disclosure sits.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING);

    // Still locked: sent, not yet played.
    h.handlers().onSpeechStarted();
    expect(h.clears()).toEqual([]);

    const markName = h.marks()[0]!.mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    // Played. Barge-in is ordinary from here — this protects the opening,
    // not the conversation.
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onSpeechStarted();
    expect(h.session.cancelResponse).toHaveBeenCalled();
    expect(h.clears()).toHaveLength(1);
  });

  it("releases the lock if Twilio never echoes the greeting's mark", () => {
    // The window between sending that mark and its echo is covered by
    // nothing else: handleAudioDone clears the dead-air clock BEFORE the
    // mark goes out. Unbounded, a lost echo would hold the lock for the
    // whole call, so no LATER agent response could be interrupted either.
    // Codex, #240 — and it corrected a comment of mine that claimed the
    // watchdog already covered this.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING);

    // No echo. The fallback is playback time plus the grace; the audio here
    // is one tiny frame, so the grace dominates.
    expect(h.timers.fire(FINAL_MARK_GRACE_MS + 1)).toBe(true);

    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onSpeechStarted();
    expect(h.session.cancelResponse).toHaveBeenCalled();
    expect(h.clears()).toHaveLength(1);
  });

  it("still owes the caller a reply when they answer over the greeting", () => {
    // They spoke and stopped while the lock was held, so a response is owed.
    // The greeting's own completion then clears the clock — it was speaking
    // before they were, so it did not deliver that reply. Before the lock
    // this could not happen: their speech cancelled the greeting outright.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onSpeechStarted();
    h.handlers().onSpeechStopped(); // arms "response"
    // THE STEP THAT MATTERS. The greeting is still playing, and its next
    // delta re-arms the cause as "utterance" — which is what lets the
    // completion below clear a clock that was owed to the caller. Without
    // this delta the cause is still "response", the clearing branch never
    // runs, and the test passes with or without the fix. It did, until
    // mutation testing said so.
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING);

    // The debt survives: firing the window ends the call as dead air rather
    // than letting it sit silent to the ten-minute ceiling.
    expect(h.timers.fire(30_000)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("does not hang up on a caller who pauses after the agent's real reply", () => {
    // The lock outlives the greeting's AUDIO — it waits on Twilio's echo. A
    // caller who answers in that gap is answering a greeting that already
    // finished, so the next completion is the agent's genuine reply to them.
    // Treating that as an undelivered debt disconnects someone who simply
    // pauses after hearing it. Codex, #240.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING); // greeting sent; echo not back yet

    h.handlers().onSpeechStarted();
    h.handlers().onSpeechStopped(); // answered AFTER the greeting finished

    // The agent's actual reply, delivered.
    h.newResponse();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone("Of course, I can help with that.");

    // Nothing is owed. A slow caller must not be cut off.
    expect(h.timers.fire(30_000)).toBe(false);
    expect(h.outcomes).toEqual([]);
  });

  it("takes its own turn after a greeting that asks nothing", () => {
    // `welcome_greeting` is free text and the admin field does not require a
    // question. A declarative greeting leaves nobody holding the turn: the
    // agent is not speaking, the caller was not asked, and the watchdog
    // clears because a delivered line owes nothing. Codex, #240.
    const h = makeBridge({ greeting: "Thank you for calling Azul Vision." });
    h.handlers().onConfigured();
    expect(h.session.speak).toHaveBeenCalledWith("Thank you for calling Azul Vision.", {
      interruptible: false,
    });
    // Not yet — it speaks first, then continues.
    expect(h.session.requestResponse).not.toHaveBeenCalled();

    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone("Thank you for calling Azul Vision.");
    h.handlers().onResponseDone();

    expect(h.session.requestResponse).toHaveBeenCalledTimes(1);
    // And that turn is owed, so silence after it is caught rather than
    // running to the ten-minute ceiling.
    expect(h.timers.fire(30_000)).toBe(true);
    expect(h.outcomes).toEqual(["dead_air"]);
  });

  it("still waits after a greeting that does ask", () => {
    // The control. GREETING ends in a question, so the caller holds the
    // turn and the agent must not speak over it.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING);
    h.handlers().onResponseDone();

    expect(h.session.requestResponse).not.toHaveBeenCalled();
    expect(h.timers.fire(30_000)).toBe(false);
  });

  it("keeps the opening in order when a caller talks over the greeting", () => {
    // The greeting used to be held in awaitingMark until Twilio echoed, while
    // a caller completion wrote straight through — so the record read
    // CALLER-then-AGENT for an exchange that happened the other way round.
    // Worse, agentLine() closes the open caller line, so the NEXT cumulative
    // re-emission of the same caller item appended a duplicate instead of
    // replacing it: the caller's words once on each side of the greeting.
    // Codex, #240, after merge.
    //
    // Both are gone with the deferral. The greeting's line is written when
    // its audio starts, so it is already ahead of these completions and
    // already closed this caller turn before the re-emission arrives.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("hello", "item-1");
    // Cumulative re-emission of the SAME item — must refine, not duplicate.
    h.handlers().onCallerTranscript("hello are you there", "item-1");

    h.handlers().onAudioDone(GREETING);
    const markName = h.marks()[0]!.mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    const lines = h.bridge.getTranscript().split("\n");
    expect(lines).toEqual([`AGENT: ${GREETING}`, "CALLER: hello are you there"]);
  });

  it("keeps two separate things the caller said over the greeting", () => {
    // Buffering the completions dropped the VAD boundaries between them:
    // callerBoundary() only marks an OPEN line, so against a log that is
    // still empty it is a no-op. Replayed without it, a second utterance
    // that happens to be a PREFIX of the first scores as `keep` — the
    // shorter re-emission of one turn — and is discarded. The boundary is
    // the only thing separating that from a genuinely new utterance.
    // Codex, #241.
    //
    // Nothing is buffered now, so both the lines and the boundary between
    // them are applied where they arrive. This is the case that proves it:
    // "yes" is a strict word-prefix of "yes this is Wayne", so it survives
    // only because the boundary reached the log before it did.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("yes this is Wayne"); // no itemId
    h.handlers().onSpeechStarted(); // a NEW utterance, not a refinement
    h.handlers().onCallerTranscript("yes");

    h.handlers().onAudioDone(GREETING);
    const markName = h.marks()[0]!.mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${GREETING}`,
      "CALLER: yes this is Wayne",
      "CALLER: yes",
    ]);
  });

  it("does not lose what a caller said before hanging up on the greeting", () => {
    // Nothing is held any more, so nothing can be lost: the caller's line was
    // written when it arrived and the greeting's when its audio started. What
    // teardown still owes is the CUT — and it amends the greeting's committed
    // line rather than appending, or the opening would appear twice, once
    // whole and once interrupted.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAgentTranscriptDelta?.(GREETING);
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onCallerTranscript("wrong number sorry", "item-1");

    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);

    // Asserted on the WHOLE transcript, not with toContain. The first version
    // of this test used toContain and so could not see order at all — it
    // passed while teardown was flushing these lines in FRONT of the greeting
    // still playing, reproducing the reversal in every hangup record from
    // that window. Codex, #241.
    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${GREETING} [interrupted]`,
      "CALLER: wrong number sorry",
    ]);
  });

  it("leaves the caller first when they speak before the greeting plays", () => {
    // The lock is taken at the handshake, but the greeting does not start
    // playing until the provider generates it. A caller who speaks in THAT
    // window really did speak first — nothing had reached them. Holding
    // their line and letting the mark echo commit the greeting ahead of it
    // manufactures the same reversal this buffering exists to prevent,
    // pointing the other way.
    //
    // Note the absent onAudioDelta before the caller speaks: every other
    // ordering test here sends one, which is exactly why none of them could
    // see this. Codex, #241.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("hello? anyone there?", "item-1");

    // NOW the greeting starts and finishes.
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING);
    const markName = h.marks()[0]!.mark.name;
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      "CALLER: hello? anyone there?",
      `AGENT: ${GREETING}`,
    ]);
  });

  it("puts the greeting where its audio began, even mid-utterance", () => {
    // The one ordering this change gives up, on purpose, and the reason it
    // is written down. The caller starts before the greeting plays but their
    // ASR completion lands after it has started, so the greeting's line is
    // already in the record and theirs follows.
    //
    // What used to hold their line back was a per-utterance decision, taken
    // at speech_started and carried to the completion. It is gone, and the
    // two tests below are why: answered once and never re-answered, that same
    // flag let a second utterance barge the greeting outright. An overlap
    // cannot be rendered as anything but a sequence in a line-per-turn
    // transcript; what a line CAN be is placed where its own audio began,
    // which needs no decision at all and so has no seam to get wrong.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted(); // caller begins — nothing has played yet
    h.handlers().onAudioDelta("ZmFrZQ=="); // greeting starts mid-utterance
    h.handlers().onCallerTranscript("hello? anyone there?", "item-1"); // completes after

    h.handlers().onAudioDone(GREETING);

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${GREETING}`,
      "CALLER: hello? anyone there?",
    ]);
  });

  it("keeps the greeting ahead of a SECOND thing said over it", () => {
    // The residual left on main by #241. The hold was decided once per
    // utterance and never re-decided, so a caller who spoke before the
    // greeting started arrived at their second utterance with the answer
    // already "not held": it wrote straight through and landed ahead of a
    // greeting whose line was still waiting on Twilio's echo.
    //
    // There is no mark echo in this test at all, and that is the fix stated
    // as an assertion: nothing about the opening is waiting for one.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted(); // into the silence before the greeting
    h.handlers().onCallerTranscript("is anyone there", "item-1");

    h.handlers().onAudioDelta("ZmFrZQ=="); // NOW the greeting starts playing

    h.handlers().onSpeechStarted(); // and they speak again over it
    h.handlers().onCallerTranscript("hello hello", "item-2");

    h.handlers().onAudioDone(GREETING);

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      "CALLER: is anyone there",
      `AGENT: ${GREETING}`,
      "CALLER: hello hello",
    ]);
  });

  it("holds the lock against a caller who ALSO spoke before the greeting", () => {
    // The same residual in its louder form: the buffering branch was what
    // stopped a barge-in during the greeting, and it was skipped whenever the
    // per-utterance hold had already been answered "no" — so this caller cut
    // the opening short. On the after-hours line that is the closed-office
    // notice, the 911 direction and the recording disclosure. The lock is
    // tested explicitly now, so the answer cannot go stale.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted(); // before the greeting plays
    h.handlers().onAudioDelta("ZmFrZQ=="); // the greeting starts
    h.handlers().onSpeechStarted(); // over the greeting

    expect(h.session.cancelResponse).not.toHaveBeenCalled();
    expect(h.clears()).toEqual([]);
  });

  it("does not record the greeting twice when the call ends before its echo", () => {
    // Its line went in when the audio started, and its awaitingMark entry is
    // still outstanding at teardown. That entry has to AMEND the line, not
    // add a second copy of the opening — while still saying the caller heard
    // only part of it, because the tail was in Twilio's buffer.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    // The wire's own transcript of a SCRIPTED line, which is not required to
    // come back byte-identical. The amendment has to agree with the line it
    // amends — the practice's words, as configured — not quietly swap in the
    // model's transcription of them.
    h.handlers().onAudioDone("thank you for calling azul vision optical how can i help you today");
    h.handlers().onCallerTranscript("sorry wrong number", "item-1");

    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${GREETING} [interrupted]`,
      "CALLER: sorry wrong number",
    ]);
  });

  it("records no greeting line when its audio never reached the caller", () => {
    // No audio, no line — the rule every other utterance follows.
    //
    // Deliberately WITHOUT a new response: a second utterance of the same one
    // carries the same epoch, so this is the single case the epoch bind
    // cannot see. The pending text has to be dropped at the completion, or
    // the greeting's line lands on top of a line the model actually spoke.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDone(GREETING); // the response ended without audio

    h.handlers().onAgentTranscriptDelta("Sorry about that.");
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone("Sorry about that.");
    const markName = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    expect(h.bridge.getTranscript().split("\n")).toEqual(["AGENT: Sorry about that."]);
  });

  /**
   * A greeting is free text an operator saved in `agents.welcome_greeting`,
   * so it goes through the agent's own output rules like any other line.
   * That makes the guardrail cut the one path other than a hangup that can
   * reach a greeting whose line is already committed.
   */
  function diagnosisGuardrail() {
    return {
      name: "No diagnosis",
      policyHint: "Do not diagnose or clinically interpret symptoms.",
      execute: async ({ agentOutput }: { agentOutput: string }) => ({
        tripwireTriggered: /you have glaucoma/i.test(agentOutput),
        outputInfo: {},
      }),
    };
  }
  const verdicts = () => Promise.resolve().then(() => Promise.resolve());
  const BAD_GREETING = "Thank you for calling. If you have glaucoma, press one.";

  it("amends the greeting's own line when a guardrail cuts it mid-playback", async () => {
    // Its line is already in the record, so the cut has to rewrite that line.
    // Appending would report the opening twice — once whole, once cut — which
    // is the same duplication the mark echo is stopped from causing.
    const h = makeBridge({
      greeting: BAD_GREETING,
      agent: makeAgent({ guardrails: [diagnosisGuardrail()] }),
    });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ=="); // the line is committed HERE
    h.handlers().onAgentTranscriptDelta(BAD_GREETING);
    await verdicts();

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${BAD_GREETING} [cut by guardrail: No diagnosis]`,
    ]);
  });

  it("starts a new caller line after a greeting the call cut short", async () => {
    // The delivered case's twin. An amendment is that line FINISHING — cut
    // short rather than delivered — so the caller's turn is over just as
    // surely, and a NEW utterance that extends the earlier one must not merge
    // backwards across it. The guardrail path is the one where nothing else
    // would close the turn: its replacement never completes here.
    const h = makeBridge({
      greeting: BAD_GREETING,
      agent: makeAgent({ guardrails: [diagnosisGuardrail()] }),
    });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("yes"); // no itemId — word-level path

    h.handlers().onAudioDelta("ZmFrZQ=="); // the greeting's line is written
    h.handlers().onAgentTranscriptDelta(BAD_GREETING);
    await verdicts(); // cut: the line is amended, and the turn ends with it

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("yes this is Wayne");

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      "CALLER: yes",
      `AGENT: ${BAD_GREETING} [cut by guardrail: No diagnosis]`,
      "CALLER: yes this is Wayne",
    ]);
  });

  it("a greeting cut before it played does not claim the replacement's line", async () => {
    // Nothing of it reached the caller, so it has no line of its own to
    // write — and the pending text must not survive the cut and land on the
    // first delta of the replacement turn, which would put the greeting in
    // the record on top of words the model actually spoke.
    const h = makeBridge({
      greeting: BAD_GREETING,
      agent: makeAgent({ guardrails: [diagnosisGuardrail()] }),
    });
    h.handlers().onConfigured();
    h.handlers().onAgentTranscriptDelta(BAD_GREETING); // no audio yet
    await verdicts();

    // No manual response bump: `speakNatural` creates the replacement's own,
    // which is exactly what puts it past the greeting's epoch.
    h.handlers().onAgentTranscriptDelta("Thank you for calling. How can I help?");
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone("Thank you for calling. How can I help?");
    const markName = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${BAD_GREETING} [cut by guardrail: No diagnosis]`,
      "AGENT: Thank you for calling. How can I help?",
    ]);
  });

  it("stamps the tail from a greeting a guardrail cut, when nothing else can", async () => {
    // The cancelled response's own completion is discarded by the epoch
    // check, and the safe replacement never completes either — the caller
    // hangs up on it, and the guardrail already cleared `assistantAudioPlaying`
    // so teardown's cut does not run. Without a stamp at the cut, a
    // transcript with plainly caller-audible agent words in it carries no
    // tail measurement at all. Codex, #243.
    const persisted: VoiceCallRecord[] = [];
    const h = makeBridge({
      greeting: BAD_GREETING,
      agent: makeAgent({ guardrails: [diagnosisGuardrail()] }),
      persistCallRecord: async (r) => void persisted.push(r),
    });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAgentTranscriptDelta(BAD_GREETING);
    await verdicts();

    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await Promise.resolve();

    expect(persisted[0]?.transcript.split("\n")).toEqual([
      `AGENT: ${BAD_GREETING} [cut by guardrail: No diagnosis]`,
    ]);
    expect(persisted[0]?.lastTranscriptAtMs).toBeDefined();
  });

  it("refines a caller line that straddles the start of the greeting", () => {
    // Codex, #243. Their turn began before the greeting played and their ASR
    // is cumulative, so the fuller completion is the SAME utterance. Closing
    // their line when the greeting goes in strands it: that re-emission
    // appends instead of replacing, and the caller's words land twice, once
    // on each side of the opening — the duplication #241 fought, in a
    // narrower window. The greeting was queued at the handshake, before they
    // had said anything, so it is not the provider moving on from their turn.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("hello", "item-1");
    h.handlers().onAudioDelta("ZmFrZQ=="); // the greeting starts mid-turn
    h.handlers().onCallerTranscript("hello are you there", "item-1"); // same turn

    h.handlers().onAudioDone(GREETING);

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      "CALLER: hello are you there",
      `AGENT: ${GREETING}`,
    ]);
  });

  it("keeps refining one caller turn across the greeting's echo, by item id", () => {
    // Codex, #243 round 4 — the mirror of the test below, and the reason the
    // echo marks the turn rather than closing it. Item identity outranks the
    // mark: a cumulative re-emission carrying the same item_id is the same
    // utterance however much of the greeting played across it. Appending it
    // would put one thing the caller said on BOTH sides of the opening, which
    // is the defect this whole PR exists to remove.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("hello", "item-1");

    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING);
    const markName = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    // The SAME item, still being transcribed after the greeting was heard.
    h.handlers().onCallerTranscript("hello are you there", "item-1");

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      "CALLER: hello are you there",
      `AGENT: ${GREETING}`,
    ]);
  });

  it("cannot be barged by a SECOND utterance after speaking before the greeting", () => {
    // From #242, which found this defect independently while this PR was open
    // and fixed it inside the buffering. The lock's whole purpose, and the
    // case that defeated it: a caller who speaks before playback recorded "do
    // not hold my transcript line" — correct, their words come first — and
    // that same decision was then read to answer "may the greeting be
    // interrupted?", letting a LATER utterance cancel the greeting and clear
    // Twilio's buffer mid-sentence. On the after-hours line that can cut the
    // 911 direction or the recording disclosure.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted(); // before any audio — caller is first
    h.handlers().onAudioDelta("ZmFrZQ=="); // greeting starts
    h.handlers().onSpeechStarted(); // talks again, OVER the greeting

    expect(h.session.cancelResponse).not.toHaveBeenCalled();
    expect(h.clears()).toEqual([]);

    // #242's ORDERING half asserted the reverse of what follows, and the
    // difference is this PR's one deliberate behaviour change. There, the
    // per-utterance carry held this caller's line so it landed ahead of a
    // greeting they began speaking before. That carry is gone: it is the very
    // decision whose staleness defeated the lock above, and Codex found two
    // more faults in it on this PR. A line written when its own audio starts
    // needs no such decision — so the greeting sits where its audio began,
    // and words transcribed after that point follow it. See "puts the
    // greeting where its audio began, even mid-utterance".
    h.handlers().onCallerTranscript("hello? are you there?", "item-1");
    h.handlers().onAudioDone(GREETING);
    const markName2 = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName2 } });

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${GREETING}`,
      "CALLER: hello? are you there?",
    ]);
  });

  it("starts a new caller line once the greeting is fully delivered", () => {
    // Codex, #243. `openingLine` leaves the caller's turn open on purpose —
    // the greeting's audio is only STARTING, and a turn straddling that
    // moment must still refine in place — but the window has to close, and
    // the mark echo is where. Left open, a genuinely NEW utterance that
    // happens to EXTEND the earlier one merges into it: an extension replaces
    // even across a speech boundary, by design, because within one turn it
    // carries every earlier word and can lose nothing. Across a delivered
    // agent line it can — the record would read as if the whole of "yes this
    // is Wayne" were said before the practice ever spoke.
    //
    // No itemIds: this is the word-level correlation path, which is the only
    // one where an extension can merge two separate turns.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();

    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("yes");

    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone(GREETING);
    const markName = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    // A NEW turn, after the greeting was heard in full.
    h.handlers().onSpeechStarted();
    h.handlers().onCallerTranscript("yes this is Wayne");

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      "CALLER: yes",
      `AGENT: ${GREETING}`,
      "CALLER: yes this is Wayne",
    ]);
  });

  it("marks a greeting cut short by a superseded response, not delivered whole", () => {
    // Codex, #243. Its line is in the record claiming the whole greeting was
    // spoken, but only the beginning was: the response was superseded with no
    // completion, so no mark went out and `awaitingMark` holds nothing to
    // correct it with. Once the utterance sequence moves on, no later cut can
    // find that line either — recordCutLine matches the greeting by sequence.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ=="); // the greeting starts playing
    h.newResponse(); // superseded — its completion never comes
    h.handlers().onAgentTranscriptDelta("Sorry, let me start again.");
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone("Sorry, let me start again.");
    const markName = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      `AGENT: ${GREETING} [interrupted]`,
      "AGENT: Sorry, let me start again.",
    ]);
  });

  it("stamps the tail from a greeting a superseding response cut short", async () => {
    // Same invariant as the barge-in and teardown cuts: words the caller
    // heard, committed, move the clock. The superseding response here carries
    // no transcript of its own, so nothing else in the call can stamp it and
    // a greeting-length tail would be measured from before the call began.
    const persisted: VoiceCallRecord[] = [];
    const h = makeBridge({
      greeting: GREETING,
      persistCallRecord: async (r) => void persisted.push(r),
    });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.newResponse();
    h.handlers().onAudioDelta("ZmFrZQ=="); // supersedes; no words of its own
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await Promise.resolve();

    expect(persisted[0]?.transcript.split("\n")).toEqual([
      `AGENT: ${GREETING} [interrupted]`,
    ]);
    expect(persisted[0]?.lastTranscriptAtMs).toBeDefined();
  });

  it("a greeting whose response emits NOTHING leaves no line behind", () => {
    // Codex, #243. Superseded before a single delta, that response never
    // opened an utterance — so the branch in openOrGetCurrent that drops a
    // pending greeting has nothing to match on. Unbound, the REPLACEMENT's
    // first audio writes the greeting's line, and then swallows the
    // replacement's own transcript at its mark, because that line is marked
    // as already committed. The greeting is the first response created after
    // the handshake, and only that one may write it.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured(); // the greeting's response

    h.newResponse(); // a later one — the greeting's produced nothing at all
    h.handlers().onAgentTranscriptDelta("Sorry about that, how can I help?");
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone("Sorry about that, how can I help?");
    const markName = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    expect(h.bridge.getTranscript().split("\n")).toEqual([
      "AGENT: Sorry about that, how can I help?",
    ]);
  });

  it("a greeting superseded before it played leaves no line behind", () => {
    // The greeting opened an utterance but never reached audio, and the wire
    // moved past it. The replacement rides a later response, so the epoch
    // bind refuses it the greeting's line — otherwise that utterance's first
    // delta writes the greeting and its own real words are lost.
    const h = makeBridge({ greeting: GREETING });
    h.handlers().onConfigured();
    h.handlers().onAgentTranscriptDelta("Thank you for calling"); // greeting opens
    h.newResponse(); // superseded — no completion ever came for it
    h.handlers().onAgentTranscriptDelta("Sorry, one moment.");
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onAudioDone("Sorry, one moment.");
    const markName = lastMarkName(h);
    h.bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: markName } });

    expect(h.bridge.getTranscript().split("\n")).toEqual(["AGENT: Sorry, one moment."]);
  });

  it("still barges in normally on a lane with no greeting", () => {
    // The lock must not leak into lanes that never take it.
    const h = makeBridge({ greeting: null });
    h.handlers().onConfigured();
    h.handlers().onAudioDelta("ZmFrZQ==");
    h.handlers().onSpeechStarted();

    expect(h.session.cancelResponse).toHaveBeenCalled();
    expect(h.clears()).toHaveLength(1);
  });

  it("opens on the agent's own words when the lane has no greeting", () => {
    const h = makeBridge({ greeting: null });
    h.handlers().onConfigured();
    expect(h.session.speak).not.toHaveBeenCalled();
    expect(h.session.requestResponse).toHaveBeenCalledTimes(1);
  });
});
