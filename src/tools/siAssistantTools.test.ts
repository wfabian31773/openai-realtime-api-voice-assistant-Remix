/**
 * SI Assistant take-message tool. Synthetic ids only. The message text
 * is persisted in the outbox first; it must not appear in logs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTool } from "./registry";
import {
  CONFIRM_IDENTITY_TOOL_NAME,
  setSiAssistantPluginStoreForTests,
  setSiAssistantReporterForTests,
  setSiAssistantToolStoreForTests,
  SI_ASSISTANT_TOOLS,
  TAKE_MESSAGE_TOOL_NAME,
} from "./siAssistantTools";
import { resetSiAssistantIdentityForTests } from "../plugin/siAssistantIdentity";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { MemoryPluginStore } from "../plugin/store";
import { flushDueOutbox, outboxIdempotencyKey } from "../plugin/messageOutbox";
import { callbackSessionFor, openCallbackSession } from "./outboundTools";
import { evaluateAndEnqueueCall } from "../plugin/callEnqueue";
import { siAssistantIdentityFor } from "../plugin/siAssistantIdentity";

afterEach(() => {
  setSiAssistantToolStoreForTests(null);
  setSiAssistantReporterForTests(undefined);
  setSiAssistantPluginStoreForTests(null);
  resetSiAssistantIdentityForTests();
});

function bindOutbox(): MemoryPluginStore {
  const plugin = new MemoryPluginStore();
  setSiAssistantPluginStoreForTests(plugin);
  return plugin;
}

describe("take_si_assistant_message", () => {
  it("persists first, then reports the message with the ticket ids", async () => {
    const plugin = bindOutbox();
    const store = new FakeOutboundStore();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      customData: {
        approval_id: "appr-1",
        ticket_number: "VA-61001",
        ticket_id: "tid-9",
        date_of_birth: "1950-03-17",
      },
    });
    const attemptId = await store.startAttempt("c1", store.campaignId, 1);
    setSiAssistantToolStoreForTests(store);
    const posted: Array<Record<string, unknown>> = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    });
    const sid = "CA" + "a".repeat(32);
    const confirm = getTool(CONFIRM_IDENTITY_TOOL_NAME);
    expect(confirm).toBeTruthy();
    expect(
      await confirm!.handler({
        speaking_with_named_patient: true,
        date_of_birth: "March 17 1950",
        outbound_contact_id: "c1",
        outbound_attempt_id: attemptId,
        outbound_call_sid: sid,
      }),
    ).toMatchObject({ success: true, confirmed: true });
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    expect(tool).toBeTruthy();
    const result = await tool!.handler({
      message: "Please call me about my glasses",
      outbound_contact_id: "c1",
      outbound_attempt_id: attemptId,
      outbound_call_sid: sid,
    });
    expect(result).toMatchObject({ success: true, message_taken: true });
    await vi.waitFor(() => {
      expect([...plugin.outbox.values()][0]?.status).toBe("delivered");
    });
    expect(posted).toHaveLength(1);
    expect(posted[0].event).toBe("message");
    expect(posted[0].approvalId).toBe("appr-1");
    expect(posted[0].ticketNumber).toBe("VA-61001");
    expect(posted[0].ticketId).toBe("tid-9");
    expect(posted[0].message).toBe("Please call me about my glasses");
    expect(posted[0].identityConfirmed).toBe(true);
    expect(posted[0].outboxId).toBeTruthy();
    expect(posted[0].idempotencyKey).toBe(outboxIdempotencyKey(sid, "Please call me about my glasses"));
    const rows = [...plugin.outbox.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("");
    expect(posted[0].outboxId).toBe(rows[0].id);
  });

  it("refuses an empty message and does not persist", async () => {
    const plugin = bindOutbox();
    const posted: unknown[] = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload);
        return { ok: true };
      },
    });
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({ message: "   " });
    expect(result).toMatchObject({ success: false, error: "empty_message" });
    expect(posted).toEqual([]);
    expect(plugin.outbox.size).toBe(0);
  });

  it("tells the caller the message was taken once persisted, even when the webhook fails", async () => {
    const plugin = bindOutbox();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setSiAssistantReporterForTests({
      async report() {
        throw new Error("Please call me about my glasses");
      },
    });
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({ message: "Please call me about my glasses" });
    expect(result).toMatchObject({ success: true, message_taken: true });
    expect(String((result as { say?: string }).say)).toMatch(/I've taken your message/);
    await vi.waitFor(() => {
      expect([...plugin.outbox.values()][0]?.lastError).toBe("send_failed");
    });
    expect([...plugin.outbox.values()][0]?.status).toBe("pending");
    expect(err.mock.calls.flat().join(" ")).not.toContain("Please call me about my glasses");
    err.mockRestore();
  });

  it("treats an unset webhook as taken after persist and leaves the row pending", async () => {
    const plugin = bindOutbox();
    setSiAssistantReporterForTests(null);
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({ message: "Need a callback about frames" });
    expect(result).toMatchObject({ success: true, message_taken: true });
    await Promise.resolve();
    const row = [...plugin.outbox.values()][0];
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(await flushDueOutbox(plugin, null)).toBe(0);
    expect([...plugin.outbox.values()][0]?.status).toBe("pending");
    expect([...plugin.outbox.values()][0]?.lastError).toBeNull();
  });

  it("does not claim the message was taken when persist fails, and offers the number", async () => {
    const plugin = bindOutbox();
    plugin.outboxBroken = true;
    const posted: unknown[] = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload);
        return { ok: true };
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({ message: "Please call me about my glasses" });
    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      message: expect.stringMatching(/wasn't able to save that message/i),
    });
    expect(String((result as { message?: string }).message)).toMatch(/909-255-3213/);
    expect(String((result as { message?: string }).message)).not.toMatch(/I've taken your message/);
    expect(posted).toEqual([]);
    expect(err.mock.calls.flat().join(" ")).not.toContain("Please call me about my glasses");
    err.mockRestore();
  });

  it("does not attach on a phone match when the attempt id is missing; suggests the placed ticket", async () => {
    bindOutbox();
    const store = new FakeOutboundStore();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      customData: { approval_id: "appr-back", ticket_number: "VA-61099", ticket_id: "tid-back" },
    });
    const attemptId = await store.startAttempt("c1", store.campaignId, 1);
    await store.finishAttempt(attemptId, { status: "no_answer" });
    setSiAssistantToolStoreForTests(store);
    const posted: Array<Record<string, unknown>> = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    });
    const sid = "CA" + "b".repeat(32);
    const { candidates } = await store.callbackCandidates("si-assistant", "+15555550111");
    openCallbackSession({
      callSid: sid,
      campaignKey: "si-assistant",
      campaignId: store.campaignId,
      callerPhone: "+15555550111",
      candidates,
      candidatesLoaded: true,
      purpose: "test",
      store,
    });
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({
      message: "Calling back about my ticket",
      outbound_callback_sid: sid,
    });
    expect(result).toMatchObject({ success: true });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].approvalId ?? null).toBeNull();
    expect(posted[0].ticketNumber ?? null).toBeNull();
    expect(posted[0].ticketId ?? null).toBeNull();
    expect(posted[0].unmatched).toBe(true);
    expect(posted[0].identityConfirmed).toBeUndefined();
    expect(posted[0].suggestions).toEqual([{ ticketNumber: "VA-61099", approvalId: "appr-back" }]);
    expect(posted[0].outboxId).toBeTruthy();
    expect(posted[0].idempotencyKey).toBe(outboxIdempotencyKey(sid, "Calling back about my ticket"));
  });

  it("prefers the identified caller and does not pick the other person on the number", async () => {
    bindOutbox();
    const store = new FakeOutboundStore();
    store.addContact({
      id: "alice",
      phone: "+15555550111",
      firstName: "Alice",
      customData: { approval_id: "appr-alice", ticket_number: "VA-alice", ticket_id: "tid-alice" },
    });
    store.addContact({
      id: "bob",
      phone: "+15555550111",
      firstName: "Bob",
      customData: { approval_id: "appr-bob", ticket_number: "VA-bob", ticket_id: "tid-bob" },
    });
    setSiAssistantToolStoreForTests(store);
    const posted: Array<Record<string, unknown>> = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    });
    const sid = "CA" + "c".repeat(32);
    const { candidates } = await store.callbackCandidates("si-assistant", "+15555550111");
    openCallbackSession({
      callSid: sid,
      campaignKey: "si-assistant",
      campaignId: store.campaignId,
      callerPhone: "+15555550111",
      candidates,
      candidatesLoaded: true,
      purpose: "test",
      store,
    });
    const session = callbackSessionFor(sid)!;
    session.chosen = {
      contactId: "alice",
      phone: "+15555550111",
      firstName: "Alice",
      lastName: "One",
      verifiedBy: "full_name_dob",
    };
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({
      message: "This is Alice",
      outbound_callback_sid: sid,
    });
    expect(result).toMatchObject({ success: true });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].approvalId).toBe("appr-alice");
    expect(posted[0].ticketNumber).toBe("VA-alice");
    expect(posted[0].unmatched).toBeUndefined();
  });

  it("sends unmatched when two placed contacts share the number", async () => {
    bindOutbox();
    const store = new FakeOutboundStore();
    store.addContact({
      id: "c-a",
      phone: "+15555550111",
      customData: { approval_id: "a", ticket_number: "VA-A", ticket_id: "ta" },
    });
    store.addContact({
      id: "c-b",
      phone: "+15555550111",
      customData: { approval_id: "b", ticket_number: "VA-B", ticket_id: "tb" },
    });
    const a = await store.startAttempt("c-a", store.campaignId, 1);
    const b = await store.startAttempt("c-b", store.campaignId, 1);
    await store.finishAttempt(a, { status: "no_answer" });
    await store.finishAttempt(b, { status: "no_answer" });
    setSiAssistantToolStoreForTests(store);
    const posted: Array<Record<string, unknown>> = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    });
    const sid = "CA" + "d".repeat(32);
    const { candidates } = await store.callbackCandidates("si-assistant", "+15555550111");
    openCallbackSession({
      callSid: sid,
      campaignKey: "si-assistant",
      campaignId: store.campaignId,
      callerPhone: "+15555550111",
      candidates,
      candidatesLoaded: true,
      purpose: "test",
      store,
    });
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({
      message: "Who am I",
      outbound_callback_sid: sid,
    });
    expect(result).toMatchObject({ success: true });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].approvalId ?? null).toBeNull();
    expect(posted[0].ticketNumber ?? null).toBeNull();
    expect(posted[0].unmatched).toBe(true);
    expect(posted[0].suggestions).toEqual(
      expect.arrayContaining([
        { ticketNumber: "VA-A", approvalId: "a" },
        { ticketNumber: "VA-B", approvalId: "b" },
      ]),
    );
    expect((posted[0].suggestions as unknown[]).length).toBe(2);
  });

  it("reuses one outbox row for the same call SID and message", async () => {
    const plugin = bindOutbox();
    setSiAssistantReporterForTests(null);
    const sid = "CA" + "e".repeat(32);
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    await tool!.handler({ message: "Same words", outbound_callback_sid: sid });
    await tool!.handler({ message: "Same words", outbound_callback_sid: sid });
    expect(plugin.outbox.size).toBe(1);
    const row = [...plugin.outbox.values()][0];
    expect(row.idempotencyKey).toBe(outboxIdempotencyKey(sid, "Same words"));
  });

  it("uses outbound_call_sid as the idempotency key on a dialled call", async () => {
    const plugin = bindOutbox();
    setSiAssistantReporterForTests(null);
    const sid = "CA" + "f".repeat(32);
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    await tool!.handler({ message: "Outbound words", outbound_call_sid: sid });
    await tool!.handler({ message: "Outbound words", outbound_call_sid: sid });
    expect(plugin.outbox.size).toBe(1);
    const row = [...plugin.outbox.values()][0];
    expect(row.callSid).toBe(sid);
    expect(row.idempotencyKey).toBe(outboxIdempotencyKey(sid, "Outbound words"));
  });

  it("defines SI_ASSISTANT_TOOLS once", () => {
    const agent = readFileSync(join(__dirname, "../agents/siAssistantAgent.ts"), "utf8");
    const tools = readFileSync(join(__dirname, "./siAssistantTools.ts"), "utf8");
    expect(tools).toMatch(/export const SI_ASSISTANT_TOOLS = \[CONFIRM_IDENTITY_TOOL_NAME, TAKE_MESSAGE_TOOL_NAME\]/);
    expect(agent).not.toMatch(/export const SI_ASSISTANT_TOOLS = \[/);
    expect(agent).toMatch(/import \{ SI_ASSISTANT_TOOLS \}/);
    expect(SI_ASSISTANT_TOOLS).toEqual([CONFIRM_IDENTITY_TOOL_NAME, TAKE_MESSAGE_TOOL_NAME]);
  });

  it("does not attach a dialled ticket before yes plus a matching date of birth", async () => {
    const plugin = bindOutbox();
    const store = new FakeOutboundStore();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      customData: { approval_id: "appr-1", ticket_number: "VA-61001", date_of_birth: "1950-03-17" },
    });
    const attemptId = await store.startAttempt("c1", store.campaignId, 1);
    setSiAssistantToolStoreForTests(store);
    const posted: Array<Record<string, unknown>> = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    });
    const sid = "CA" + "7".repeat(32);
    await getTool(TAKE_MESSAGE_TOOL_NAME)!.handler({
      message: "Call me back",
      outbound_contact_id: "c1",
      outbound_attempt_id: attemptId,
      outbound_call_sid: sid,
    });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].ticketNumber ?? null).toBeNull();
    expect(posted[0].unmatched).toBe(true);
    expect([...plugin.outbox.values()][0].ticketNumber).toBeNull();
  });

  it("never attaches after wrong_person, and re-attaches an earlier unmatched message once identified", async () => {
    const plugin = bindOutbox();
    const store = new FakeOutboundStore();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      customData: { approval_id: "appr-1", ticket_number: "VA-61001", date_of_birth: "1950-03-17" },
    });
    const attemptId = await store.startAttempt("c1", store.campaignId, 1);
    setSiAssistantToolStoreForTests(store);
    const posted: Array<Record<string, unknown>> = [];
    setSiAssistantReporterForTests({
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    });
    const sid = "CA" + "8".repeat(32);
    await getTool(TAKE_MESSAGE_TOOL_NAME)!.handler({
      message: "Leave this for the team",
      outbound_contact_id: "c1",
      outbound_attempt_id: attemptId,
      outbound_call_sid: sid,
    });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].unmatched).toBe(true);

    expect(
      await getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
        speaking_with_named_patient: false,
        outbound_contact_id: "c1",
        outbound_attempt_id: attemptId,
        outbound_call_sid: sid,
      }),
    ).toMatchObject({ confirmed: false });
    const afterNo = await getTool(TAKE_MESSAGE_TOOL_NAME)!.handler({
      message: "Still unmatched after no",
      outbound_contact_id: "c1",
      outbound_attempt_id: attemptId,
      outbound_call_sid: sid,
    });
    expect(afterNo).toMatchObject({ success: true });
    await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));
    expect(posted.every((p) => p.ticketNumber == null)).toBe(true);

    resetSiAssistantIdentityForTests();
    const sidYes = "CA" + "9".repeat(32);
    await getTool(TAKE_MESSAGE_TOOL_NAME)!.handler({
      message: "Taken before identify",
      outbound_contact_id: "c1",
      outbound_attempt_id: attemptId,
      outbound_call_sid: sidYes,
    });
    await vi.waitFor(() => expect(posted.some((p) => p.message === "Taken before identify")).toBe(true));
    const before = posted.filter((p) => p.message === "Taken before identify");
    expect(before[0].ticketNumber ?? null).toBeNull();

    await getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
      speaking_with_named_patient: true,
      date_of_birth: "March 17 1950",
      outbound_contact_id: "c1",
      outbound_attempt_id: attemptId,
      outbound_call_sid: sidYes,
    });
    await vi.waitFor(() => {
      const attached = posted.filter((p) => p.ticketNumber === "VA-61001" && p.identityConfirmed === true);
      expect(attached.length).toBeGreaterThanOrEqual(1);
    });
    const row = [...plugin.outbox.values()].find((r) => r.callSid === sidYes);
    expect(row?.ticketNumber).toBe("VA-61001");
    expect(row?.approvalId).toBe("appr-1");
  });

  it("verifies a dialled patient from the real enqueue path, with no injected date of birth", async () => {
    bindOutbox();
    const store = new FakeOutboundStore();
    const queued = await evaluateAndEnqueueCall(
      store,
      {
        approvalId: "appr-1",
        phone: "+15555550111",
        firstName: "Testa",
        lastName: "Patient",
        dateOfBirth: "March 17, 1950",
        ticketNumber: "VA-61001",
        ticketId: "tid-9",
      },
      new Date("2026-10-22T18:00:00Z"),
    );
    expect(queued).toMatchObject({ ok: true });
    const contact = [...store.contacts.values()][0];
    expect(contact.customData.date_of_birth).toBe("1950-03-17");
    expect(Object.keys(contact.customData)).not.toContain("injected");
    const attemptId = await store.startAttempt(contact.id, store.campaignId, 1);
    setSiAssistantToolStoreForTests(store);
    const sid = "CA" + "b".repeat(32);
    expect(
      await getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
        speaking_with_named_patient: true,
        date_of_birth: "March 17 1950",
        outbound_contact_id: contact.id,
        outbound_attempt_id: attemptId,
        outbound_call_sid: sid,
      }),
    ).toMatchObject({ success: true, confirmed: true });
  });

  it("when enqueue stored no date of birth, says it cannot verify and never says does not match", async () => {
    const store = new FakeOutboundStore();
    await evaluateAndEnqueueCall(
      store,
      {
        approvalId: "appr-1",
        phone: "+15555550111",
        firstName: "Testa",
        lastName: "Patient",
        ticketNumber: "VA-61001",
      },
      new Date("2026-10-22T18:00:00Z"),
    );
    const contact = [...store.contacts.values()][0];
    expect(contact.customData.date_of_birth).toBeUndefined();
    const attemptId = await store.startAttempt(contact.id, store.campaignId, 1);
    setSiAssistantToolStoreForTests(store);
    const result = await getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
      speaking_with_named_patient: true,
      date_of_birth: "March 17 1950",
      outbound_contact_id: contact.id,
      outbound_attempt_id: attemptId,
      outbound_call_sid: "CA" + "c".repeat(32),
    });
    expect(result).toMatchObject({ success: true, confirmed: false, cannot_verify: true });
    const fix = String((result as { fix: string }).fix);
    expect(fix).toMatch(/cannot verify/i);
    expect(fix).toMatch(/take a message/i);
    expect(fix).toMatch(/do not say.{0,40}does not match/i);
    expect(fix).not.toMatch(/does not match the patient on file/i);
  });

  it("keeps wrong_person sticky so a later yes cannot attach", async () => {
    bindOutbox();
    const store = new FakeOutboundStore();
    await evaluateAndEnqueueCall(
      store,
      {
        approvalId: "appr-1",
        phone: "+15555550111",
        firstName: "Testa",
        lastName: "Patient",
        dateOfBirth: "1950-03-17",
        ticketNumber: "VA-61001",
      },
      new Date("2026-10-22T18:00:00Z"),
    );
    const contact = [...store.contacts.values()][0];
    const attemptId = await store.startAttempt(contact.id, store.campaignId, 1);
    setSiAssistantToolStoreForTests(store);
    const sid = "CA" + "d".repeat(32);
    await getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
      speaking_with_named_patient: false,
      outbound_contact_id: contact.id,
      outbound_attempt_id: attemptId,
      outbound_call_sid: sid,
    });
    expect(siAssistantIdentityFor(sid)?.wrongPerson).toBe(true);
    const later = await getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
      speaking_with_named_patient: true,
      date_of_birth: "March 17 1950",
      outbound_contact_id: contact.id,
      outbound_attempt_id: attemptId,
      outbound_call_sid: sid,
    });
    expect(later).toMatchObject({ confirmed: false });
    expect(siAssistantIdentityFor(sid)).toMatchObject({
      wrongPerson: true,
      greetingAffirmed: false,
      dobMatched: false,
    });
  });

  it("treats a failed contact load as an error, not as no date of birth", async () => {
    bindOutbox();
    const store = new FakeOutboundStore();
    await evaluateAndEnqueueCall(
      store,
      {
        approvalId: "appr-1",
        phone: "+15555550111",
        firstName: "Testa",
        lastName: "Patient",
        dateOfBirth: "1950-03-17",
        ticketNumber: "VA-61001",
      },
      new Date("2026-10-22T18:00:00Z"),
    );
    const contact = [...store.contacts.values()][0];
    const attemptId = await store.startAttempt(contact.id, store.campaignId, 1);
    store.loadCallContact = async () => {
      throw new Error("db down");
    };
    setSiAssistantToolStoreForTests(store);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
      speaking_with_named_patient: true,
      date_of_birth: "March 17 1950",
      outbound_contact_id: contact.id,
      outbound_attempt_id: attemptId,
      outbound_call_sid: "CA" + "e".repeat(32),
    });
    err.mockRestore();
    expect(result).toMatchObject({
      success: false,
      error: "contact_load_failed",
    });
    const fix = String((result as { fix: string }).fix);
    expect(fix).toMatch(/right now/i);
    expect(fix).toMatch(/take a message/i);
    expect(fix).toMatch(/do not say there is no date of birth on file/i);
    expect(fix).not.toMatch(/there is no date of birth on file, so you cannot verify/i);
  });
});

describe("confirm_si_assistant_identity — the date of birth is tried twice (v115)", () => {
  async function dialled(): Promise<{ attemptId: string; sid: string }> {
    const store = new FakeOutboundStore();
    store.addContact({
      id: "c-dob",
      phone: "+15555550177",
      customData: { approval_id: "appr-dob", ticket_number: "VA-61077", date_of_birth: "1950-03-17" },
    });
    const attemptId = await store.startAttempt("c-dob", store.campaignId, 1);
    setSiAssistantToolStoreForTests(store);
    setSiAssistantReporterForTests({ async report() { return { ok: true, status: 200 }; } });
    bindOutbox();
    return { attemptId, sid: "CA" + "d".repeat(32) };
  }

  function confirmWith(dob: string, attemptId: string, sid: string) {
    return getTool(CONFIRM_IDENTITY_TOOL_NAME)!.handler({
      speaking_with_named_patient: true,
      date_of_birth: dob,
      outbound_contact_id: "c-dob",
      outbound_attempt_id: attemptId,
      outbound_call_sid: sid,
    });
  }

  it("a correct date on the second try still confirms", async () => {
    const { attemptId, sid } = await dialled();
    expect(await confirmWith("April 2 1961", attemptId, sid)).toMatchObject({ confirmed: false });
    expect(await confirmWith("March 17 1950", attemptId, sid)).toMatchObject({ confirmed: true });
    expect(siAssistantIdentityFor(sid)).toMatchObject({ dobMatched: true });
  });

  it("after two wrong dates a third, correct one is refused and nothing is identified", async () => {
    const { attemptId, sid } = await dialled();
    expect(await confirmWith("April 2 1961", attemptId, sid)).toMatchObject({ confirmed: false });
    expect(await confirmWith("May 9 1972", attemptId, sid)).toMatchObject({ confirmed: false });
    const third = await confirmWith("March 17 1950", attemptId, sid);
    expect(third).toMatchObject({ success: true, confirmed: false, locked: true });
    expect(siAssistantIdentityFor(sid)).toMatchObject({ dobMatched: false, dobTries: 2 });
  });
});
