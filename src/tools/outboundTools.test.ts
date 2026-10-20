import { afterEach, describe, expect, it } from "vitest";
import { getTool } from "./registry";
import {
  CALL_OUTCOMES,
  END_CALL_TOOL_NAME,
  OPT_OUT_TOOL_NAME,
  RECORD_OUTCOME_TOOL_NAME,
  setOutboundToolStoreForTests,
} from "./outboundTools";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";

const INJECTED = {
  outbound_contact_id: "c1",
  outbound_phone: "+15555550111",
  outbound_campaign: "test-campaign",
};

function store() {
  const s = new FakeOutboundStore();
  s.addContact({ id: "c1", phone: "+15555550111", status: "calling" });
  setOutboundToolStoreForTests(s);
  return s;
}

afterEach(() => setOutboundToolStoreForTests(null));

describe("opt_out_of_calls", () => {
  it("puts the number on the do-not-contact list and settles the contact", async () => {
    const s = store();
    const r = await getTool(OPT_OUT_TOOL_NAME)!.handler({ ...INJECTED });
    expect(r.success).toBe(true);
    expect(s.dnc.get("5555550111")).toBe("voice:test-campaign");
    expect(s.contacts.get("c1")!.status).toBe("do_not_call");
    expect((r as { message: string }).message).toMatch(/won't receive these calls/);
  });

  it("stamps the list before anything else, so it lands even if settling fails", async () => {
    const s = store();
    s.settleContact = async () => {
      throw new Error("db blip");
    };
    await expect(getTool(OPT_OUT_TOOL_NAME)!.handler({ ...INJECTED })).rejects.toThrow("db blip");
    expect(s.dnc.has("5555550111")).toBe(true);
  });

  it("does nothing on a call that was not dialled", async () => {
    const s = store();
    const r = await getTool(OPT_OUT_TOOL_NAME)!.handler({});
    expect(r).toMatchObject({ success: false, error: "not_an_outbound_call" });
    expect(s.dnc.size).toBe(0);
  });

  it("asks the model for nothing — who the call is about is injected", () => {
    expect(getTool(OPT_OUT_TOOL_NAME)!.input_schema.properties).toEqual({});
  });
});

describe("record_call_outcome", () => {
  it.each(Object.entries(CALL_OUTCOMES))("records %s as %s", async (outcome, status) => {
    const s = store();
    const r = await getTool(RECORD_OUTCOME_TOOL_NAME)!.handler({ ...INJECTED, outcome });
    expect(r.success).toBe(true);
    expect(s.contacts.get("c1")!.status).toBe(status);
  });

  it("queues call_back_later for tomorrow and nothing else for a retry", async () => {
    const s = store();
    await getTool(RECORD_OUTCOME_TOOL_NAME)!.handler({ ...INJECTED, outcome: "call_back_later" });
    expect(s.contacts.get("c1")!.nextAttemptAt).not.toBeNull();
    await getTool(RECORD_OUTCOME_TOOL_NAME)!.handler({ ...INJECTED, outcome: "not_interested" });
    expect(s.contacts.get("c1")!.nextAttemptAt).toBeNull();
  });

  it("refuses an outcome it does not know", async () => {
    store();
    const r = await getTool(RECORD_OUTCOME_TOOL_NAME)!.handler({ ...INJECTED, outcome: "booked" });
    expect(r).toMatchObject({ success: false, error: "unknown_outcome" });
  });
});

describe("end_call", () => {
  it("succeeds on a dialled call, which is what lets the bridge hang up", async () => {
    store();
    expect(await getTool(END_CALL_TOOL_NAME)!.handler({ ...INJECTED })).toEqual({ success: true, ended: true });
  });

  it("refuses on any other call", async () => {
    expect(await getTool(END_CALL_TOOL_NAME)!.handler({})).toMatchObject({ success: false });
  });
});
