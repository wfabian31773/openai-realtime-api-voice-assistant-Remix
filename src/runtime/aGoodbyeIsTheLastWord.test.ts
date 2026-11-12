/**
 * A GOODBYE IS THE LAST WORD — v217.
 *
 * Found by the 2026-11-12 overnight pass. On the NPX outreach campaign the
 * agent said goodbye, called `record_call_outcome`, then `end_call`. The v56
 * guard read the outcome's answer as a tool answer the caller was still
 * waiting on and held the hangup. Its refusal told the model to "ask if there
 * is anything else", so the caller heard "Is there anything else I can help
 * you with?" after the goodbye.
 *
 * Measured, `npx-outreach`, 2026-11-11..12: 8 of 98 heard calls. All 8 carry
 * `hangupsHeld = 1` on their `follow_up_summary` row. On every one the
 * agent's goodbye came straight after the caller's last line, and the two
 * tools followed with no caller line between them.
 *
 * The change has two halves.
 * - The tool: every `record_call_outcome` answer declares
 *   `nothing_to_say: true`.
 * - The bridge: such an answer does not hold a hangup, unless the caller's own
 *   last words have had no reply. A model that records and hangs up without a
 *   goodbye is still held, exactly as v56 holds it.
 *
 * Driven through the REAL `record_call_outcome` and `end_call` handlers
 * (a fake outbound store) into the REAL bridge. Transcripts are synthetic
 * stand-ins; the call SIDs are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VoiceCallBridge,
  declaresNothingToSay,
  type BridgeSessionHandlers,
  type CallOutcome,
  type VoiceCallRecord,
} from "./mediaStreamBridge";
import { getTool } from "../tools/registry";
import {
  END_CALL_TOOL_NAME,
  RECORD_OUTCOME_TOOL_NAME,
  recordedOutcome,
  setOutboundToolStoreForTests,
} from "../tools/outboundTools";
import { FakeOutboundStore } from "./outbound/store.testkit";
import { followUpEvent } from "./followUpTelemetry";

const INJECTED = {
  outbound_contact_id: "c1",
  outbound_phone: "+15555550111",
  outbound_campaign: "npx-outreach",
};

/** What a lookup or a filing answers: something the caller IS waiting on. */
const AN_ANSWER = '{"success":true,"ticket_number":"VA-90217"}';

function harness() {
  const store = new FakeOutboundStore();
  store.addContact({ id: "c1", phone: "+15555550111", status: "calling" });
  setOutboundToolStoreForTests(store);
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
  // The real tools, with the call's identity injected the way the lane does.
  const dispatch = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const tool = name === RECORD_OUTCOME_TOOL_NAME || name === END_CALL_TOOL_NAME ? getTool(name) : null;
    if (tool) return { ok: true, output: JSON.stringify(await tool.handler({ ...INJECTED, ...args })) };
    return { ok: true, output: AN_ANSWER };
  });
  const bridge = new VoiceCallBridge({
    context: {
      callSid: "CA00000000000000000000000000000217", streamSid: "MZ-test",
      slug: "npx-outreach", callerPhone: "+15555550111", dialedNumber: "+15559876543",
    },
    agent: { instructions: "", tools: [], guardrails: [], toolNames: [], skipped: [], dispatch } as never,
    createSession: (h: BridgeSessionHandlers) => { handlers = h; return session as never; },
    twilio: { sendFrame: (f: { event: string; mark?: { name: string } }) => { if (f.event === "mark" && f.mark) mark = f.mark.name; }, close: vi.fn() },
    onOutcome: (o: CallOutcome) => outcomes.push(o),
    persistCallRecord: async (r: VoiceCallRecord) => { records.push(r); },
  } as never);
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  /** One agent line the caller has finished hearing (the mark echo). */
  const say = (text: string) => {
    epoch++; active = true; handlers.onResponseStarted?.();
    handlers.onAgentTranscriptDelta(text);
    handlers.onAudioDelta(Buffer.alloc(800, 0x7f).toString("base64"));
    handlers.onAudioDone(text);
    active = false; handlers.onResponseDone();
    bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: mark } } as never);
  };
  const caller = (text: string) => handlers.onCallerTranscript(text);
  const toolNameById = new Map<string, string>();
  /** One response that carries these tool calls and no words. */
  const tools = async (...calls: Array<[name: string, args?: Record<string, unknown>]>) => {
    epoch++; active = true; handlers.onResponseStarted?.();
    for (const [i, [name, args]] of calls.entries()) {
      const id = `call-${epoch}-${i}`;
      toolNameById.set(id, name);
      handlers.onToolCall(id, name, args ?? {});
    }
    await flush();
    active = false; handlers.onResponseDone();
    await flush();
  };
  /** The answer the bridge sent the model for the last call to `name`. */
  const sent = (name: string) => {
    const calls = session.sendToolResult.mock.calls as Array<[string, boolean, Record<string, unknown>]>;
    const mine = calls.filter(([id]) => toolNameById.get(id) === name);
    return mine[mine.length - 1]?.[2];
  };
  return { bridge, session, store, records, outcomes, dispatch, say, caller, tools, sent, flush };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setOutboundToolStoreForTests(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Shape = [sid: string, outcome: string, declined: string, goodbye: string];

/** Every corpus call: the offer declined (or a wrong person), the agent's
 * goodbye straight after, then the outcome and the hangup in one batch. */
const CORPUS: Shape[] = [
  ["CA579d90ed3b59c4c502d11370919c9c85", "not_interested", "No.", "Thank you for your time. Goodbye."],
  ["CA345e8d31f43f0ee0b3909464b964ece3", "not_interested", "Uh, no thank you.", "Thank you for your time. Goodbye."],
  ["CAbd3c3f09ba8bc3bb6b88c6a94cd20572", "not_interested", "I'll just keep my current appointment.", "Understood. Thank you for your time, and have a great day."],
  ["CA769a4e55d42d0a4109092f6f14efa534", "wrong_person", "This is someone else.", "I'm sorry, I may have the wrong number. Goodbye."],
  ["CAb7ca2f1db243bc7b8bb292e578ec00da", "not_interested", "The current appointment is fine.", "Understood, we'll leave it as is. Thank you for your time, and goodbye."],
  ["CA4d8ac43bb81c9523b276c97f86681739", "not_interested", "I don't have time.", "No problem. Thank you for your time, and have a great day."],
  ["CA85159804e156a8b269169342d3a15ba6", "not_interested", "Just keep my current appointment.", "Understood, we'll leave that as is. Thank you for your time. Goodbye."],
  ["CAc44cb8be50ebd3da717be2a0723ea816", "not_interested", "No.", "Understood. Thanks for your time. Take care."],
];

async function declinedThenGoodbye(h: ReturnType<typeof harness>, declined: string, goodbye: string) {
  h.say("Hello, this is an automated assistant calling for Azul Vision. This call is recorded. May I speak with the patient?");
  h.caller("Yes.");
  h.say("Our records show you have an eye exam coming up. We'd like to offer you a sooner appointment. Does that interest you?");
  h.caller(declined);
  h.say(goodbye);
}

describe("CORPUS: the agent said goodbye, recorded the outcome and ended the call", () => {
  it.each(CORPUS)("%s (%s) ends on the goodbye: the hangup is not held and nothing more is asked", async (_sid, outcome, declined, goodbye) => {
    const h = harness();
    await declinedThenGoodbye(h, declined, goodbye);
    await h.tools([RECORD_OUTCOME_TOOL_NAME, { outcome }], [END_CALL_TOOL_NAME, { reason: "completed" }]);
    expect(h.sent(END_CALL_TOOL_NAME)).not.toMatchObject({ error: "unvoiced_tool_result" });
    expect(h.dispatch).toHaveBeenCalledWith(END_CALL_TOOL_NAME, { reason: "completed" });
    vi.advanceTimersByTime(10_000);
    await h.flush();
    expect(h.outcomes).toEqual(["agent_ended"]);
    // No second line was spoken after the goodbye.
    expect(h.session.speak).not.toHaveBeenCalled();
    const r = h.records[0];
    expect(r.hangupsHeld).toBe(0);
    const ev = followUpEvent(r);
    expect(ev?.data.hangupsHeld ?? 0).toBe(0);
    // The outcome landed on the contact, as before.
    expect(h.store.contacts.get("c1")!.status).toBe(outcome === "wrong_person" ? "wrong_number" : "declined");
  });

  it("the same when the outcome and the hangup come in two responses, the second with no words", async () => {
    const [, outcome, declined, goodbye] = CORPUS[0];
    const h = harness();
    await declinedThenGoodbye(h, declined, goodbye);
    await h.tools([RECORD_OUTCOME_TOOL_NAME, { outcome }]);
    await h.tools([END_CALL_TOOL_NAME, { reason: "completed" }]);
    expect(h.sent(END_CALL_TOOL_NAME)).not.toMatchObject({ error: "unvoiced_tool_result" });
    vi.advanceTimersByTime(10_000);
    await h.flush();
    expect(h.outcomes).toEqual(["agent_ended"]);
  });
});

describe("CONTROLS: what v56 still holds", () => {
  it("no goodbye: the caller's last words have had no reply, so the hangup is held and the model must speak", async () => {
    const h = harness();
    h.say("Hello, this is an automated assistant calling for Azul Vision. This call is recorded. May I speak with the patient?");
    h.caller("Yes.");
    h.say("We'd like to offer you a sooner appointment. Does that interest you?");
    h.caller("No.");
    await h.tools([RECORD_OUTCOME_TOOL_NAME, { outcome: "not_interested" }], [END_CALL_TOOL_NAME, { reason: "completed" }]);
    expect(h.sent(END_CALL_TOOL_NAME)).toMatchObject({ error: "unvoiced_tool_result" });
    expect(h.dispatch).not.toHaveBeenCalledWith(END_CALL_TOOL_NAME, expect.anything());
    expect(h.outcomes).toEqual([]);
  });

  it("a sibling that leaves an answer, in the same batch as the outcome, still holds the hangup", async () => {
    const h = harness();
    await declinedThenGoodbye(h, "No.", "Thank you for your time. Goodbye.");
    await h.tools(
      ["request_staff_callback"],
      [RECORD_OUTCOME_TOOL_NAME, { outcome: "not_interested" }],
      [END_CALL_TOOL_NAME, { reason: "completed" }],
    );
    expect(h.sent(END_CALL_TOOL_NAME)).toMatchObject({ error: "unvoiced_tool_result" });
    expect(h.outcomes).toEqual([]);
  });

  it("the outcome settling AFTER a sibling's answer does not clear it", async () => {
    const h = harness();
    await declinedThenGoodbye(h, "No.", "Thank you for your time. Goodbye.");
    await h.tools(
      [RECORD_OUTCOME_TOOL_NAME, { outcome: "not_interested" }],
      ["lookup_patient"],
      [END_CALL_TOOL_NAME, { reason: "completed" }],
    );
    expect(h.sent(END_CALL_TOOL_NAME)).toMatchObject({ error: "unvoiced_tool_result" });
  });

  it("any other tool after the goodbye still holds the hangup — the change is the flag, never the tool's name", async () => {
    const h = harness();
    await declinedThenGoodbye(h, "No.", "Thank you for your time. Goodbye.");
    await h.tools(["lookup_patient"], [END_CALL_TOOL_NAME, { reason: "completed" }]);
    expect(h.sent(END_CALL_TOOL_NAME)).toMatchObject({ error: "unvoiced_tool_result" });
  });
});

describe("the flag comes from the tool, on every answer it gives on a dialled call", () => {
  it("a recorded outcome, a repeat and an unknown outcome all say there is nothing to say", async () => {
    const store = new FakeOutboundStore();
    store.addContact({ id: "c1", phone: "+15555550111", status: "calling" });
    setOutboundToolStoreForTests(store);
    const tool = getTool(RECORD_OUTCOME_TOOL_NAME)!;
    const first = await tool.handler({ ...INJECTED, outcome: "not_interested" });
    expect(first).toMatchObject({ success: true, recorded: "not_interested", nothing_to_say: true });
    const again = await tool.handler({ ...INJECTED, outcome: "done" });
    expect(again).toMatchObject({ recorded: "already_settled", nothing_to_say: true });
    const unknown = await tool.handler({ ...INJECTED, outcome: "booked" });
    expect(unknown).toMatchObject({ error: "unknown_outcome", nothing_to_say: true });
  });

  it("the recorded answer tells the model to end the call without a second goodbye", () => {
    const r = recordedOutcome("done") as Record<string, unknown>;
    expect(r.fix).toMatch(/already said goodbye, call end_call now/i);
    expect(r.fix).not.toMatch(/anything else/i);
  });

  it("the bridge reads the declared field, and only a literal true", () => {
    expect(declaresNothingToSay({ nothing_to_say: true })).toBe(true);
    expect(declaresNothingToSay({ nothing_to_say: "true" })).toBe(false);
    expect(declaresNothingToSay({ success: true, ticket_number: "VA-1" })).toBe(false);
    expect(declaresNothingToSay(null)).toBe(false);
  });
});
