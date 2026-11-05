/**
 * AN AFTERNOON SIGN-OFF AND A BLESSING ARE GOODBYES TOO — v176.
 *
 * v134 hangs up 6 s after a completed goodbye exchange, and v169 widened its
 * whole-phrase matcher to a sign-off that names the caller. Two closings of
 * 2026-11-04 still sat open until the dead-air watchdog ended them, and both
 * had already filed:
 *
 *   - the agent's afternoon sign-off: "That's everything on my end. Have a
 *     good afternoon, <name>." — the matcher knew "have a good day / evening /
 *     night / weekend" and nothing about the afternoon or the morning, and
 *     "that's everything on my end" was an unknown phrase;
 *   - a Spanish caller's blessing: "Okey. Igualmente, bendiciones. Adiós." —
 *     "bendiciones" was an unknown word, and unknown words keep the call open.
 *
 * Runtime calls ending `dead_air` (duration >= 30) on 2026-10-26..11-04 whose
 * last four turns carry an afternoon or morning sign-off, "everything on my
 * end", or a blessing: 3. Two are below; the third (CA03196272…) is v169's
 * endearment case, which still stays open.
 *
 * THE CORPUS, 2026-11-04, by real CallSid, the closing exchange reproduced
 * with synthetic names and numbers:
 *
 *   closes now:  CA5e11320a4d4c5469d28a6d0dcee3f002  CAd598e4da36ab4482da48c587500b806c
 *   still open:  CA939cd5c2196d767a299d98fe9b56dcb4  (the sign-off was cut off
 *                mid-line and carried a callback number; the caller's "Okay."
 *                answered that, not a goodbye)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOODBYE_GRACE_MS, VoiceCallBridge, type BridgeSessionHandlers, type CallOutcome, type VoiceCallRecord,
} from "./mediaStreamBridge";
import { callerConclusion, completesGoodbye, isAgentSignOff } from "./goodbye";

function harness() {
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
  const bridge = new VoiceCallBridge({
    context: { callSid: "CA00000000000000000000000000000176", streamSid: "MZ-test", slug: "surgery", callerPhone: "", dialedNumber: "" },
    agent: { instructions: "", tools: [], guardrails: [], toolNames: ["lookup"], skipped: [],
      dispatch: vi.fn(async () => ({ ok: true, output: '{"success":true}' })) },
    createSession: (h) => { handlers = h; return session; },
    twilio: { sendFrame: (f) => { if (f.event === "mark") mark = f.mark.name; }, close: vi.fn() },
    onOutcome: (o) => outcomes.push(o), persistCallRecord: async (r) => { records.push(r); },
  });
  const say = (text: string) => {
    epoch++; active = true; handlers.onResponseStarted?.();
    handlers.onAgentTranscriptDelta(text);
    handlers.onAudioDelta(Buffer.alloc(800, 0x7f).toString("base64"));
    handlers.onAudioDone(text);
    active = false; handlers.onResponseDone();
    bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: mark } });
  };
  const exchange = (agentBefore: string, caller: string, agentAfter: string) => {
    say(agentBefore);
    handlers.onCallerTranscript(caller);
    say(agentAfter);
  };
  return { handlers, records, outcomes, say, exchange };
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

const CLOSES: Array<[sid: string, before: string, caller: string, after: string]> = [
  ["CA5e11320a4d4c5469d28a6d0dcee3f002",
    "That's everything on my end. Have a good afternoon, Marisol.", "Thank you.", "You're welcome."],
  ["CAd598e4da36ab4482da48c587500b806c",
    "Igualmente, Marisol. Que tenga un buen día.", "Okey. Igualmente, bendiciones. Adiós.", "Adiós."],
];

describe("the 2026-11-04 corpus: closings that sat open until the dead-air watchdog", () => {
  for (const [sid, before, caller, after] of CLOSES) {
    it(`${sid} ends ${GOODBYE_GRACE_MS / 1000} s after the sign-off`, () => {
      const h = harness();
      h.exchange(before, caller, after);
      vi.advanceTimersByTime(GOODBYE_GRACE_MS - 1);
      expect(h.outcomes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(h.outcomes).toEqual(["agent_ended"]);
      expect(h.records[0]).toMatchObject({ teardownReason: "goodbye_grace" });
    });
  }
});

const STAYS_OPEN: Array<[label: string, before: string, caller: string, after: string]> = [
  ["CA939cd5c2196d767a299d98fe9b56dcb4: an acknowledgement of a cut-off line carrying a number is not a goodbye",
    "Okay. Your callback number is 555-010-0199. Have a good day.", "Okay.", "Take care, Marisol."],
  ["a blessing inside a request is not a goodbye",
    "Your ticket number is VA-11176.", "God bless, and I also need a refill.", "Of course. Which medication?"],
  ["\"that's everything on my end\" alone does not close the call",
    "Your ticket number is VA-11177.", "Thank you.", "That's everything on my end."],
  ["\"that's all on my end\" alone does not close the call either",
    "Your ticket number is VA-11178.", "Thank you.", "That's all on my end."],
  ["a thank-you answering a question still keeps it open after an afternoon sign-off",
    "Is there anything else I can help with today?", "Thank you.", "Have a good afternoon, Marisol."],
];

describe("closings it must still leave open", () => {
  for (const [label, before, caller, after] of STAYS_OPEN) {
    it(label, () => {
      const h = harness();
      h.exchange(before, caller, after);
      vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2);
      expect(h.outcomes).toEqual([]);
    });
  }

  it("the caller speaking inside the grace window still cancels it", () => {
    const h = harness();
    h.exchange("That's everything on my end. Have a good morning, Marisol.", "Thank you.", "You're welcome.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS - 1000);
    h.handlers.onCallerTranscript("Oh wait, one more thing.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2);
    expect(h.outcomes).toEqual([]);
  });
});

describe("the phrases themselves", () => {
  it("an afternoon or morning sign-off is a sign-off; a greeting is not", () => {
    expect(isAgentSignOff("Have a good afternoon.")).toBe(true);
    expect(isAgentSignOff("Have a great morning, Marisol.")).toBe(true);
    expect(isAgentSignOff("That's everything on my end. Have a good afternoon.")).toBe(true);
    expect(isAgentSignOff("That is all from my end. Take care.")).toBe(true);
    expect(isAgentSignOff("That's everything on my end.")).toBe(false);
    // "that's all" is a farewell on its own; inside "that's all on my end" it is not (Codex P2, #429).
    expect(isAgentSignOff("That's all on my end.")).toBe(false);
    expect(isAgentSignOff("That's all from my end, Marisol.")).toBe(false);
    expect(isAgentSignOff("That's all on my end. You're welcome.")).toBe(false);
    expect(isAgentSignOff("That's all on my end. Have a good day.")).toBe(true);
    expect(isAgentSignOff("That's all.")).toBe(true);
    expect(isAgentSignOff("Good morning, thank you for calling.")).toBe(false);
  });

  it("a blessing is the caller's farewell, in either language", () => {
    expect(callerConclusion("Bendiciones.", "")).toBe("farewell");
    expect(callerConclusion("Gracias. Que Dios la bendiga.", "")).toBe("farewell");
    expect(callerConclusion("Dios lo bendiga. Adiós.", "")).toBe("farewell");
    expect(callerConclusion("God bless you. Bye.", "")).toBe("farewell");
    expect(callerConclusion("God bless.", "")).toBe("farewell");
  });

  it("a blessing is answered by a polite reply alone, as any farewell is", () => {
    expect(completesGoodbye("Igualmente.", "farewell")).toBe(true);
    expect(completesGoodbye("You too, Marisol.", "farewell")).toBe(true);
  });

  it("\"that's everything on my end\" is never a caller's farewell", () => {
    expect(callerConclusion("That's everything on my end.", "")).toBeNull();
  });
});
