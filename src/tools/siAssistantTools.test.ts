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
import { openCallbackSession } from "./outboundTools";

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
    expect(posted).toHaveLength(1);
    expect(posted[0].event).toBe("message");
    expect(posted[0].approvalId).toBe("appr-1");
    expect(posted[0].ticketNumber).toBe("VA-61001");
    expect(posted[0].ticketId).toBe("tid-9");
    expect(posted[0].message).toBe("Please call me about my glasses");
    const rows = [...plugin.outbox.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].message).toBe("Please call me about my glasses");
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
    expect([...plugin.outbox.values()][0]?.status).toBe("pending");
    expect(err.mock.calls.flat().join(" ")).not.toContain("Please call me about my glasses");
    err.mockRestore();
  });

  it("treats an unset webhook as taken after persist, so retry can deliver later", async () => {
    const plugin = bindOutbox();
    setSiAssistantReporterForTests(null);
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({ message: "Need a callback about frames" });
    expect(result).toMatchObject({ success: true, message_taken: true });
    const row = [...plugin.outbox.values()][0];
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toBe("no_webhook");
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
    expect(posted[0].approvalId).toBe("appr-back");
    expect(posted[0].ticketNumber).toBe("VA-61099");
    expect(posted[0].ticketId).toBe("tid-back");
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
