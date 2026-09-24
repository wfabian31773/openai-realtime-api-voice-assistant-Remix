/**
 * THREE PROMPTS, THEN THE CALL ENDS — the silence ladder, v65.
 *
 * Operator, 2026-09-24: *"I've heard the agent speak several times before, I
 * cannot hear you, after the third time, the agent cuts the call. That's how
 * it was and always should be to protect against malicious users, bots and
 * things."* It did not exist — grepped before building — and it also closes a
 * measured gap: `handleResponseDone` cleared the watchdog once the agent's
 * line was delivered and nothing re-armed it until the caller spoke, so of
 * 138 substantive runtime calls over 2026-09-17..23 whose transcript held no
 * caller line, the watchdog fired on ONE. The rest ended `caller_hangup` at
 * 68 seconds average and two sat open to the ten-minute ceiling.
 *
 * Driven against the real bridge with a fake clock. The words are asserted
 * literally, because a protection against diallers that the model MAY phrase
 * is not a protection — the v22/v39 reasoning.
 */
import { describe, it, expect, vi } from "vitest";
import {
  SILENCE_PROMPT_LINE,
  SILENCE_STRIKE_LIMIT,
  clampSilenceWindow,
  type VoiceCallRecord,
  type BridgeSessionHandlers,
} from "./mediaStreamBridge";
import { statusFor } from "./callRecord";
import { followUpEvent } from "./followUpTelemetry";

/** The bridge harness lives in the bridge's own suite; this re-creates the
 * two moving parts it needs — a fake clock and a fake session — rather than
 * exporting a test helper across files. */
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

const WINDOW = 12_000;
const AGENT_WINDOW = 30_000;

async function ladder(
  over: { silenceStrikeLimit?: number; greeting?: string } = {},
) {
  const { VoiceCallBridge } = await import("./mediaStreamBridge");
  const timers = makeTimers();
  const outcomes: string[] = [];
  const records: VoiceCallRecord[] = [];
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
      callSid: "CA000000000000000000000000000000si",
      streamSid: "MZ-test",
      slug: "optical",
      callerPhone: "+15551234567",
      dialedNumber: "+15559876543",
    },
    agent: {
      instructions: "optical",
      tools: [],
      skipped: [],
      dispatch: async () => ({ ok: true, output: {} }),
      guardrails: [],
    } as never,
    greeting: over.greeting,
    twilio: { sendFrame: () => undefined, close: () => undefined },
    createSession: (h: BridgeSessionHandlers) => {
      handlers = h;
      return session as never;
    },
    onOutcome: (o: string) => outcomes.push(o),
    persistCallRecord: async (r: VoiceCallRecord) => {
      records.push(r);
    },
    maxCallMs: 600_000,
    deadAirMs: AGENT_WINDOW,
    silencePromptMs: WINDOW,
    silenceStrikeLimit: over.silenceStrikeLimit,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  } as never);

  /** One complete agent line: a new response, transcript, audio, completion. */
  const speak = (text: string) => {
    epoch += 1;
    handlers.onAgentTranscriptDelta(text);
    handlers.onAudioDelta(Buffer.alloc(800).toString("base64"));
    handlers.onAudioDone(text);
  };
  return { bridge, session, timers, outcomes, records, speak, handlers: () => handlers };
}

describe("the clock after the agent has finished and nothing is owed", () => {
  it("arms the CALLER's window, where until v65 it armed nothing at all", async () => {
    const h = await ladder();
    h.speak("How can I help you today?");
    expect(h.timers.armed(WINDOW)).toBe(1);
    // And the agent's own failure bound is gone, which was always right: the
    // line was delivered, so the agent owes nothing.
    expect(h.timers.armed(AGENT_WINDOW)).toBe(0);
  });

  it("does NOT arm it while the agent still owes a reply", async () => {
    const h = await ladder();
    h.handlers().onSpeechStopped(); // a response is owed
    expect(h.timers.armed(AGENT_WINDOW)).toBe(1);
    expect(h.timers.armed(WINDOW)).toBe(0);
  });

  it("is replaced the moment the caller starts a turn — a talking caller has no ladder", async () => {
    const h = await ladder();
    h.speak("How can I help you today?");
    expect(h.timers.armed(WINDOW)).toBe(1);
    h.handlers().onSpeechStopped();
    expect(h.timers.armed(WINDOW)).toBe(0);
    expect(h.timers.armed(AGENT_WINDOW)).toBe(1);
  });
});

describe("the ladder itself", () => {
  it("speaks the operator's line, verbatim and interruptible", async () => {
    const h = await ladder();
    h.speak("How can I help you today?");
    expect(h.timers.fire(WINDOW)).toBe(true);

    expect(h.session.speak).toHaveBeenCalledWith(SILENCE_PROMPT_LINE, { interruptible: true });
    expect(SILENCE_PROMPT_LINE).toContain("I cannot hear you");
    // NOT locked like the greeting: the whole point is to make them talk, so
    // their first syllable must be able to cut it off.
    expect(h.session.speak).not.toHaveBeenCalledWith(SILENCE_PROMPT_LINE, { interruptible: false });
  });

  it("re-arms itself, so one unanswered prompt is not the end of it", async () => {
    const h = await ladder();
    h.speak("How can I help you today?");
    h.timers.fire(WINDOW);
    expect(h.timers.armed(WINDOW)).toBe(1);
    expect(h.outcomes).toEqual([]);
  });

  it("speaks three times and ends the call on the fourth window — the operator's 'third time'", async () => {
    const h = await ladder();
    h.speak("How can I help you today?");
    for (let i = 0; i < SILENCE_STRIKE_LIMIT; i += 1) {
      expect(h.timers.fire(WINDOW)).toBe(true);
      expect(h.outcomes).toEqual([]);
    }
    expect(h.session.speak).toHaveBeenCalledTimes(SILENCE_STRIKE_LIMIT);
    expect(h.timers.fire(WINDOW)).toBe(true);
    expect(h.outcomes).toEqual(["caller_silent"]);
  });

  it("ends as caller_silent and NEVER as dead_air", async () => {
    // Folding this into dead_air would move the v54 refusal-then-silence
    // count without the defect behind it moving — the `total_turns` mistake.
    const h = await ladder({ silenceStrikeLimit: 1 });
    h.speak("How can I help you today?");
    h.timers.fire(WINDOW); // prompt 1
    h.timers.fire(WINDOW); // out of prompts
    expect(h.outcomes).toEqual(["caller_silent"]);
    expect(h.outcomes).not.toContain("dead_air");
  });

  it("starts again from zero once the caller is actually HEARD", async () => {
    const h = await ladder();
    h.speak("How can I help you today?");
    h.timers.fire(WINDOW);
    h.timers.fire(WINDOW);
    h.timers.fire(WINDOW); // three prompts spent

    h.handlers().onCallerTranscript("Sorry, I am here.", "item-1");
    h.speak("No problem. What can I do for you?");

    // A fresh three, not a cut on the next window.
    expect(h.timers.fire(WINDOW)).toBe(true);
    expect(h.outcomes).toEqual([]);
    expect(h.session.speak).toHaveBeenCalledTimes(4);
  });

  it("counts the prompts it SPOKE, and says whether they ran out, on the record", async () => {
    const h = await ladder({ silenceStrikeLimit: 2 });
    h.speak("How can I help you today?");
    h.timers.fire(WINDOW);
    h.timers.fire(WINDOW);
    h.timers.fire(WINDOW); // the cut
    expect(h.records).toHaveLength(1);
    expect(h.records[0].silencePrompts).toBe(2);
    expect(h.records[0].silenceCut).toBe(true);
  });

  it("records a prompt that was answered as spoken but NOT as a cut", async () => {
    const h = await ladder();
    h.speak("How can I help you today?");
    h.timers.fire(WINDOW);
    h.handlers().onCallerTranscript("I am here.", "item-1");
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    expect(h.records[0].silenceCut).toBe(false);
    // Reset on being heard, which is the point — the guard number is prompts
    // on calls that carried on, and it is read off the telemetry row.
    expect(h.records[0].silencePrompts).toBe(0);
  });
});

// WHAT THE CALLER HEARS when the ladder gives up is asserted in
// `voiceWebhook.test.ts`, beside the other post-stream lines and with the
// request signing that suite already does properly: the sign-off is spoken by
// the TwiML, never by the agent, because teardown closes the media stream.

describe("the row and the status", () => {
  it("writes a telemetry row for a silence-only call, which owed no follow-up at all", () => {
    // THE GATE HAD TO WIDEN. A caller who never speaks runs no tools, so
    // `owed` is 0 and the row was skipped on exactly the population the
    // ladder exists for — the v58 shape, an instrument blind to its subject.
    const ev = followUpEvent({
      followUps: { owed: 0, requested: 0, toolCallsAfterDone: 0, lastUnanswered: false },
      outcome: "caller_silent",
      silencePrompts: 3,
      silenceCut: true,
    } as never);
    expect(ev).not.toBeNull();
    expect(ev?.data.silencePrompts).toBe(3);
    expect(ev?.data.silenceCut).toBe(true);
    // A cut is worth a warn: it is a call that ended with nobody served.
    expect(ev?.level).toBe("warn");
  });

  it("still says nothing about a call with neither a follow-up nor a prompt", () => {
    expect(
      followUpEvent({
        followUps: { owed: 0, requested: 0, toolCallsAfterDone: 0, lastUnanswered: false },
        outcome: "caller_hangup",
        silencePrompts: 0,
      } as never),
    ).toBeNull();
  });

  it("carries a prompt that did NOT end the call, which is the guard number", () => {
    const ev = followUpEvent({
      followUps: { owed: 0, requested: 0, toolCallsAfterDone: 0, lastUnanswered: false },
      outcome: "completed",
      silencePrompts: 1,
      silenceCut: false,
    } as never);
    expect(ev?.data.silencePrompts).toBe(1);
    expect(ev?.level).toBe("info");
  });

  it("reads failed when the caller never spoke and completed when they did", () => {
    // The dead_air rule, for the dead_air reason: the ladder resets on being
    // heard, so it can end a call that HELD a conversation and then went
    // quiet, and that call must still be graded and synced.
    expect(statusFor("caller_silent", "")).toBe("failed");
    expect(statusFor("caller_silent", "AGENT: Hello?\nCALLER: Yes, hi.\n")).toBe("completed");
  });
});

describe("the window is a dial, and a typo cannot disarm the ladder", () => {
  it("clamps to a range that can neither fire over the agent nor wait for ever", () => {
    expect(clampSilenceWindow(12_000)).toBe(12_000);
    expect(clampSilenceWindow(0)).toBe(5_000);
    expect(clampSilenceWindow(-1)).toBe(5_000);
    expect(clampSilenceWindow(600_000)).toBe(60_000);
    expect(clampSilenceWindow(Number.NaN)).toBe(12_000);
  });
});
