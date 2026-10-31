/**
 * NO SILENCE AFTER THE OPENING OF A CALL WE PLACED (v159).
 *
 * Driven against the real bridge with a fake clock and a session whose provider
 * never answers by itself, which is the state both 2026-10-31 test calls sat in
 * for about 23 seconds. Patient lanes do not set the flag and must not change.
 */
import { describe, expect, it, vi } from "vitest";
import { OPENING_PROCEED_MS, SILENCE_PROMPT_LINE, VoiceCallBridge, type BridgeSessionHandlers } from "./mediaStreamBridge";

const OPENING = "Hi, this is Benchmark Tester. Do you have two minutes?";
const WINDOW = 12_000;

async function call(proceedAfterOpening: boolean) {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  let epoch = 0;
  let responseActive = false;
  const marks: string[] = [];
  const frames: string[] = [];
  const outcomes: string[] = [];
  const session = {
    appendAudio: vi.fn(), cancelResponse: vi.fn(), sendToolResult: vi.fn(), close: vi.fn(), setSpokenLanguage: vi.fn(),
    requestResponse: vi.fn(), speakNatural: vi.fn(), speak: vi.fn(),
    getResponseEpoch: () => epoch, isResponseActive: () => responseActive,
  };
  let handlers!: BridgeSessionHandlers;
  const bridge = new VoiceCallBridge({
    context: { callSid: `CA${"b".repeat(32)}`, streamSid: "MZ-test", slug: "wayne-operator", callerPhone: "+15555550123", dialedNumber: "+15555550100" },
    agent: { instructions: "operator", tools: [], skipped: [], dispatch: async () => ({ ok: true, output: {} }), guardrails: [] } as never,
    greeting: OPENING,
    twilio: { sendFrame: (f: { event: string; mark?: { name: string } }) => { frames.push(f.event); if (f.event === "mark" && f.mark) marks.push(f.mark.name); }, close: () => undefined },
    createSession: (h: BridgeSessionHandlers) => { handlers = h; return session as never; },
    onOutcome: (o: string) => { outcomes.push(o); },
    persistCallRecord: async () => undefined,
    maxCallMs: 600_000, deadAirMs: 30_000, silencePromptMs: WINDOW,
    setTimer: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimer: (h: unknown) => { pending.delete(h as number); },
    ...(proceedAfterOpening ? { proceedAfterOpening: true } : {}),
  } as never) as VoiceCallBridge;
  handlers.onConfigured();
  // The opening: its response is created, its audio goes out, it completes.
  const openingPlays = () => {
    epoch += 1;
    handlers.onResponseStarted?.();
    handlers.onAgentTranscriptDelta(OPENING);
    handlers.onAudioDelta(Buffer.alloc(800).toString("base64"));
    handlers.onAudioDone(OPENING);
    handlers.onResponseDone();
  };
  return {
    session, handlers, openingPlays, frames, outcomes,
    /** Twilio echoes the newest mark: the caller has now heard the whole line. */
    played: () => bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: marks[marks.length - 1] } } as never),
    fire(ms: number) {
      for (const [id, t] of pending) if (t.ms === ms) { pending.delete(id); t.fn(); return true; }
      return false;
    },
    newResponse: () => { epoch += 1; },
    setResponseActive: (active: boolean) => { responseActive = active; },
  };
}

describe("v159: an operator call carries on after its opening", () => {
  it("answers a person who spoke over the opening after the provider's window, when it stays silent", async () => {
    const c = await call(true);
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.openingPlays();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    c.played();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
    expect(c.session.requestResponse).toHaveBeenCalledOnce();
  });

  it("speech stopping just before the mark leaves the provider's pending reply to arrive: no duplicate", async () => {
    const c = await call(true);
    c.openingPlays();
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.played();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    c.newResponse();
    c.setResponseActive(true);
    expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
    expect(c.session.requestResponse).not.toHaveBeenCalled();
  });

  it("does not answer twice when the provider already answered them", async () => {
    const c = await call(true);
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.openingPlays();
    c.newResponse();
    c.played();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
  });

  it("leaves a person still talking at the end of the opening alone", async () => {
    const c = await call(true);
    c.openingPlays();
    c.handlers.onSpeechStarted();
    c.played();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(false);
  });

  it("carries on after a short silence, once, instead of waiting for the ladder", async () => {
    const c = await call(true);
    c.openingPlays();
    c.played();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
    expect(c.session.requestResponse).toHaveBeenCalledOnce();
    expect(c.session.speak).not.toHaveBeenCalledWith(SILENCE_PROMPT_LINE, expect.anything());
  });

  it("a reply inside the window cancels it", async () => {
    const c = await call(true);
    c.openingPlays();
    c.played();
    c.handlers.onSpeechStarted();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(false);
    expect(c.session.requestResponse).not.toHaveBeenCalled();
  });

  it("speech that crosses the end of the opening is still answered when the provider stays silent", async () => {
    const c = await call(true);
    c.openingPlays();
    c.handlers.onSpeechStarted();
    c.played();
    c.handlers.onSpeechStopped();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
    expect(c.session.requestResponse).toHaveBeenCalledOnce();
  });

  it("a reply inside the window is answered too when the provider stays silent", async () => {
    const c = await call(true);
    c.openingPlays();
    c.played();
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
    expect(c.session.requestResponse).toHaveBeenCalledOnce();
  });

  it("does not add a request when the provider answers that speech, and the next window is the full one", async () => {
    const c = await call(true);
    c.openingPlays();
    c.handlers.onSpeechStarted();
    c.played();
    c.handlers.onSpeechStopped();
    c.newResponse();
    c.handlers.onResponseStarted?.();
    c.handlers.onAgentTranscriptDelta("Yes, thanks.");
    c.handlers.onAudioDelta(Buffer.alloc(800).toString("base64"));
    c.handlers.onAudioDone("Yes, thanks.");
    c.handlers.onResponseDone();
    c.played();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(false);
    expect(c.session.requestResponse).not.toHaveBeenCalled();
  });

  it("speech already answered by a response is not retried after it stops", async () => {
    const c = await call(true);
    c.openingPlays();
    c.handlers.onSpeechStarted();
    c.played();
    c.newResponse();
    c.handlers.onSpeechStopped();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(false);
    expect(c.session.requestResponse).not.toHaveBeenCalled();
  });

  it("a response created with no words yet is left to answer: no second turn, no cannot-hear line", async () => {
    const c = await call(true);
    c.openingPlays();
    c.played();
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.newResponse();
    c.setResponseActive(true);
    expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    expect(c.session.speak).not.toHaveBeenCalledWith(SILENCE_PROMPT_LINE, expect.anything());
    // The agent's own watchdog runs while it owes the words.
    expect(c.fire(30_000)).toBe(true);
  });

  it("a transcribed reply gets no extra turn while the provider is answering it", async () => {
    const c = await call(true);
    c.openingPlays();
    c.played();
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.handlers.onCallerTranscript("Yes, go ahead.");
    c.newResponse();
    c.setResponseActive(true);
    c.fire(OPENING_PROCEED_MS);
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    expect(c.session.speak).not.toHaveBeenCalledWith(SILENCE_PROMPT_LINE, expect.anything());
  });

  it("a response that already finished empty leaves the full window, not the short one's prompt", async () => {
    const c = await call(true);
    c.openingPlays();
    c.played();
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.newResponse();
    expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
    expect(c.session.speak).not.toHaveBeenCalledWith(SILENCE_PROMPT_LINE, expect.anything());
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    expect(c.fire(WINDOW)).toBe(true);
    expect(c.session.speak).toHaveBeenCalledWith(SILENCE_PROMPT_LINE, { interruptible: true });
  });

  describe("the carry-on turn", () => {
    type Call = Awaited<ReturnType<typeof call>>;
    const carryOn = async () => {
      const c = await call(true);
      c.openingPlays();
      c.played();
      c.handlers.onSpeechStarted();
      c.handlers.onSpeechStopped();
      expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
      expect(c.session.requestResponse).toHaveBeenCalledOnce();
      return c;
    };
    const audioSent = (c: Call) => c.frames.filter((f) => f === "media").length;
    const start = (c: Call) => { c.newResponse(); c.handlers.onResponseStarted?.(); };
    const speak = (c: Call, words: string) => {
      c.handlers.onAgentTranscriptDelta(words);
      c.handlers.onAudioDelta(Buffer.alloc(800).toString("base64"));
      c.handlers.onAudioDone(words);
      c.handlers.onResponseDone();
    };

    it("a provider reply landing after our request is cancelled once the first has spoken, and its audio is dropped", async () => {
      const c = await carryOn();
      start(c);
      speak(c, "Thanks for taking my call.");
      const before = audioSent(c);
      expect(before).toBeGreaterThan(0);
      expect(c.session.cancelResponse).not.toHaveBeenCalled();
      start(c);
      expect(c.session.cancelResponse).toHaveBeenCalledOnce();
      speak(c, "Thanks for taking my call, again.");
      expect(audioSent(c)).toBe(before);
    });

    it("a first answer with no audio does not cost the real one", async () => {
      const c = await carryOn();
      start(c);
      c.handlers.onResponseDone();
      const before = audioSent(c);
      start(c);
      speak(c, "Thanks for taking my call.");
      expect(c.session.cancelResponse).not.toHaveBeenCalled();
      expect(audioSent(c)).toBeGreaterThan(before);
    });

    it("the person speaking again ends the guard: their next reply is not cancelled", async () => {
      const c = await carryOn();
      start(c);
      speak(c, "Thanks for taking my call.");
      c.played();
      c.handlers.onSpeechStarted();
      c.handlers.onSpeechStopped();
      start(c);
      expect(c.session.cancelResponse).not.toHaveBeenCalled();
    });

    it("a tool's follow-up is not cancelled", async () => {
      const c = await carryOn();
      start(c);
      c.handlers.onAgentTranscriptDelta("One moment.");
      c.handlers.onAudioDelta(Buffer.alloc(800).toString("base64"));
      c.handlers.onToolCall("call-1", "lookup", {});
      start(c);
      expect(c.session.cancelResponse).not.toHaveBeenCalled();
    });

    it("an empty answer from someone who never spoke leaves the ladder running through its prompts to the cut", async () => {
      const c = await call(true);
      c.openingPlays();
      c.played();
      expect(c.fire(OPENING_PROCEED_MS)).toBe(true);
      start(c);
      c.handlers.onResponseDone();
      // Not the agent's watchdog: this silence is not a provider fault.
      expect(c.fire(30_000)).toBe(false);
      expect(c.fire(WINDOW)).toBe(true);
      expect(c.session.speak).toHaveBeenCalledWith(SILENCE_PROMPT_LINE, { interruptible: true });
      c.fire(WINDOW);
      c.fire(WINDOW);
      expect(c.outcomes).toEqual([]);
      expect(c.fire(WINDOW)).toBe(true);
      expect(c.outcomes).toEqual(["caller_silent"]);
    });

    it("a request the provider never answers still ends at the agent's watchdog", async () => {
      const c = await call(true);
      c.openingPlays();
      c.played();
      c.fire(OPENING_PROCEED_MS);
      expect(c.fire(WINDOW)).toBe(false);
      expect(c.fire(30_000)).toBe(true);
      expect(c.outcomes).toEqual(["dead_air"]);
    });
  });

  it("a patient lane is unchanged: nothing is requested and the ladder keeps its window", async () => {
    const c = await call(false);
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.openingPlays();
    c.played();
    expect(c.session.requestResponse).not.toHaveBeenCalled();

    const quiet = await call(false);
    quiet.openingPlays();
    quiet.played();
    expect(quiet.fire(OPENING_PROCEED_MS)).toBe(false);
    expect(quiet.fire(WINDOW)).toBe(true);
    expect(quiet.session.speak).toHaveBeenCalledWith(SILENCE_PROMPT_LINE, { interruptible: true });

    const crossing = await call(false);
    crossing.openingPlays();
    crossing.handlers.onSpeechStarted();
    crossing.played();
    crossing.handlers.onSpeechStopped();
    expect(crossing.fire(OPENING_PROCEED_MS)).toBe(false);
  });
});
