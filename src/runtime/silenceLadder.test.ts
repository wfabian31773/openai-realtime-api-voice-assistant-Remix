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
  over: {
    silenceStrikeLimit?: number;
    greeting?: string;
    guardrails?: unknown[];
  } = {},
) {
  const { VoiceCallBridge } = await import("./mediaStreamBridge");
  const timers = makeTimers();
  const outcomes: string[] = [];
  const records: VoiceCallRecord[] = [];
  const marks: string[] = [];
  let clears = 0;
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
      guardrails: over.guardrails ?? [],
    } as never,
    greeting: over.greeting,
    twilio: {
      sendFrame: (f: { event: string; mark?: { name: string } }) => {
        if (f.event === "mark" && f.mark) marks.push(f.mark.name);
        if (f.event === "clear") clears += 1;
      },
      close: () => undefined,
    },
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

  /**
   * One agent line the caller has FINISHED HEARING: a new response,
   * transcript, audio, the provider's completion — and then Twilio's mark
   * echo, which is the only ground truth that the audio actually played
   * (CLAUDE.md, and Codex P1 on this PR). A test that stops at `onAudioDone`
   * is a test of a line still buffered inside Twilio, which is a different
   * state and has its own test below.
   */
  const speak = (text: string, bytes = 800) => {
    generate(text, bytes);
    echoMark();
  };
  /** The provider finished GENERATING. Twilio may still be playing it. */
  const generate = (text: string, bytes = 800) => {
    epoch += 1;
    handlers.onAgentTranscriptDelta(text);
    handlers.onAudioDelta(Buffer.alloc(bytes).toString("base64"));
    handlers.onAudioDone(text);
  };
  /** Twilio echoes the newest mark: the caller has heard everything sent. */
  const echoMark = () => {
    const name = marks[marks.length - 1];
    bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name } } as never);
  };
  return {
    bridge,
    session,
    timers,
    outcomes,
    records,
    marks,
    clears: () => clears,
    speak,
    generate,
    echoMark,
    handlers: () => handlers,
  };
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

  it("does not start counting until the caller has FINISHED HEARING the line", async () => {
    // CODEX P1. `response.done` means the PROVIDER finished GENERATING; Grok
    // streams faster than real time, so the whole line can still be sitting
    // in Twilio's buffer. A window that started here would expire while the
    // agent was still talking, prompt over its own question, and on the third
    // one hang up on a caller who was listening. The 30-second watchdog this
    // branch used to clear outlasted any plausible tail; shrinking the window
    // is what made it reachable.
    const h = await ladder();
    // Eight seconds of μ-law at 8 bytes/ms.
    h.generate("A long question the caller is still hearing.", 8 * 8_000);
    expect(h.timers.armed(WINDOW)).toBe(0);
    // The bare window cannot fire: the clock carries the unplayed duration.
    expect(h.timers.fire(WINDOW)).toBe(false);
    expect(h.session.speak).not.toHaveBeenCalled();
    expect(h.timers.armed(WINDOW + 8_000)).toBe(1);
  });

  it("restarts from the mark echo, so the caller gets a FULL window of silence", async () => {
    // The conservative arm above can only be too patient. Twilio's echo is
    // the ground truth that the audio landed, so the clock restarts from the
    // true moment the caller was left holding the turn.
    const h = await ladder();
    h.generate("A long question.", 8 * 8_000);
    h.echoMark();
    expect(h.timers.armed(WINDOW + 8_000)).toBe(0);
    expect(h.timers.armed(WINDOW)).toBe(1);
  });

  it("covers EVERY unechoed utterance, not just the newest one", async () => {
    // CODEX P1, ROUND 2. The round-1 fix bounded on `done.bytes` — the newest
    // line alone. Several utterances can complete before the newest mark
    // echoes (one response carrying two is enough), and each completion
    // RE-ARMS, so a long line followed by a short one left a window shorter
    // than the audio still queued ahead of it: the prompt landed over the
    // agent mid-line, and three strikes later the call is cut on a caller who
    // was listening. The very failure the round-1 fix was for, one utterance
    // along.
    const h = await ladder();
    h.generate("Ten seconds of question the caller is still hearing.", 8 * 10_000);
    // The second completion must not shorten the window to its own one second.
    h.generate("One more second.", 8 * 1_000);
    expect(h.timers.armed(WINDOW + 1_000)).toBe(0);
    expect(h.timers.fire(WINDOW + 1_000)).toBe(false);
    expect(h.timers.armed(WINDOW + 11_000)).toBe(1);
    expect(h.session.speak).not.toHaveBeenCalled();
  });

  it("forgets audio a barge-in told Twilio to DISCARD, across repeated turns", async () => {
    // CODEX P2, ROUND 4, and it withdraws a claim I made in round 3. I wrote
    // that the over-estimate after a `clear` was "bounded to one agent turn".
    // It is not: the accumulator resets only when the NEWEST mark echoes, and a
    // caller who keeps interrupting never lets one echo — so every cleared turn
    // stays counted. The silence window then grows without limit and the ladder
    // stops firing at all, which defeats the protection this PR exists to add.
    // Twilio dropped that audio, so it can never be "still being heard".
    const h = await ladder();
    h.generate("Ten seconds of the first answer.", 8 * 10_000);
    h.handlers().onSpeechStarted(); // barge-in: Twilio is told to clear
    h.generate("Ten seconds of the second answer.", 8 * 10_000);
    h.handlers().onSpeechStarted(); // and again, still no mark echoed
    h.generate("One second.", 8 * 1_000);
    // Only the last second can still be queued: 21 seconds were discarded.
    expect(h.timers.armed(WINDOW + 1_000)).toBe(1);
    expect(h.timers.armed(WINDOW + 21_000)).toBe(0);
  });

  it("forgets discarded audio on the GUARDRAIL path too, not just the barge-in", async () => {
    // BOTH cancel paths tell Twilio to `clear`, and a reset at one site and not
    // the other is the drift `discardBufferedAudio` exists to prevent. This
    // test is why that helper is justified: a mutation reverting ONLY this path
    // to the inline three lines failed nothing until it existed.
    const guardrail = {
      name: "No diagnosis",
      policyHint: "Do not diagnose.",
      execute: async ({ agentOutput }: { agentOutput: string }) => ({
        tripwireTriggered: /you have glaucoma/i.test(agentOutput),
        outputInfo: {},
      }),
    };
    const h = await ladder({ guardrails: [guardrail] });
    // ORDER MATTERS, and `generate()` has it the other way round: the guardrail
    // cuts a line the caller is ALREADY HEARING, so ten seconds of audio has to
    // be in flight before the violating text arrives. Driven by hand for that.
    h.handlers().onAudioDelta(Buffer.alloc(8 * 10_000).toString("base64"));
    h.handlers().onAgentTranscriptDelta("Based on that, you have glaucoma");
    // Guardrail verdicts land on the microtask queue.
    await Promise.resolve().then(() => Promise.resolve());
    expect(h.clears()).toBeGreaterThan(0);
    // The replacement turn carries one second; the cut ten are gone.
    h.generate("Let me take a message instead.", 8 * 1_000);
    expect(h.timers.armed(WINDOW + 1_000)).toBe(1);
    expect(h.timers.armed(WINDOW + 11_000)).toBe(0);
  });

  it("does not clear twice when the caller speaks again with no audio playing", async () => {
    // `discardBufferedAudio` leaves `assistantAudioPlaying` false, which is what
    // makes `handleCallerSpeechStarted` return early until new audio arrives. A
    // second `clear` on a stream with nothing buffered is a wasted frame, and
    // losing that line would also re-cancel an epoch that is already cancelled.
    const h = await ladder();
    h.generate("A line the caller talks over.", 8 * 1_000);
    h.handlers().onSpeechStarted();
    expect(h.clears()).toBe(1);
    h.handlers().onSpeechStarted(); // nothing is playing now
    expect(h.clears()).toBe(1);
  });

  it("counts an utterance SUPERSEDED without a completion event", async () => {
    // CODEX P1, ROUND 3. `openOrGetCurrent` drops the previous `current` when a
    // new response epoch starts, WITHOUT a completion event — and its audio was
    // already forwarded to Twilio. Accumulating at `response.done` therefore
    // missed those bytes entirely, so the next completion armed a window
    // shorter than the audio still queued and the prompt landed over the agent.
    // The third variant of the same error: count the audio the caller may still
    // be hearing, not the audio that happened to reach a completion.
    const h = await ladder();
    // Ten seconds forwarded, then a NEW epoch supersedes it with no onAudioDone.
    h.handlers().onAudioDelta(Buffer.alloc(8 * 10_000).toString("base64"));
    h.generate("The reply that replaced it.", 8 * 1_000);
    // Both must be in the bound: 10s superseded + 1s completed.
    expect(h.timers.armed(WINDOW + 1_000)).toBe(0);
    expect(h.timers.fire(WINDOW + 1_000)).toBe(false);
    expect(h.timers.armed(WINDOW + 11_000)).toBe(1);
    expect(h.session.speak).not.toHaveBeenCalled();
  });

  it("does not count audio from a cancelled epoch, which is never forwarded", async () => {
    // The other direction, and it matters: over-patience is safe but not free,
    // because a bound that only ever grows stops the ladder firing at all. A
    // barge-in cancels the epoch, so `openOrGetCurrent` returns null and those
    // deltas are DROPPED rather than sent — they cannot be queued inside Twilio
    // and must not inflate the bound.
    //
    // Driven through the REAL barge-in path, which needs the agent's audio to
    // be playing: `handleCallerSpeechStarted` returns early unless
    // `assistantAudioPlaying`, so a mark echo before the barge-in would make
    // this test silently exercise nothing. The first version of it called an
    // optional method that does not exist and passed either way.
    const h = await ladder();
    h.generate("A line the caller talks over.", 8 * 1_000); // 1s sent, playing
    h.handlers().onSpeechStarted(); // a real barge-in: the epoch is cancelled
    // Twenty seconds of stale audio on the CANCELLED epoch: dropped, not sent.
    h.handlers().onAudioDelta(Buffer.alloc(8 * 20_000).toString("base64"));
    h.generate("The reply after the barge-in.", 8 * 1_000); // new epoch, 1s
    // ONE second — the reply's own. The barge-in told Twilio to `clear`, so the
    // second that had been forwarded before it was DISCARDED and cannot still
    // be reaching the caller.
    //
    // This assertion read `WINDOW + 2_000` until round 4, on the claim that the
    // pre-barge-in audio stayed counted "in the safe direction, bounded to one
    // agent turn". That claim was wrong — see the repeated-barge-in test above,
    // where it grows without limit — and this is rewritten to the property, not
    // loosened to fit.
    expect(h.timers.armed(WINDOW + 1_000)).toBe(1);
    expect(h.timers.armed(WINDOW + 2_000)).toBe(0);
    expect(h.timers.armed(WINDOW + 22_000)).toBe(0);
  });

  it("counts an utterance that carried audio and no transcript", async () => {
    // WHY THE TOTAL IS NOT READ OFF `awaitingMark`, which is the obvious place
    // and the wrong one: its second push sits behind `else if (text)`, so an
    // utterance with audio and an empty transcript sends a mark and leaves NO
    // entry. Summing that array would make those bytes invisible and put the
    // prompt back over the agent on exactly the lines nobody can see.
    const h = await ladder();
    h.handlers().onAudioDelta(Buffer.alloc(8 * 9_000).toString("base64"));
    h.handlers().onAudioDone("");
    expect(h.timers.armed(WINDOW)).toBe(0);
    expect(h.timers.armed(WINDOW + 9_000)).toBe(1);
  });

  it("forgets the queue once the newest echo proves it played", async () => {
    // Otherwise the bound only ever grows and every later window inherits the
    // whole call's audio — too patient without limit is its own defect.
    const h = await ladder();
    h.speak("A long question.", 8 * 8_000); // generates AND echoes
    h.generate("A short one.", 8 * 1_000);
    expect(h.timers.armed(WINDOW + 9_000)).toBe(0);
    expect(h.timers.armed(WINDOW + 1_000)).toBe(1);
  });

  it("a mark that never echoes still fires, one line's patience later and never over the agent", async () => {
    const h = await ladder();
    h.generate("A long question.", 8 * 8_000);
    expect(h.timers.fire(WINDOW + 8_000)).toBe(true);
    expect(h.session.speak).toHaveBeenCalledTimes(1);
  });

  it("an echo does NOT extend a clock the AGENT owes — that is not this timer's business", async () => {
    const h = await ladder();
    h.generate("What is your date of birth?");
    h.handlers().onSpeechStopped(); // the caller answered: a reply is owed
    expect(h.timers.armed(AGENT_WINDOW)).toBe(1);
    h.echoMark();
    expect(h.timers.armed(AGENT_WINDOW)).toBe(1);
    expect(h.timers.armed(WINDOW)).toBe(0);
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

    // A fresh three, not a cut on the next window — the LADDER reset.
    expect(h.timers.fire(WINDOW)).toBe(true);
    expect(h.outcomes).toEqual([]);
    expect(h.session.speak).toHaveBeenCalledTimes(4);
    // And the cumulative count kept every one of them.
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    expect(h.records[0].silencePrompts).toBe(4);
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

  it("REMEMBERS a prompt the caller answered — that is the guard number (Codex P2)", async () => {
    // The ladder and the count were one field, and the reset erased the
    // prompt that WORKED. So a call where the ladder spoke and the caller
    // came back read zero prompts, `followUpEvent` skipped its row on a call
    // that owed no follow-up, and this PR's own guard — prompts on calls that
    // then carried on normally, the false-positive rate and the window's dial
    // — could not be measured at all.
    const h = await ladder();
    h.speak("How can I help you today?");
    h.timers.fire(WINDOW);
    h.handlers().onCallerTranscript("I am here.", "item-1");
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    expect(h.records[0].silenceCut).toBe(false);
    expect(h.records[0].silencePrompts).toBe(1);
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
