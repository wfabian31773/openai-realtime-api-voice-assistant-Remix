/**
 * A DROPPED xAI CONNECTION RECONNECTS (v263): the wrapper, over the real
 * GrokVoiceSession and a fake socket, with the clock and timers injected.
 *
 * The bridge's side is a set of recording handlers: what the wrapper hands
 * the bridge is the whole contract, because the bridge does not change.
 */
import { describe, expect, it } from "vitest";
import {
  ReconnectingSession,
  REPLAY_LEAD_FRAMES,
  RESUME_HISTORY_CHARS,
  STALE_CALLER_TURN_MS,
  TRANSPORT_ERROR_HOLD_MS,
  DEFAULT_RECONNECT_BUDGET_MS,
  reconnectEnabledFor,
  resumeBlock,
  type ReconnectEvent,
  type ReconnectingSessionDeps,
} from "./reconnectingSession";
import type { GrokTransport, ProviderCloseDiagnostics } from "./grokSession";
import type { BridgeSessionHandlers } from "./mediaStreamBridge";
import type { GrokSessionConfig } from "./wireTypes";
import { MID_CALL_DROPS_20261119, type DropShape } from "./fixtures/midCallDrops20261119";

const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString("base64");
/** μ-law digital silence. */
const SILENCE = b64(new Array(160).fill(0xff));
/** Speech-loud μ-law. */
const LOUD = b64(new Array(160).fill(0x00));

class FakeTransport implements GrokTransport {
  readonly sent: Array<Record<string, any>> = [];
  closed = false;
  committed = false;
  diag: ProviderCloseDiagnostics | null = null;
  private msg: ((d: string) => void) | null = null;
  private err: ((e: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private buffered: string[];

  constructor(opts: { buffered?: Array<Record<string, unknown>> } = {}) {
    this.buffered = (opts.buffered ?? []).map((e) => JSON.stringify(e));
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  onMessage(cb: (d: string) => void): void {
    this.msg = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.err = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  commitBuffered(): void {
    this.committed = true;
    for (const b of this.buffered.splice(0)) this.msg?.(b);
  }
  closeDiagnostics(): ProviderCloseDiagnostics {
    return this.diag as ProviderCloseDiagnostics;
  }
  emit(event: Record<string, unknown>): void {
    this.msg?.(JSON.stringify(event));
  }
  drop(): void {
    this.closeCb?.();
  }
  fail(e: Error): void {
    this.err?.(e);
  }
  ofType(type: string): Array<Record<string, any>> {
    return this.sent.filter((e) => e.type === type);
  }
}

function config(): GrokSessionConfig {
  return {
    voice: "eve",
    instructions: "## Role & Persona\nYou answer the line.",
    audio: {
      input: {
        format: { type: "audio/pcmu", rate: 8000 },
        transcription: { language_hint: "en" },
        transport: "json",
      },
      output: { format: { type: "audio/pcmu", rate: 8000 }, transport: "json" },
    },
    turn_detection: { type: "server_vad" },
    reasoning: { effort: "none" },
    tools: [],
  };
}

type Calls = { name: string; args: unknown[] }[];

function recordingHandlers(calls: Calls): BridgeSessionHandlers {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  return {
    onResponseStarted: rec("onResponseStarted"),
    onToolCall: rec("onToolCall"),
    onConfigured: rec("onConfigured"),
    onAudioDelta: rec("onAudioDelta"),
    onAgentTranscriptDelta: rec("onAgentTranscriptDelta"),
    onAudioDone: rec("onAudioDone"),
    onSpeechStarted: rec("onSpeechStarted"),
    onSpeechStopped: rec("onSpeechStopped"),
    onResponseDone: rec("onResponseDone"),
    onCallerTranscript: rec("onCallerTranscript"),
    onError: rec("onError"),
    onClosed: rec("onClosed"),
  };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function harness(opts: Partial<Omit<ReconnectingSessionDeps, "history">> & { history?: string } = {}) {
  const { history, ...over } = opts;
  const calls: Calls = [];
  const logs: string[] = [];
  const events: ReconnectEvent[] = [];
  let clock = 1_000_000;
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const first = new FakeTransport();
  const next: FakeTransport[] = [];
  const state = {
    history: history ?? "AGENT: Thank you for calling. How can I help you today?\nCALLER: I need a refill.\nAGENT: I can help with that.",
    mayReconnect: true,
    connectCalls: 0,
    connect: async (): Promise<GrokTransport> => {
      const t = new FakeTransport({ buffered: [{ type: "session.created", conversation: { id: `c${next.length + 2}` } }] });
      next.push(t);
      return t;
    },
  };
  const s = new ReconnectingSession({
    slug: "tech",
    callSid: "CA00000000000000000000000000000001",
    handlers: recordingHandlers(calls),
    transport: first,
    config: config(),
    connect: () => {
      state.connectCalls += 1;
      return state.connect();
    },
    mayReconnect: () => state.mayReconnect,
    history: () => state.history,
    now: () => clock,
    setTimer: (fn, ms) => {
      timerId += 1;
      timers.set(timerId, { at: clock + ms, fn });
      return timerId;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    log: (l) => logs.push(l),
    onReconnect: (e) => events.push(e),
    ...over,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= clock && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  const configureFirst = () => {
    first.emit({ type: "session.created", conversation: { id: "c1" } });
    first.emit({ type: "session.updated" });
  };
  /** Drop the session in use, let the connect resolve, and configure the new one. */
  const dropAndReconnect = async (transport: FakeTransport = first) => {
    transport.drop();
    await settle();
    const t = next[next.length - 1];
    t.emit({ type: "session.updated" });
    return t;
  };
  const named = (name: string) => calls.filter((c) => c.name === name);
  return { s, calls, named, logs, events, first, next, state, advance, configureFirst, dropAndReconnect, timers };
}

describe("RUNTIME_RECONNECT, the switch", () => {
  it("is off unless set", () => {
    expect(reconnectEnabledFor("tech", undefined)).toBe(false);
    expect(reconnectEnabledFor("tech", "")).toBe(false);
    expect(reconnectEnabledFor("tech", "0")).toBe(false);
    expect(reconnectEnabledFor("tech", "off")).toBe(false);
  });

  it("is on for every lane on 1, true, on or all", () => {
    for (const v of ["1", "true", "ON", " all "]) expect(reconnectEnabledFor("no-ivr", v)).toBe(true);
  });

  it("is on for the lanes a comma list names, and only those", () => {
    expect(reconnectEnabledFor("tech", "optical, tech")).toBe(true);
    expect(reconnectEnabledFor("surgery", "optical, tech")).toBe(false);
    expect(reconnectEnabledFor("Tech", "tech")).toBe(true);
  });
});

describe("a drop on a configured call reconnects", () => {
  it("opens a new session, configures it with the resume block, and never tells the bridge it closed", async () => {
    const h = harness();
    h.configureFirst();
    expect(h.named("onConfigured")).toHaveLength(1);
    const t2 = await h.dropAndReconnect();

    expect(h.state.connectCalls).toBe(1);
    expect(t2.committed).toBe(true);
    const update = t2.ofType("session.update")[0];
    expect(update.session.instructions).toContain("## Role & Persona\nYou answer the line.");
    expect(update.session.instructions).toContain("## The line dropped and you are back");
    expect(update.session.instructions).toContain("CALLER: I need a refill.");
    expect(h.named("onClosed")).toHaveLength(0);
    // The new handshake is not the bridge's: forwarding it would replay the greeting.
    expect(h.named("onConfigured")).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ attempt: 1, result: "reconnected", resumedTurn: false, cutMidTurn: false });
  });

  it("routes the bridge's calls to the new session once it is configured", async () => {
    const h = harness();
    h.configureFirst();
    const t2 = await h.dropAndReconnect();
    h.s.appendAudio(SILENCE);
    h.s.speak("Is there anything else?");
    expect(t2.ofType("input_audio_buffer.append")).toHaveLength(1);
    expect(t2.ofType("conversation.item.create").some((e) => e.item.type === "force_message")).toBe(true);
    expect(h.first.ofType("input_audio_buffer.append")).toHaveLength(0);
  });

  it("ignores anything the dropped session says after the drop", async () => {
    const h = harness();
    h.configureFirst();
    await h.dropAndReconnect();
    h.first.emit({ type: "response.created" });
    h.first.emit({ type: "response.output_audio.delta", delta: SILENCE });
    h.first.drop();
    expect(h.named("onResponseStarted")).toHaveLength(0);
    expect(h.named("onAudioDelta")).toHaveLength(0);
    expect(h.named("onClosed")).toHaveLength(0);
  });

  it("a second close from the dropped transport after the swap changes nothing", async () => {
    const h = harness();
    h.configureFirst();
    await h.dropAndReconnect();
    h.first.drop();
    await settle();
    expect(h.state.connectCalls).toBe(1);
    expect(h.named("onClosed")).toHaveLength(0);
    expect(h.events).toHaveLength(1);
  });

  it("does not close the dropped transport again, which would mark its close as ours", async () => {
    const h = harness();
    h.configureFirst();
    await h.dropAndReconnect();
    expect(h.first.closed).toBe(false);
  });

  it("keeps the response epoch moving forward across the swap", async () => {
    const h = harness();
    h.configureFirst();
    for (let i = 0; i < 3; i += 1) {
      h.first.emit({ type: "response.created" });
      h.first.emit({ type: "response.done" });
    }
    expect(h.s.getResponseEpoch()).toBe(3);
    const t2 = await h.dropAndReconnect();
    expect(h.s.getResponseEpoch()).toBe(3);
    t2.emit({ type: "response.created" });
    expect(h.s.getResponseEpoch()).toBe(4);
  });

  it("carries the dropped transport's own diagnostics on the event", async () => {
    const h = harness();
    h.configureFirst();
    const diag = { firstSignal: "socket_end", closeCode: 1006 } as unknown as ProviderCloseDiagnostics;
    h.first.diag = diag;
    await h.dropAndReconnect();
    expect(h.events[0].dropped).toBe(diag);
    expect(h.s.currentTransport()).toBe(h.next[0]);
  });

  it("re-applies the caller's language to the new session", async () => {
    const h = harness();
    h.configureFirst();
    h.s.setSpokenLanguage("es");
    const t2 = await h.dropAndReconnect();
    const update = t2.ofType("session.update")[0];
    expect(update.session.audio.input.transcription.language_hint).toMatch(/^es/);
    expect(update.session.instructions).toContain("The caller is speaking");
    expect(update.session.instructions).toContain("## The line dropped and you are back");
  });

  it("reconnects a second time and stops at the limit", async () => {
    const h = harness({ maxReconnects: 2 });
    h.configureFirst();
    const t2 = await h.dropAndReconnect();
    const t3 = await h.dropAndReconnect(t2);
    expect(h.named("onClosed")).toHaveLength(0);
    t3.drop();
    await settle();
    expect(h.state.connectCalls).toBe(2);
    expect(h.named("onClosed")).toHaveLength(1);
    expect(h.events.map((e) => e.result)).toEqual(["reconnected", "reconnected", "limit"]);
    expect(h.events[2].attempt).toBe(3);
  });
});

describe("what the drop left open", () => {
  it("completes a line cut mid-word and ends the open response, then asks for the agent's turn", async () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "response.created" });
    h.first.emit({ type: "response.output_audio_transcript.delta", delta: "Your appointment is on" });
    h.first.emit({ type: "response.output_audio.delta", delta: SILENCE });
    const t2 = await h.dropAndReconnect();
    expect(h.named("onAudioDone")).toEqual([{ name: "onAudioDone", args: [undefined] }]);
    expect(h.named("onResponseDone")).toHaveLength(1);
    expect(t2.ofType("response.create")).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ cutMidTurn: true, resumedTurn: true });
  });

  it("asks for the agent's turn when the caller's line was the last one", async () => {
    const h = harness({ history: "AGENT: How can I help?\nCALLER: I need my records sent." });
    h.configureFirst();
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("response.create")).toHaveLength(1);
    expect(h.events[0].resumedTurn).toBe(true);
  });

  it("waits when the agent had finished and was waiting on the caller", async () => {
    const h = harness({ history: "CALLER: Hi.\nAGENT: May I have your date of birth?" });
    h.configureFirst();
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("response.create")).toHaveLength(0);
    expect(h.events[0].resumedTurn).toBe(false);
  });

  it("does not ask when the caller spoke during the gap: their audio goes in and is answered on its own", async () => {
    const h = harness({ history: "AGENT: How can I help?\nCALLER: I need my records sent." });
    h.configureFirst();
    h.first.drop();
    h.s.appendAudio(LOUD);
    h.s.appendAudio(SILENCE);
    await settle();
    const t2 = h.next[0];
    expect(t2.ofType("input_audio_buffer.append")).toHaveLength(0);
    t2.emit({ type: "session.updated" });
    expect(t2.ofType("input_audio_buffer.append").map((e) => e.audio)).toEqual([LOUD, SILENCE]);
    expect(t2.ofType("response.create")).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ heldAudioFrames: 2, resumedTurn: false });
  });

  it("says what the bridge asked for during the gap, in order, instead of asking on its own", async () => {
    const h = harness();
    h.configureFirst();
    h.first.drop();
    h.s.speak("One moment.");
    h.s.requestResponse();
    await settle();
    const t2 = h.next[0];
    t2.emit({ type: "session.updated" });
    const force = t2.ofType("conversation.item.create").filter((e) => e.item.type === "force_message");
    expect(force).toHaveLength(1);
    expect(force[0].item.content[0].text).toBe("One moment.");
    expect(h.events[0]).toMatchObject({ queuedTurns: 2, resumedTurn: false });
  });

  it("a line the bridge asked for during the gap is the only turn, even when the caller spoke last", async () => {
    const h = harness({ history: "AGENT: How can I help?\nCALLER: I need my records sent." });
    h.configureFirst();
    h.first.drop();
    h.s.speak("One moment.");
    await settle();
    const t2 = h.next[0];
    t2.emit({ type: "session.updated" });
    t2.emit({ type: "response.created" });
    await settle();
    expect(t2.ofType("response.create")).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ queuedTurns: 1, resumedTurn: false });
  });

  it("nothing the new session sends before its handshake reaches the bridge", async () => {
    const h = harness();
    h.configureFirst();
    h.first.drop();
    await settle();
    const t2 = h.next[0];
    t2.emit({ type: "response.created" });
    t2.emit({ type: "response.output_audio.delta", delta: SILENCE });
    t2.emit({ type: "input_audio_buffer.speech_started" });
    expect(h.named("onResponseStarted")).toHaveLength(0);
    expect(h.named("onAudioDelta")).toHaveLength(0);
    expect(h.named("onSpeechStarted")).toHaveLength(0);
    t2.emit({ type: "session.updated" });
    t2.emit({ type: "response.output_audio.delta", delta: SILENCE });
    expect(h.named("onAudioDelta")).toHaveLength(1);
  });

  it("a barge-in during the gap discards the lines queued in it", async () => {
    const h = harness();
    h.configureFirst();
    h.first.drop();
    h.s.speak("One moment.");
    h.s.requestResponse();
    expect(h.s.cancelResponse()).toBe(1);
    await settle();
    const t2 = h.next[0];
    t2.emit({ type: "session.updated" });
    expect(t2.ofType("conversation.item.create")).toHaveLength(0);
  });

  it("carries lines the dropped session had queued and never started", async () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "response.created" });
    h.s.speak("Your ticket is filed."); // queued behind the open response
    const t2 = await h.dropAndReconnect();
    const force = t2.ofType("conversation.item.create").filter((e) => e.item.type === "force_message");
    expect(force.map((e) => e.item.content[0].text)).toEqual(["Your ticket is filed."]);
    expect(t2.ofType("response.create")).toHaveLength(0);
    expect(h.events[0].queuedTurns).toBe(1);
  });

  it("carries a line sent and not yet started", async () => {
    const h = harness();
    h.configureFirst();
    h.s.speak("Let me check.");
    expect(h.first.ofType("conversation.item.create")).toHaveLength(1);
    const t2 = await h.dropAndReconnect();
    const force = t2.ofType("conversation.item.create").filter((e) => e.item.type === "force_message");
    expect(force.map((e) => e.item.content[0].text)).toEqual(["Let me check."]);
  });

  it("isResponseActive reads false during the gap", async () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "response.created" });
    expect(h.s.isResponseActive()).toBe(true);
    h.first.drop();
    expect(h.s.isResponseActive()).toBe(false);
  });
});

describe("the caller mid-sentence when the line drops", () => {
  it("replays their turn from just before the provider heard it start", async () => {
    const h = harness();
    h.configureFirst();
    for (let i = 0; i < 100; i += 1) h.s.appendAudio(SILENCE);
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    for (let i = 0; i < 20; i += 1) h.s.appendAudio(LOUD);
    const t2 = await h.dropAndReconnect();
    const appended = t2.ofType("input_audio_buffer.append").map((e) => e.audio);
    expect(appended).toHaveLength(REPLAY_LEAD_FRAMES + 20);
    expect(appended.slice(0, REPLAY_LEAD_FRAMES).every((a) => a === SILENCE)).toBe(true);
    expect(appended.slice(REPLAY_LEAD_FRAMES).every((a) => a === LOUD)).toBe(true);
    expect(t2.ofType("response.create")).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ replayedCallerFrames: REPLAY_LEAD_FRAMES + 20, resumedTurn: false });
  });

  it("does not ask for the agent's turn over a replay, even when the caller spoke last", async () => {
    const h = harness({ history: "AGENT: How can I help?\nCALLER: I need my records sent." });
    h.configureFirst();
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    for (let i = 0; i < 20; i += 1) h.s.appendAudio(LOUD);
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("input_audio_buffer.append").length).toBeGreaterThan(0);
    expect(t2.ofType("response.create")).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ resumedTurn: false });
  });

  it("puts the replay before what they said during the gap: one continuous stretch", async () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    h.s.appendAudio(LOUD);
    h.first.drop();
    h.s.appendAudio(SILENCE);
    await settle();
    const t2 = h.next[0];
    t2.emit({ type: "session.updated" });
    expect(t2.ofType("input_audio_buffer.append").map((e) => e.audio)).toEqual([LOUD, SILENCE]);
  });

  it("replays nothing once their words were transcribed", async () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    h.s.appendAudio(LOUD);
    h.first.emit({ type: "input_audio_buffer.speech_stopped" });
    h.first.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "Yes.", item_id: "i1" });
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("input_audio_buffer.append")).toHaveLength(0);
    expect(h.events[0].replayedCallerFrames).toBe(0);
  });

  it("still replays a turn that stopped a moment ago and was not yet transcribed", async () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    h.s.appendAudio(LOUD);
    h.first.emit({ type: "input_audio_buffer.speech_stopped" });
    h.advance(500);
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("input_audio_buffer.append").map((e) => e.audio)).toEqual([LOUD]);
  });

  it("does not replay a turn that stopped long ago with no transcript (transcribed as nothing)", async () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    h.s.appendAudio(LOUD);
    h.first.emit({ type: "input_audio_buffer.speech_stopped" });
    h.advance(STALE_CALLER_TURN_MS + 1);
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("input_audio_buffer.append")).toHaveLength(0);
  });

  it("replays from the earliest open turn when a second started before the first was transcribed", async () => {
    const h = harness();
    h.configureFirst();
    for (let i = 0; i < REPLAY_LEAD_FRAMES; i += 1) h.s.appendAudio(SILENCE);
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    h.s.appendAudio(LOUD);
    h.first.emit({ type: "input_audio_buffer.speech_stopped" });
    h.first.emit({ type: "input_audio_buffer.speech_started" });
    h.s.appendAudio(LOUD);
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("input_audio_buffer.append")).toHaveLength(REPLAY_LEAD_FRAMES + 2);
  });
});

describe("tools across the drop", () => {
  const toolCall = (t: FakeTransport, id: string) =>
    t.emit({ type: "response.function_call_arguments.done", call_id: id, name: "lookup_patient", arguments: "{\"last_name\":\"x\"}" });

  it("an answer that arrives during the gap goes to the new session as a note, not a function_call_output", async () => {
    const h = harness();
    h.configureFirst();
    toolCall(h.first, "call_1");
    h.first.drop();
    h.s.sendToolResult("call_1", true, { found: true });
    await settle();
    const t2 = h.next[0];
    t2.emit({ type: "session.updated" });
    const items = t2.ofType("conversation.item.create").map((e) => e.item);
    expect(items.some((i) => i.type === "function_call_output")).toBe(false);
    const note = items.find((i) => i.type === "message");
    expect(note.role).toBe("user");
    expect(note.content[0].text).toContain("The phone system, not the caller");
    expect(note.content[0].text).toContain("lookup_patient");
    expect(h.events[0].carriedToolAnswers).toBe(1);
  });

  it("an answer that arrives after the swap is still a note, and the agent is not asked on its own", async () => {
    const h = harness({ history: "AGENT: How can I help?\nCALLER: Look me up." });
    h.configureFirst();
    toolCall(h.first, "call_1");
    const t2 = await h.dropAndReconnect();
    expect(t2.ofType("response.create")).toHaveLength(0);
    expect(h.events[0].resumedTurn).toBe(false);
    h.s.sendToolResult("call_1", false, { error: "timeout" });
    const items = t2.ofType("conversation.item.create").map((e) => e.item);
    expect(items.some((i) => i.type === "function_call_output")).toBe(false);
    expect(items.find((i) => i.type === "message").content[0].text).toContain("It failed");
  });

  it("a tool the new session called is answered as usual", async () => {
    const h = harness();
    h.configureFirst();
    const t2 = await h.dropAndReconnect();
    toolCall(t2, "call_2");
    h.s.sendToolResult("call_2", true, { ok: 1 });
    expect(t2.ofType("conversation.item.create").some((e) => e.item.type === "function_call_output")).toBe(true);
  });

  it("lists the tools already run in the resume block", async () => {
    const h = harness();
    h.configureFirst();
    toolCall(h.first, "call_1");
    h.s.sendToolResult("call_1", true, { found: true });
    const t2 = await h.dropAndReconnect();
    const instructions = t2.ofType("session.update")[0].session.instructions as string;
    expect(instructions).toContain("### Tools you already ran");
    expect(instructions).toContain("- lookup_patient(");
    expect(instructions).toContain("answered:");
  });

  it("the guidance a bot sends during the gap is held, not counted as a tool answer", async () => {
    const h = harness();
    h.configureFirst();
    h.first.drop();
    h.s.addBotGuidance("ask about the frames");
    await settle();
    const t2 = h.next[0];
    t2.emit({ type: "session.updated" });
    const msg = t2.ofType("conversation.item.create").find((e) => e.item.type === "message");
    expect(msg?.item.content[0].text).toContain("Bot-provided context");
    expect(h.events[0].carriedToolAnswers).toBe(0);
  });
});

describe("when the reconnect cannot help, the call ends as it did before", () => {
  it("a connect that fails ends the call", async () => {
    const h = harness();
    h.state.connect = async () => {
      throw new Error("HTTP 503");
    };
    h.configureFirst();
    h.first.drop();
    await settle();
    expect(h.named("onClosed")).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ result: "connect_failed", attempt: 1 });
  });

  it("a new session not configured within the budget ends the call, and the late socket is closed", async () => {
    const h = harness();
    let resolve!: (t: GrokTransport) => void;
    h.state.connect = () => new Promise((r) => (resolve = r));
    h.configureFirst();
    h.first.drop();
    h.advance(DEFAULT_RECONNECT_BUDGET_MS - 1);
    expect(h.named("onClosed")).toHaveLength(0);
    h.advance(1);
    expect(h.named("onClosed")).toHaveLength(1);
    expect(h.events[0].result).toBe("budget_spent");
    const late = new FakeTransport();
    resolve(late);
    await settle();
    expect(late.closed).toBe(true);
  });

  it("a configured session that never gets its handshake counts against the budget too", async () => {
    const h = harness();
    h.configureFirst();
    h.first.drop();
    await settle();
    h.advance(DEFAULT_RECONNECT_BUDGET_MS);
    expect(h.events[0].result).toBe("budget_spent");
    expect(h.next[0].closed).toBe(true);
    // Its handshake arriving afterwards changes nothing.
    h.next[0].emit({ type: "session.updated" });
    expect(h.named("onConfigured")).toHaveLength(1);
    expect(h.named("onClosed")).toHaveLength(1);
  });

  it("a new socket that closes before its handshake ends the call", async () => {
    const h = harness();
    h.configureFirst();
    h.first.drop();
    await settle();
    h.next[0].drop();
    expect(h.named("onClosed")).toHaveLength(1);
    expect(h.events[0].result).toBe("closed_before_configured");
  });

  it("a drop after the caller hung up is not reconnected", async () => {
    const h = harness();
    h.configureFirst();
    h.state.mayReconnect = false;
    h.first.drop();
    await settle();
    expect(h.state.connectCalls).toBe(0);
    expect(h.named("onClosed")).toHaveLength(1);
    expect(h.events).toHaveLength(0);
  });

  it("a drop before the first session was configured stays the setup path's", async () => {
    const h = harness();
    h.first.emit({ type: "session.created", conversation: { id: "c1" } });
    h.first.drop();
    await settle();
    expect(h.state.connectCalls).toBe(0);
    expect(h.named("onClosed")).toHaveLength(1);
  });

  it("our own close during the gap stops the reconnect and the late socket is closed", async () => {
    const h = harness();
    let resolve!: (t: GrokTransport) => void;
    h.state.connect = () => new Promise((r) => (resolve = r));
    h.configureFirst();
    h.first.drop();
    h.s.close();
    const late = new FakeTransport();
    resolve(late);
    await settle();
    expect(late.closed).toBe(true);
    expect(h.named("onClosed")).toHaveLength(0);
    expect(h.timers.size).toBe(0);
  });

  it("our own close after a reconnect closes the session in use", async () => {
    const h = harness();
    h.configureFirst();
    const t2 = await h.dropAndReconnect();
    h.s.close();
    expect(t2.closed).toBe(true);
    t2.drop();
    expect(h.named("onClosed")).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });
});

describe("a socket error waits for the close behind it", () => {
  it("an error followed by its close reconnects and never reaches the bridge", async () => {
    const h = harness();
    h.configureFirst();
    h.first.fail(new Error("Invalid WebSocket frame: RSV1 must be clear"));
    expect(h.named("onError")).toHaveLength(0);
    const t2 = await h.dropAndReconnect();
    h.advance(TRANSPORT_ERROR_HOLD_MS * 2);
    expect(h.named("onError")).toHaveLength(0);
    expect(h.named("onClosed")).toHaveLength(0);
    expect(h.s.currentTransport()).toBe(t2);
  });

  it("an error on the new session after the swap is held and reported on its own", async () => {
    const h = harness();
    h.configureFirst();
    h.first.fail(new Error("first"));
    const t2 = await h.dropAndReconnect();
    t2.fail(new Error("second"));
    h.advance(TRANSPORT_ERROR_HOLD_MS);
    expect(h.named("onError")).toHaveLength(1);
    expect((h.named("onError")[0].args[0] as Error).message).toBe("second");
  });

  it("an error with no close behind it reaches the bridge, late", () => {
    const h = harness();
    h.configureFirst();
    h.first.fail(new Error("boom"));
    h.advance(TRANSPORT_ERROR_HOLD_MS - 1);
    expect(h.named("onError")).toHaveLength(0);
    h.advance(1);
    expect(h.named("onError")).toHaveLength(1);
  });

  it("an error before the first handshake reaches the bridge at once", () => {
    const h = harness();
    h.first.fail(new Error("boom"));
    expect(h.named("onError")).toHaveLength(1);
  });

  it("a provider error event is not held: the connection is up and the session reports it", () => {
    const h = harness();
    h.configureFirst();
    h.first.emit({ type: "error", error: { type: "server_error", message: "x" } });
    expect(h.named("onError")).toHaveLength(1);
  });

  it("an error on the new socket before its handshake fails the reconnect", async () => {
    const h = harness();
    h.configureFirst();
    h.first.drop();
    await settle();
    h.next[0].fail(new Error("boom"));
    expect(h.events[0].result).toBe("connect_failed");
    expect(h.named("onClosed")).toHaveLength(1);
    expect(h.named("onError")).toHaveLength(0);
  });
});

describe("the resume block", () => {
  it("says not to greet or repeat the disclosure, and carries the call so far", () => {
    const text = resumeBlock("AGENT: Hello.\nCALLER: Hi.", ["- lookup_patient({}) answered: {}"]);
    expect(text).toContain("Do not greet them again and do not repeat the recording disclosure.");
    expect(text).toContain("AGENT: Hello.\nCALLER: Hi.");
    expect(text).toContain("### Tools you already ran\n- lookup_patient({}) answered: {}");
  });

  it("keeps the tail of a long call", () => {
    const long = `${"x".repeat(RESUME_HISTORY_CHARS)}\nCALLER: the last thing they said`;
    const text = resumeBlock(long, []);
    expect(text).toContain("CALLER: the last thing they said");
    expect(text.length).toBeLessThan(RESUME_HISTORY_CHARS + 2_000);
    expect(text).not.toContain("### Tools you already ran");
  });

  it("says so when nothing was said", () => {
    expect(resumeBlock("  ", [])).toContain("(nothing was said yet)");
  });
});

describe("the corpus: the 219 mid-call drops of 2026-11-19..22 (RULE THREE)", () => {
  it("holds the counts the fixture's header states", () => {
    const by = (shape: string) => MID_CALL_DROPS_20261119.filter((d) => d.shape === shape).length;
    expect(MID_CALL_DROPS_20261119).toHaveLength(219);
    expect([by("I"), by("Q"), by("S"), by("C")]).toEqual([112, 72, 33, 2]);
    expect(MID_CALL_DROPS_20261119.filter((d) => d.toolNearEnd)).toHaveLength(2);
    expect(new Set(MID_CALL_DROPS_20261119.map((d) => d.callSid)).size).toBe(219);
    expect(MID_CALL_DROPS_20261119.every((d) => /^CA[0-9a-f]{32}$/.test(d.callSid))).toBe(true);
  });

  const HISTORY: Record<DropShape, string> = {
    I: "AGENT: How can I help?\nCALLER: I'm calling about my prescription.",
    Q: "CALLER: I'm calling about my prescription.\nAGENT: Which pharmacy do you use?",
    S: "CALLER: I'm calling about my prescription.\nAGENT: I've sent that to the team.",
    C: "AGENT: How can I help?\nCALLER: I need to move my appointment.",
  };

  for (const drop of MID_CALL_DROPS_20261119) {
    const owed = (drop.shape === "I" || drop.shape === "C") && !drop.toolNearEnd;
    it(`${drop.callSid} (${drop.lane}, ${drop.shape}${drop.toolNearEnd ? "T" : ""}) carries on, ${owed ? "the agent taking its turn" : "waiting"}`, async () => {
      const h = harness({ slug: drop.lane, callSid: drop.callSid, history: HISTORY[drop.shape] });
      h.configureFirst();
      if (drop.shape === "I") {
        h.first.emit({ type: "response.created" });
        h.first.emit({ type: "response.output_audio_transcript.delta", delta: "Let me" });
        h.first.emit({ type: "response.output_audio.delta", delta: SILENCE });
      }
      if (drop.toolNearEnd) {
        h.first.emit({ type: "response.function_call_arguments.done", call_id: "call_t", name: "file_tech_ticket", arguments: "{}" });
      }
      const t2 = await h.dropAndReconnect();
      expect(h.named("onClosed")).toHaveLength(0);
      expect(h.named("onConfigured")).toHaveLength(1);
      expect(h.events).toHaveLength(1);
      expect(h.events[0].result).toBe("reconnected");
      expect(h.events[0].resumedTurn).toBe(owed);
      expect(t2.ofType("response.create")).toHaveLength(owed ? 1 : 0);
      if (drop.shape === "I") expect(h.named("onAudioDone")).toEqual([{ name: "onAudioDone", args: [undefined] }]);
      if (drop.toolNearEnd) {
        // The tool answers after the swap: a note, and the bridge asks for the follow-up as usual.
        h.s.sendToolResult("call_t", true, { ticket_number: "VA-1" });
        expect(t2.ofType("conversation.item.create").some((e) => e.item.type === "function_call_output")).toBe(false);
      }
    });
  }
});
