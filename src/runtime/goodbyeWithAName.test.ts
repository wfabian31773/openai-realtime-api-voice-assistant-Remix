/**
 * A GOODBYE THAT NAMES THE CALLER IS STILL A GOODBYE — v169.
 *
 * v134 hangs up 6 s after a completed goodbye exchange. Its matcher is
 * deliberately whole-phrase ("unknown words keep the call open"), and three
 * ordinary closings fell outside it:
 *
 *   - the agent addresses the caller by name: "You're welcome, Irene. Take care.";
 *   - the agent says goodbye first and the caller answers it: "Adiós." / "Gracias." / "Con gusto.";
 *   - a bare thank-you before the agent's full sign-off: "Thank you." / "You're welcome, Charles. Take care.".
 *
 * Each of those calls then sat open in silence until the dead-air watchdog
 * ended it. Queue lanes and PCP, `runtime_outcome = dead_air`, duration >= 30:
 * 4–7 a day on 10-26..10-29, 15 on 10-30, 34 on 11-02, with an average of 53 s
 * between the last line and the end of the call on 11-02. Every one of the
 * nine below had already filed; the cost is the caller's silence, the minutes,
 * and a dead_air ending that reads as a failure.
 *
 * THE CORPUS, 2026-11-02, by real CallSid — the closing exchange is
 * reproduced with synthetic names:
 *
 *   closes now:  CAf04bb5b6b2e79edbfe356424145c3c49  CAb03255367655997ebe61f306e46ff380
 *                CAe867ea3e0bceb48c0a1e68c2cceb047a  CAc4c427a123a0769552ceb46ef9293ffe
 *                CA973e5f0cbf9befd3636f4ec27ea9a4b2  CA93febba5c6aba66231fcca699ad60b05
 *                CA3a0ebc9ebd6183d7bade0648887d3a07  CA5b3e9a46ecd520e85e7ad1b3d44a4a46
 *                CAe04c939d901c7f5a1bd5e3ad628db2a1
 *   still open:  CA03196272b6a93ad41c3efbd6d842c1f4  (the caller added an endearment)
 *                CA97cd9a6cd845b2eb7c6241da5e65cde0  ("No, not interested." is not a goodbye)
 *                CA0c5d2fd93c87a6604f1375e30fce696e  ("Okay." after directions is not a goodbye)
 *                CAd4a6f01fb17b61b862c18e7e2c62b8fb  (a thank-you answering an agent question)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOODBYE_GRACE_MS, VoiceCallBridge, type BridgeSessionHandlers, type CallOutcome, type VoiceCallRecord,
} from "./mediaStreamBridge";

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
    context: { callSid: "CA00000000000000000000000000000169", streamSid: "MZ-test", slug: "optical", callerPhone: "", dialedNumber: "" },
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
  ["CAf04bb5b6b2e79edbfe356424145c3c49",
    "Your ticket number is VA-11111. The optical team will follow up with you about mailing those prescriptions. Is there anything else?",
    "No, thank you.", "You're welcome, Irene. Take care."],
  ["CAb03255367655997ebe61f306e46ff380", "VA-11112.", "Thank you.", "You're welcome, Guadalupe. Have a good day."],
  ["CAe867ea3e0bceb48c0a1e68c2cceb047a",
    "Your ticket number is VA-11113. It's marked high priority. The clinical team will follow up with you.",
    "Thank you.", "You're welcome, Charles. Take care."],
  ["CAc4c427a123a0769552ceb46ef9293ffe",
    "I don't have a time for that. The HVA Hub team will reach out as soon as they can.",
    "Okay, thank you.", "You're welcome, Silverio. Take care."],
  ["CA973e5f0cbf9befd3636f4ec27ea9a4b2", "Que tenga un buen día.", "Gracias.", "Igualmente."],
  ["CA93febba5c6aba66231fcca699ad60b05", "Adiós.", "Gracias.", "Con gusto."],
  ["CA3a0ebc9ebd6183d7bade0648887d3a07",
    "Listo, Eloisa. Su número de ticket es VA-11114. El equipo clínico la va a llamar a ese número. Que se mejore pronto.",
    "Gracias.", "Con gusto. Adiós."],
  ["CA5b3e9a46ecd520e85e7ad1b3d44a4a46", "Que le vaya bien.", "A usted también. Bye.", "Bye."],
  ["CAe04c939d901c7f5a1bd5e3ad628db2a1", "Con gusto, Ramón. Adiós.", "Okey. Adiós.", "Adiós."],
];

describe("the 2026-11-02 corpus: closings that sat open until the dead-air watchdog", () => {
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
  ["CA03196272b6a93ad41c3efbd6d842c1f4: an unknown word in the caller's reply keeps it open",
    "Igualmente, Margarito. Que tenga un buen día.", "Gracias, preciosa. Gracias, igualmente.", "Adiós."],
  ["CA97cd9a6cd845b2eb7c6241da5e65cde0: a refusal is not a goodbye",
    "There's nobody I can put you through to from here. Would you like to tell me what you need?",
    "No, not interested.", "Okay. Take care."],
  ["CA0c5d2fd93c87a6604f1375e30fce696e: an acknowledgement of directions is not a goodbye",
    "The office is at 100 Example Drive. Hours today are 8 to 5.", "Okay.", "Sounds good. Have a great day."],
  ["CAd4a6f01fb17b61b862c18e7e2c62b8fb: a thank-you answering an agent question keeps it open",
    "Su próxima cita es el miércoles. ¿Necesita algo más con alguna de las dos?", "No, gracias.",
    "Con gusto, Niurka. Que tenga un buen día."],
  ["a thank-you is not closed by a reply with no farewell in it",
    "Your ticket number is VA-11115.", "Thank you.", "You're welcome, Irene."],
  ["a name cannot stand in for a farewell",
    "Your ticket number is VA-11116.", "Thank you.", "Okay, Thursday."],
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
    h.exchange("VA-11117.", "Thank you.", "You're welcome, Irene. Take care.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS - 1000);
    h.handlers.onCallerTranscript("Oh wait, one more thing.");
    vi.advanceTimersByTime(GOODBYE_GRACE_MS * 2);
    expect(h.outcomes).toEqual([]);
  });
});
