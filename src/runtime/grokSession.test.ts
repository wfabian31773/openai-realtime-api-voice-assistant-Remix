import { describe, it, expect, vi } from "vitest";
import { GrokVoiceSession, buildSessionConfig, PRE_CONFIG_AUDIO_CAP } from "./grokSession";
import type { GrokTransport, GrokVoiceSessionHandlers } from "./grokSession";
import type { GrokClientEvent, GrokServerEvent } from "./wireTypes";
import { loadGrokRuntimeVoiceConfig } from "./config";
import type { GrokToolDefinition } from "./wireTypes";

/** A stand-in tool set. The runtime is agent-agnostic, so these tests use
 * a fixture rather than any real agent's tools — if a lane's tools could
 * change what the wire does, that would itself be the bug. */
const FIXTURE_TOOLS: readonly GrokToolDefinition[] = [
  {
    type: "function",
    name: "report_preference",
    description: "Report the caller's stated preference.",
    parameters: {
      type: "object",
      properties: { timeOfDay: { type: "string" } },
      required: ["timeOfDay"],
    },
  },
  {
    type: "function",
    name: "create_ticket",
    description: "File a callback request.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

class TestTransport implements GrokTransport {
  public sent: GrokClientEvent[] = [];
  public closed = false;
  private messageHandler: ((data: string) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  onMessage(cb: (data: string) => void): void {
    this.messageHandler = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorHandler = cb;
  }
  onClose(cb: () => void): void {
    this.closeHandler = cb;
  }
  emit(event: GrokServerEvent): void {
    this.messageHandler?.(JSON.stringify(event));
  }
  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
  emitClose(): void {
    this.closeHandler?.();
  }
  /** Bypasses the JSON.stringify(event) helper to deliver a raw, possibly
   * unparseable string, for the malformed-event test below. */
  emitRaw(data: string): void {
    this.messageHandler?.(data);
  }
}

function makeSession(handlers: Partial<Parameters<typeof buildHandlers>[0]> = {}) {
  const transport = new TestTransport();
  const config = loadGrokRuntimeVoiceConfig({});
  const sessionConfig = buildSessionConfig(config, "instructions", [...FIXTURE_TOOLS]);
  const built = buildHandlers(handlers);
  const session = new GrokVoiceSession(transport, sessionConfig, built);
  return { transport, session, ...built };
}

/** Typed against the real handler signatures rather than bare `vi.fn()`,
 * so a change to the session's callback shape fails the typecheck here
 * instead of silently passing a mock that no longer matches. */
function buildHandlers(over: {
  onToolCall?: GrokVoiceSessionHandlers["onToolCall"];
  onError?: NonNullable<GrokVoiceSessionHandlers["onError"]>;
  onAudioDone?: NonNullable<GrokVoiceSessionHandlers["onAudioDone"]>;
  onAgentTranscriptDelta?: NonNullable<GrokVoiceSessionHandlers["onAgentTranscriptDelta"]>;
  onResponseDone?: NonNullable<GrokVoiceSessionHandlers["onResponseDone"]>;
}) {
  return {
    onToolCall: over.onToolCall ?? vi.fn(),
    onError: over.onError ?? vi.fn(),
    onAudioDone: over.onAudioDone ?? vi.fn(),
    onAgentTranscriptDelta: over.onAgentTranscriptDelta ?? vi.fn(),
    onResponseDone: over.onResponseDone ?? vi.fn(),
  } satisfies GrokVoiceSessionHandlers;
}

describe("GrokVoiceSession — what the bridge needs to attribute agent speech", () => {
  it("counts response cycles, so a cancelled response's late events are identifiable", () => {
    const { transport, session } = makeSession();
    expect(session.getResponseEpoch()).toBe(0);
    transport.emit({ type: "response.created" } as GrokServerEvent);
    expect(session.getResponseEpoch()).toBe(1);
    transport.emit({ type: "response.done" } as GrokServerEvent);
    // A finished response does NOT open a new cycle — only response.created
    // does, which is what makes the number usable as an epoch.
    expect(session.getResponseEpoch()).toBe(1);
    transport.emit({ type: "response.created" } as GrokServerEvent);
    expect(session.getResponseEpoch()).toBe(2);
  });

  it("hands the completed utterance its spoken text — on this runtime the wire is the only source", () => {
    const onAudioDone = vi.fn();
    const { transport } = makeSession({ onAudioDone });
    transport.emit({
      type: "response.output_audio_transcript.done",
      transcript: "Good afternoon, this is Azul Vision.",
    } as GrokServerEvent);
    expect(onAudioDone).toHaveBeenCalledWith("Good afternoon, this is Azul Vision.");
  });

  it("streams agent transcript deltas, so a line cut off by barge-in still has its words", () => {
    const onAgentTranscriptDelta = vi.fn();
    const { transport } = makeSession({ onAgentTranscriptDelta });
    transport.emit({
      type: "response.output_audio_transcript.delta",
      delta: "Are you calling about ",
    } as GrokServerEvent);
    transport.emit({
      type: "response.output_audio_transcript.delta",
      delta: "your order",
    } as GrokServerEvent);
    expect(onAgentTranscriptDelta.mock.calls.map((c) => c[0])).toEqual([
      "Are you calling about ",
      "your order",
    ]);
  });

  it("an empty transcript delta is not forwarded as a word the agent spoke", () => {
    const onAgentTranscriptDelta = vi.fn();
    const { transport } = makeSession({ onAgentTranscriptDelta });
    transport.emit({
      type: "response.output_audio_transcript.delta",
      delta: "",
    } as GrokServerEvent);
    expect(onAgentTranscriptDelta).not.toHaveBeenCalled();
  });
});

describe("GrokVoiceSession lifecycle", () => {
  it("starts idle", () => {
    const { session } = makeSession();
    expect(session.getState()).toBe("idle");
  });

  it("moves to connected on session.created and immediately sends session.update", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "sess-1" } });
    expect(session.getState()).toBe("connected");
    expect(session.getSessionId()).toBe("sess-1");
    expect(transport.sent[0].type).toBe("session.update");
  });

  it("tolerates a session.created without a conversation id", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" });
    expect(session.getState()).toBe("connected");
    expect(session.getSessionId()).toBeNull();
  });

  it("moves to configured on session.updated", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "sess-1" } });
    transport.emit({ type: "session.updated" });
    expect(session.getState()).toBe("configured");
  });

  it("moves to error state and calls onError on a provider error event", () => {
    const onError = vi.fn();
    const { transport, session } = makeSession({ onError });
    transport.emit({ type: "error", error: { message: "rate limited" } });
    expect(session.getState()).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toContain("rate limited");
  });

  it("moves to closed when the transport closes — there is no session.closed wire event", () => {
    const { transport, session } = makeSession();
    transport.emitClose();
    expect(session.getState()).toBe("closed");
  });

  it("close() closes the transport and marks closed without inventing a close handshake", () => {
    const { transport, session } = makeSession();
    session.close();
    expect(session.getState()).toBe("closed");
    expect(transport.closed).toBe(true);
    // No session.close exists on this wire; closing the socket IS the close.
    expect(transport.sent).toHaveLength(0);
  });

  it("announces every response.done — the boundary the bridge's tool follow-up waits on", () => {
    // If the wire stopped emitting this, every post-tool follow-up would
    // starve behind an awaiting flag nothing clears, and the caller would
    // sit in silence until the dead-air watchdog kills the call (Codex,
    // PR #227 round 17).
    const onResponseDone = vi.fn();
    const { transport } = makeSession({ onResponseDone });
    transport.emit({ type: "response.created" } as GrokServerEvent);
    transport.emit({ type: "response.done" } as GrokServerEvent);
    expect(onResponseDone).toHaveBeenCalledTimes(1);
  });

  it("dispatches response.function_call_arguments.done to onToolCall with the JSON-string arguments parsed", () => {
    const onToolCall = vi.fn();
    const { transport } = makeSession({ onToolCall });
    transport.emit({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "report_preference",
      arguments: JSON.stringify({ timeOfDay: "morning" }),
    });
    expect(onToolCall).toHaveBeenCalledWith("call-1", "report_preference", { timeOfDay: "morning" });
  });

  it("unparseable function-call arguments surface as an error, never as a garbage dispatch", () => {
    const onToolCall = vi.fn();
    const onError = vi.fn();
    const { transport } = makeSession({ onToolCall, onError });
    transport.emit({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "report_preference",
      arguments: "not json {",
    });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("valid JSON that is not an OBJECT — null, an array, a string — surfaces as an error too (review finding)", () => {
    // JSON.parse('null') succeeds; dispatched onward it would be
    // destructured inside an async handler nobody awaits, and the
    // swallowed rejection is a stalled call: no function_call_output,
    // no error, dead air.
    const onToolCall = vi.fn();
    const onError = vi.fn();
    const { transport } = makeSession({ onToolCall, onError });
    for (const bad of ["null", "[1,2]", '"morning"', "42"]) {
      transport.emit({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
        name: "report_preference",
        arguments: bad,
      });
    }
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(4);
  });

  it("speak() sends an interruptible force_message with the exact given text — the model is bypassed", () => {
    const { transport, session } = makeSession();
    // Says are response-gated AND config-gated (see pendingSays): the
    // session must be configured before a line goes on the wire.
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    session.speak("Would you prefer morning or afternoon?");
    const sent = transport.sent.find((e) => e.type === "conversation.item.create");
    expect(sent).toBeDefined();
    if (sent && sent.type === "conversation.item.create") {
      expect(sent.item).toEqual({
        type: "force_message",
        role: "assistant",
        interruptible: true,
        content: [{ type: "output_text", text: "Would you prefer morning or afternoon?" }],
      });
    }
  });

  it("sendToolResult() answers the call with a function_call_output item carrying a JSON-string payload", () => {
    const { transport, session } = makeSession();
    session.sendToolResult("call-1", false, { reason: "unknown_tool" });
    const sent = transport.sent.find((e) => e.type === "conversation.item.create");
    expect(sent).toBeDefined();
    if (sent && sent.type === "conversation.item.create") {
      expect(sent.item.type).toBe("function_call_output");
      const item = sent.item as { call_id: string; output: string };
      expect(item.call_id).toBe("call-1");
      expect(JSON.parse(item.output)).toEqual({ ok: false, reason: "unknown_tool" });
    }
  });

  it("goes to error state on an unparseable server event rather than throwing", () => {
    const onError = vi.fn();
    const { transport, session } = makeSession({ onError });
    expect(() => transport.emitRaw("not json")).not.toThrow();
    expect(session.getState()).toBe("error");
    expect(onError).toHaveBeenCalled();
  });
});

describe("response.cancel gating (production lesson: cancelling a non-open response tears the call down)", () => {
  it("cancelResponse() is a NO-OP while no response is open — force_message playback has none", () => {
    const { transport, session } = makeSession();
    session.speak("A scripted line is playing.");
    session.cancelResponse();
    expect(transport.sent.some((e) => e.type === "response.cancel")).toBe(false);
  });

  it("cancels exactly while a response is open at the wire, and never after its done", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "response.created" });
    session.cancelResponse();
    expect(transport.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);

    transport.emit({ type: "response.done" });
    session.cancelResponse();
    expect(transport.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
  });

  it("barge-in DISCARDS the queued scripted lines — the cancelled response's own done must not speak stale text", () => {
    // Codex review, PR #200 round 4: the bridge writes off every
    // outstanding utterance at barge-in, so a held line flushed by the
    // cancellation's response.done would be heard by the caller while
    // absent from transcript/marks/final-action handling.
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    const forceMessages = () =>
      transport.sent.filter(
        (e) =>
          e.type === "conversation.item.create" &&
          (e as { item?: { type?: string } }).item?.type === "force_message",
      );

    session.speak("First scripted line.");
    expect(forceMessages()).toHaveLength(1);
    transport.emit({ type: "response.created" }); // the line's response opens
    session.speak("Second scripted line."); // queued behind the open response

    session.cancelResponse(); // caller barges into the first line
    transport.emit({ type: "response.done" }); // the cancelled response settles

    // The queued second line was discarded at the barge-in boundary,
    // and the settled done flushes nothing.
    expect(forceMessages()).toHaveLength(1);

    // The gate itself is intact: the next authorized line speaks normally.
    session.speak("The current question, re-rendered after the caller's turn.");
    expect(forceMessages()).toHaveLength(2);
  });

  it("a cancel that races the response's natural completion is absorbed, NOT a fatal provider error", () => {
    // Live shape (sibling repo, 2026-08-23): response.created reached us, so
    // wireResponseActive is true and a barge-in sends response.cancel — but
    // Grok had already finished the response, its response.done still in
    // flight. Grok rejects the cancel. Treating that as a provider error
    // ends a HEALTHY caller's call; it is really the missing response.done.
    const onError = vi.fn();
    const { transport, session } = makeSession({ onError });
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    transport.emit({ type: "response.created" });

    session.cancelResponse();
    expect(transport.sent.some((e) => e.type === "response.cancel")).toBe(true);

    // The provider's dispatch speaks the next question after the caller's
    // turn. wireResponseActive is still true (the cancel is unsettled), so
    // the line is HELD — this is the line that would be lost forever if the
    // rejection were treated as fatal, or stranded if it were absorbed
    // without releasing the queue.
    const forceMessages = () =>
      transport.sent.filter(
        (e) =>
          e.type === "conversation.item.create" &&
          (e as { item?: { type?: string } }).item?.type === "force_message",
      );
    session.speak("The current question, re-rendered after the caller turn.");
    expect(forceMessages()).toHaveLength(0);

    transport.emit({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "cancellation failed: no active response found",
      },
    });

    // The call survives: no error state, no provider-failure teardown.
    expect(session.getState()).toBe("configured");
    expect(onError).not.toHaveBeenCalled();
    // And it counted as the missing response.done — the held line is
    // released rather than waiting on a done that is never coming.
    expect(forceMessages()).toHaveLength(1);
  });

  it("only absorbs that error while a cancel is actually outstanding — every other provider error stays fatal", () => {
    const onError = vi.fn();
    const { transport, session } = makeSession({ onError });
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });

    // Same message, but we never sent a cancel: a genuine provider fault.
    transport.emit({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "cancellation failed: no active response found",
      },
    });
    expect(session.getState()).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("an unrelated provider error during an outstanding cancel is still fatal", () => {
    const onError = vi.fn();
    const { transport, session } = makeSession({ onError });
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    transport.emit({ type: "response.created" });
    session.cancelResponse();

    transport.emit({
      type: "error",
      error: { type: "server_error", message: "internal failure" },
    });
    expect(session.getState()).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("a second barge-in in the same response cycle sends NO duplicate cancel (Codex #213 r2)", () => {
    // A stale audio delta re-arms the bridge's assistantAudioPlaying after
    // the first barge-in, so a second caller segment re-enters barge-in
    // while wireResponseActive is still true. Two cancels would draw two
    // rejections, and only the first is absorbable — the second would tear
    // the call down. One cancel per response cycle.
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    transport.emit({ type: "response.created" });

    session.cancelResponse();
    session.cancelResponse();
    session.cancelResponse();
    expect(transport.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
  });

  it("a NEW response cycle can be cancelled again — the suppression is per cycle, not per call", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    transport.emit({ type: "response.created" });
    session.cancelResponse();
    transport.emit({ type: "response.done" });

    transport.emit({ type: "response.created" });
    session.cancelResponse();
    expect(transport.sent.filter((e) => e.type === "response.cancel")).toHaveLength(2);
  });

  it("absorbs the rejection even when the natural response.done arrives FIRST (Codex #213)", () => {
    // The likelier ordering, in fact: Grok finishes the response and emits
    // response.done, THEN receives our cancel and rejects it — an ordered
    // socket delivers done first. A response.done does NOT prove the cancel
    // was honored, so it must not consume the cancel debt.
    const onError = vi.fn();
    const { transport, session } = makeSession({ onError });
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    transport.emit({ type: "response.created" });

    session.cancelResponse();
    transport.emit({ type: "response.done" }); // natural completion, not the cancel
    transport.emit({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "cancellation failed: no active response found",
      },
    });

    expect(session.getState()).toBe("configured");
    expect(onError).not.toHaveBeenCalled();
  });

  it("the debt does not outlive the response cycle — a stray rejection in a LATER cycle stays fatal", () => {
    const onError = vi.fn();
    const { transport, session } = makeSession({ onError });
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    transport.emit({ type: "response.created" });
    session.cancelResponse();
    transport.emit({ type: "response.done" });

    // A NEW response opens: whatever became of that cancel is settled, and
    // the debt must not silently absorb errors for the rest of the call.
    transport.emit({ type: "response.created" });
    transport.emit({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "cancellation failed: no active response found",
      },
    });
    expect(session.getState()).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("the queue is discarded even when the cancel itself is a no-op (say sent, its response not yet open)", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    session.speak("Sent line awaiting its response.created.");
    session.speak("Queued line."); // held behind awaitingSayStart
    session.cancelResponse(); // nothing open at the wire — no cancel sent
    expect(transport.sent.some((e) => e.type === "response.cancel")).toBe(false);

    // The sent line's response cycle runs; the discarded queued line
    // must not follow it out.
    transport.emit({ type: "response.created" });
    transport.emit({ type: "response.done" });
    const forceMessages = transport.sent.filter(
      (e) =>
        e.type === "conversation.item.create" &&
        (e as { item?: { type?: string } }).item?.type === "force_message",
    );
    expect(forceMessages).toHaveLength(1);
  });
});

describe("per-utterance completion signal", () => {
  it("onAudioDone fires on response.output_audio_transcript.done — the wire has no response.output_audio.done", () => {
    const onAudioDone = vi.fn();
    const { transport } = makeSession({ onAudioDone });
    transport.emit({ type: "response.output_audio_transcript.done", transcript: "Hello." });
    expect(onAudioDone).toHaveBeenCalledTimes(1);
  });
});

describe("buildSessionConfig", () => {
  it("builds the real wire shape: session-level voice/turn_detection/reasoning, pcmu@8000 both legs, json transport, only the narrow report tools", () => {
    const config = loadGrokRuntimeVoiceConfig({
      XAI_DRS_VOICE_MODEL: "grok-voice-think-fast-2.0",
      XAI_DRS_VOICE_NAME: "eve",
      XAI_DRS_VOICE_REASONING_EFFORT: "high",
    });
    const sessionConfig = buildSessionConfig(config, "be helpful", [...FIXTURE_TOOLS]);
    expect(sessionConfig.voice).toBe("eve");
    expect(sessionConfig.reasoning).toEqual({ effort: "high" });
    expect(sessionConfig.turn_detection?.type).toBe("server_vad");
    expect(sessionConfig.turn_detection?.silence_duration_ms).toBeGreaterThan(0);
    expect(sessionConfig.audio.input.format).toEqual({ type: "audio/pcmu", rate: 8000 });
    expect(sessionConfig.audio.output.format).toEqual({ type: "audio/pcmu", rate: 8000 });
    expect(sessionConfig.audio.input.transport).toBe("json");
    expect(sessionConfig.audio.output.transport).toBe("json");
    expect(sessionConfig.tools.map((t) => t.name).sort()).toEqual(
      FIXTURE_TOOLS.map((t) => t.name).sort(),
    );
    // Every tool is a plain function tool — Grok gets no path around the core.
    expect(sessionConfig.tools.every((t) => t.type === "function")).toBe(true);
    // The model rides the connection URL, never the session payload.
    expect("model" in sessionConfig).toBe(false);
  });
});

describe("config ALWAYS precedes caller audio", () => {
  /* The first rule in this module's doc and the one that cost a whole line
   * (5Star #199): audio delivered during the handshake locks Grok's input
   * pipeline to the wrong format and the agent is permanently deaf. It had
   * no test — not here and not in the provider this was ported from — which
   * a mutation sweep found by deleting the guard and watching every test
   * still pass. */

  it("HOLDS caller audio that arrives before the config lands", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" } as GrokServerEvent);
    session.appendAudio("QUJD");
    session.appendAudio("REVG");
    expect(transport.sent.filter((e) => e.type === "input_audio_buffer.append")).toHaveLength(0);
  });

  it("releases it once configured, in the order the caller spoke", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" } as GrokServerEvent);
    session.appendAudio("QUJD");
    session.appendAudio("REVG");
    transport.emit({ type: "session.updated" } as GrokServerEvent);
    const appends = transport.sent.filter((e) => e.type === "input_audio_buffer.append") as Array<{
      audio: string;
    }>;
    expect(appends.map((a) => a.audio)).toEqual(["QUJD", "REVG"]);
  });

  it("releases it AFTER the opening turn is queued, never before", () => {
    // With server VAD live, draining a buffered speech turn ahead of the
    // opener lets Grok answer free-form before the agent has spoken.
    const transport = new TestTransport();
    const config = loadGrokRuntimeVoiceConfig({});
    const sessionConfig = buildSessionConfig(config, "instructions", [...FIXTURE_TOOLS]);
    const session: GrokVoiceSession = new GrokVoiceSession(transport, sessionConfig, {
      onToolCall: vi.fn(),
      onConfigured: () => session.requestResponse(),
    });
    transport.emit({ type: "session.created" } as GrokServerEvent);
    session.appendAudio("QUJD");
    transport.emit({ type: "session.updated" } as GrokServerEvent);
    const openerAt = transport.sent.findIndex((e) => e.type === "response.create");
    const audioAt = transport.sent.findIndex((e) => e.type === "input_audio_buffer.append");
    expect(openerAt).toBeGreaterThanOrEqual(0);
    expect(audioAt).toBeGreaterThan(openerAt);
  });

  it("passes audio straight through once configured", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" } as GrokServerEvent);
    transport.emit({ type: "session.updated" } as GrokServerEvent);
    session.appendAudio("QUJD");
    const appends = transport.sent.filter((e) => e.type === "input_audio_buffer.append") as Array<{
      audio: string;
    }>;
    expect(appends.map((a) => a.audio)).toEqual(["QUJD"]);
  });

  it("bounds the hold and drops the OLDEST frames — stale audio is worth less than fresh", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" } as GrokServerEvent);
    for (let i = 0; i < PRE_CONFIG_AUDIO_CAP + 10; i += 1) session.appendAudio(`f${i}`);
    transport.emit({ type: "session.updated" } as GrokServerEvent);
    const appends = transport.sent.filter((e) => e.type === "input_audio_buffer.append") as Array<{
      audio: string;
    }>;
    expect(appends).toHaveLength(PRE_CONFIG_AUDIO_CAP);
    expect(appends[0].audio).toBe("f10");
    expect(appends[appends.length - 1].audio).toBe(`f${PRE_CONFIG_AUDIO_CAP + 9}`);
  });
});

describe("GrokVoiceSession — asking the agent to take a turn", () => {
  it("requestResponse() sends a response.create with NO instructions — the agent's own prompt writes the turn", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" } as GrokServerEvent);
    transport.emit({ type: "session.updated" } as GrokServerEvent);
    session.requestResponse();
    const creates = transport.sent.filter((e) => e.type === "response.create") as Array<{
      response: Record<string, unknown>;
    }>;
    expect(creates).toHaveLength(1);
    // The absence is the whole point: `response.instructions` OVERRIDES
    // the session's instructions, so a single word here would generate
    // this turn without the agent's prompt or the knowledge pack. On the
    // opening turn that is the caller's first sentence.
    expect(creates[0].response).toEqual({});
    expect("instructions" in creates[0].response).toBe(false);
  });

  it("requestResponse() is response-gated like every other queued turn", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" } as GrokServerEvent);
    transport.emit({ type: "session.updated" } as GrokServerEvent);
    transport.emit({ type: "response.created" } as GrokServerEvent);
    session.requestResponse();
    // A response is already open at the wire — the turn waits for it.
    expect(transport.sent.filter((e) => e.type === "response.create")).toHaveLength(0);
    transport.emit({ type: "response.done" } as GrokServerEvent);
    expect(transport.sent.filter((e) => e.type === "response.create")).toHaveLength(1);
  });
});

describe("GrokVoiceSession.setSpokenLanguage", () => {
  it("sends a mid-call session.update with language_hint=es after the handshake", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "sess-lang" } });
    transport.emit({ type: "session.updated" });
    const before = transport.sent.filter((e) => e.type === "session.update").length;
    session.setSpokenLanguage("es");
    const updates = transport.sent.filter((e) => e.type === "session.update") as Array<{
      session: { audio: { input: { transcription?: { language_hint?: string } } }; instructions: string };
    }>;
    expect(updates.length).toBe(before + 1);
    expect(updates[updates.length - 1]?.session.audio.input.transcription?.language_hint).toBe("es");
    // Agent-agnostic copy: the runtime names the language and holds tool
    // arguments to English, but never names a particular agent's tools —
    // the scheduling provider this was ported from did, and that was
    // correct there and wrong here.
    expect(updates[updates.length - 1]?.session.instructions).toMatch(/now speaking es/);
    expect(updates[updates.length - 1]?.session.instructions).toMatch(/ARGUMENTS in English/);
    expect(updates[updates.length - 1]?.session.instructions).not.toMatch(/report_\*/);
  });

  it("accepts a spoken language NAME, not just a code — callers say \"Spanish\"", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "sess-lang-2" } });
    transport.emit({ type: "session.updated" });
    session.setSpokenLanguage("Spanish");
    const updates = transport.sent.filter((e) => e.type === "session.update") as Array<{
      session: { audio: { input: { transcription?: { language_hint?: string } } } };
    }>;
    expect(updates[updates.length - 1]?.session.audio.input.transcription?.language_hint).toBe("es");
  });

  it("an unknown language is passed through rather than forced to English", () => {
    // Answering a Korean caller in English is a worse failure than sending
    // a hint the provider may ignore.
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "sess-lang-3" } });
    transport.emit({ type: "session.updated" });
    session.setSpokenLanguage("ko-KR");
    const updates = transport.sent.filter((e) => e.type === "session.update") as Array<{
      session: { audio: { input: { transcription?: { language_hint?: string } } } };
    }>;
    expect(updates[updates.length - 1]?.session.audio.input.transcription?.language_hint).toBe("ko");
  });

  it("language_hint follows Tagalog — not collapsed to English", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "sess-tl" } });
    transport.emit({ type: "session.updated" });
    session.setSpokenLanguage("tagalog");
    const updates = transport.sent.filter((e) => e.type === "session.update") as Array<{
      session: { audio: { input: { transcription?: { language_hint?: string } } }; instructions: string };
    }>;
    expect(updates[updates.length - 1]?.session.audio.input.transcription?.language_hint).toBe("tl");
    expect(updates[updates.length - 1]?.session.instructions).toMatch(/speaking tl/i);
  });

  it("speakNatural() sends a constrained response.create — not a force_message and not unconstrained free speech", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", conversation: { id: "s1" } });
    transport.emit({ type: "session.updated" });
    session.speakNatural("Speak this meaning in Tagalog: The closest clinic is Downey.");
    const created = transport.sent.find((e) => e.type === "response.create") as
      | { type: "response.create"; response?: { instructions?: string } }
      | undefined;
    expect(created?.response?.instructions).toContain("Speak this meaning in Tagalog");
    expect(
      transport.sent.some(
        (e) =>
          e.type === "conversation.item.create" &&
          (e as { item?: { type?: string } }).item?.type === "force_message",
      ),
    ).toBe(false);
  });
});
