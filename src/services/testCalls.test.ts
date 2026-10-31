/**
 * TEST CALLS FILE NOTHING (v159). VA-79092: the operator line dialled one of
 * our own inbound lines and the agent filed a real ticket under "Unnamed". The
 * client is what reaches the ticketing app, and the app is what texts callers,
 * so the assertions are on the client with only the network faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:5432/unused";
  process.env.OPENAI_API_KEY ||= "synthetic-key";
});
import { ticketingApiClient } from "../../server/services/ticketingApiClient";
import { toCallLogRow } from "../runtime/callRecord";
import { defaultUrgentTransferAlerts } from "../runtime/urgentTransferAlerts";
import { readFileSync } from "node:fs";
import { clearTestCallsForTests, isTestCall, isTestLineNumber, markSipTestCall, markTestCall, TEST_TICKET_PREFIX } from "./testCalls";

const OPERATOR = "+15555550100";
const TEST_LINE = "+15555550177";
const PATIENT = "+15555550123";
const SID = `CA${"c".repeat(32)}`;
const fetchSpy = vi.fn();

beforeEach(() => {
  process.env.OPERATOR_LINE_FROM_NUMBER = OPERATOR;
  process.env.VOICE_TEST_LINE_NUMBERS = ` ${TEST_LINE} , `;
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  clearTestCallsForTests();
});
afterEach(() => {
  delete process.env.OPERATOR_LINE_FROM_NUMBER;
  delete process.env.VOICE_TEST_LINE_NUMBERS;
  vi.unstubAllGlobals();
});

describe("what counts as a test call", () => {
  it("the operator line or a configured test line, on either end, in any format", () => {
    expect(isTestCall({ callerPhone: OPERATOR, dialedNumber: "+15555550999" })).toBe(true);
    expect(isTestCall({ callerPhone: PATIENT, dialedNumber: OPERATOR })).toBe(true);
    expect(isTestCall({ callerPhone: "(555) 555-0177" })).toBe(true);
  });

  it("nobody else, and nothing when unconfigured", () => {
    expect(isTestCall({ callerPhone: PATIENT, dialedNumber: "+15555550999" })).toBe(false);
    expect(isTestLineNumber("anonymous")).toBe(false);
    expect(isTestLineNumber("")).toBe(false);
    delete process.env.OPERATOR_LINE_FROM_NUMBER;
    delete process.env.VOICE_TEST_LINE_NUMBERS;
    expect(isTestCall({ callerPhone: OPERATOR })).toBe(false);
  });

  it("does not read an international number as the US number with the same ten digits", () => {
    const env = { OPERATOR_LINE_FROM_NUMBER: "+14582345678" };
    expect(isTestLineNumber("+4582345678", env)).toBe(false);
    expect(isTestLineNumber("+45 82 34 56 78", env)).toBe(false);
    expect(isTestLineNumber("+14582345678", env)).toBe(true);
    expect(isTestLineNumber("4582345678", env)).toBe(true);
    expect(isTestLineNumber("+4582345678", { OPERATOR_LINE_FROM_NUMBER: "+4582345678" })).toBe(true);
  });

  it("the shared Twilio number never counts where it may be substituted, even if listed", () => {
    const env = { OPERATOR_LINE_FROM_NUMBER: OPERATOR, TWILIO_PHONE_NUMBER: OPERATOR };
    expect(isTestLineNumber(OPERATOR, env)).toBe(false);
    expect(isTestCall({ callerPhone: PATIENT, dialedNumber: OPERATOR }, env)).toBe(false);
    expect(isTestCall({ callerPhone: OPERATOR }, env)).toBe(false);
  });

  it("the operator line counts as the trusted caller even when it is the shared Twilio number", () => {
    const env = { OPERATOR_LINE_FROM_NUMBER: OPERATOR, TWILIO_PHONE_NUMBER: OPERATOR };
    expect(isTestCall({ trustedCallerPhone: OPERATOR, dialedNumber: "+15555550999" }, env)).toBe(true);
    expect(isTestCall({ trustedCallerPhone: PATIENT, dialedNumber: OPERATOR }, env)).toBe(false);
    expect(markSipTestCall({ callSid: SID, xCallerPhone: OPERATOR, dialedNumber: "+15555550999" }, env)).toBe(true);
    clearTestCallsForTests();
    expect(markSipTestCall({ callSid: SID, xCallerPhone: PATIENT, dialedNumber: OPERATOR }, env)).toBe(false);
  });

  it("a marked CallSid counts with no numbers at hand, as the tools have", () => {
    expect(isTestCall({ callSid: SID })).toBe(false);
    markTestCall(SID);
    expect(isTestCall({ callSid: SID })).toBe(true);
  });
});

describe("a test call never reaches the ticketing app", () => {
  const ticket = { departmentId: 3, patientFirstName: "Unnamed", patientLastName: "Caller", patientPhone: OPERATOR, reasonForCalling: "test" } as never;

  it("createTicket answers a test number and posts nothing", async () => {
    const res = await ticketingApiClient.createTicket({ ...(ticket as object), callData: { callSid: SID, callerPhone: OPERATOR } } as never);
    expect(res.success).toBe(true);
    expect(res.ticketNumber?.startsWith(TEST_TICKET_PREFIX)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a marked call is suppressed with no numbers on the payload, as the teardown sweep sends", async () => {
    markTestCall(SID);
    expect((await ticketingApiClient.createTicket({ ...(ticket as object), callData: { callSid: SID } } as never)).success).toBe(true);
    expect((await ticketingApiClient.submitTicket({ patientFullName: "Unnamed Caller", callData: { callSid: SID } } as never)).success).toBe(true);
    expect((await ticketingApiClient.createPcpTicket({ callSid: SID } as never)).success).toBe(true);
    expect((await ticketingApiClient.createLocationQueueTicket({ locationName: "x", defaultLocationName: "x", body: {}, callSid: SID })).ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the records link, which the app would text, is not sent", async () => {
    markTestCall(SID);
    expect((await ticketingApiClient.sendRecordsIntakeLink({ callSid: SID, channel: "sms" })).success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the post-call sync stamps nothing", async () => {
    expect((await ticketingApiClient.updateTicketCallData({ ticketNumber: `${TEST_TICKET_PREFIX}ABC`, callSid: "CAother" } as never)).success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a real caller still reaches the app", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true, ticketNumber: "VA-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    process.env.TICKETING_SYSTEM_URL = "https://ticketing.example";
    process.env.TICKETING_API_KEY = "synthetic";
    await ticketingApiClient.createTicket({ ...(ticket as object), patientPhone: PATIENT, callData: { callSid: `CA${"d".repeat(32)}`, callerPhone: PATIENT } } as never).catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("the SIP path, whose filing tools hand over only a CallSid", () => {
  const posted = async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ success: true, ticketNumber: "PCP-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    process.env.TICKETING_SYSTEM_URL = "https://ticketing.example";
    process.env.TICKETING_API_KEY = "synthetic";
    await ticketingApiClient.createPcpTicket({ callSid: SID } as never).catch(() => undefined);
    return fetchSpy.mock.calls.length > 0;
  };

  it("a test number on X-CallerPhone or the dialled mapping suppresses the CallSid-only filing", async () => {
    expect(markSipTestCall({ callSid: SID, xCallerPhone: OPERATOR, dialedNumber: "+15555550999" })).toBe(true);
    expect(await posted()).toBe(false);
    clearTestCallsForTests();
    expect(markSipTestCall({ callSid: SID, xCallerPhone: PATIENT, dialedNumber: TEST_LINE })).toBe(true);
    expect(await posted()).toBe(false);
  });

  it("a real caller on a real line is not marked and still files", async () => {
    expect(markSipTestCall({ callSid: SID, xCallerPhone: PATIENT, dialedNumber: "+15555550999" })).toBe(false);
    expect(await posted()).toBe(true);
  });

  it("no CallSid, or missing numbers, marks nothing", () => {
    expect(markSipTestCall({ callSid: undefined, xCallerPhone: OPERATOR })).toBe(false);
    expect(markSipTestCall({ callSid: SID })).toBe(false);
    expect(isTestCall({ callSid: SID })).toBe(false);
  });

  it("the webhook marks from X-CallerPhone and the mapping, before the session, and tags the row", () => {
    const src = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");
    expect(src).toContain("markSipTestCall({ callSid: twilioCallSidFromSIP, xCallerPhone, dialedNumber: realDialedNumber })");
    expect(src.indexOf("markSipTestCall({")).toBeLessThan(src.indexOf("const extendedMetadata = {"));
    // Only the header: the From fallback carries Twilio's number on a real call.
    expect(src).toMatch(/callerPhoneNumber = decodeURIComponent\(callerPhoneHeader\.value\);\s+xCallerPhone = callerPhoneNumber;/);
    expect(src.match(/xCallerPhone = /g)).toHaveLength(1);
    expect(src).toContain("environment: isTestCall({ callSid: twilioCallSid }) ? TEST_CALL_ENVIRONMENT : environment");
  });
});

describe("the tag and the on-call text", () => {
  const record = { callSid: SID, slug: "no-ivr", callerPhone: OPERATOR, dialedNumber: "+15555550999", direction: "inbound",
    startedAtMs: 0, endedAtMs: 1000, outcome: "caller_hangup", transcript: "", toolEvents: [] } as never;

  it("the SIP on-call text reads the test mark on both the handoff and the recovery path", () => {
    const src = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");
    expect(src).toContain("isTestCall({ callSid: opts.callSid, callerPhone: opts.callerNumber })");
    const sends = src.split("sendUrgentTransferSms({").slice(1);
    expect(sends).toHaveLength(2);
    for (const send of sends) expect(send.slice(0, 80)).toContain("callSid: sipCallSidOf(conferenceName)");
  });

  it("tags the operator's call on the shared Twilio number, and the runtime marks it", () => {
    const env = { OPERATOR_LINE_FROM_NUMBER: OPERATOR, TWILIO_PHONE_NUMBER: OPERATOR, APP_ENV: "production" };
    expect(toCallLogRow(record, {}, env).environment).toBe("test");
    const src = readFileSync(new URL("../runtime/voiceRuntime.ts", import.meta.url), "utf8");
    expect(src).toContain("isTestCall({ trustedCallerPhone: entry.callerPhone, dialedNumber: entry.dialedNumber }, env)");
  });

  it("tags the call row in the existing environment column", () => {
    expect(toCallLogRow(record, {}, { OPERATOR_LINE_FROM_NUMBER: OPERATOR, APP_ENV: "production" }).environment).toBe("test");
    expect(toCallLogRow(record, {}, { APP_ENV: "production" }).environment).toBe("production");
  });

  it("does not text the on-call phone", async () => {
    const create = vi.fn().mockResolvedValue({});
    const alerts = defaultUrgentTransferAlerts(
      { URGENT_NOTIFICATION_NUMBER: "+15555550111", TWILIO_PHONE_NUMBER: "+15555550222", OPERATOR_LINE_FROM_NUMBER: OPERATOR },
      () => undefined,
      { smsClient: async () => ({ messages: { create } }) } as never,
    );
    alerts.smsBeforeDial({ callSid: SID, callerNumber: OPERATOR });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
    alerts.smsBeforeDial({ callSid: `CA${"d".repeat(32)}`, callerNumber: PATIENT });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).toHaveBeenCalledOnce();
  });
});
