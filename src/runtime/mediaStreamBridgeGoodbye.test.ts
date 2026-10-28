import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOODBYE_GRACE_MS, FINAL_MARK_GRACE_MS, SILENCE_PROMPT_LINE, SILENCE_STRIKE_LIMIT,
  VoiceCallBridge, type BridgeSessionHandlers, type CallOutcome, type VoiceCallRecord,
} from "./mediaStreamBridge";
import { followUpEvent } from "./followUpTelemetry";

function harness(goodbyeGraceMs?: number) {
  let handlers!: BridgeSessionHandlers;
  let epoch = 0;
  let active = false;
  let mark = "";
  const records: VoiceCallRecord[] = [];
  const outcomes: CallOutcome[] = [];
  const session = {
    appendAudio: vi.fn(), cancelResponse: vi.fn(), sendToolResult: vi.fn(),
    requestResponse: vi.fn(), speakNatural: vi.fn(), speak: vi.fn(), close: vi.fn(),
    getResponseEpoch: () => epoch, isResponseActive: () => active, setSpokenLanguage: vi.fn(),
  };
  const close = vi.fn();
  const bridge = new VoiceCallBridge({
    context: { callSid: "CA00000000000000000000000000000132", streamSid: "MZ-test", slug: "no-ivr", callerPhone: "", dialedNumber: "" },
    agent: { instructions: "", tools: [], guardrails: [], toolNames: ["lookup"], skipped: [],
      dispatch: vi.fn(async () => ({ ok: true, output: '{"success":true}' })) },
    createSession: (h) => { handlers = h; return session; },
    twilio: { sendFrame: (f) => { if (f.event === "mark") mark = f.mark.name; }, close },
    onOutcome: (o) => outcomes.push(o), persistCallRecord: async (r) => { records.push(r); },
    goodbyeGraceMs,
  });
  const start = () => { epoch++; active = true; handlers.onResponseStarted?.(); };
  const audioDone = (text: string, bytes = 800) => {
    handlers.onAgentTranscriptDelta(text);
    handlers.onAudioDelta(Buffer.alloc(bytes, 0x7f).toString("base64"));
    handlers.onAudioDone(text);
  };
  const responseDone = () => { active = false; handlers.onResponseDone(); };
  const echo = () => bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: mark } });
  const say = (text: string) => { start(); audioDone(text); responseDone(); echo(); };
  const goodbye = () => { handlers.onCallerTranscript("Thank you, bye!"); say("You're welcome. Goodbye!"); };
  return { bridge, handlers, session, close, records, outcomes, start, audioDone, responseDone, echo, say, goodbye };
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("VoiceCallBridge — goodbye grace", () => {
  it("a re-emitted cumulative caller item keeps the agent's preceding question (Codex P2, #396)", () => {
    const h = harness();
    h.say("Is there anything else I can help you with?");
    h.handlers.onCallerTranscript("Thank", "item_caller_1");
    h.handlers.onCallerTranscript("Thank you", "item_caller_1");
    h.say("You're welcome. Goodbye!");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS);
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.records[0]).toMatchObject({ teardownReason: "goodbye_grace" });
  });

  it("hangs up exactly six seconds after the goodbye plays, through deliberate teardown", () => {
    expect(GOODBYE_GRACE_MS).toBe(6_000);
    const h = harness(); h.goodbye();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.records[0]).toMatchObject({ outcome: "agent_ended", teardownReason: "goodbye_grace", goodbyeGraceHangup: true, silenceCut: false });
    expect(followUpEvent(h.records[0])?.data.goodbyeGraceHangup).toBe(true);
    expect(console.info).toHaveBeenCalledWith("[bridge] CA00000000000000000000000000000132 goodbye_grace");
    h.handlers.onClosed(); h.bridge.handleSocketClosed();
    expect(h.outcomes).toHaveLength(1);
  });

  it("waits for response done AND playback, including a mark that echoes first", () => {
    const h = harness(); h.handlers.onCallerTranscript("Adiós.");
    h.start(); h.audioDone("Hasta luego.", 80_000); h.echo();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS);
    expect(h.outcomes).toEqual([]);
    h.responseDone(); vi.advanceTimersByTime(GOODBYE_GRACE_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("does not count buffered playback as part of the grace window", () => {
    const h = harness(); h.handlers.onCallerTranscript("Bye.");
    h.start(); h.audioDone("Goodbye.", 80_000); h.responseDone();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual([]);
    h.echo(); vi.advanceTimersByTime(GOODBYE_GRACE_MS - 1); expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("bounds a missing playback mark using the queued audio duration", () => {
    const h = harness(); h.handlers.onCallerTranscript("Bye."); h.start();
    h.audioDone("Goodbye.", 80_000); h.responseDone();
    vi.advanceTimersByTime(10_000 + FINAL_MARK_GRACE_MS + GOODBYE_GRACE_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("supports an injected grace window", () => {
    const h = harness(123); h.goodbye(); vi.advanceTimersByTime(122);
    expect(h.outcomes).toEqual([]); vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("accepts a caller transcript after response start but before the agent's first output", () => {
    const h = harness(); h.start(); h.handlers.onCallerTranscript("Goodbye.");
    h.audioDone("Goodbye."); h.responseDone(); h.echo();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("arms when the caller's goodbye transcript completes after the agent's reply (Codex P2, #396)", () => {
    const h = harness(); h.start(); h.audioDone("Goodbye!");
    h.handlers.onCallerTranscript("Bye.");
    h.responseDone(); h.echo();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("arms when the late goodbye transcript arrives after the reply already finished playing", () => {
    const h = harness(); h.say("Goodbye!");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
    h.handlers.onCallerTranscript("Thanks, bye.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("a late non-farewell transcript keeps the call open", () => {
    const h = harness(); h.start(); h.audioDone("Goodbye!");
    h.handlers.onCallerTranscript("I need to reschedule.");
    h.responseDone(); h.echo();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
  });

  it("caller speech after the reply prevents a later transcript from closing it", () => {
    const h = harness(); h.say("Goodbye!"); h.handlers.onSpeechStarted();
    h.handlers.onCallerTranscript("Bye.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
  });

  it("a tool before the first audio prevents that response from arming grace", async () => {
    const h = harness(); h.handlers.onCallerTranscript("Bye."); h.start();
    h.handlers.onToolCall("tool-1", "lookup", {});
    await Promise.resolve(); await Promise.resolve();
    h.audioDone("Goodbye."); h.responseDone(); h.echo();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
  });

  it.each(["speech", "transcript", "response", "tool"])("cancels when a new %s event arrives", (event) => {
    const h = harness(); h.goodbye(); vi.advanceTimersByTime(GOODBYE_GRACE_MS - 1);
    if (event === "speech") h.handlers.onSpeechStarted();
    if (event === "transcript") h.handlers.onCallerTranscript("Wait, I have another question.");
    if (event === "response") h.start();
    if (event === "tool") h.handlers.onToolCall("tool-1", "lookup", {});
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2);
    expect(h.outcomes).toEqual([]); expect(h.close).not.toHaveBeenCalled();
  });

  it("cannot revive a cancelled goodbye on late response done or mark events", () => {
    const h = harness(); h.handlers.onCallerTranscript("Bye."); h.start(); h.audioDone("Goodbye.");
    h.handlers.onCallerTranscript("Actually, wait."); h.responseDone(); h.echo();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
  });

  it("cancels on another farewell transcript and waits for a new agent reply", () => {
    const h = harness(); h.goodbye();
    h.handlers.onCallerTranscript("Bye bye."); h.echo(); h.responseDone();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
    h.say("Goodbye."); vi.advanceTimersByTime(GOODBYE_GRACE_MS);
    expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("ignores empty caller transcript events during grace", () => {
    const h = harness(); h.goodbye(); h.handlers.onCallerTranscript("  ");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("does not re-arm on response done after a tool in the goodbye response settles", async () => {
    const h = harness(); h.handlers.onCallerTranscript("Bye."); h.start(); h.audioDone("Goodbye.");
    h.handlers.onToolCall("tool-1", "lookup", {});
    await Promise.resolve(); await Promise.resolve();
    h.responseDone(); h.echo();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
  });

  it("cancels if a transfer starts during grace", () => {
    const h = harness(); h.goodbye(); h.bridge.noteTransferStarting();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
  });

  it("waits for the entire response, so a question after a goodbye keeps the call open", () => {
    const h = harness(); h.handlers.onCallerTranscript("Bye."); h.start();
    h.audioDone("Goodbye."); h.echo(); h.audioDone("What is your number?"); h.echo(); h.responseDone();
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2); expect(h.outcomes).toEqual([]);
  });

  it("arms for a direct caller goodbye followed by a completed acknowledgement", () => {
    const h = harness(); h.handlers.onCallerTranscript("Bye."); h.say("You're welcome.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("arms for a Spanish done answer after a Spanish closing question", () => {
    const h = harness(); h.say("¿Hay algo más en que pueda ayudarle?");
    h.handlers.onCallerTranscript("No, gracias."); h.say("Que tenga un buen día. Adiós.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it("re-arms after a fresh goodbye exchange", () => {
    const h = harness(); h.goodbye(); h.handlers.onSpeechStarted(); h.handlers.onCallerTranscript("Wait.");
    h.say("How can I help?"); h.goodbye(); vi.advanceTimersByTime(GOODBYE_GRACE_MS);
    expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it.each(["No.", "That's it.", "Thanks."])("arms for %s after anything else and an agent sign-off", (answer) => {
    const h = harness(); h.say("Is there anything else I can help you with?");
    h.handlers.onCallerTranscript(answer); h.say("Have a good day!");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS); expect(h.outcomes).toEqual(["agent_ended"]);
  });

  it.each([
    ["What number should we call?", "No.", "Goodbye."],
    ["Anything else?", "No, I need help with something else.", "Take care."],
    ["Anything else?", "Yes, thanks.", "Take care."],
    ["Anything else?", "Okay.", "Have a good day."],
    ["Anything else?", "Thanks.", "What is your number?"],
    ["How can I help?", "Bye the way I need help.", "Have a good day."],
    ["How can I help?", "Before I say goodbye, can you check?", "Goodbye."],
    ["Anything else?", "Goodbye.", "Before you go, what is your number?"],
  ])("keeps ambiguous or unfinished exchanges open", (question, caller, agent) => {
    const h = harness(); h.say(question); h.handlers.onCallerTranscript(caller); h.say(agent);
    vi.advanceTimersByTime(24_000); expect(h.outcomes).toEqual([]);
  });

  it("preserves the never-heard caller's original three-prompt silence ladder", () => {
    const h = harness(); h.say("How can I help?");
    for (let i = 0; i < SILENCE_STRIKE_LIMIT; i++) {
      vi.advanceTimersByTime(12_000);
      expect(h.session.speak).toHaveBeenLastCalledWith(SILENCE_PROMPT_LINE, { interruptible: true });
      h.say(SILENCE_PROMPT_LINE);
    }
    vi.advanceTimersByTime(12_000); expect(h.outcomes).toEqual(["caller_silent"]);
    expect(h.records[0].goodbyeGraceHangup).toBe(false);
  });

  it("preserves v131 stand-down for a heard caller without a goodbye", () => {
    const h = harness(); h.handlers.onCallerTranscript("I need an appointment."); h.say("Which day works for you?");
    vi.advanceTimersByTime(120_000); expect(h.outcomes).toEqual([]);
    expect(h.session.speak).not.toHaveBeenCalled(); h.bridge.handleSocketClosed();
    expect(h.records[0]).toMatchObject({ silenceStoodDown: true, goodbyeGraceHangup: false });
  });
});
