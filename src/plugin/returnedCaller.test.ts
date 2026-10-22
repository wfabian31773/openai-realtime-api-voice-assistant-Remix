/**
 * Returned-caller ticket lookup. Synthetic phones and ticket numbers only.
 * Never picks between people on one number.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extrasForIdentifiedContact,
  extrasForReturnedCaller,
  extrasOfMatch,
  hasTicketKeys,
  matchPlacedContacts,
} from "./returnedCaller";
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

describe("matchPlacedContacts", () => {
  it("attaches when exactly one ticket and one patient were placed in-window", () => {
    const match = matchPlacedContacts(
      [
        {
          contactId: "c1",
          lastAttemptAt: new Date("2026-10-22T16:00:00Z"),
          data: { approval_id: "appr", ticket_number: "VA-1", ticket_id: "t1" },
        },
        {
          contactId: "c1",
          lastAttemptAt: new Date("2026-10-22T10:00:00Z"),
          data: { approval_id: "appr", ticket_number: "VA-1", ticket_id: "t1" },
        },
      ],
      NOW,
    );
    expect(match).toEqual({
      kind: "one",
      extras: { approvalId: "appr", ticketNumber: "VA-1", ticketId: "t1" },
    });
  });

  it("refuses when two tickets match on one number", () => {
    const match = matchPlacedContacts(
      [
        {
          contactId: "c-old",
          lastAttemptAt: new Date("2026-10-22T10:00:00Z"),
          data: { approval_id: "old", ticket_number: "VA-1", ticket_id: "t1" },
        },
        {
          contactId: "c-new",
          lastAttemptAt: new Date("2026-10-22T16:00:00Z"),
          data: { approval_id: "new", ticket_number: "VA-2", ticket_id: "t2" },
        },
      ],
      NOW,
    );
    expect(match.kind).toBe("several");
    expect(extrasOfMatch(match)).toEqual({});
  });

  it("refuses when one ticket matches two patients", () => {
    const match = matchPlacedContacts(
      [
        {
          contactId: "alice",
          lastAttemptAt: new Date("2026-10-22T10:00:00Z"),
          data: { approval_id: "a", ticket_number: "VA-1", ticket_id: "t1" },
        },
        {
          contactId: "bob",
          lastAttemptAt: new Date("2026-10-22T16:00:00Z"),
          data: { approval_id: "b", ticket_number: "VA-1", ticket_id: "t1" },
        },
      ],
      NOW,
    );
    expect(match.kind).toBe("several");
  });

  it("excludes a missing lastAttemptAt and a never-placed (at === 0) contact", () => {
    const match = matchPlacedContacts(
      [
        { contactId: "undated", lastAttemptAt: null, data: { approval_id: "undated", ticket_number: "VA-u" } },
        {
          contactId: "zero",
          lastAttemptAt: new Date(0),
          data: { approval_id: "zero", ticket_number: "VA-z" },
        },
        {
          contactId: "dated",
          lastAttemptAt: new Date("2026-10-22T12:00:00Z"),
          data: { approval_id: "dated", ticket_number: "VA-d" },
        },
      ],
      NOW,
    );
    expect(match).toEqual({
      kind: "one",
      extras: { approvalId: "dated", ticketNumber: "VA-d", ticketId: null },
    });
  });

  it("excludes a placed dial older than 72 hours", () => {
    const stale = new Date("2026-10-18T16:00:00Z");
    expect(NOW.getTime() - stale.getTime()).toBeGreaterThan(RETURNED_CALL_LOOKBACK_MS);
    const match = matchPlacedContacts(
      [
        {
          contactId: "stale",
          lastAttemptAt: stale,
          data: { approval_id: "stale", ticket_number: "VA-0", ticket_id: "t0" },
        },
      ],
      NOW,
    );
    expect(match.kind).toBe("none");
  });
});

describe("extrasForIdentifiedContact", () => {
  it("uses the identified caller's contact and ignores the other person on the number", () => {
    const extras = extrasForIdentifiedContact(
      { contactId: "alice" },
      [
        { contactId: "bob", data: { approval_id: "bob", ticket_number: "VA-bob" } },
        { contactId: "alice", data: { approval_id: "alice", ticket_number: "VA-alice", ticket_id: "ta" } },
      ],
    );
    expect(extras).toEqual({ approvalId: "alice", ticketNumber: "VA-alice", ticketId: "ta" });
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

  it("attaches a unique committed approval and refuses two tickets on one number", async () => {
    const plugin = new MemoryPluginStore();
    await plugin.insertApproval(
      approval({
        id: "appr-only",
        ticketNumber: "VA-9",
        ticketId: "tid-9",
        committedAt: new Date("2026-10-22T15:00:00Z"),
      }),
    );
    const one = await extrasForReturnedCaller(PHONE, NOW, new FakeOutboundStore(), plugin);
    expect(one).toEqual({ approvalId: "appr-only", ticketNumber: "VA-9", ticketId: "tid-9" });

    await plugin.insertApproval(
      approval({
        id: "appr-other",
        ticketNumber: "VA-2",
        ticketId: "tid-2",
        committedAt: new Date("2026-10-22T16:00:00Z"),
      }),
    );
    const two = await extrasForReturnedCaller(PHONE, NOW, new FakeOutboundStore(), plugin);
    expect(two).toEqual({});
  });

  it("does not count unsent approvals (approved / sending) or a committedAt of zero", async () => {
    const plugin = new MemoryPluginStore();
    await plugin.insertApproval(
      approval({
        id: "appr-approved",
        status: "approved",
        committedAt: null,
        approvedAt: new Date("2026-10-22T15:00:00Z"),
        ticketNumber: "VA-unsent",
      }),
    );
    await plugin.insertApproval(
      approval({
        id: "appr-sending",
        status: "sending",
        committedAt: null,
        approvedAt: new Date("2026-10-22T16:00:00Z"),
        ticketNumber: "VA-sending",
      }),
    );
    await plugin.insertApproval(
      approval({
        id: "appr-zero",
        status: "committed",
        committedAt: new Date(0),
        ticketNumber: "VA-zero",
      }),
    );
    const extras = await extrasForReturnedCaller(PHONE, NOW, new FakeOutboundStore(), plugin);
    expect(extras).toEqual({});
  });

  it("does not consult approvals when the campaign already has several matches", async () => {
    const outbound = new FakeOutboundStore();
    outbound.addContact({
      id: "c-a",
      phone: PHONE,
      customData: { approval_id: "a", ticket_number: "VA-A", ticket_id: "ta" },
    });
    outbound.addContact({
      id: "c-b",
      phone: PHONE,
      customData: { approval_id: "b", ticket_number: "VA-B", ticket_id: "tb" },
    });
    const a = await outbound.startAttempt("c-a", outbound.campaignId, 1);
    const b = await outbound.startAttempt("c-b", outbound.campaignId, 1);
    await outbound.finishAttempt(a, { status: "no_answer" });
    await outbound.finishAttempt(b, { status: "no_answer" });
    const plugin = new MemoryPluginStore();
    await plugin.insertApproval(
      approval({
        id: "appr-unique",
        ticketNumber: "VA-only",
        committedAt: new Date("2026-10-22T15:00:00Z"),
      }),
    );
    const extras = await extrasForReturnedCaller(PHONE, NOW, outbound, plugin);
    expect(extras).toEqual({});
  });

  it("the runtime teardown prefers the identified caller and never picks on phone", () => {
    const src = readFileSync(join(__dirname, "../runtime/voiceRuntime.ts"), "utf8");
    expect(src).toMatch(/callbackSessionFor/);
    expect(src).toMatch(/extrasForIdentifiedContact/);
    expect(src).toMatch(/extrasForReturnedCaller/);
    expect(src).toMatch(/hasTicketKeys/);
    expect(src).toMatch(/si-assistant/);
    expect(src.indexOf("identified = returnedSession")).toBeLessThan(src.indexOf("closeCallbackSession(record.callSid"));
  });
});
