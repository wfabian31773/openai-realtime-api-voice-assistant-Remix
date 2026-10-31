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
  const marks: string[] = [];
  const session = {
    appendAudio: vi.fn(), cancelResponse: vi.fn(), sendToolResult: vi.fn(), close: vi.fn(), setSpokenLanguage: vi.fn(),
    requestResponse: vi.fn(), speakNatural: vi.fn(), speak: vi.fn(),
    getResponseEpoch: () => epoch, isResponseActive: () => false,
  };
  let handlers!: BridgeSessionHandlers;
  const bridge = new VoiceCallBridge({
    context: { callSid: `CA${"b".repeat(32)}`, streamSid: "MZ-test", slug: "wayne-operator", callerPhone: "+15555550123", dialedNumber: "+15555550100" },
    agent: { instructions: "operator", tools: [], skipped: [], dispatch: async () => ({ ok: true, output: {} }), guardrails: [] } as never,
    greeting: OPENING,
    twilio: { sendFrame: (f: { event: string; mark?: { name: string } }) => { if (f.event === "mark" && f.mark) marks.push(f.mark.name); }, close: () => undefined },
    createSession: (h: BridgeSessionHandlers) => { handlers = h; return session as never; },
    onOutcome: () => undefined,
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
    session, handlers, openingPlays,
    /** Twilio echoes the newest mark: the caller has now heard the whole line. */
    played: () => bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: marks[marks.length - 1] } } as never),
    fire(ms: number) {
      for (const [id, t] of pending) if (t.ms === ms) { pending.delete(id); t.fn(); return true; }
      return false;
    },
    newResponse: () => { epoch += 1; },
  };
}

describe("v159: an operator call carries on after its opening", () => {
  it("answers a person who spoke over the opening as soon as it has played", async () => {
    const c = await call(true);
    c.handlers.onSpeechStarted();
    c.handlers.onSpeechStopped();
    c.openingPlays();
    expect(c.session.requestResponse).not.toHaveBeenCalled();
    c.played();
    expect(c.session.requestResponse).toHaveBeenCalledOnce();
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
