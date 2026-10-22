/**
 * SI Assistant take-message tool. Synthetic ids only. The message text
 * is persisted in the outbox first; it must not appear in logs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTool } from "./registry";
import {
  setSiAssistantPluginStoreForTests,
  setSiAssistantReporterForTests,
  setSiAssistantToolStoreForTests,
  SI_ASSISTANT_TOOLS,
  TAKE_MESSAGE_TOOL_NAME,
} from "./siAssistantTools";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { MemoryPluginStore } from "../plugin/store";
import { flushDueOutbox, outboxIdempotencyKey } from "../plugin/messageOutbox";
import { callbackSessionFor, openCallbackSession } from "./outboundTools";

afterEach(() => {
  setSiAssistantToolStoreForTests(null);
  setSiAssistantReporterForTests(undefined);
  setSiAssistantPluginStoreForTests(null);
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
      customData: { approval_id: "appr-1", ticket_number: "VA-61001", ticket_id: "tid-9" },
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
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    expect(tool).toBeTruthy();
    const result = await tool!.handler({
      message: "Please call me about my glasses",
      outbound_contact_id: "c1",
      outbound_attempt_id: attemptId,
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
    const rows = [...plugin.outbox.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("");
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

  it("looks up ticket keys from the recent outbound contact when the attempt id is missing", async () => {
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
    openCallbackSession({
      callSid: sid,
      campaignKey: "si-assistant",
      campaignId: store.campaignId,
      callerPhone: "+15555550111",
      candidates: [],
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
    expect(posted[0].approvalId).toBe("appr-back");
    expect(posted[0].ticketNumber).toBe("VA-61099");
    expect(posted[0].ticketId).toBe("tid-back");
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
    session.chosen = { contactId: "alice", phone: "+15555550111", firstName: "Alice" };
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

  it("defines SI_ASSISTANT_TOOLS once", () => {
    const agent = readFileSync(join(__dirname, "../agents/siAssistantAgent.ts"), "utf8");
    const tools = readFileSync(join(__dirname, "./siAssistantTools.ts"), "utf8");
    expect(tools).toMatch(/export const SI_ASSISTANT_TOOLS = \[TAKE_MESSAGE_TOOL_NAME\]/);
    expect(agent).not.toMatch(/export const SI_ASSISTANT_TOOLS = \[/);
    expect(agent).toMatch(/import \{ SI_ASSISTANT_TOOLS \}/);
    expect(SI_ASSISTANT_TOOLS).toEqual([TAKE_MESSAGE_TOOL_NAME]);
  });
});
