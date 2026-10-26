/**
 * VA-76222 / VA-76221 — the two after-hours defects, driven on the real agent.
 *
 *   1. A failed on-call transfer files an identifiable ticket (name, DOB, ANI),
 *      never "Unknown Caller" when we have the phone.
 *   2. A caller who declines details is still transferred.
 *   3. A spoken-name miss that the chart name corrects never produces "not found".
 *
 * Synthetic fixtures only. Nothing here is a real person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.OPENAI_API_KEY ||= "test-unused";

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({
    success: true,
    ticketNumber: "VA-TEST",
    message: "VA-TEST",
  })),
  lookupByPhone: vi.fn(async () => ({
    patientFound: false,
    upcomingAppointments: [],
    pastAppointments: [],
    totalAppointmentsFound: 0,
  })),
  lookupByNameAndDOB: vi.fn(async () => ({
    patientFound: false,
    upcomingAppointments: [],
    pastAppointments: [],
    totalAppointmentsFound: 0,
  })),
}));

vi.mock("../../server/db", () => ({ db: {} }));
vi.mock("../../server/storage", () => ({ storage: { updateCallLog: async () => undefined } }));
vi.mock("../services/syncAgentService", () => ({
  SyncAgentService: {
    submitSimplifiedTicket: (p: Record<string, unknown>) => h.submitSimplifiedTicket(p),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock("../services/scheduleLookupService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/scheduleLookupService")>();
  return {
    ...actual,
    scheduleLookupService: {
      lookupByPhone: (...a: unknown[]) => h.lookupByPhone(...(a as [])),
      lookupByNameAndDOB: (...a: unknown[]) => h.lookupByNameAndDOB(...(a as [])),
      formatContextForAgent: actual.scheduleLookupService.formatContextForAgent.bind(
        actual.scheduleLookupService,
      ),
    },
  };
});
vi.mock("../services/callerMemoryService", () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => "" },
}));

const { createNoIvrAgent } = await import("./noIvrAgent");
const { resetGateAttempts } = await import("../tools/gateAttempts");
const { escalationDetailsMap } = await import("../services/escalationStore");
const { urgentFallbackTicketParams } = await import("../services/urgentTransferAlert");
const { appWouldRefuseName } = await import("../services/standInName");
const { LOOKUP_UNSURE_SAY, payloadSaysNotFound } = await import("../tools/lookupUnsure");
const { URGENT_TRANSFER_NOT_ANSWERED } = await import("../services/urgentTransferAlert");

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

let n = 0x622;
const freshSid = () => `CA${(++n).toString(16).padStart(32, "0")}`;

const ANI = "+15551234567";
const FLASHES = {
  reason: "Caller reports flashes and a curtain over the left eye since this morning",
  caller_type: "patient_urgent_medical" as const,
  symptoms_summary: "flashes and a curtain over the left eye",
};
const VISION_LOSS = {
  reason: "Patient reports sudden vision loss in the left eye",
  caller_type: "patient_urgent_medical" as const,
  symptoms_summary: "sudden vision loss",
};
const CHART = {
  patientFound: true,
  patientName: "Dana Example",
  matchedBy: "phone" as const,
  upcomingAppointments: [],
  pastAppointments: [
    {
      date: "Monday, January 6, 2042",
      isoDate: "2042-01-06",
      dayOfWeek: "Monday",
      timeOfDay: "morning",
      location: "Example Vision Testville",
      provider: "Dr. Example",
      status: "Active",
    },
  ],
  totalAppointmentsFound: 1,
  lastLocationSeen: "Example Vision Testville",
  lastProviderSeen: "Dr. Example",
  lastVisitDate: "2042-01-06",
};

beforeEach(() => {
  resetGateAttempts();
  escalationDetailsMap.clear();
  h.submitSimplifiedTicket.mockClear();
  h.lookupByPhone.mockReset().mockResolvedValue({
    patientFound: false,
    upcomingAppointments: [],
    pastAppointments: [],
    totalAppointmentsFound: 0,
  } as any);
  h.lookupByNameAndDOB.mockReset().mockResolvedValue({
    patientFound: false,
    upcomingAppointments: [],
    pastAppointments: [],
    totalAppointmentsFound: 0,
  } as any);
});

describe("a failed transfer creates an identifiable ticket", () => {
  it("keeps the captured name, date of birth and ANI — never Unknown Caller", async () => {
    const callSid = freshSid();
    const callId = `call-${callSid}`;
    const handoff = vi.fn(async () => {
      throw new Error("on-call leg failed");
    });
    const agent = await createNoIvrAgent(handoff, { callId, callSid, callerPhone: ANI } as any);

    const r = await call(agent, "escalate_to_human", {
      ...FLASHES,
      patient_first_name: "Dana",
      patient_last_name: "Example",
      patient_dob: "January 4, 1958",
    });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Transfer failed/i);
    expect(handoff).toHaveBeenCalledTimes(1);

    const details = escalationDetailsMap.get(callId);
    expect(details?.patientFirstName).toBe("Dana");
    expect(details?.patientLastName).toBe("Example");
    expect(details?.patientDob).toBe("January 4, 1958");
    expect(details?.callbackNumber).toBe(ANI);

    const ticket = urgentFallbackTicketParams({
      why: URGENT_TRANSFER_NOT_ANSWERED,
      escalationDetails: details,
      callerId: ANI,
      callSid,
      agentUsed: "no-ivr",
    });
    expect(`${ticket.patientFirstName} ${ticket.patientLastName}`).toBe("Dana Example");
    expect(appWouldRefuseName(`${ticket.patientFirstName} ${ticket.patientLastName}`)).toBe(false);
    expect(ticket.patientPhone).toBe(ANI);
    expect(ticket.patientBirthMonth).toBe("01");
    expect(ticket.patientBirthDay).toBe("04");
    expect(ticket.patientBirthYear).toBe("1958");
    expect(JSON.stringify(ticket)).not.toMatch(/Unknown Caller/);
  });

  it("with no name but an ANI, the ticket is the stand-in — never Unknown Caller", () => {
    const ticket = urgentFallbackTicketParams({
      why: URGENT_TRANSFER_NOT_ANSWERED,
      escalationDetails: { reason: FLASHES.reason },
      callerId: ANI,
      callSid: freshSid(),
      agentUsed: "no-ivr",
    });
    expect(`${ticket.patientFirstName} ${ticket.patientLastName}`).toBe("Unnamed Caller");
    expect(appWouldRefuseName(`${ticket.patientFirstName} ${ticket.patientLastName}`)).toBe(false);
    expect(ticket.patientPhone).toBe(ANI);
    expect(JSON.stringify(ticket)).not.toMatch(/Unknown Caller/);
  });
});

describe("a caller who declines details is still transferred", () => {
  it("details_declined on the first call dials immediately", async () => {
    const callSid = freshSid();
    const handoff = vi.fn(async () => {});
    const agent = await createNoIvrAgent(handoff, {
      callId: `call-${callSid}`,
      callSid,
      callerPhone: ANI,
    } as any);

    const r = await call(agent, "escalate_to_human", { ...FLASHES, details_declined: true });
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(escalationDetailsMap.get(`call-${callSid}`)?.callbackNumber).toBe(ANI);
  });

  it("the one identity ask, then a second call with nothing, still dials", async () => {
    const callSid = freshSid();
    const handoff = vi.fn(async () => {});
    const agent = await createNoIvrAgent(handoff, {
      callId: `call-${callSid}`,
      callSid,
      callerPhone: ANI,
    } as any);

    vi.useFakeTimers();
    try {
      const ask = await call(agent, "escalate_to_human", FLASHES);
      expect(ask.success).toBe(false);
      expect(ask.need_identity).toBe(true);
      expect(String(ask.message)).toMatch(/Ask ONCE/);
      expect(handoff).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);

      const again = await call(agent, "escalate_to_human", FLASHES);
      expect(again.success).toBe(true);
      expect(handoff).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a batched sibling of the identity ask does not dial", async () => {
    const callSid = freshSid();
    const handoff = vi.fn(async () => {});
    const agent = await createNoIvrAgent(handoff, {
      callId: `call-${callSid}`,
      callSid,
      callerPhone: ANI,
    } as any);

    const first = await call(agent, "escalate_to_human", FLASHES);
    const sibling = await call(agent, "escalate_to_human", FLASHES);
    expect(first.need_identity).toBe(true);
    expect(sibling.need_identity).toBe(true);
    expect(handoff).not.toHaveBeenCalled();
  });

  it("a successful transfer's record ticket keeps the ANI even if the model sent another number", async () => {
    const callSid = freshSid();
    const handoff = vi.fn(async () => {});
    const agent = await createNoIvrAgent(handoff, {
      callId: `call-${callSid}`,
      callSid,
      callerPhone: ANI,
    } as any);

    const r = await call(agent, "escalate_to_human", {
      ...FLASHES,
      patient_first_name: "Dana",
      patient_last_name: "Example",
      patient_dob: "January 4, 1958",
      callback_number: "+15559990000",
    });
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(escalationDetailsMap.get(`call-${callSid}`)?.callbackNumber).toBe(ANI);
  });

  it("a 911-level emergency never waits on the ask", async () => {
    const callSid = freshSid();
    const handoff = vi.fn(async () => {});
    const agent = await createNoIvrAgent(handoff, {
      callId: `call-${callSid}`,
      callSid,
      callerPhone: ANI,
    } as any);

    const r = await call(agent, "escalate_to_human", VISION_LOSS);
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
  });
});

describe("a corrected schedule match never produces not-found", () => {
  it("re-runs with the chart name when the spoken last name missed", async () => {
    h.lookupByPhone.mockResolvedValue(CHART as any);
    h.lookupByNameAndDOB
      .mockResolvedValueOnce({
        patientFound: false,
        upcomingAppointments: [],
        pastAppointments: [],
        totalAppointmentsFound: 0,
      } as any)
      .mockResolvedValueOnce({
        ...CHART,
        matchedBy: "name_and_dob",
        identity: { unique: true, candidateCount: 1, candidates: [] },
      } as any);

    const agent = await createNoIvrAgent(async () => {}, {
      callId: "call-lookup",
      callSid: freshSid(),
      callerPhone: ANI,
    } as any);

    const r = await call(agent, "lookup_schedule", {
      first_name: "Dana",
      last_name: "Exampel",
      date_of_birth: "01/04/1958",
    });

    expect(h.lookupByNameAndDOB).toHaveBeenCalledTimes(2);
    const chartCall = h.lookupByNameAndDOB.mock.calls[1] as unknown as [string, string, string];
    expect(chartCall[0]).toBe("Dana");
    expect(chartCall[1]).toBe("Example");
    expect(r.found).toBe(true);
    expect(r.lastProviderSeen).toBe("Dr. Example");
    expect(payloadSaysNotFound(r)).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/not found/i);
  });

  it("an ambiguous chart-name retry is not treated as found", async () => {
    h.lookupByPhone.mockResolvedValue(CHART as any);
    h.lookupByNameAndDOB
      .mockResolvedValueOnce({
        patientFound: false,
        upcomingAppointments: [],
        pastAppointments: [],
        totalAppointmentsFound: 0,
      } as any)
      .mockResolvedValueOnce({
        ...CHART,
        matchedBy: "name_and_dob",
        identity: { unique: false, candidateCount: 2, candidates: [] },
      } as any);

    const agent = await createNoIvrAgent(async () => {}, {
      callId: "call-ambiguous",
      callSid: freshSid(),
      callerPhone: ANI,
    } as any);

    const r = await call(agent, "lookup_schedule", {
      first_name: "Dana",
      last_name: "Exampel",
      date_of_birth: "01/04/1958",
    });

    expect(r.found).toBe(false);
    expect(r.visit_history_on_file).toBe(true);
    expect(r.message).toBe(LOOKUP_UNSURE_SAY);
    expect(payloadSaysNotFound(r)).toBe(false);
  });

  it("when the chart still cannot confirm, the spoken line is the unsure wording", async () => {
    h.lookupByPhone.mockResolvedValue(CHART as any);
    const agent = await createNoIvrAgent(async () => {}, {
      callId: "call-unsure",
      callSid: freshSid(),
      callerPhone: ANI,
    } as any);

    const r = await call(agent, "lookup_schedule", {
      first_name: "Dana",
      last_name: "Exampel",
      date_of_birth: "01/04/1958",
    });

    expect(r.found).toBe(false);
    expect(r.visit_history_on_file).toBe(true);
    expect(r.message).toBe(LOOKUP_UNSURE_SAY);
    expect(payloadSaysNotFound(r)).toBe(false);
  });
});
