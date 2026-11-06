/**
 * A FILED CALL ENDS AFTER TWO MINUTES OF CALLER SILENCE — v183.
 *
 * Operator, 2026-11-06, approving the proposal: once a ticket is filed and
 * the caller has been silent for two minutes, say a sign-off and hang up.
 * v131 stands the silence ladder down for a caller we have heard, so nothing
 * ended those calls but the caller or the ten-minute ceiling.
 *
 * Corpus: live runtime `max_duration` calls 2026-10-23..11-05 (22). On 5 a
 * filing tool succeeded during the call and the caller then said nothing for
 * five to eight minutes before the ceiling (RESCUED below). On 3 more the
 * caller went quiet too, but their only ticket was filed by the teardown
 * filer AFTER the ceiling, so nothing was filed during the call and this
 * build leaves them as they were (NOT FILED DURING THE CALL). The rest were
 * still talking when the ceiling cut them and are out of scope.
 *
 * Driven against the real bridge with fake timers. Transcripts are synthetic
 * stand-ins; the call SIDs are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CALL_MS,
  FILED_SILENCE_MS,
  FILING_TOOL,
  SILENCE_PROMPT_MS,
  VoiceCallBridge,
  filedSilenceFromEnv,
  type BridgeSessionHandlers,
  type CallOutcome,
  type VoiceCallRecord,
} from "./mediaStreamBridge";
import { statusFor } from "./callRecord";
import { followUpEvent } from "./followUpTelemetry";

const FILED = '{"success":true,"ticket_number":"VA-79001"}';
const REFUSED = '{"success":false,"missingFields":["date_of_birth"]}';
const OPEN_TICKETS = '{"success":true,"has_open_tickets":true,"tickets":[{"ticket_number":"VA-70000"}]}';

function harness(opts: { slug?: string; outputs?: Record<string, string>; filedSilenceMs?: number } = {}) {
  let handlers!: BridgeSessionHandlers;
  let epoch = 0;
  let active = false;
  let mark = "";
  const records: VoiceCallRecord[] = [];
  const outcomes: CallOutcome[] = [];
  const outputs = opts.outputs ?? {};
  const session = {
    appendAudio: vi.fn(), cancelResponse: vi.fn(), sendToolResult: vi.fn(),
    requestResponse: vi.fn(), speakNatural: vi.fn(), speak: vi.fn(), close: vi.fn(),
    getResponseEpoch: () => epoch, isResponseActive: () => active, setSpokenLanguage: vi.fn(),
  };
  const bridge = new VoiceCallBridge({
    context: {
      callSid: "CA00000000000000000000000000000183", streamSid: "MZ-test",
      slug: opts.slug ?? "optical", callerPhone: "+15551234567", dialedNumber: "+15559876543",
    },
    agent: {
      instructions: "", tools: [], guardrails: [], toolNames: [], skipped: [],
      dispatch: vi.fn(async (name: string) => ({ ok: true, output: outputs[name] ?? '{"success":true}' })),
    } as never,
    createSession: (h: BridgeSessionHandlers) => { handlers = h; return session as never; },
    twilio: { sendFrame: (f: { event: string; mark?: { name: string } }) => { if (f.event === "mark" && f.mark) mark = f.mark.name; }, close: vi.fn() },
    onOutcome: (o: CallOutcome) => outcomes.push(o),
    persistCallRecord: async (r: VoiceCallRecord) => { records.push(r); },
    ...(opts.filedSilenceMs !== undefined ? { filedSilenceMs: opts.filedSilenceMs } : {}),
  } as never);
  /** One agent line the caller has finished hearing (the mark echo). */
  const say = (text: string) => {
    epoch++; active = true; handlers.onResponseStarted?.();
    handlers.onAgentTranscriptDelta(text);
    handlers.onAudioDelta(Buffer.alloc(800, 0x7f).toString("base64"));
    handlers.onAudioDone(text);
    active = false; handlers.onResponseDone();
    bridge.handleTwilioFrame({ event: "mark", streamSid: "MZ-test", mark: { name: mark } } as never);
  };
  /** A response that carries one tool call and no words; its follow-up is requested. */
  const tool = async (name: string) => {
    epoch++; active = true; handlers.onResponseStarted?.();
    handlers.onToolCall(`call-${epoch}`, name, {});
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    active = false; handlers.onResponseDone();
    await Promise.resolve();
  };
  const caller = (text: string) => handlers.onCallerTranscript(text);
  const emptyReply = () => { epoch++; handlers.onResponseStarted?.(); handlers.onResponseDone(); };
  const stop = () => bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" } as never);
  return { bridge, session, records, outcomes, say, tool, caller, emptyReply, stop };
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** A heard caller, a request filed by `filingTool`, the readback, then silence. */
async function filedThenSilent(slug: string, filingTool: string) {
  const h = harness({ slug, outputs: { [filingTool]: FILED, check_open_tickets: '{"success":true,"has_open_tickets":false}' } });
  h.say("Thank you for calling. How can I help you today?");
  h.caller("I need to follow up on my request.");
  await h.tool("check_open_tickets");
  await h.tool(filingTool);
  h.say("I've filed that for you as VA-79001. Is there anything else I can help you with?");
  return h;
}

const RESCUED: Array<[sid: string, slug: string, tool: string]> = [
  ["CA44cc950a5a3a834c3881bbe171889c89", "pcp", "create_pcp_task"],
  ["CAacd6dc415476b2105fc16ac11221c4fe", "optical", "file_optical_ticket"],
  ["CAcab0f70c9e19a39b387f4275eaa686c2", "tech", "file_tech_ticket"],
  ["CA02ad88524f4aaa2f6f7b5efc5cb98b24", "surgery", "file_surgery_ticket"],
  ["CAe2b0a77610d49652ceb23ed9150d4a7f", "optical", "file_optical_ticket"],
];

describe("RESCUED: a filing tool succeeded, then the heard caller said nothing", () => {
  it.each(RESCUED)("%s (%s) ends two minutes after the agent's last line, not at the ceiling", async (_sid, slug, tool) => {
    const h = await filedThenSilent(slug, tool);
    vi.advanceTimersByTime(FILED_SILENCE_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["filed_silence"]);
    const r = h.records[0];
    expect(r).toMatchObject({ outcome: "filed_silence", filedSilenceHangup: true, silenceStoodDown: true });
    expect(statusFor(r.outcome, r.transcript)).toBe("completed");
    const ev = followUpEvent(r);
    expect(ev?.data.filedSilenceHangup).toBe(true);
    expect(ev?.data.outcome).toBe("filed_silence");
    // Nothing was said by the runtime itself; the sign-off is the TwiML's.
    expect(h.session.speak).not.toHaveBeenCalled();
  });

  it("the two minutes is the default, and the queue lanes' and PCP's filing tools all count", () => {
    expect(FILED_SILENCE_MS).toBe(120_000);
    for (const name of ["file_optical_ticket", "file_surgery_ticket", "file_tech_ticket", "file_records_ticket",
      "create_ticket", "create_pcp_task", "handle_patient_medical_records_request"]) {
      expect(FILING_TOOL.test(name)).toBe(true);
    }
    for (const name of ["check_open_tickets", "lookup_patient", "classify_optical_request", "record_pcp_intake", "handoff_to_pcp"]) {
      expect(FILING_TOOL.test(name)).toBe(false);
    }
  });
});

describe("NOT FILED DURING THE CALL: the ticket came from the teardown filer, so the call runs as before", () => {
  // CA3d2dbf37c1e8dff5a4bf6e13aecf9ce0 and CA5cd767b276d06ee6cda8ffb2e22a511e
  // (pcp) and CAaea5a118d101a6899723eb1638599c57 (surgery): the caller went
  // quiet, no filing tool ran, and the ticket was created at the ceiling by
  // the floor or the sweep. CA2934ce30d26c006d6ed5e3567e7f4eb4 (tech, heard
  // once, no ticket) and CAab29753903115cedd689b1be7a7f1778 (pcp, still
  // talking at 548 s) are the same shape here.
  it.each([
    ["CA3d2dbf37c1e8dff5a4bf6e13aecf9ce0", "pcp"],
    ["CA5cd767b276d06ee6cda8ffb2e22a511e", "pcp"],
    ["CAaea5a118d101a6899723eb1638599c57", "surgery"],
    ["CA2934ce30d26c006d6ed5e3567e7f4eb4", "tech"],
    ["CAab29753903115cedd689b1be7a7f1778", "pcp"],
  ])("%s (%s) stays open to the ceiling", async (_sid, slug) => {
    const h = harness({ slug });
    h.say("Thank you for calling. How can I help you today?");
    h.caller("Hello?");
    h.say("I'm here. How can I help you today?");
    vi.advanceTimersByTime(DEFAULT_MAX_CALL_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["max_duration"]);
    expect(h.records[0].filedSilenceHangup).toBe(false);
  });

  it("a REFUSED filing does not count", async () => {
    const h = harness({ outputs: { file_optical_ticket: REFUSED } });
    h.say("How can I help you today?");
    h.caller("My glasses are ready?");
    await h.tool("file_optical_ticket");
    h.say("May I have your date of birth, starting with the month?");
    vi.advanceTimersByTime(FILED_SILENCE_MS * 2);
    expect(h.outcomes).toEqual([]);
  });

  it("finding an EXISTING open ticket does not count", async () => {
    const h = harness({ outputs: { check_open_tickets: OPEN_TICKETS } });
    h.say("How can I help you today?");
    h.caller("I'm checking on my request.");
    await h.tool("check_open_tickets");
    h.say("I see an open request, VA-70000. Is there anything else?");
    vi.advanceTimersByTime(FILED_SILENCE_MS * 2);
    expect(h.outcomes).toEqual([]);
  });
});

describe("the silence is the caller's, measured honestly", () => {
  it("the caller speaking restarts it: the call ends two minutes after the agent's NEXT line", async () => {
    const h = await filedThenSilent("optical", "file_optical_ticket");
    vi.advanceTimersByTime(90_000);
    h.caller("Sorry, one more thing — can they call my cell?");
    h.say("Of course. I've added that. Anything else?");
    vi.advanceTimersByTime(FILED_SILENCE_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["filed_silence"]);
  });

  it("the caller's words alone cancel it, before any agent reply", async () => {
    const h = await filedThenSilent("optical", "file_optical_ticket");
    vi.advanceTimersByTime(90_000);
    h.caller("Hold on, let me find my card.");
    // No agent turn yet. The deadline armed at the stand-down must not end
    // a call whose caller spoke thirty seconds ago.
    vi.advanceTimersByTime(FILED_SILENCE_MS - 90_000);
    expect(h.outcomes).toEqual([]);
  });

  it("the time in the ladder's window counts: the clock is armed for what is left of two minutes", async () => {
    const h = await filedThenSilent("tech", "file_tech_ticket");
    // At the stand-down, one caller window has already passed.
    vi.advanceTimersByTime(SILENCE_PROMPT_MS);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(FILED_SILENCE_MS - SILENCE_PROMPT_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["filed_silence"]);
  });

  it("a stalled agent is nudged first; the clock runs from the agent's answer", async () => {
    const h = harness({ outputs: { file_surgery_ticket: FILED } });
    h.say("How can I help you today?");
    h.caller("I need to move my surgery date.");
    await h.tool("file_surgery_ticket");
    h.say("I've filed that as VA-79001.");
    vi.advanceTimersByTime(SILENCE_PROMPT_MS);
    expect(h.session.requestResponse).toHaveBeenCalled();
    h.say("Is there anything else I can help you with?");
    vi.advanceTimersByTime(FILED_SILENCE_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["filed_silence"]);
  });

  it("a nudge answered with nothing stands down and still ends the call two minutes after the last line", async () => {
    const h = harness({ outputs: { create_pcp_task: FILED }, slug: "pcp" });
    h.say("How can I help you today?");
    h.caller("Calling about a referral.");
    await h.tool("create_pcp_task");
    h.say("Your request is logged.");
    vi.advanceTimersByTime(SILENCE_PROMPT_MS);
    expect(h.session.requestResponse).toHaveBeenCalled();
    h.emptyReply();
    vi.advanceTimersByTime(FILED_SILENCE_MS - SILENCE_PROMPT_MS - 1);
    expect(h.outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.outcomes).toEqual(["filed_silence"]);
  });

  it("a caller mid-sentence when the clock runs out is not cut off", async () => {
    const h = await filedThenSilent("optical", "file_optical_ticket");
    vi.advanceTimersByTime(FILED_SILENCE_MS - 1_000);
    (h.bridge as unknown as { handleCallerSpeechStarted(): void }).handleCallerSpeechStarted();
    vi.advanceTimersByTime(1_000);
    expect(h.outcomes).toEqual([]);
  });

  it("an agent turn starting cancels it", async () => {
    const h = await filedThenSilent("optical", "file_optical_ticket");
    vi.advanceTimersByTime(60_000);
    // The model begins a response on its own; nothing ends the call under it.
    (h.bridge as unknown as { handleResponseStarted(): void }).handleResponseStarted();
    vi.advanceTimersByTime(FILED_SILENCE_MS);
    expect(h.outcomes).toEqual([]);
  });

  it("a call that ends another way records filedSilenceHangup false", async () => {
    const h = await filedThenSilent("optical", "file_optical_ticket");
    vi.advanceTimersByTime(30_000);
    await h.stop();
    expect(h.outcomes).toEqual(["caller_hangup"]);
    expect(h.records[0].filedSilenceHangup).toBe(false);
    vi.advanceTimersByTime(FILED_SILENCE_MS);
    expect(h.outcomes).toEqual(["caller_hangup"]);
  });
});

describe("the after-number", () => {
  it("a filed-silence ending writes its follow-up row even on a call that owed nothing else", () => {
    const ev = followUpEvent({ outcome: "filed_silence", filedSilenceHangup: true } as never);
    expect(ev).not.toBeNull();
    expect(ev?.data.filedSilenceHangup).toBe(true);
    expect(ev?.level).toBe("info");
  });
});

describe("the lever", () => {
  it("0 switches it off: a filed silent call runs to the ceiling as before", async () => {
    const h = harness({ outputs: { file_optical_ticket: FILED }, filedSilenceMs: 0 });
    h.say("How can I help you today?");
    h.caller("Checking on my glasses.");
    await h.tool("file_optical_ticket");
    h.say("Filed as VA-79001. Anything else?");
    vi.advanceTimersByTime(DEFAULT_MAX_CALL_MS);
    expect(h.outcomes).toEqual(["max_duration"]);
  });

  it("reads RUNTIME_FILED_SILENCE_MS: unset is two minutes, 0 is off, others are clamped to 30 s–9 min", () => {
    expect(filedSilenceFromEnv(undefined)).toBe(120_000);
    expect(filedSilenceFromEnv("")).toBe(120_000);
    expect(filedSilenceFromEnv("0")).toBe(0);
    expect(filedSilenceFromEnv("abc")).toBe(120_000);
    expect(filedSilenceFromEnv("5000")).toBe(30_000);
    expect(filedSilenceFromEnv("180000")).toBe(180_000);
    expect(filedSilenceFromEnv("9999999")).toBe(540_000);
  });
});
