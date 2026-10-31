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
import { clearTestCallsForTests, isTestCall, isTestLineNumber, markTestCall, TEST_TICKET_PREFIX } from "./testCalls";

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

describe("the tag and the on-call text", () => {
  const record = { callSid: SID, slug: "no-ivr", callerPhone: OPERATOR, dialedNumber: "+15555550999", direction: "inbound",
    startedAtMs: 0, endedAtMs: 1000, outcome: "caller_hangup", transcript: "", toolEvents: [] } as never;

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
