/**
 * THE AFTER-HOURS HEADS-UP TEXT AND ITS SAFETY NET, ON THE RUNTIME.
 *
 * The corpus is CA3a8fd9cc0f2f79eae30f5785ceba6d22 (2026-10-02 00:15 UTC): the
 * first urgent escalation the runtime dialled after the after-hours line moved
 * here. The on-call phone rang for 40 seconds with no text in front of it, the
 * dial rang out, and the request left no ticket of any provenance. Operator:
 * "I need those alert sms to let me know who is calling and why."
 *
 * Synthetic caller only — no real name, number or reason is reproduced here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTransfer } from "./runtimeTransfer";
import { defaultUrgentTransferAlerts, type UrgentTransferAlerts } from "./urgentTransferAlerts";
import { ACCEPT_WINDOW_MS, type TransferTwilioOps } from "./warmTransfer";
import { escalationDetailsMap } from "../services/escalationStore";
import {
  buildUrgentTransferSms,
  URGENT_TRANSFER_NOT_ANSWERED,
  urgentFallbackTicketParams,
} from "../services/urgentTransferAlert";

const writes = vi.hoisted(() => ({ persistTransferOutcome: vi.fn(async () => true) }));
vi.mock("./callRecord", () => writes);

const ENV = {
  TWILIO_AUTH_TOKEN: "test-auth-token",
  TWILIO_ACCOUNT_SID: "ACxxx",
  TWILIO_PHONE_NUMBER: "+15550000000",
  HUMAN_AGENT_NUMBER: "+18185551234",
  PCP_HUMAN_AGENT_NUMBER: "+17149564300",
  URGENT_NOTIFICATION_NUMBER: "+15557770000",
};

const META = {
  callSid: "CAcaller",
  callId: "CAcaller",
  callerPhone: "+15551234567",
  dialedNumber: "+15559876543",
};

const URGENT = {
  agentSlug: "no-ivr",
  callerType: "patient_urgent",
  reason: "Sudden curtain over the left eye",
  patientFirstName: "Test",
  patientLastName: "Caller",
  callbackNumber: "+15551112222",
};

afterEach(() => {
  escalationDetailsMap.clear();
  vi.useRealTimers();
});

/** Records the order of everything that touches the outside world. */
function harness() {
  const events: string[] = [];
  const sms: Array<{ callerNumber?: string; reason?: string; firstName?: string }> = [];
  const tickets: Array<Parameters<UrgentTransferAlerts["fallbackTicket"]>[0]> = [];
  const ops: TransferTwilioOps = {
    createOfficeLeg: async () => {
      events.push("dial");
      return { sid: "CAoffice" };
    },
    redirectCallerToConference: async () => void events.push("redirect"),
    endCall: async () => void events.push("end"),
    redirectCallerToQueue: async () => void events.push("queue"),
  };
  const urgentAlerts: UrgentTransferAlerts = {
    smsBeforeDial: (input) => {
      events.push("sms");
      sms.push({
        callerNumber: input.callerNumber,
        reason: input.escalationDetails?.reason,
        firstName: input.escalationDetails?.patientFirstName,
      });
    },
    fallbackTicket: (input) => {
      events.push("ticket");
      tickets.push(input);
    },
  };
  const transfer = (env: Record<string, string | undefined> = ENV) =>
    createRuntimeTransfer({ env, ops, domain: "runtime.example.test", log: () => undefined, urgentAlerts });
  return { events, sms, tickets, transfer };
}

describe("the heads-up text goes out BEFORE the on-call phone rings", () => {
  it("texts who is calling and why, then dials — the order the operator relies on", async () => {
    const { events, sms, transfer } = harness();
    const t = transfer();
    escalationDetailsMap.set("CAcaller", URGENT);

    const outcome = t.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(t.pendingAccepts()).toBe(1));

    expect(events.slice(0, 2)).toEqual(["sms", "dial"]);
    expect(sms).toEqual([{ callerNumber: META.callerPhone, reason: URGENT.reason, firstName: "Test" }]);

    t.abandonFor("CAcaller");
    await expect(outcome).rejects.toThrow(/handoff_failed/);
  });

  it("sends nothing when the policy refuses the dial — no phone is about to ring", async () => {
    const { events, transfer } = harness();
    const t = transfer();
    // No escalation on the side channel: the clinical branch refuses.
    await expect(t.handoffFor("no-ivr", META)()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    expect(events).toEqual([]);
  });

  it("sends nothing for PCP, whose professional callers go to a call centre", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-30T17:00:00Z"), toFake: ["Date"] });
    const { events, transfer } = harness();
    const t = transfer({ ...ENV, RUNTIME_TRANSFER_MODE: "warm" });
    escalationDetailsMap.set("CAcaller", {
      agentSlug: "pcp",
      callerType: "medical_office",
      callerRequestedHuman: true,
      reason: "Clinic asking for the team",
    });
    const outcome = t.handoffFor("pcp", META)();
    await vi.waitFor(() => expect(t.pendingAccepts()).toBe(1));
    expect(events).not.toContain("sms");
    t.abandonFor("CAcaller");
    await outcome;
  });
});

describe("a transfer that rang and was not taken files the urgent ticket", () => {
  it("files it with the escalation the agent recorded — the corpus call's missing ticket", async () => {
    const { tickets, transfer } = harness();
    const t = transfer();
    escalationDetailsMap.set("CAcaller", URGENT);

    const outcome = t.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(t.pendingAccepts()).toBe(1));
    // The caller hangs up while it rings, as on the corpus call.
    t.abandonFor("CAcaller");
    await expect(outcome).rejects.toThrow(/handoff_failed/);

    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      callSid: "CAcaller",
      callerNumber: META.callerPhone,
      dialTarget: ENV.HUMAN_AGENT_NUMBER,
      agentUsed: "no-ivr",
    });
    // Read BEFORE the attempt's finally cleared the side channel.
    expect(tickets[0].escalationDetails?.reason).toBe(URGENT.reason);
  });

  it("files nothing when a human took the call", async () => {
    const { tickets, transfer } = harness();
    const t = transfer();
    escalationDetailsMap.set("CAcaller", URGENT);
    const outcome = t.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(t.pendingAccepts()).toBe(1));
    const { default: twilio } = await import("twilio");
    const body = { CallSid: "CAoffice", Digits: "1" };
    t.handleAccept({
      headers: {
        host: "runtime.example.test",
        "x-forwarded-proto": "https",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          ENV.TWILIO_AUTH_TOKEN,
          "https://runtime.example.test/voice/transfer-accept",
          body,
        ),
      },
      body,
      originalUrl: "/voice/transfer-accept",
    });
    await outcome;
    expect(tickets).toEqual([]);
  });

  it("files nothing when the policy refused — nothing rang", async () => {
    const { tickets, transfer } = harness();
    await expect(transfer().handoffFor("no-ivr", META)()).rejects.toThrow(/UNAVAILABLE/);
    expect(tickets).toEqual([]);
  });

  it("files nothing for PCP, which files its own structured ticket before dialling", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-30T17:00:00Z"), toFake: ["Date"] });
    const { tickets, transfer } = harness();
    const t = transfer({ ...ENV, RUNTIME_TRANSFER_MODE: "warm" });
    escalationDetailsMap.set("CAcaller", {
      agentSlug: "pcp",
      callerType: "medical_office",
      callerRequestedHuman: true,
      reason: "Clinic asking for the team",
    });
    const outcome = t.handoffFor("pcp", META)();
    await vi.waitFor(() => expect(t.pendingAccepts()).toBe(1));
    t.abandonFor("CAcaller");
    await outcome;
    expect(tickets).toEqual([]);
  });
});

describe("the sender the runtime uses in production", () => {
  it("texts URGENT_NOTIFICATION_NUMBER from the practice number, in the old core's words", async () => {
    const created: Array<{ body: string; from: string; to: string }> = [];
    const alerts = defaultUrgentTransferAlerts(ENV, () => undefined, {
      smsClient: async () => ({ messages: { create: async (m) => void created.push(m) } }),
      now: () => new Date("2026-10-02T00:15:00Z"),
    });
    alerts.smsBeforeDial({ callerNumber: META.callerPhone, escalationDetails: URGENT });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].to).toBe(ENV.URGENT_NOTIFICATION_NUMBER);
    expect(created[0].from).toBe(ENV.TWILIO_PHONE_NUMBER);
    expect(created[0].body).toBe(
      buildUrgentTransferSms({ callerNumber: META.callerPhone, escalationDetails: URGENT }, "5:15 PM"),
    );
    expect(created[0].body).toContain("📞 INCOMING TRANSFER - 5:15 PM");
    expect(created[0].body).toContain(`From: ${META.callerPhone}`);
    expect(created[0].body).toContain(`Reason: ${URGENT.reason}`);
  });

  it("says it skipped, and sends nothing, when the recipient is not configured", async () => {
    const lines: string[] = [];
    const create = vi.fn();
    const alerts = defaultUrgentTransferAlerts(
      { ...ENV, URGENT_NOTIFICATION_NUMBER: undefined },
      (l) => lines.push(l),
      { smsClient: async () => ({ messages: { create } }) },
    );
    alerts.smsBeforeDial({ callerNumber: META.callerPhone, escalationDetails: URGENT });
    await new Promise((r) => setTimeout(r, 0));
    expect(create).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/urgent SMS skipped/);
  });

  it("never throws into the dial when the text fails", async () => {
    const lines: string[] = [];
    const alerts = defaultUrgentTransferAlerts(ENV, (l) => lines.push(l), {
      smsClient: async () => ({
        messages: {
          create: async () => {
            throw new Error("carrier down");
          },
        },
      }),
    });
    expect(() => alerts.smsBeforeDial({ callerNumber: META.callerPhone })).not.toThrow();
    await vi.waitFor(() => expect(lines.join("\n")).toMatch(/urgent SMS failed/));
  });

  it("files the old core's urgent After Hours ticket", async () => {
    const filed: Array<ReturnType<typeof urgentFallbackTicketParams>> = [];
    const alerts = defaultUrgentTransferAlerts(ENV, () => undefined, {
      createTicket: async (p) => {
        filed.push(p);
        return { success: true, ticketNumber: "VA-1" };
      },
    });
    alerts.fallbackTicket({
      callSid: "CAcaller",
      callerNumber: META.callerPhone,
      escalationDetails: URGENT,
      why: URGENT_TRANSFER_NOT_ANSWERED,
      dialTarget: ENV.HUMAN_AGENT_NUMBER,
      agentUsed: "no-ivr",
    });
    await vi.waitFor(() => expect(filed).toHaveLength(1));
    // After Hours is department 8 in the Support Center. The config constant
    // of the same name is 3 (Technicians Support), and until v89 this ticket
    // went there with a retinal-surgery request type — see urgentTransferAlert.ts.
    expect(filed[0]).toMatchObject({
      departmentId: 8,
      requestTypeId: 34,
      requestReasonId: 159,
      priority: "urgent",
      patientFirstName: "Test",
      patientPhone: URGENT.callbackNumber,
      callData: { callSid: "CAcaller", callerPhone: META.callerPhone, agentUsed: "no-ivr" },
    });
    expect(filed[0].description).toContain(URGENT_TRANSFER_NOT_ANSWERED);
    expect(filed[0].description).toContain("Please call the patient back immediately.");
  });
});

describe("one copy of the words, read by both pipelines", () => {
  const routes = readFileSync(join(__dirname, "..", "voiceAgentRoutes.ts"), "utf8");

  it("the old core builds its text and its ticket from the shared module", () => {
    expect(routes).toMatch(/buildUrgentTransferSms\(opts, urgentAlertTime\(\)\)/);
    expect(routes).toMatch(/urgentFallbackTicketParams\(\{/);
  });

  it("no inline copy of the text survives in the old core", () => {
    // Comment lines may quote the text (the old core's own history does);
    // a second copy is CODE that builds it.
    const code = routes
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toContain("📞 INCOMING TRANSFER");
    expect(code).not.toContain("Please call the patient back immediately.");
  });

  it("the accept window the warm path waits is still the bound — the text is not part of it", () => {
    // The text is fire-and-forget: nothing in the attempt awaits it.
    const src = readFileSync(join(__dirname, "runtimeTransfer.ts"), "utf8");
    expect(src).toMatch(/urgentAlerts\.smsBeforeDial\(/);
    expect(src).not.toMatch(/await\s+urgentAlerts\./);
    expect(ACCEPT_WINDOW_MS).toBeGreaterThan(0);
  });
});
