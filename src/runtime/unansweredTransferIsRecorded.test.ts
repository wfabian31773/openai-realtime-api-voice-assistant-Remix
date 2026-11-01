/**
 * v163, ticket 70166: an urgent after-hours transfer rang out. The fallback
 * ticket filed, but the only trace of the failed handoff on it was the
 * "URGENT TRANSFER NOT ANSWERED … was transferred" sentence. The settle now
 * hands the dial's own status and ring time to the fallback, and both ticket
 * payloads carry a fixed HANDOFF FAILED line. The old core passes no handoff
 * and its payload is unchanged.
 *
 * Synthetic caller only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTransfer } from "./runtimeTransfer";
import type { UrgentTransferAlerts } from "./urgentTransferAlerts";
import type { TransferTwilioOps } from "./warmTransfer";
import { escalationDetailsMap } from "../services/escalationStore";
import {
  handoffFailedLine,
  URGENT_TRANSFER_NOT_ANSWERED,
  urgentFallbackTicketParams,
  urgentRingOutBesideParams,
} from "../services/urgentTransferAlert";

const writes = vi.hoisted(() => ({ persistTransferOutcome: vi.fn(async () => true) }));
vi.mock("./callRecord", () => writes);

const ENV = {
  TWILIO_AUTH_TOKEN: "test-auth-token",
  TWILIO_ACCOUNT_SID: "ACxxx",
  TWILIO_PHONE_NUMBER: "+15550000000",
  HUMAN_AGENT_NUMBER: "+18185551234",
  URGENT_NOTIFICATION_NUMBER: "+15557770000",
};
const META = { callSid: "CAcaller163", callId: "CAcaller163", callerPhone: "+15551234567", dialedNumber: "+15559876543" };
const URGENT = {
  agentSlug: "no-ivr",
  callerType: "patient_urgent",
  reason: "Sudden curtain over one eye",
  patientFirstName: "Test",
  patientLastName: "Example",
  callbackNumber: "+15551112222",
};

afterEach(() => escalationDetailsMap.clear());

describe("the settle hands the failure to the urgent fallback", () => {
  it("passes NO_ANSWER and the ring time when nobody accepts", async () => {
    const tickets: Array<Parameters<UrgentTransferAlerts["fallbackTicket"]>[0]> = [];
    const ops: TransferTwilioOps = {
      createOfficeLeg: async () => ({ sid: "CAoffice163" }),
      redirectCallerToConference: async () => undefined,
      endCall: async () => undefined,
      redirectCallerToQueue: async () => undefined,
    };
    const t = createRuntimeTransfer({
      env: ENV, ops, domain: "runtime.example.test", log: () => undefined,
      urgentAlerts: { smsBeforeDial: () => undefined, fallbackTicket: (i) => void tickets.push(i) },
    });
    escalationDetailsMap.set(META.callId, URGENT);
    const outcome = t.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(t.pendingAccepts()).toBe(1));
    t.abandonFor(META.callSid);
    await expect(outcome).rejects.toThrow(/handoff_failed:NO_ANSWER/);

    expect(tickets).toHaveLength(1);
    expect(tickets[0].handoff?.status).toBe("NO_ANSWER");
    expect(typeof tickets[0].handoff?.ringSeconds).toBe("number");
  });
});

describe("the HANDOFF FAILED line on the ticket", () => {
  const base = { why: URGENT_TRANSFER_NOT_ANSWERED, dialTarget: ENV.HUMAN_AGENT_NUMBER, agentUsed: "no-ivr" };

  it("says the caller was not connected, with status and ring time, and carries no caller data", () => {
    const line = handoffFailedLine({ status: "NO_ANSWER", ringSeconds: 45 });
    expect(line).toBe("HANDOFF FAILED (NO_ANSWER, 45s after the dial started): the caller was NOT connected to the on-call provider.");
    expect(handoffFailedLine({ status: "FAILED" })).toBe("HANDOFF FAILED (FAILED): the caller was NOT connected to the on-call provider.");
  });

  it("is on the fallback ticket when the runtime supplies it", () => {
    const p = urgentFallbackTicketParams({ ...base, callSid: META.callSid, handoff: { status: "NO_ANSWER", ringSeconds: 45 } });
    expect(p.description).toContain("HANDOFF FAILED (NO_ANSWER, 45s");
    expect(p.priority).toBe("urgent");
    expect(p.departmentId).toBe(8);
  });

  it("is on the ring-out record filed beside an earlier request", () => {
    const p = urgentRingOutBesideParams({
      ...base, callSid: META.callSid, earlierTicket: "VA-EARLIER", handoff: { status: "DECLINED", ringSeconds: 12 },
    });
    expect(p.reasonForCalling).toContain("HANDOFF FAILED (DECLINED, 12s");
    expect(p.reasonForCalling.split("\n")[0]).toBe("Request Type: Urgent/Emergency Transfer");
  });

  it("is absent when the caller (the old core) passes no handoff — that payload is unchanged", () => {
    const p = urgentFallbackTicketParams({ ...base, callSid: META.callSid });
    expect(p.description).not.toContain("HANDOFF FAILED");
  });
});
