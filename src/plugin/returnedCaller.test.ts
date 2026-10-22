/**
 * Returned-caller ticket attach. Synthetic phones and ticket numbers only.
 * A phone match never attaches. Identified callers do. Everyone else
 * gets up to three suggestions.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SUGGESTION_LIMIT,
  attachmentForSiAssistant,
  extrasForIdentifiedContact,
  hasTicketKeys,
  mergeSuggestions,
  suggestionsForReturnedCaller,
  suggestionsFromPlacedContacts,
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
    channel: "sms",
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

describe("suggestionsFromPlacedContacts", () => {
  it("keeps a placed dial and skips queued or never-placed contacts", () => {
    const ranked = suggestionsFromPlacedContacts(
      [
        { lastAttemptAt: null, data: { approval_id: "queued", ticket_number: "VA-q" } },
        {
          lastAttemptAt: new Date(0),
          data: { approval_id: "zero", ticket_number: "VA-z" },
        },
        {
          lastAttemptAt: new Date("2026-10-22T12:00:00Z"),
          data: { approval_id: "dated", ticket_number: "VA-d" },
        },
      ],
      NOW,
    );
    expect(ranked.map((r) => r.suggestion)).toEqual([{ ticketNumber: "VA-d", approvalId: "dated" }]);
  });

  it("excludes a placed dial older than 72 hours", () => {
    const stale = new Date("2026-10-18T16:00:00Z");
    expect(NOW.getTime() - stale.getTime()).toBeGreaterThan(RETURNED_CALL_LOOKBACK_MS);
    expect(
      suggestionsFromPlacedContacts(
        [{ lastAttemptAt: stale, data: { approval_id: "stale", ticket_number: "VA-0" } }],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("mergeSuggestions", () => {
  it("caps at three, newest first, and dedupes by ticket key", () => {
    const merged = mergeSuggestions(
      [
        { suggestion: { ticketNumber: "VA-1", approvalId: "a" }, at: 1, key: "VA-1" },
        { suggestion: { ticketNumber: "VA-1", approvalId: "a-again" }, at: 2, key: "VA-1" },
        { suggestion: { ticketNumber: "VA-2", approvalId: "b" }, at: 3, key: "VA-2" },
        { suggestion: { ticketNumber: "VA-3", approvalId: "c" }, at: 4, key: "VA-3" },
        { suggestion: { ticketNumber: "VA-4", approvalId: "d" }, at: 5, key: "VA-4" },
      ],
      SUGGESTION_LIMIT,
    );
    expect(merged).toEqual([
      { ticketNumber: "VA-4", approvalId: "d" },
      { ticketNumber: "VA-3", approvalId: "c" },
      { ticketNumber: "VA-2", approvalId: "b" },
    ]);
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

describe("suggestionsForReturnedCaller", () => {
  it("suggests a placed campaign dial and does not attach", async () => {
    const outbound = new FakeOutboundStore(() => new Date("2026-10-22T16:00:00Z"));
    outbound.addContact({
      id: "c1",
      phone: PHONE,
      customData: { approval_id: "appr-1", ticket_number: "VA-61001", ticket_id: "tid-9" },
    });
    const attemptId = await outbound.startAttempt("c1", outbound.campaignId, 1);
    await outbound.finishAttempt(attemptId, { status: "no_answer" });
    const suggestions = await suggestionsForReturnedCaller(PHONE, NOW, outbound, null);
    expect(suggestions).toEqual([{ ticketNumber: "VA-61001", approvalId: "appr-1" }]);
    const attachment = await attachmentForSiAssistant({ phone: PHONE }, NOW, outbound, null);
    expect(attachment.identityConfirmed).toBe(false);
    expect(hasTicketKeys(attachment.extras)).toBe(false);
    expect(attachment.suggestions).toEqual(suggestions);
  });

  it("unions a placed dial with a sent text and skips a committed call", async () => {
    const outbound = new FakeOutboundStore(() => new Date("2026-10-22T14:00:00Z"));
    outbound.addContact({
      id: "c-a",
      phone: PHONE,
      customData: { approval_id: "appr-a", ticket_number: "VA-A", ticket_id: "ta" },
    });
    const placed = await outbound.startAttempt("c-a", outbound.campaignId, 1);
    await outbound.finishAttempt(placed, { status: "no_answer" });

    const plugin = new MemoryPluginStore();
    await plugin.insertApproval(
      approval({
        id: "appr-sms",
        channel: "sms",
        ticketNumber: "VA-B",
        ticketId: "tb",
        committedAt: new Date("2026-10-22T16:00:00Z"),
      }),
    );
    await plugin.insertApproval(
      approval({
        id: "appr-call",
        channel: "call",
        ticketNumber: "VA-C",
        ticketId: "tc",
        committedAt: new Date("2026-10-22T17:00:00Z"),
      }),
    );
    const suggestions = await suggestionsForReturnedCaller(PHONE, NOW, outbound, plugin);
    expect(suggestions).toEqual([
      { ticketNumber: "VA-B", approvalId: "appr-sms" },
      { ticketNumber: "VA-A", approvalId: "appr-a" },
    ]);
  });

  it("does not count unsent approvals or a committedAt of zero", async () => {
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
    expect(await suggestionsForReturnedCaller(PHONE, NOW, new FakeOutboundStore(), plugin)).toEqual([]);
  });

  it("caps the union at three newest tickets", async () => {
    const plugin = new MemoryPluginStore();
    for (const hour of [10, 12, 14, 16]) {
      await plugin.insertApproval(
        approval({
          id: `appr-${hour}`,
          ticketNumber: `VA-${hour}`,
          ticketId: `t-${hour}`,
          committedAt: new Date(`2026-10-22T${hour}:00:00Z`),
        }),
      );
    }
    expect(await suggestionsForReturnedCaller(PHONE, NOW, new FakeOutboundStore(), plugin)).toEqual([
      { ticketNumber: "VA-16", approvalId: "appr-16" },
      { ticketNumber: "VA-14", approvalId: "appr-14" },
      { ticketNumber: "VA-12", approvalId: "appr-12" },
    ]);
  });
});

describe("attachmentForSiAssistant", () => {
  it("does not attach a dialled contact until they said yes and the date of birth matches", async () => {
    const data = { approval_id: "appr-out", ticket_number: "VA-out", ticket_id: "tid-out" };
    const bare = await attachmentForSiAssistant({ outboundContactData: data, phone: PHONE }, NOW, new FakeOutboundStore(), null);
    expect(bare.identityConfirmed).toBe(false);
    expect(bare.extras).toEqual({});
    const confirmed = await attachmentForSiAssistant(
      { outboundContactData: data, greetingAffirmed: true, dobMatched: true, phone: PHONE },
      NOW,
      new FakeOutboundStore(),
      null,
    );
    expect(confirmed).toEqual({
      identityConfirmed: true,
      extras: { approvalId: "appr-out", ticketNumber: "VA-out", ticketId: "tid-out" },
      suggestions: [],
    });
    const noDob = await attachmentForSiAssistant(
      { outboundContactData: data, greetingAffirmed: true, dobMatched: false, phone: PHONE },
      NOW,
      new FakeOutboundStore(),
      null,
    );
    expect(noDob.identityConfirmed).toBe(false);
  });

  it("never attaches after wrong_person, even with a yes and a date match", async () => {
    const attachment = await attachmentForSiAssistant(
      {
        outboundContactData: { approval_id: "appr-out", ticket_number: "VA-out" },
        greetingAffirmed: true,
        dobMatched: true,
        wrongPerson: true,
        phone: PHONE,
      },
      NOW,
      new FakeOutboundStore(),
      null,
    );
    expect(attachment.identityConfirmed).toBe(false);
    expect(attachment.extras).toEqual({});
  });

  it("attaches the identified callback caller only after a full-name and date-of-birth match", async () => {
    const candidates = [
      {
        contactId: "bob",
        lastAttemptAt: new Date("2026-10-22T16:00:00Z"),
        data: { approval_id: "bob", ticket_number: "VA-bob" },
      },
      {
        contactId: "alice",
        lastAttemptAt: new Date("2026-10-22T10:00:00Z"),
        data: { approval_id: "alice", ticket_number: "VA-alice", ticket_id: "ta" },
      },
    ];
    const firstNameOnly = await attachmentForSiAssistant(
      { chosen: { contactId: "alice", verifiedBy: "first_name" }, candidates, phone: PHONE },
      NOW,
    );
    expect(firstNameOnly.identityConfirmed).toBe(false);
    expect(firstNameOnly.extras).toEqual({});
    const attachment = await attachmentForSiAssistant(
      { chosen: { contactId: "alice", verifiedBy: "full_name_dob" }, candidates, phone: PHONE },
      NOW,
    );
    expect(attachment.identityConfirmed).toBe(true);
    expect(attachment.extras).toEqual({ approvalId: "alice", ticketNumber: "VA-alice", ticketId: "ta" });
    expect(attachment.suggestions).toEqual([]);
  });

  it("never attaches on a phone match alone", async () => {
    const outbound = new FakeOutboundStore(() => new Date("2026-10-22T16:00:00Z"));
    outbound.addContact({
      id: "only",
      phone: PHONE,
      customData: { approval_id: "only", ticket_number: "VA-only" },
    });
    const attemptId = await outbound.startAttempt("only", outbound.campaignId, 1);
    await outbound.finishAttempt(attemptId, { status: "no_answer" });
    const attachment = await attachmentForSiAssistant({ phone: PHONE }, NOW, outbound, null);
    expect(attachment.identityConfirmed).toBe(false);
    expect(attachment.extras).toEqual({});
    expect(attachment.suggestions).toEqual([{ ticketNumber: "VA-only", approvalId: "only" }]);
  });
});

describe("runtime teardown identity", () => {
  it("uses the same attachment helper for the message and the call report", () => {
    const src = readFileSync(join(__dirname, "../runtime/voiceRuntime.ts"), "utf8");
    expect(src).toMatch(/callbackSessionFor/);
    expect(src).toMatch(/attachmentForSiAssistant/);
    expect(src).toMatch(/identifiedAttemptId/);
    expect(src).toMatch(/identifiedStore/);
    expect(src).not.toMatch(/extrasForReturnedCaller/);
    expect(src).not.toMatch(/matchPlacedContacts/);
    expect(src.indexOf("identified = returnedSession")).toBeLessThan(src.indexOf("closeCallbackSession(record.callSid"));
    expect(src.indexOf("identifiedAttemptId")).toBeLessThan(src.indexOf("closeCallbackSession(record.callSid"));
    expect(src.indexOf("shouldReportSiAssistantCall")).toBeLessThan(src.indexOf("attachmentForSiAssistant"));
    expect(src.indexOf("reattachTakenMessages")).toBeGreaterThan(src.indexOf("shouldReportSiAssistantCall"));
  });
});
