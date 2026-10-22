/**
 * SI Assistant take-message tool. Synthetic ids only. The message text
 * is delivered to the ticketing webhook and must not appear in logs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTool } from "./registry";
import {
  setSiAssistantReporterForTests,
  setSiAssistantToolStoreForTests,
  TAKE_MESSAGE_TOOL_NAME,
} from "./siAssistantTools";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";

afterEach(() => {
  setSiAssistantToolStoreForTests(null);
  setSiAssistantReporterForTests(undefined);
});

describe("take_si_assistant_message", () => {
  it("reports the message to the ticketing webhook with the ticket ids", async () => {
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
  });

  it("refuses an empty message and does not post", async () => {
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
  });

  it("does not log the message text when the webhook fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setSiAssistantReporterForTests({
      async report() {
        throw new Error("Please call me about my glasses");
      },
    });
    const tool = getTool(TAKE_MESSAGE_TOOL_NAME);
    const result = await tool!.handler({ message: "Please call me about my glasses" });
    expect(result).toMatchObject({ success: true, message_taken: true });
    expect(err.mock.calls.flat().join(" ")).not.toContain("Please call me about my glasses");
    err.mockRestore();
  });
});
