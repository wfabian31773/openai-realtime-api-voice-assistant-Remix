/**
 * XAI MARKUP IS NEVER THE AGENT'S WORDS, AND A GOODBYE IS NOT FOLLOWED BY
 * ANOTHER TURN — v275.
 *
 * Measured on the Hub, agent lines in the 30 days to 2026-11-26: 104 carried
 * xAI's own markup (`<response_segment_0_already_spoken>…`, `<silence />`,
 * `<turn_end>`, `<end_of_call>`, `<tool_call>…`, `<system_warning>…`), on every
 * lane that takes calls, and many ended `[interrupted]`, so their audio was
 * playing. The biggest group (no-ivr): the agent said "Great, have a good
 * day!" and called `record_answered_question` in the same response; the bridge
 * then asked the model for a turn after the tool answer, and the model, with
 * nothing to add, answered with markup repeating the goodbye.
 *
 * Fix 1: a tool answer that declares `nothing_to_say` (now including
 * `record_answered_question`) gets no further turn when the response has just
 * said a goodbye that completes the caller's closing. The call ends on the
 * goodbye grace, as a goodbye with no tool after it already does.
 *
 * Fix 2: from the first tag on, an agent utterance is muted: its later audio
 * is not sent to Twilio and its transcript stops before the tag, so the
 * stored line carries only the words before it.
 *
 * Driven through the REAL `record_answered_question` result into the REAL
 * bridge. Transcripts are synthetic stand-ins; the call SIDs are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallBridge, type BridgeSessionHandlers, type CallOutcome, type VoiceCallRecord } from "./mediaStreamBridge";
import { answeredQuestionResult } from "../agents/afterHoursAnsweredQuestion";
import { followUpEvent } from "./followUpTelemetry";
import { providerMarkupIndex, providerMarkupMayOpen, withoutProviderMarkup } from "./providerMarkup";

const ANSWERED = "record_answered_question";
/** What a lookup or a filing answers: something the caller IS waiting on. */
const AN_ANSWER = '{"success":true,"ticket_number":"VA-90275"}';
const AUDIO = Buffer.alloc(800, 0x7f).toString("base64");

function harness() {
  let handlers!: BridgeSessionHandlers;
  let epoch = 0;
  let active = false;
  let mark = "";
  const records: VoiceCallRecord[] = [];
  const outcomes: CallOutcome[] = [];
  const media: string[] = [];
  const session = {
    appendAudio: vi.fn(), cancelResponse: vi.fn(), sendToolResult: vi.fn(),
    requestResponse: vi.fn(), speakNatural: vi.fn(), speak: vi.fn(), close: vi.fn(),
    getResponseEpoch: () => epoch, isResponseActive: () => active, setSpokenLanguage: vi.fn(),
  };
  const dispatch = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === ANSWERED) return { ok: true, output: JSON.stringify(answeredQuestionResult(args.follow_up_owed as boolean | undefined)) };
    return { ok: true, output: AN_ANSWER };
  });
  const bridge = new VoiceCallBridge({
    context: {
      callSid: "CA00000000000000000000000000000275", streamSid: "MZ-test",
      slug: "no-ivr", callerPhone: "+15555550111", dialedNumber: "+15559876543",
    },
    agent: { instructions: "", tools: [], guardrails: [], toolNames: [], skipped: [], dispatch } as never,
    createSession: (h: BridgeSessionHandlers) => { handlers = h; return session as never; },
    twilio: {
      sendFrame: (f: { event: string; mark?: { name: string }; media?: { payload: string } }) => {
        if (f.event === "mark" && f.mark) mark = f.mark.name;
        if (f.event === "media" && f.media) media.push(f.media.payload);
      },
      close: vi.fn(),
    },
    onOutcome: (o: CallOutcome) => outcomes.push(o),
    persistCallRecord: async (r: VoiceCallRecord) => { records.push(r); },
  } as never);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const echo = () => bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: mark } } as never);

  /**
   * One response. `deltas` are the transcript deltas, each followed by one
   * audio delta; `done` is the wire's completed transcript (defaults to the
   * deltas joined). Tool calls ride after the audio, or before it with
   * `toolsFirst`. The caller hears it to the end (the mark echoes).
   */
  const respond = async (opts: {
    deltas?: string[];
    done?: string;
    audioFirst?: boolean;
    tools?: Array<[name: string, args?: Record<string, unknown>]>;
    toolsFirst?: boolean;
    echoMark?: boolean;
    /** The wire sends no completed transcript; the deltas are the line. */
    noWireTranscript?: boolean;
    /** Words with no audio: nothing reached the caller. */
    noAudio?: boolean;
    /** Runs after the tools have answered and before the response's done. */
    beforeDone?: () => void;
  }) => {
    epoch++; active = true; handlers.onResponseStarted?.();
    const callTools = () => {
      for (const [i, [name, args]] of (opts.tools ?? []).entries()) handlers.onToolCall(`call-${epoch}-${i}`, name, args ?? {});
    };
    if (opts.toolsFirst) callTools();
    const deltas = opts.deltas ?? [];
    for (const d of deltas) {
      if (opts.audioFirst && !opts.noAudio) handlers.onAudioDelta(AUDIO);
      handlers.onAgentTranscriptDelta(d);
      if (!opts.audioFirst && !opts.noAudio) handlers.onAudioDelta(AUDIO);
    }
    if (deltas.length > 0) handlers.onAudioDone(opts.noWireTranscript ? undefined : (opts.done ?? deltas.join("")));
    if (!opts.toolsFirst) callTools();
    await flush();
    opts.beforeDone?.();
    active = false; handlers.onResponseDone();
    await flush();
    if (opts.echoMark !== false && deltas.length > 0) echo();
  };
  const say = (text: string) => respond({ deltas: [text] });
  /** Open a response by hand, for a line that does not finish. */
  const begin = () => { epoch++; active = true; handlers.onResponseStarted?.(); };
  const finish = async () => { active = false; handlers.onResponseDone(); await flush(); };
  const caller = (text: string, itemId?: string) => handlers.onCallerTranscript(text, itemId);
  const end = async () => { vi.advanceTimersByTime(10_000); await flush(); };
  const agentLines = () => (records[0]?.transcript ?? "").split("\n").filter((l) => l.startsWith("AGENT: "));
  /** The next dispatch answers only when released. */
  const holdNextAnswer = (output: string) => {
    let release!: () => void;
    dispatch.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, output }); }));
    return () => release();
  };
  return { bridge, session, handlers: () => handlers, records, outcomes, media, dispatch, respond, say, caller, end, agentLines, flush, echo, begin, finish, holdNextAnswer };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The question answered, the caller's closing, then the goodbye and the
 * answered record in ONE response. The caller's closings vary the way the
 * corpus calls did. */
const LEAD: Array<[sid: string, closingQuestion: string, callerClosing: string]> = [
  ["CA1ffa60d08348d7e902be212b84c90fd1", "Is there anything else I can help you with?", "No, that's it. Thank you."],
  ["CAd7f061a92ce39ad71bac7e391ff9c4cc", "Is there anything else I can help you with?", "No, thank you."],
  ["CA8ea235f529126eeab8ec3fd1a5128798", "Is there anything else I can help you with?", "No. Thank you very much."],
  ["CA7fc110aa7865ed90689bc13c84558e3e", "Is there anything else I can help you with?", "That's it, thank you."],
  ["CA7f2a0afbb2c9ac7433f353f227a5aacc", "Is there anything else I can help you with?", "No, thank you very much."],
  ["CA3270360204edf4559319ec3cafa439d4", "Is there anything else I can help you with?", "No. Okay, thank you."],
  ["CA3f2094866008f11f7fd239f879b747f6", "Our offices open at 8 AM.", "Okay, thank you. Bye."],
  ["CA48219fabcf19c713fd43bb70711dfb38", "Is there anything else I can help you with?", "No, that's all. Thanks."],
  ["CA9a051bda273d5bc4bbd63bb438c8fdaa", "Is there anything else I can help you with?", "Nothing else, thank you."],
  ["CA9c2b9e4b03d03c91d963fce815c3bc43", "Is there anything else I can help you with?", "No, gracias."],
  ["CAa43b92cf4009491963357c75890c78f0", "Our offices are closed right now and open at 8 AM.", "Okay. Thank you."],
  ["CAb93639c9fa4d6697a5dd9c5ed00bfb1a", "Is there anything else I can help you with?", "No, thanks so much."],
  ["CAcfdaf663f0c4df8c268a1b35bb9b1e5e", "Is there anything else I can help you with?", "No. Thank you."],
];

const GOODBYE = "Great, have a good day!";
/** What the model answered the needless follow-up with. */
const ECHO_MARKUP = `<response_segment_0_already_spoken>${GOODBYE}</response_segment_0_already_spoken>`;

async function answeredThenClosing(h: ReturnType<typeof harness>, closingQuestion: string, callerClosing: string) {
  h.caller("What time does the Covina office open?");
  await h.say(closingQuestion);
  h.caller(callerClosing);
}

describe("FIX 1, CORPUS: a goodbye and record_answered_question in one response end the call on the goodbye", () => {
  it.each(LEAD)("%s: no follow-up is asked for, and the goodbye grace ends the call", async (_sid, q, closing) => {
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before);
    await h.end();
    expect(h.outcomes).toEqual(["agent_ended"]);
    const r = h.records[0];
    expect(r.goodbyeGraceHangup).toBe(true);
    expect(r.teardownReason).toBe("goodbye_grace");
    expect(r.followUps?.skippedAfterGoodbye).toBe(1);
    expect(r.followUps?.owed).toBe(1);
    expect(r.followUps?.requested).toBe(0);
    // The last agent line is the goodbye, and nothing was spoken after it.
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.session.speak).not.toHaveBeenCalled();
    expect(followUpEvent(r)?.data).toMatchObject({ skippedAfterGoodbye: 1, requested: 0 });
  });

  it("the same when the tool call reaches the bridge before the goodbye's audio", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]], toolsFirst: true });
    expect(h.session.requestResponse.mock.calls.length).toBe(before);
    await h.end();
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
  });

  it("the same when the tool answers after the goodbye has finished playing", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const release = h.holdNextAnswer(JSON.stringify(answeredQuestionResult(false)));
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    // The goodbye's mark has echoed; only now does the answer arrive.
    release();
    await h.flush();
    expect(h.session.requestResponse.mock.calls.length).toBe(before);
    await h.end();
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
  });

  it("ends 6 seconds after the goodbye's mark echoes, before the caller's silence window", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    vi.advanceTimersByTime(5_900);
    await h.flush();
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(200);
    await h.flush();
    expect(h.outcomes).toEqual(["agent_ended"]);
  });
});

describe("FIX 1, review of #524", () => {
  it("a bookkeeping answer that settles before the goodbye is heard does not keep the follow-up", async () => {
    // P2 on 35cba36: the tool answered while the caller was still owed a reply
    // (no agent words heard yet), and that latched a follow-up the goodbye
    // then made needless.
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    h.begin();
    h.handlers().onToolCall("call-early", ANSWERED, { follow_up_owed: false });
    await h.flush();
    h.handlers().onAgentTranscriptDelta(GOODBYE);
    h.handlers().onAudioDelta(AUDIO);
    h.handlers().onAudioDone(GOODBYE);
    await h.finish();
    h.echo();
    expect(h.session.requestResponse.mock.calls.length).toBe(before);
    await h.end();
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
  });

  it("a caller still owed a reply when the response ends still gets the follow-up", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ tools: [[ANSWERED, { follow_up_owed: false }]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });
});

describe("FIX 1, controls: the follow-up is still asked for", () => {
  it("when the tool answer has something for the caller (a filing)", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [["create_ticket", {}]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when a sibling tool in the same response has an answer", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }], ["create_ticket", {}]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the answered record is refused because a follow-up is owed (v267)", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: true }]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the agent's words were not a goodbye", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: ["Our Covina office opens at 8 AM."], tools: [[ANSWERED, { follow_up_owed: false }]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the caller's last line was not a closing", async () => {
    const h = harness();
    h.caller("Hi.");
    await h.say("How can I help you today?");
    h.caller("I need to know when the Covina office opens.");
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the response said nothing at all (tools only)", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ tools: [[ANSWERED, { follow_up_owed: false }]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the goodbye was said in an earlier response, not this one", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    // The goodbye rides with a filing, so its follow-up is asked for ...
    await h.respond({ deltas: [GOODBYE], tools: [["create_ticket", {}]] });
    const before = h.session.requestResponse.mock.calls.length;
    // ... and that follow-up says nothing and records the answered question.
    await h.respond({ tools: [[ANSWERED, { follow_up_owed: false }]] });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the caller said goodbye again after the agent's goodbye, before the tool answered", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const release = h.holdNextAnswer(JSON.stringify(answeredQuestionResult(false)));
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    h.caller("Okay, bye.");
    release();
    await h.flush();
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the caller said goodbye again after the tool answered, before the response finished", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({
      deltas: [GOODBYE],
      tools: [[ANSWERED, { follow_up_owed: false }]],
      beforeDone: () => h.caller("Okay, bye."),
    });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the caller is talking and an earlier closing is only re-emitted", async () => {
    const h = harness();
    h.caller("What time does the Covina office open?", "item-1");
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.", "item-2");
    const release = h.holdNextAnswer(JSON.stringify(answeredQuestionResult(false)));
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    // A new turn starts; the provider re-sends the closing it already sent.
    h.handlers().onSpeechStarted();
    h.caller("No, thank you.", "item-2");
    release();
    await h.flush();
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the goodbye's words carried no audio, so the caller never heard them", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]], noAudio: true });
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when only an earlier line of the response was heard and the goodbye after it was not", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    const hs = h.handlers();
    h.begin();
    hs.onAgentTranscriptDelta("Okay.");
    hs.onAudioDelta(AUDIO);
    hs.onAudioDone("Okay.");
    hs.onAgentTranscriptDelta(GOODBYE);
    hs.onAudioDone(GOODBYE);
    hs.onToolCall("call-x", ANSWERED, { follow_up_owed: false });
    await h.flush();
    await h.finish();
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the caller started speaking before the tool answered", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    // The goodbye plays, the caller starts talking, and only then does the
    // tool's answer arrive: the caller is owed a reply.
    let release!: () => void;
    h.dispatch.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, output: JSON.stringify(answeredQuestionResult(false)) }); }));
    const before = h.session.requestResponse.mock.calls.length;
    const pending = h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    await h.flush();
    h.handlers().onSpeechStarted();
    release();
    await pending;
    await h.flush();
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });

  it("when the caller spoke again after the goodbye, before the tool answered", async () => {
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    let release!: () => void;
    h.dispatch.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, output: JSON.stringify(answeredQuestionResult(false)) }); }));
    const before = h.session.requestResponse.mock.calls.length;
    const pending = h.respond({ deltas: [GOODBYE], tools: [[ANSWERED, { follow_up_owed: false }]] });
    await h.flush();
    h.caller("Oh wait, one more thing.");
    release();
    await pending;
    await h.flush();
    expect(h.session.requestResponse.mock.calls.length).toBe(before + 1);
  });
});

describe("FIX 2: provider markup is not played or recorded", () => {
  it("an utterance that is only markup sends no audio after the tag and records no line", async () => {
    const h = harness();
    h.caller("Okay.");
    const mediaBefore = h.media.length;
    await h.respond({ deltas: ["<silence />"] });
    expect(h.media.length).toBe(mediaBefore);
    h.caller("Hello?");
    await h.say("I'm here. Can you hear me?");
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.agentLines().some((l) => l.includes("<"))).toBe(false);
    expect(h.records[0].providerMarkupCuts).toBe(1);
    expect(followUpEvent(h.records[0])?.data).toMatchObject({ providerMarkupCuts: 1 });
  });

  it("the echoed goodbye the needless follow-up produced is never played", async () => {
    const h = harness();
    h.caller("No, that's it. Thank you.");
    const mediaBefore = h.media.length;
    await h.respond({ deltas: ["<response_segment_0_already_spoken>", "Great, have a good day!", "</response_segment_0_already_spoken>"] , done: ECHO_MARKUP });
    expect(h.media.length).toBe(mediaBefore);
  });

  it("TAIL SHAPE: the words before the tag are kept, the rest is dropped, and the goodbye still ends the call", async () => {
    // CAcaf28bb5cc022a28b6be90e255269520, CA52c5fc04fffe09818c60f541e578782a:
    // "Great, have a good day! <…>" after the caller's thank-you.
    const h = harness();
    await h.say("Your request is filed. Is there anything else I can help you with?");
    h.caller("No, thank you.");
    await h.respond({ deltas: [`${GOODBYE} `, "<turn_end>", " more"], done: `${GOODBYE} <turn_end> more` });
    await h.end();
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.records[0].providerMarkupCuts).toBe(1);
  });

  /**
   * The wire's real order (probed 2026-11-26 on grok-voice-3.0, synthetic
   * lines): a sentence's transcript comes BEFORE its audio, and most of that
   * audio comes after the next delta. On "Great, have a good day! <turn_end>"
   * the goodbye's 12,677 bytes arrived as 3,869 before the tag's delta and
   * 3,176 + 4,160 + 496 + 976 after it, and the tag added no audio at all.
   * Codex P2 on #524: muting at the tag dropped the goodbye's own audio.
   */
  const bytes = (n: number) => Buffer.alloc(n, 0x55).toString("base64");
  const sentBytes = (h: ReturnType<typeof harness>, from: number) =>
    h.media.slice(from).reduce((sum, m) => sum + Buffer.from(m, "base64").length, 0);
  const goodbyeThenTag = async (h: ReturnType<typeof harness>, transcriptDeltas: string[], audio: number[][], done: string) => {
    h.begin();
    const hs = h.handlers();
    for (const [i, d] of transcriptDeltas.entries()) {
      hs.onAgentTranscriptDelta(d);
      for (const n of audio[i] ?? []) hs.onAudioDelta(bytes(n));
    }
    hs.onAudioDone(done);
    await h.finish();
    h.echo();
  };

  it("the goodbye's audio that arrives after the tag's delta still plays, and the call ends on it", async () => {
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    const from = h.media.length;
    await goodbyeThenTag(h, [GOODBYE, " <turn_end>"], [[3869], [3176, 4160, 496, 976]], `${GOODBYE} <turn_end>`);
    expect(sentBytes(h, from)).toBe(12677);
    await h.end();
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.records[0].providerMarkupCuts).toBe(1);
  });

  it("CODEX SHAPE: one delta carrying the goodbye and the tag keeps the goodbye's audio", async () => {
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    const from = h.media.length;
    await goodbyeThenTag(h, [`${GOODBYE} <turn_end>`], [[3869, 3176, 4160, 496, 976]], `${GOODBYE} <turn_end>`);
    expect(sentBytes(h, from)).toBe(12677);
    await h.end();
    expect(h.outcomes).toEqual(["agent_ended"]);
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
  });

  it("REVIEW SHAPE: the delta with the tag also carries the end of the goodbye, and the end still plays", async () => {
    // github-actions on a42a38f9: the caller has heard only "Great," when the
    // delta carrying "have a good day! <turn_end>" arrives. The rest of the
    // goodbye's audio comes after that delta and must still be sent.
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    const from = h.media.length;
    await goodbyeThenTag(h, ["Great, ", "have a good day! <turn_end>"], [[2000], [1869, 3176, 4160, 496, 976]], `${GOODBYE} <turn_end>`);
    expect(sentBytes(h, from)).toBe(12677);
    await h.end();
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
  });

  it("OPERATOR'S CHOICE: a tag read aloud after real words plays whole, and only the line is cut", async () => {
    // Probed: "Great, have a good day! <tool_call>end_call<arg_key>…" took
    // 35,717 bytes, 23,040 of them the tool call read aloud. Where the
    // goodbye's audio ends is not known, and an estimate drew opposite review
    // findings on #524 (0 such lines in the 30 days to 2026-11-26), so the
    // audio plays as it did before v275 (operator, 2026-11-26: the exact cut).
    const h = harness();
    h.caller("No, thank you.");
    const from = h.media.length;
    await goodbyeThenTag(
      h,
      [GOODBYE, " <tool_call>end_call<arg_key>reason</arg_key></tool_call>"],
      [[3869], [3176, 4160, 496, 976, 8000, 8000, 7040]],
      `${GOODBYE} <tool_call>end_call<arg_key>reason</arg_key></tool_call>`,
    );
    expect(sentBytes(h, from)).toBe(35717);
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.records[0].providerMarkupCuts).toBe(1);
  });

  it("CODEX SHAPE: a number read back before a tag is never cut short", async () => {
    // Codex P2 on #524 (604741080d): a character-count budget gave a ticket
    // number read back before a tag less audio than it takes to say.
    // CA08109d2bc937b876b609dc096e269be3 (pcp) is the one such line in the 30
    // days to 2026-11-26. Probed: the number said as words ("…V A seven three
    // six zero one.") took 33,157 bytes; written with digits the line is 31
    // characters, which the withdrawn estimate allowed 23,050.
    const line = "Your ticket number is VA-73601.";
    const h = harness();
    h.caller("What's the ticket number?");
    const from = h.media.length;
    await goodbyeThenTag(h, [line, " <turn_end>"], [[4000], [8000, 8000, 8000, 5157]], `${line} <turn_end>`);
    expect(sentBytes(h, from)).toBe(33157);
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${line}`);
  });

  it("a tag split across two deltas is still caught", async () => {
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    await h.respond({ deltas: [`${GOODBYE} <`, "silence />"], done: `${GOODBYE} <silence />` });
    await h.end();
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
  });

  it("with no completed transcript from the wire, the deltas after the tag are not recorded", async () => {
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    await h.respond({ deltas: [`${GOODBYE} <`, "silence /> more words"], noWireTranscript: true });
    await h.end();
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.records[0].providerMarkupCuts).toBe(1);
  });

  it("deltas after the tag are not added to the line, even with no tag in them", async () => {
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    await h.respond({ deltas: [`${GOODBYE} `, "<silence />", " more words"], noWireTranscript: true });
    await h.end();
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
  });

  it("a caller who barges in after the tag gets the clean words recorded as interrupted", async () => {
    const h = harness();
    h.caller("What time do you open?");
    h.begin();
    const hs = h.handlers();
    hs.onAgentTranscriptDelta("We open at 8 AM. ");
    hs.onAudioDelta(AUDIO);
    hs.onAgentTranscriptDelta("<turn_end>");
    hs.onSpeechStarted();
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    const line = h.agentLines().slice(-1)[0];
    expect(line).toContain("We open at 8 AM.");
    expect(line).toContain("[interrupted]");
    expect(line).not.toContain("<");
  });

  it("markup only in the wire's completed transcript is stripped from the line, and counted once", async () => {
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    await h.respond({ deltas: [GOODBYE], done: `${GOODBYE} <end_of_call>` });
    await h.end();
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.records[0].providerMarkupCuts).toBe(1);
    // Its audio had already been sent: the caller may have heard the markup.
    expect(h.records[0].providerMarkupHeard).toBe(1);
    expect(followUpEvent(h.records[0])?.data).toMatchObject({ providerMarkupCuts: 1, providerMarkupHeard: 1 });
  });

  it("REVIEW SHAPE: a markup-only completed line whose audio played leaves a count and a true log line", async () => {
    // github-actions on 60474108: the stream carried no tag, the audio went
    // out, and the completed transcript was only markup. Nothing is stored as
    // the line, so the count and the log are the trace, and the log must not
    // say the audio was not played.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.caller("Okay.");
    await h.respond({ deltas: ["Mm."], done: "<silence />" });
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.agentLines()).toEqual([]);
    expect(h.records[0].providerMarkupCuts).toBe(1);
    expect(h.records[0].providerMarkupHeard).toBe(1);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("provider markup"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("its audio was already sent");
    expect(said[0]).not.toContain("not played");
    warn.mockRestore();
  });

  it("markup only in the completed transcript, with no audio sent, is not counted as possibly heard", async () => {
    const h = harness();
    h.caller("Okay.");
    await h.respond({ deltas: ["Mm."], done: "<silence />", noAudio: true });
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.records[0].providerMarkupCuts).toBe(1);
    expect(h.records[0].providerMarkupHeard).toBe(0);
  });

  it("REVIEW SHAPE: markup after the agent's words is counted as possibly heard, and the log says its audio plays", async () => {
    // github-actions on 4457f662: the log said the rest of the utterance was
    // not played, though a line whose words came first plays its audio whole.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    await h.say("Is there anything else I can help you with?");
    h.caller("No, thank you.");
    const mediaBefore = h.media.length;
    await h.respond({ deltas: [`${GOODBYE} `, "<turn_end>"], done: `${GOODBYE} <turn_end>` });
    await h.end();
    // Both audio deltas went out: nothing of a words-first line is cut.
    expect(h.media.length).toBe(mediaBefore + 2);
    expect(h.records[0].providerMarkupCuts).toBe(1);
    expect(h.records[0].providerMarkupHeard).toBe(1);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("provider markup"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("its audio plays whole, so the caller may have heard it");
    expect(said[0]).not.toContain("not played");
    warn.mockRestore();
  });

  it("a line that opens with markup is not counted as heard, and the log says none of its audio is played", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.caller("Okay.");
    const mediaBefore = h.media.length;
    await h.respond({ deltas: ["<turn_end>"] });
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.media.length).toBe(mediaBefore);
    expect(h.records[0].providerMarkupCuts).toBe(1);
    expect(h.records[0].providerMarkupHeard).toBe(0);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("provider markup"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("none of its audio is played");
    warn.mockRestore();
  });

  it("audio that arrives before the tag's transcript is sent; audio after it is not", async () => {
    const h = harness();
    h.caller("Okay.");
    const mediaBefore = h.media.length;
    await h.respond({ deltas: ["<system_warning>", "do not repeat</system_warning>"], audioFirst: true });
    // The first audio delta reached Twilio before the tag was seen; the second did not.
    expect(h.media.length).toBe(mediaBefore + 1);
  });

  describe("CODEX SHAPE: a tag split after its \"<\" holds the line's audio until the text says which", () => {
    // Codex P2 on 4457f662: a first delta of only "<" matched no tag, so the
    // audio that came before the next delta reached Twilio, and a line that
    // opens with markup could still be heard.
    const chunk = (c: string) => Buffer.alloc(400, c.charCodeAt(0)).toString("base64");
    const open = (h: ReturnType<typeof harness>) => {
      h.caller("Okay.");
      h.begin();
      return h.handlers();
    };

    it("\"<\" then \"turn_end>\": none of the audio is sent and no line is recorded", async () => {
      const h = harness();
      const hs = open(h);
      const mediaBefore = h.media.length;
      hs.onAgentTranscriptDelta("<");
      hs.onAudioDelta(chunk("a"));
      hs.onAudioDelta(chunk("b"));
      expect(h.media.length).toBe(mediaBefore);
      hs.onAgentTranscriptDelta("turn_end>");
      hs.onAudioDelta(chunk("c"));
      hs.onAudioDone("<turn_end>");
      await h.finish();
      expect(h.media.length).toBe(mediaBefore);
      h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
      await h.flush();
      expect(h.agentLines()).toEqual([]);
      expect(h.records[0].providerMarkupCuts).toBe(1);
      expect(h.records[0].providerMarkupHeard).toBe(0);
    });

    it("\"</\" then \"silence>\" is held the same way", async () => {
      const h = harness();
      const hs = open(h);
      const mediaBefore = h.media.length;
      hs.onAgentTranscriptDelta(" </");
      hs.onAudioDelta(chunk("a"));
      hs.onAgentTranscriptDelta("silence>");
      hs.onAudioDone("</silence>");
      await h.finish();
      expect(h.media.length).toBe(mediaBefore);
    });

    it("a \"<\" the next delta shows is not a tag sends the held audio first, in order", async () => {
      const h = harness();
      const hs = open(h);
      const mediaBefore = h.media.length;
      hs.onAgentTranscriptDelta("<");
      hs.onAudioDelta(chunk("a"));
      hs.onAudioDelta(chunk("b"));
      hs.onAgentTranscriptDelta("3 minutes away.");
      expect(h.media.slice(mediaBefore)).toEqual([chunk("a"), chunk("b")]);
      hs.onAudioDelta(chunk("c"));
      hs.onAudioDone("<3 minutes away.");
      await h.finish();
      expect(h.media.slice(mediaBefore)).toEqual([chunk("a"), chunk("b"), chunk("c")]);
    });

    it("held audio is dropped when the completed transcript opens with markup", async () => {
      const h = harness();
      const hs = open(h);
      const mediaBefore = h.media.length;
      hs.onAgentTranscriptDelta("<");
      hs.onAudioDelta(chunk("a"));
      hs.onAudioDone("<end_of_call>");
      await h.finish();
      expect(h.media.length).toBe(mediaBefore);
      h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
      await h.flush();
      expect(h.agentLines()).toEqual([]);
    });

    it("held audio is sent when the completed transcript is not markup", async () => {
      const h = harness();
      const hs = open(h);
      const mediaBefore = h.media.length;
      hs.onAgentTranscriptDelta("<");
      hs.onAudioDelta(chunk("a"));
      hs.onAudioDone("<");
      await h.finish();
      expect(h.media.slice(mediaBefore)).toEqual([chunk("a")]);
    });

    it("a \"<\" after the agent's words holds nothing: such a line plays its audio whole", async () => {
      const h = harness();
      const hs = open(h);
      const mediaBefore = h.media.length;
      hs.onAgentTranscriptDelta("Okay. <");
      hs.onAudioDelta(chunk("a"));
      expect(h.media.slice(mediaBefore)).toEqual([chunk("a")]);
    });
  });

  it("a tool call written out as text is cut where it starts", async () => {
    const h = harness();
    h.caller("Can you check my appointment?");
    await h.respond({ deltas: ["Let me check. ", "<tool_call>lookup_schedule<arg_key>first_name</arg_key>"], done: "Let me check. <tool_call>lookup_schedule<arg_key>first_name</arg_key>" });
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.agentLines().slice(-1)[0]).toBe("AGENT: Let me check.");
  });

  it("a completed transcript that drops the tag but keeps the words after it does not bring back what was muted", async () => {
    // P2 on 35cba36: the wire's transcript overrode the cut already made on
    // the streamed text, so the muted words reached the line and the goodbye
    // check.
    const [, q, closing] = LEAD[0];
    const h = harness();
    await answeredThenClosing(h, q, closing);
    const before = h.session.requestResponse.mock.calls.length;
    await h.respond({
      deltas: [`${GOODBYE} `, "<silence />", " Is there anything else?"],
      done: `${GOODBYE} Is there anything else?`,
      tools: [[ANSWERED, { follow_up_owed: false }]],
    });
    expect(h.session.requestResponse.mock.calls.length).toBe(before);
    await h.end();
    expect(h.agentLines().slice(-1)[0]).toBe(`AGENT: ${GOODBYE}`);
    expect(h.records[0].goodbyeGraceHangup).toBe(true);
    expect(h.records[0].providerMarkupCuts).toBe(1);
  });

  it("an ordinary line is untouched", async () => {
    const h = harness();
    h.caller("What time do you open?");
    const mediaBefore = h.media.length;
    await h.respond({ deltas: ["We open at 8 AM, ", "and 2 < 3 is still true."] });
    expect(h.media.length).toBe(mediaBefore + 2);
    h.bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
    await h.flush();
    expect(h.agentLines().slice(-1)[0]).toBe("AGENT: We open at 8 AM, and 2 < 3 is still true.");
    expect(h.records[0].providerMarkupCuts).toBe(0);
  });
});

describe("providerMarkup", () => {
  it.each(["<", " < ", "</", "< /", "\t</ "])("%j may open a tag", (text) => {
    expect(providerMarkupMayOpen(text)).toBe(true);
  });

  it.each(["", "<t", "<turn_end>", "a <", "Okay. </", "<3", "< 3"])("%j is not waiting on a tag", (text) => {
    expect(providerMarkupMayOpen(text)).toBe(false);
  });

  it.each([
    ["<silence />", 0],
    ["Great, have a good day! <turn_end>", 24],
    ["Okay. </response_segment_0_already_spoken>", 6],
    ["< tool_call>", 0],
    ["<_x>", 0],
  ])("finds the tag in %j", (text, at) => {
    expect(providerMarkupIndex(text)).toBe(at);
  });

  it.each(["2 < 3", "a <3", "x <-y", "less than <", "We open at 8."])("finds no tag in %j", (text) => {
    expect(providerMarkupIndex(text)).toBe(-1);
    expect(withoutProviderMarkup(text)).toBe(text);
  });

  it("keeps the words before the first tag", () => {
    expect(withoutProviderMarkup("Great, have a good day! <silence /> more")).toBe("Great, have a good day!");
    expect(withoutProviderMarkup(ECHO_MARKUP)).toBe("");
  });
});
