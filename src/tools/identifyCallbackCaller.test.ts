/**
 * A RETURNED CALL'S TOOLS (v106): who rang us back, and what may be recorded
 * against them. RULE ZERO step 2 in code — the calling number makes the people
 * on it candidates, a name the caller gives picks one only when exactly one
 * person fits, and a caller on another phone is found by last name AND a date
 * of birth the campaign holds, never by name alone. Synthetic people only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTool } from "./registry";
import {
  END_CALL_TOOL_NAME,
  IDENTIFY_CALLBACK_TOOL_NAME,
  MAX_IDENTIFY_TRIES,
  OPT_OUT_TOOL_NAME,
  RECORD_OUTCOME_TOOL_NAME,
  callbackSessionFor,
  closeCallbackSession,
  openCallbackSession,
} from "./outboundTools";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import type { ContactRow } from "../runtime/outbound/store";

const CALLER = "+15555550111";
const PURPOSE = "it was a test call, and nothing is needed from them.";
let n = 0;

async function session(
  contacts: Array<Partial<ContactRow> & { id: string; phone: string }>,
  opts: { callerPhone?: string; loaded?: boolean } = {},
) {
  const store = new FakeOutboundStore();
  for (const c of contacts) store.addContact(c);
  const callSid = `CA${String(++n).padStart(32, "0")}`;
  const callerPhone = opts.callerPhone ?? CALLER;
  const { campaignId, candidates } = await store.callbackCandidates("test-campaign", callerPhone);
  openCallbackSession({
    callSid,
    campaignKey: "test-campaign",
    campaignId,
    callerPhone,
    candidates: opts.loaded === false ? [] : candidates,
    candidatesLoaded: opts.loaded !== false,
    purpose: PURPOSE,
    store,
  });
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    getTool(tool)!.handler({ outbound_callback_sid: callSid, ...args });
  return { store, callSid, call };
}

afterEach(() => undefined);

describe("identify_callback_caller", () => {
  it("identifies the one person on the calling number by the first name they confirm", async () => {
    const { store, callSid, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", lastName: "One" }]);
    const r = await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "testa" });
    expect(r).toMatchObject({ success: true, identified: true, first_name: "Testa" });
    expect((r as { fix: string }).fix).toContain(PURPOSE);
    // The returned call joins the campaign's history as an inbound attempt.
    expect(store.attempts).toEqual([
      expect.objectContaining({ contactId: "c1", direction: "inbound", callSid, attemptNumber: 0 }),
    ]);
  });

  it("does not identify the person on the number when the caller gives another name", async () => {
    const { store, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", lastName: "One" }]);
    const r = await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Other" });
    expect(r).toMatchObject({ success: true, identified: false, needs: "last_name" });
    expect(store.attempts).toHaveLength(0);
  });

  it("never picks between two people on one number who share a first name — asks the last name, then the date of birth", async () => {
    const { call } = await session([
      { id: "c1", phone: CALLER, firstName: "Testa", lastName: "One", customData: { date_of_birth: "1950-01-02" } },
      { id: "c2", phone: CALLER, firstName: "Testa", lastName: "One", customData: { date_of_birth: "1980-03-04" } },
      { id: "c3", phone: CALLER, firstName: "Testa", lastName: "Two" },
    ]);
    expect(await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" })).toMatchObject({
      identified: false,
      needs: "last_name",
    });
    // "One" still fits two people (two dates of birth).
    expect(await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa", last_name: "One" })).toMatchObject({
      identified: false,
      needs: "date_of_birth",
    });
    expect(
      await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa", last_name: "One", date_of_birth: "March 4, 1980" }),
    ).toMatchObject({ identified: true });
  });

  it("picks one person among several on the number when their first name is theirs alone", async () => {
    const { store, call } = await session([
      { id: "c1", phone: CALLER, firstName: "Testa", lastName: "One" },
      { id: "c2", phone: CALLER, firstName: "Other", lastName: "Two" },
    ]);
    expect(await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Other" })).toMatchObject({ identified: true });
    expect(store.attempts[0].contactId).toBe("c2");
  });

  it("finds a caller ringing from another phone by last name AND the date of birth on file", async () => {
    const { store, call } = await session(
      [{ id: "c1", phone: "+15555550122", firstName: "Testa", lastName: "One", customData: { date_of_birth: "1950-01-02" } }],
      { callerPhone: "+15555550199" },
    );
    expect(await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" })).toMatchObject({ needs: "last_name" });
    expect(await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa", last_name: "One" })).toMatchObject({
      needs: "date_of_birth",
    });
    expect(
      await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa", last_name: "One", date_of_birth: "01/02/1950" }),
    ).toMatchObject({ identified: true });
    expect(store.attempts[0].contactId).toBe("c1");
  });

  it("never identifies a caller on another phone by name alone — not without a date of birth on file to check", async () => {
    const { store, call } = await session(
      [{ id: "c1", phone: "+15555550122", firstName: "Testa", lastName: "One" }],
      { callerPhone: "+15555550199" },
    );
    const r = await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa", last_name: "One", date_of_birth: "01/02/1950" });
    expect(r).toMatchObject({ identified: false });
    expect(store.attempts).toHaveLength(0);
  });

  it("does not identify a caller on another phone whose date of birth does not match", async () => {
    const { call } = await session(
      [{ id: "c1", phone: "+15555550122", firstName: "Testa", lastName: "One", customData: { date_of_birth: "1950-01-02" } }],
      { callerPhone: "+15555550199" },
    );
    expect(
      await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa", last_name: "One", date_of_birth: "01/03/1950" }),
    ).toMatchObject({ identified: false });
  });

  it("reads the list again when the runtime could not read it in time, rather than calling them a stranger", async () => {
    const { call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", lastName: "One" }], { loaded: false });
    expect(await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" })).toMatchObject({ identified: true });
  });

  it("stops after a bounded number of tries", async () => {
    const { call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", lastName: "One" }]);
    for (let i = 0; i < MAX_IDENTIFY_TRIES; i++) await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Nobody" });
    const r = await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" });
    expect(r).toMatchObject({ identified: false });
    expect((r as { fix: string }).fix).toMatch(/^Stop trying/);
  });

  it("does nothing on a call that is not a returned call", async () => {
    expect(await getTool(IDENTIFY_CALLBACK_TOOL_NAME)!.handler({ first_name: "Testa" })).toMatchObject({
      success: false,
      error: "not_a_returned_call",
    });
  });
});

describe("recording an outcome on a returned call", () => {
  it("records nothing until somebody is identified — a household member ringing back is not the patient", async () => {
    const { store, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "voicemail" }]);
    expect(await call(RECORD_OUTCOME_TOOL_NAME, { outcome: "done" })).toMatchObject({
      success: false,
      error: "caller_not_identified",
    });
    expect(store.contacts.get("c1")!.status).toBe("voicemail");
  });

  it("records the identified caller's outcome over the row's earlier status, once", async () => {
    const { store, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "voicemail" }]);
    await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" });
    expect(await call(RECORD_OUTCOME_TOOL_NAME, { outcome: "done" })).toMatchObject({ success: true, recorded: "done" });
    expect(store.contacts.get("c1")!.status).toBe("completed");
    expect(await call(RECORD_OUTCOME_TOOL_NAME, { outcome: "not_interested" })).toMatchObject({
      recorded: "already_settled",
    });
    expect(store.contacts.get("c1")!.status).toBe("completed");
  });

  it("never turns an opt-out back into a row the queue would ring", async () => {
    const { store, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "do_not_call" }]);
    await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" });
    await call(RECORD_OUTCOME_TOOL_NAME, { outcome: "call_back_later" });
    expect(store.contacts.get("c1")!.status).toBe("do_not_call");
  });

  it("refuses wrong_person: the caller rang us and is identified", async () => {
    const { store, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "voicemail" }]);
    await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" });
    expect(await call(RECORD_OUTCOME_TOOL_NAME, { outcome: "wrong_person" })).toMatchObject({
      success: false,
      error: "not_on_a_returned_call",
    });
    expect(store.contacts.get("c1")!.status).toBe("voicemail");
  });
});

describe("opting out on a returned call", () => {
  it("puts the calling number on the list even before anybody is identified", async () => {
    const { store, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "voicemail" }]);
    expect(await call(OPT_OUT_TOOL_NAME)).toMatchObject({ success: true });
    expect(store.dnc.has("5555550111")).toBe(true);
    expect(store.contacts.get("c1")!.status).toBe("voicemail");
  });

  it("puts both numbers on the list, and settles the row, when the identified caller rang from another phone", async () => {
    const { store, call } = await session(
      [{ id: "c1", phone: "+15555550122", firstName: "Testa", lastName: "One", customData: { date_of_birth: "1950-01-02" } }],
      { callerPhone: "+15555550199" },
    );
    await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa", last_name: "One", date_of_birth: "1/2/1950" });
    await call(OPT_OUT_TOOL_NAME);
    expect([...store.dnc.keys()].sort()).toEqual(["5555550122", "5555550199"]);
    expect(store.contacts.get("c1")!.status).toBe("do_not_call");
  });
});

describe("hanging up a returned call", () => {
  it("is allowed", async () => {
    const { call } = await session([]);
    expect(await call(END_CALL_TOOL_NAME)).toMatchObject({ success: true, ended: true });
  });
});

describe("when the returned call ends", () => {
  it("ends its inbound attempt and marks an identified caller with no outcome as answered", async () => {
    const { store, callSid, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "voicemail" }]);
    await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" });
    await closeCallbackSession(callSid, { durationSeconds: 42 });
    expect(store.attempts[0].endedAt).toBeDefined();
    expect(store.attempts[0].finish).toMatchObject({ status: "completed", durationSeconds: 42 });
    expect(store.contacts.get("c1")!.status).toBe("answered");
    expect(callbackSessionFor(callSid)).toBeUndefined();
  });

  it("leaves a recorded outcome alone", async () => {
    const { store, callSid, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "voicemail" }]);
    await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" });
    await call(RECORD_OUTCOME_TOOL_NAME, { outcome: "not_interested" });
    await closeCallbackSession(callSid);
    expect(store.contacts.get("c1")!.status).toBe("declined");
  });

  it("touches nobody when nobody was identified", async () => {
    const { store, callSid } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "voicemail" }]);
    await closeCallbackSession(callSid);
    expect(store.contacts.get("c1")!.status).toBe("voicemail");
    expect(store.attempts).toHaveLength(0);
  });

  it("never overwrites a settled row with answered", async () => {
    const { store, callSid, call } = await session([{ id: "c1", phone: CALLER, firstName: "Testa", status: "declined" }]);
    await call(IDENTIFY_CALLBACK_TOOL_NAME, { first_name: "Testa" });
    await closeCallbackSession(callSid);
    expect(store.contacts.get("c1")!.status).toBe("declined");
  });
});
