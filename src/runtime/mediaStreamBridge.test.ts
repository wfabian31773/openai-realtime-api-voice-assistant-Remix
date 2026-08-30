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
