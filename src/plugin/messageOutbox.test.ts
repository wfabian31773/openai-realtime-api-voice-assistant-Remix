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
import { MemoryPluginStore, OUTBOX_MAX_ATTEMPTS, OUTBOX_RETENTION_MS, STALE_SENDING_MS } from "./store";
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
