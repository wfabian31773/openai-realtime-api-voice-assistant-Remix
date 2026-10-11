/**
 * THE PRODUCTION DEFAULTS BEHIND THE RING-OUT RECORD.
 *
 * `urgentTransferAlerts.test.ts` drives the decision with injected seams. This
 * file runs the sender with NONE of them injected, so the defaults the runtime
 * actually mounts are what decide: the call's ticket is read off `call_logs`,
 * a held ticket sends the record through `submitSimplifiedTicket`, and no held
 * ticket keeps `createTicket`. A seam that defaulted to a no-op would pass
 * every test in the other file and file nothing in production.
 *
 * Synthetic caller only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  ticketNumber: undefined as string | undefined,
  read: vi.fn(),
}));
vi.mock("../../server/storage", () => ({
  storage: {
    getCallLogBySid: async (sid: string) => {
      store.read(sid);
      return { callSid: sid, ticketNumber: store.ticketNumber ?? null };
    },
  },
}));

const sink = vi.hoisted(() => ({
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: "VA-OWN", message: "VA-OWN" })),
  submitSimplifiedTicket: vi.fn(async (_params: Record<string, unknown>) => ({
    success: true,
    ticketNumber: "VA-BESIDE",
    message: "VA-BESIDE",
  })),
}));
vi.mock("../services/syncAgentService", () => ({ SyncAgentService: sink }));

import { defaultUrgentTransferAlerts } from "./urgentTransferAlerts";
import { URGENT_TRANSFER_NOT_ANSWERED } from "../services/urgentTransferAlert";

const RING_OUT = {
  callSid: "CAcaller",
  callerNumber: "+15551234567",
  why: URGENT_TRANSFER_NOT_ANSWERED,
  dialTarget: "+18185551234",
  agentUsed: "no-ivr",
  escalationDetails: { reason: "Sudden curtain over the left eye", callbackNumber: "+15551112222" },
};

afterEach(() => {
  store.ticketNumber = undefined;
  store.read.mockClear();
  sink.createTicket.mockClear();
  sink.submitSimplifiedTicket.mockClear();
});

describe("the ring-out record, with the runtime's own defaults", () => {
  it("reads this call's ticket off call_logs and files beside it when one is held", async () => {
    store.ticketNumber = "VA-70441";
    const lines: string[] = [];
    defaultUrgentTransferAlerts({}, (l) => lines.push(l)).fallbackTicket(RING_OUT);
    await vi.waitFor(() => expect(sink.submitSimplifiedTicket).toHaveBeenCalledTimes(1));

    expect(store.read).toHaveBeenCalledWith("CAcaller");
    expect(sink.createTicket).not.toHaveBeenCalled();
    const params = sink.submitSimplifiedTicket.mock.calls[0][0];
    expect(params).toMatchObject({
      departmentId: 8,
      priority: "urgent",
      secondTicketOnThisCall: { keySuffix: "urgent-ringout" },
    });
    await vi.waitFor(() => expect(lines.join("\n")).toContain("(beside VA-70441)"));
  });

  it("keeps the call's-own-ticket path when call_logs holds no ticket yet", async () => {
    defaultUrgentTransferAlerts({}, () => undefined).fallbackTicket(RING_OUT);
    await vi.waitFor(() => expect(sink.createTicket).toHaveBeenCalledTimes(1));
    expect(store.read).toHaveBeenCalledWith("CAcaller");
    expect(sink.submitSimplifiedTicket).not.toHaveBeenCalled();
  });
});
