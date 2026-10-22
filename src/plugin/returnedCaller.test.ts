/**
 * Returned-caller ticket lookup. Synthetic phones and ticket numbers only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extrasForReturnedCaller, extrasFromRecentContacts, hasTicketKeys } from "./returnedCaller";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { MemoryPluginStore, RETURNED_CALL_LOOKBACK_MS } from "./store";
import { bindOutboundStore, bindPluginStore } from "./bindings";
import { hashPayload } from "./tokens";
import type { ContactApprovalRow } from "./store";

afterEach(() => {
  bindOutboundStore(null);
  bindPluginStore(null);
});

const NOW = new Date("2026-10-22T18:00:00Z");
const PHONE = "+15555550111";

function approval(partial: Partial<ContactApprovalRow> & { id: string }): ContactApprovalRow {
  const now = partial.createdAt ?? NOW;
  return {
    channel: "call",
    status: "committed",
    tokenJti: "preparer",
    ticketId: "tid-1",
    ticketNumber: "VA-61001",
    phoneKey: "5555550111",
    payload: { phone: PHONE },
    payloadHash: hashPayload({ phone: PHONE }),
    confirmTokenHash: null,
    confirmExpiresAt: null,
    confirmUsedAt: null,
    approvedBy: "staff",
    approvedAt: now,
    rejectedBy: null,
    rejectedAt: null,
    cancelledAt: null,
    committedAt: now,
    result: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe("extrasFromRecentContacts", () => {
  it("picks the newest in-window contact that has ticket keys", () => {
    const extras = extrasFromRecentContacts(
      [
        {
          lastAttemptAt: new Date("2026-10-22T10:00:00Z"),
          data: { approval_id: "old", ticket_number: "VA-1", ticket_id: "t1" },
        },
        {
          lastAttemptAt: new Date("2026-10-22T16:00:00Z"),
          data: { approval_id: "new", ticket_number: "VA-2", ticket_id: "t2" },
        },
        {
          lastAttemptAt: new Date("2026-10-18T16:00:00Z"),
          data: { approval_id: "stale", ticket_number: "VA-0", ticket_id: "t0" },
        },
      ],
      NOW,
    );
    expect(extras).toEqual({ approvalId: "new", ticketNumber: "VA-2", ticketId: "t2" });
    expect(NOW.getTime() - new Date("2026-10-18T16:00:00Z").getTime()).toBeGreaterThan(RETURNED_CALL_LOOKBACK_MS);
  });

  it("ranks a missing lastAttemptAt below a dated one", () => {
    const extras = extrasFromRecentContacts(
      [
        { lastAttemptAt: null, data: { approval_id: "undated", ticket_number: "VA-u" } },
        { lastAttemptAt: new Date("2026-10-22T12:00:00Z"), data: { approval_id: "dated", ticket_number: "VA-d" } },
      ],
      NOW,
    );
    expect(extras.approvalId).toBe("dated");
  });
});

describe("extrasForReturnedCaller", () => {
  it("reads ticket keys from the campaign contact within 72 hours", async () => {
    const outbound = new FakeOutboundStore();
    outbound.addContact({
      id: "c1",
      phone: PHONE,
      customData: { approval_id: "appr-1", ticket_number: "VA-61001", ticket_id: "tid-9" },
    });
    const attemptId = await outbound.startAttempt("c1", outbound.campaignId, 1);
    await outbound.finishAttempt(attemptId, { status: "no_answer" });
    const extras = await extrasForReturnedCaller(PHONE, NOW, outbound, null);
    expect(extras).toEqual({ approvalId: "appr-1", ticketNumber: "VA-61001", ticketId: "tid-9" });
    expect(hasTicketKeys(extras)).toBe(true);
  });

  it("falls back to the most recent approved contact_approvals row", async () => {
    const plugin = new MemoryPluginStore();
    await plugin.insertApproval(
      approval({
        id: "appr-older",
        ticketNumber: "VA-1",
        approvedAt: new Date("2026-10-21T12:00:00Z"),
      }),
    );
    await plugin.insertApproval(
      approval({
        id: "appr-newer",
        ticketNumber: "VA-2",
        ticketId: "tid-new",
        approvedAt: new Date("2026-10-22T15:00:00Z"),
      }),
    );
    const extras = await extrasForReturnedCaller(PHONE, NOW, new FakeOutboundStore(), plugin);
    expect(extras).toEqual({ approvalId: "appr-newer", ticketNumber: "VA-2", ticketId: "tid-new" });
  });

  it("the runtime teardown looks up extras on a returned SI Assistant call", () => {
    const src = readFileSync(join(__dirname, "../runtime/voiceRuntime.ts"), "utf8");
    expect(src).toMatch(/extrasForReturnedCaller/);
    expect(src).toMatch(/hasTicketKeys/);
    expect(src).toMatch(/si-assistant/);
  });
});
