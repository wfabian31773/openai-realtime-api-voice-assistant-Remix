/**
 * Durable outbox: reclaim, dead audit, retention, idempotency.
 * Synthetic ids and messages only.
 */
import { describe, expect, it, vi } from "vitest";
import {
  flushDueOutbox,
  flushOutboxRow,
  persistTakenMessage,
  purgeOutboxRetention,
  reattachTakenMessages,
  reclaimStaleOutboxSending,
  settleOutboxDelivery,
} from "./messageOutbox";
import {
  ATTACHMENT_UPDATE_MAX_ATTEMPTS,
  MemoryPluginStore,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETENTION_MS,
  STALE_SENDING_MS,
} from "./store";
import { createSqlPluginStore } from "./sqlStore";
import type { CallbackReporter } from "./callbackReport";

describe("message outbox", () => {
  it("reclaims a stale sending row so the sweep can retry", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const row = await persistTakenMessage({ callSid: "CA" + "1".repeat(32), message: "hello" }, now, store);
    expect(row).toBeTruthy();
    await store.markOutbox(row!.id, { status: "sending", attempts: 1, updatedAt: now }, "pending");
    const fresh = await reclaimStaleOutboxSending(store, new Date(now.getTime() + STALE_SENDING_MS - 1));
    expect(fresh).toEqual([]);
    expect(store.outbox.get(row!.id)?.status).toBe("sending");

    const reclaimed = await reclaimStaleOutboxSending(store, new Date(now.getTime() + STALE_SENDING_MS + 1));
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].status).toBe("pending");
    expect(reclaimed[0].lastError).toBe("stale_sending");
  });

  it("audits a dead row with ids only and keeps the body out of the audit", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const persisted = await persistTakenMessage(
      { callSid: "CA" + "2".repeat(32), ticketId: "tid-1", approvalId: "appr-1", message: "secret body" },
      now,
      store,
    );
    expect(persisted).toBeTruthy();
    await store.markOutbox(
      persisted!.id,
      { attempts: OUTBOX_MAX_ATTEMPTS, updatedAt: now },
      "pending",
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await flushOutboxRow(
      { ...persisted!, attempts: OUTBOX_MAX_ATTEMPTS },
      store,
      {
        async report() {
          return { ok: false, status: 500 };
        },
      },
      now,
    );
    const row = [...store.outbox.values()][0];
    expect(row.status).toBe("dead");
    expect(row.lastError).toBe("webhook_500");
    const audit = await store.listAudit();
    const dead = audit.find((e) => e.tool === "outbox_dead");
    expect(dead).toMatchObject({
      approvalId: "appr-1",
      ticketId: "tid-1",
      outcome: "failed",
    });
    expect(JSON.stringify(dead)).not.toContain("secret body");
    expect(err.mock.calls.flat().join(" ")).not.toContain("secret body");
    err.mockRestore();
  });

  it("does not expire pending rows when the webhook URL is unset", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    await persistTakenMessage({ message: "keep me" }, now, store);
    expect(await flushDueOutbox(store, null, now)).toBe(0);
    const row = [...store.outbox.values()][0];
    expect(row.status).toBe("pending");
    expect(row.lastError).toBeNull();
    expect(row.attempts).toBe(0);
  });

  it("purges a delivered body and deletes an undelivered row after 30 days", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const delivered = await persistTakenMessage({ callSid: "CA" + "3".repeat(32), message: "gone" }, now, store);
    await store.markOutbox(delivered!.id, { status: "delivered", message: "gone", updatedAt: now });
    const stale = await persistTakenMessage(
      { callSid: "CA" + "4".repeat(32), message: "old" },
      new Date(now.getTime() - OUTBOX_RETENTION_MS - 1),
      store,
    );
    expect(stale).toBeTruthy();
    const purged = await purgeOutboxRetention(store, now);
    expect(purged.bodies).toBe(1);
    expect(purged.expired).toBe(1);
    expect(store.outbox.get(delivered!.id)?.message).toBe("");
    expect(store.outbox.has(stale!.id)).toBe(false);
    const expired = (await store.listAudit()).find((e) => e.tool === "outbox_expired");
    expect(expired).toMatchObject({
      tool: "outbox_expired",
      route: `/api/plugin/v1/message_outbox/${stale!.id}`,
      outcome: "expired",
      httpStatus: 410,
    });
    expect(JSON.stringify(expired)).not.toContain("old");
    expect(JSON.stringify(expired)).not.toContain("gone");
  });

  it("the retention purge clears the sender and MessageSid with the body", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const messageSid = "SM" + "4".repeat(32);
    const row = await persistTakenMessage(
      { message: "Please call me", fromPhone: "+15555550199", messageSid, inboundSms: true },
      now,
      store,
    );
    await store.markOutbox(row!.id, { status: "delivered", updatedAt: now });
    const purged = await purgeOutboxRetention(store, now);
    expect(purged.bodies).toBe(1);
    const after = store.outbox.get(row!.id)!;
    expect(after.message).toBe("");
    expect(after.fromPhone).toBeNull();
    expect(after.messageSid).toBeNull();
    // A second pass finds nothing left to purge.
    expect((await purgeOutboxRetention(store, now)).bodies).toBe(0);
  });

  it("the SQL purge nulls from_phone and message_sid as well as the body", async () => {
    const seen: string[] = [];
    const sqlStore = createSqlPluginStore(async (text) => {
      seen.push(text);
      return [];
    });
    await sqlStore.purgeDeliveredOutboxBodies(new Date("2026-10-22T18:00:00Z"));
    expect(seen[0]).toMatch(/SET message = '', from_phone = NULL, message_sid = NULL/);
    expect(seen[0]).toMatch(/from_phone IS NOT NULL OR message_sid IS NOT NULL/);
  });

  it("two senders with the same text and no MessageSid get two rows", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const a = await persistTakenMessage(
      { message: "Is my order ready?", fromPhone: "+15555550101", messageSid: null, inboundSms: true },
      now,
      store,
    );
    const b = await persistTakenMessage(
      { message: "Is my order ready?", fromPhone: "+15555550102", messageSid: "", inboundSms: true },
      now,
      store,
    );
    expect(a!.id).not.toBe(b!.id);
    expect(store.outbox.size).toBe(2);
    expect(a!.idempotencyKey).toMatch(/^sms-nosid:/);
    expect(b!.idempotencyKey).toMatch(/^sms-nosid:/);
    expect(a!.idempotencyKey).not.toBe(b!.idempotencyKey);
    expect(a!.idempotencyKey!.length).toBeLessThanOrEqual(64);
    expect(store.outbox.get(b!.id)?.fromPhone).toBe("+15555550102");
  });

  it("writes the expiry audit before deleting, and keeps the row if the audit throws", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const stale = await persistTakenMessage(
      { callSid: "CA" + "7".repeat(32), message: "keep" },
      new Date(now.getTime() - OUTBOX_RETENTION_MS - 1),
      store,
    );
    expect(stale).toBeTruthy();
    const original = store.writeAudit.bind(store);
    store.writeAudit = async () => {
      throw new Error("audit down");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const purged = await purgeOutboxRetention(store, now);
    expect(purged.expired).toBe(0);
    expect(store.outbox.has(stale!.id)).toBe(true);
    store.writeAudit = original;
    const ok = await purgeOutboxRetention(store, now);
    expect(ok.expired).toBe(1);
    expect(store.outbox.has(stale!.id)).toBe(false);
    err.mockRestore();
  });

  it("sends the outbox id and idempotency key so a redelivery can be deduped", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const posted: Array<Record<string, unknown>> = [];
    const persisted = await persistTakenMessage(
      {
        callSid: "CA" + "6".repeat(32),
        message: "callback please",
        suggestions: [{ ticketNumber: "VA-1", approvalId: "appr-1" }],
      },
      now,
      store,
    );
    expect(persisted).toBeTruthy();
    await flushOutboxRow(
      persisted!,
      store,
      {
        async report(payload) {
          posted.push(payload as unknown as Record<string, unknown>);
          return { ok: true, status: 200 };
        },
      },
      now,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0].outboxId).toBe(persisted!.id);
    expect(posted[0].idempotencyKey).toBe(persisted!.idempotencyKey);
    expect(posted[0].unmatched).toBe(true);
    expect(posted[0].suggestions).toEqual([{ ticketNumber: "VA-1", approvalId: "appr-1" }]);
  });

  it("the SQL insert conflicts on the idempotency key and markOutbox writes attempts", async () => {
    const seen: string[] = [];
    const store = createSqlPluginStore(async (text) => {
      seen.push(text);
      return [];
    });
    await store.insertOutbox({
      id: "obx",
      callSid: "CA" + "5".repeat(32),
      ticketId: null,
      ticketNumber: null,
      approvalId: null,
      message: "hi",
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      idempotencyKey: "abc",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(seen[0]).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    expect(seen[0]).toMatch(/idempotency_key/);
    seen.length = 0;
    await store.markOutbox("obx", { status: "sending", attempts: 2, updatedAt: new Date() }, "pending");
    expect(seen[0]).toMatch(/attempts = COALESCE/);
    seen.length = 0;
    await store.listExpiredOutboxIds(new Date());
    expect(seen[0]).toMatch(/SELECT id FROM plugin_message_outbox/);
    expect(seen[0]).not.toMatch(/DELETE/);
    seen.length = 0;
    await store.deleteOutboxIds(["obx"]);
    expect(seen[0]).toMatch(/DELETE FROM plugin_message_outbox/);
    expect(seen[0]).toMatch(/id = ANY/);
    expect(seen[0]).toMatch(/status IN \('pending', 'sending', 'dead'\)/);
  });

  it("queues a follow-up attach update when the row is mid-send, same outbox id and key", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const sid = "CA" + "8".repeat(32);
    const persisted = await persistTakenMessage(
      { callSid: sid, message: "Taken before identify" },
      now,
      store,
    );
    expect(persisted).toBeTruthy();
    await store.markOutbox(persisted!.id, { status: "sending", attempts: 1, updatedAt: now }, "pending");
    const sendSnapshot = { ...store.outbox.get(persisted!.id)! };
    expect(sendSnapshot.ticketNumber).toBeNull();

    const posted: Array<Record<string, unknown>> = [];
    const reporter: CallbackReporter = {
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    };

    const n = await reattachTakenMessages(
      sid,
      { ticketId: "tid-9", ticketNumber: "VA-61001", approvalId: "appr-1" },
      store,
      reporter,
      now,
    );
    expect(n).toBe(1);
    expect(store.outbox.get(persisted!.id)?.status).toBe("sending");
    expect(store.outbox.get(persisted!.id)?.ticketNumber).toBe("VA-61001");
    expect(posted).toEqual([]);

    await settleOutboxDelivery(store, sendSnapshot, { ok: true, error: "" }, now, reporter);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      event: "message",
      attachmentUpdate: true,
      outboxId: persisted!.id,
      idempotencyKey: persisted!.idempotencyKey,
      ticketNumber: "VA-61001",
      approvalId: "appr-1",
      ticketId: "tid-9",
      identityConfirmed: true,
    });
    expect(posted[0].message).toBeUndefined();
    expect(store.outbox.get(persisted!.id)?.status).toBe("delivered");
  });

  it("retries an attachmentUpdate when the receiver returns 5xx", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const sid = "CA" + "b".repeat(32);
    const persisted = await persistTakenMessage(
      { callSid: sid, message: "Taken before identify" },
      now,
      store,
    );
    expect(persisted).toBeTruthy();
    await store.markOutbox(persisted!.id, { status: "sending", attempts: 1, updatedAt: now }, "pending");
    const sendSnapshot = { ...store.outbox.get(persisted!.id)! };
    await reattachTakenMessages(
      sid,
      { ticketId: "tid-5xx", ticketNumber: "VA-61003", approvalId: "appr-5xx" },
      store,
      { async report() { return { ok: true, status: 200 }; } },
      now,
    );

    let updates = 0;
    const posted: Array<Record<string, unknown>> = [];
    const reporter: CallbackReporter = {
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        if (payload.attachmentUpdate) {
          updates += 1;
          if (updates === 1) return { ok: false, status: 503 };
        }
        return { ok: true, status: 200 };
      },
    };

    await settleOutboxDelivery(store, sendSnapshot, { ok: true, error: "" }, now, reporter);
    // The message itself was delivered; only the follow-up is owed.
    const owed = store.outbox.get(persisted!.id)!;
    expect(owed.status).toBe("delivered");
    expect(owed.deliveredAt).toEqual(now);
    expect(owed.attachmentPending).toBe(true);
    expect(owed.attachmentAttempts).toBe(1);
    expect(owed.lastError).toBe("attachment_update");
    expect(owed.attachmentNextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());

    const later = new Date(now.getTime() + 30_000);
    await flushDueOutbox(store, reporter, later);
    expect(updates).toBe(2);
    expect(posted.filter((p) => p.attachmentUpdate === true)).toHaveLength(2);
    // The redelivery is the follow-up alone, never the message again.
    expect(posted.filter((p) => p.message !== undefined)).toHaveLength(0);
    expect(store.outbox.get(persisted!.id)?.status).toBe("delivered");
    expect(store.outbox.get(persisted!.id)?.attachmentPending).toBe(false);
  });

  it("a failed follow-up never makes a delivered message dead and never notes it dead", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const sid = "CA" + "e".repeat(32);
    const persisted = await persistTakenMessage({ callSid: sid, message: "Delivered then keyed" }, now, store);
    await store.markOutbox(persisted!.id, { status: "sending", attempts: OUTBOX_MAX_ATTEMPTS, updatedAt: now }, "pending");
    const sendSnapshot = { ...store.outbox.get(persisted!.id)! };
    await reattachTakenMessages(sid, { ticketId: "tid-x", ticketNumber: "VA-61009", approvalId: null }, store, null, now);

    let updates = 0;
    const reporter: CallbackReporter = {
      async report(payload) {
        if (payload.attachmentUpdate) {
          updates += 1;
          return { ok: false, status: 503 };
        }
        return { ok: true, status: 200 };
      },
    };
    // The send attempt is at the outbox cap; under the old rule a failed
    // follow-up here would have dead-lettered a delivered message.
    await settleOutboxDelivery(store, sendSnapshot, { ok: true, error: "" }, now, reporter);
    expect(store.outbox.get(persisted!.id)?.status).toBe("delivered");
    expect(store.outbox.get(persisted!.id)?.attachmentPending).toBe(true);

    let t = now.getTime();
    for (let i = 0; i < ATTACHMENT_UPDATE_MAX_ATTEMPTS + 2; i += 1) {
      t += 31 * 60 * 1000;
      await flushDueOutbox(store, reporter, new Date(t));
    }
    const row = store.outbox.get(persisted!.id)!;
    expect(updates).toBe(ATTACHMENT_UPDATE_MAX_ATTEMPTS);
    expect(row.status).toBe("delivered");
    expect(row.attachmentPending).toBe(false);
    expect(row.lastError).toBe("attachment_update_exhausted");
    const audit = await store.listAudit();
    expect(audit.some((e) => e.tool === "outbox_dead")).toBe(false);
    expect(audit.filter((e) => e.tool === "outbox_attachment_update_exhausted")).toHaveLength(1);
  });

  it("a delivered row re-keyed later owes the follow-up when the webhook fails, staying delivered", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const sid = "CA" + "f".repeat(32);
    const persisted = await persistTakenMessage({ callSid: sid, message: "Delivered unmatched" }, now, store);
    await flushOutboxRow(persisted!, store, { async report() { return { ok: true, status: 200 }; } }, now);
    expect(store.outbox.get(persisted!.id)?.status).toBe("delivered");

    await reattachTakenMessages(
      sid,
      { ticketId: "tid-d", ticketNumber: "VA-61010", approvalId: null },
      store,
      { async report() { return { ok: false, status: 502 }; } },
      now,
    );
    const row = store.outbox.get(persisted!.id)!;
    expect(row.status).toBe("delivered");
    expect(row.attachmentPending).toBe(true);
    expect((await store.listAudit()).some((e) => e.tool === "outbox_dead")).toBe(false);
  });

  it("a stale reclaim with no confirmed 2xx is a first delivery, not an attachmentUpdate", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const sid = "CA" + "a".repeat(32);
    const persisted = await persistTakenMessage(
      { callSid: sid, message: "Taken then the process died" },
      now,
      store,
    );
    expect(persisted).toBeTruthy();
    await store.markOutbox(persisted!.id, { status: "sending", attempts: 1, updatedAt: now }, "pending");
    const n = await reattachTakenMessages(
      sid,
      { ticketId: "tid-r", ticketNumber: "VA-61002", approvalId: "appr-r" },
      store,
      { async report() { return { ok: true, status: 200 }; } },
      now,
    );
    expect(n).toBe(1);
    expect(store.outbox.get(persisted!.id)?.status).toBe("sending");
    expect(store.outbox.get(persisted!.id)?.ticketNumber).toBe("VA-61002");

    // Process dies before settleDelivery. Reclaim persists stale_sending.
    const later = new Date(now.getTime() + STALE_SENDING_MS + 1);
    const reclaimed = await reclaimStaleOutboxSending(store, later);
    expect(reclaimed[0]?.lastError).toBe("stale_sending");
    expect(reclaimed[0]?.ticketNumber).toBe("VA-61002");

    const posted: Array<Record<string, unknown>> = [];
    const reporter: CallbackReporter = {
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    };
    await flushDueOutbox(store, reporter, later);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      event: "message",
      outboxId: persisted!.id,
      idempotencyKey: persisted!.idempotencyKey,
      ticketNumber: "VA-61002",
      approvalId: "appr-r",
      ticketId: "tid-r",
      identityConfirmed: true,
      message: "Taken then the process died",
    });
    expect(posted[0].attachmentUpdate).toBeUndefined();
    expect(store.outbox.get(persisted!.id)?.status).toBe("delivered");
  });

  it("a redelivery of a row with a confirmed 2xx is an attachmentUpdate", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const persisted = await persistTakenMessage({ callSid: "CA" + "c".repeat(32), message: "Confirmed once" }, now, store);
    // A row the receiver already accepted that is back in the queue keyed.
    await store.markOutbox(persisted!.id, {
      deliveredAt: now,
      ticketNumber: "VA-61011",
      lastError: "stale_sending",
      updatedAt: now,
    });
    const posted: Array<Record<string, unknown>> = [];
    await flushDueOutbox(
      store,
      {
        async report(payload) {
          posted.push(payload as unknown as Record<string, unknown>);
          return { ok: true, status: 200 };
        },
      },
      now,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0].attachmentUpdate).toBe(true);
  });

  it("an inbound SMS keys on its MessageSid and carries the sender to the webhook", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const messageSid = "SM" + "1".repeat(32);
    const first = await persistTakenMessage(
      { message: "Please call me", fromPhone: "+15555550199", messageSid },
      now,
      store,
    );
    const retry = await persistTakenMessage(
      { message: "Please call me", fromPhone: "+15555550199", messageSid },
      now,
      store,
    );
    expect(first!.idempotencyKey).toBe(`sms:${messageSid}`);
    expect(retry!.id).toBe(first!.id);
    expect(store.outbox.size).toBe(1);

    const posted: Array<Record<string, unknown>> = [];
    const reporter: CallbackReporter = {
      async report(payload) {
        posted.push(payload as unknown as Record<string, unknown>);
        return { ok: true, status: 200 };
      },
    };
    await flushOutboxRow(first!, store, reporter, now);
    await flushOutboxRow(retry!, store, reporter, now);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      event: "message",
      from: "+15555550199",
      messageSid,
      idempotencyKey: `sms:${messageSid}`,
      unmatched: true,
    });
  });

  it("the SQL store persists the sender, MessageSid and the delivery markers", async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const store = createSqlPluginStore(async (text, params) => {
      seen.push({ text, params: params ?? [] });
      return [];
    });
    await store.insertOutbox({
      id: "obx",
      callSid: null,
      ticketId: null,
      ticketNumber: null,
      approvalId: null,
      message: "hi",
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      idempotencyKey: "sms:SM" + "2".repeat(32),
      fromPhone: "+15555550199",
      messageSid: "SM" + "2".repeat(32),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(seen[0].text).toMatch(/from_phone, message_sid/);
    expect(seen[0].params).toContain("+15555550199");
    seen.length = 0;
    const at = new Date("2026-10-22T18:00:00Z");
    await store.markOutbox("obx", { deliveredAt: at, attachmentPending: true, attachmentAttempts: 1 }, "delivered");
    expect(seen[0].text).toMatch(/delivered_at = COALESCE/);
    expect(seen[0].text).toMatch(/attachment_pending = COALESCE/);
    expect(seen[0].params).toContain(at.toISOString());
    expect(seen[0].params).toContain(true);
    seen.length = 0;
    await store.claimDueAttachmentUpdates(at, new Date(at.getTime() + 1000), 5);
    expect(seen[0].text).toMatch(/status = 'delivered'/);
    expect(seen[0].text).toMatch(/AND attachment_pending/);
    expect(seen[0].text).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it("does not delete a delivered row when expiry ids are re-checked", async () => {
    const store = new MemoryPluginStore();
    const now = new Date("2026-10-22T18:00:00Z");
    const delivered = await persistTakenMessage({ callSid: "CA" + "9".repeat(32), message: "kept" }, now, store);
    expect(delivered).toBeTruthy();
    await store.markOutbox(delivered!.id, { status: "delivered", message: "", updatedAt: now });
    expect(await store.deleteOutboxIds([delivered!.id])).toBe(0);
    expect(store.outbox.has(delivered!.id)).toBe(true);
  });
});
