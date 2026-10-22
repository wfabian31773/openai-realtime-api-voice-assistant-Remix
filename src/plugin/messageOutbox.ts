/**
 * Durable taken-message outbox. Persist first, then tell the caller it
 * was taken. The webhook is a retryable delivery of a row that already
 * exists — a missing URL, a 5xx or a timeout must not un-take the
 * message. The body is PHI: never log it, never write it to
 * plugin_audit_log.
 */
import { createHash } from "node:crypto";
import {
  newId,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETENTION_MS,
  STALE_SENDING_MS,
  type MessageOutboxRow,
  type PluginStore,
} from "./store";
import { boundPluginStore } from "./bindings";
import { createCallbackReporter, type CallbackReporter } from "./callbackReport";
import { SI_ASSISTANT_SLUG } from "./siAssistantConstants";

const BACKOFF_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

export function outboxBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_MS * 2 ** exp, BACKOFF_CAP_MS);
}

export function outboxIdempotencyKey(callSid: string | null | undefined, message: string): string | null {
  if (!callSid) return null;
  return createHash("sha256").update(`${callSid}\n${message}`, "utf8").digest("hex");
}

export function phiFreeOutboxError(status?: number, failed?: "timeout" | "no_webhook" | "send_failed"): string {
  if (failed === "timeout") return "timeout";
  if (failed === "no_webhook") return "no_webhook";
  if (failed === "send_failed") return "send_failed";
  if (typeof status === "number") return `webhook_${status}`;
  return "send_failed";
}

export async function persistTakenMessage(
  input: {
    callSid?: string | null;
    ticketId?: string | null;
    ticketNumber?: string | null;
    approvalId?: string | null;
    message: string;
    suggestions?: Array<{ ticketNumber: string | null; approvalId: string | null }>;
  },
  now = new Date(),
  store: PluginStore | null = boundPluginStore(),
): Promise<MessageOutboxRow | null> {
  if (!store) return null;
  try {
    return await store.insertOutbox({
      id: newId(),
      callSid: input.callSid ?? null,
      ticketId: input.ticketId ?? null,
      ticketNumber: input.ticketNumber ?? null,
      approvalId: input.approvalId ?? null,
      message: input.message,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      idempotencyKey: outboxIdempotencyKey(input.callSid, input.message),
      suggestions: input.suggestions ?? [],
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    console.error("[si-assistant] outbox persist failed");
    return null;
  }
}

async function deliverRow(
  row: MessageOutboxRow,
  reporter: CallbackReporter | null,
): Promise<{ ok: boolean; error: string }> {
  if (!reporter) return { ok: false, error: phiFreeOutboxError(undefined, "no_webhook") };
  try {
    const unmatched = !row.ticketNumber && !row.approvalId && !row.ticketId;
    const result = await reporter.report({
      event: "message",
      slug: SI_ASSISTANT_SLUG,
      ticketNumber: row.ticketNumber,
      approvalId: row.approvalId,
      ticketId: row.ticketId,
      message: row.message,
      unmatched: unmatched || undefined,
      suggestions: unmatched && row.suggestions?.length ? row.suggestions : undefined,
      identityConfirmed: !unmatched || undefined,
      outboxId: row.id,
      idempotencyKey: row.idempotencyKey ?? undefined,
    });
    if (result.ok) return { ok: true, error: "" };
    return { ok: false, error: phiFreeOutboxError(result.status) };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      ok: false,
      error: phiFreeOutboxError(undefined, name === "AbortError" ? "timeout" : "send_failed"),
    };
  }
}

async function noteDead(store: PluginStore, row: MessageOutboxRow): Promise<void> {
  try {
    await store.writeAudit({
      tokenJti: "system",
      tool: "outbox_dead",
      route: "/api/plugin/v1/message_outbox",
      method: "SWEEP",
      approvalId: row.approvalId,
      ticketId: row.ticketId,
      outcome: "failed",
      httpStatus: 408,
    });
  } catch {
    console.error("[si-assistant] outbox dead audit failed");
  }
}

async function settleDelivery(
  store: PluginStore,
  row: MessageOutboxRow,
  delivered: { ok: boolean; error: string },
  now: Date,
): Promise<void> {
  if (delivered.ok) {
    await store.markOutbox(
      row.id,
      { status: "delivered", lastError: null, message: "", updatedAt: now },
      "sending",
    );
    return;
  }
  const dead = row.attempts >= OUTBOX_MAX_ATTEMPTS;
  await store.markOutbox(
    row.id,
    {
      status: dead ? "dead" : "pending",
      lastError: delivered.error,
      nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(row.attempts)),
      updatedAt: now,
    },
    "sending",
  );
  if (dead) await noteDead(store, row);
  console.error(`[si-assistant] outbox ${row.id} ${delivered.error}${dead ? " dead" : ""}`);
}

export async function reclaimStaleOutboxSending(
  store: PluginStore | null = boundPluginStore(),
  now = new Date(),
  staleMs = STALE_SENDING_MS,
): Promise<MessageOutboxRow[]> {
  if (!store) return [];
  return store.reclaimStaleOutboxSending(now, new Date(now.getTime() - staleMs));
}

async function noteExpired(store: PluginStore, id: string): Promise<void> {
  await store.writeAudit({
    tokenJti: "system",
    tool: "outbox_expired",
    route: `/api/plugin/v1/message_outbox/${id}`,
    method: "SWEEP",
    outcome: "expired",
    httpStatus: 410,
  });
}

export async function purgeOutboxRetention(
  store: PluginStore | null = boundPluginStore(),
  now = new Date(),
): Promise<{ bodies: number; expired: number }> {
  if (!store) return { bodies: 0, expired: 0 };
  const bodies = await store.purgeDeliveredOutboxBodies(now);
  const expiredIds = await store.listExpiredOutboxIds(new Date(now.getTime() - OUTBOX_RETENTION_MS));
  const audited: string[] = [];
  for (const id of expiredIds) {
    try {
      await noteExpired(store, id);
      audited.push(id);
    } catch {
      console.error("[si-assistant] outbox expired audit failed");
    }
  }
  if (audited.length) await store.deleteOutboxIds(audited);
  return { bodies, expired: audited.length };
}

/** Stamp ticket keys on a message taken before the caller was identified. */
export async function reattachTakenMessages(
  callSid: string | null | undefined,
  extras: { ticketId?: string | null; ticketNumber?: string | null; approvalId?: string | null },
  store: PluginStore | null = boundPluginStore(),
  reporter: CallbackReporter | null = createCallbackReporter(),
  now = new Date(),
): Promise<number> {
  if (!store || !callSid) return 0;
  if (!extras.ticketId && !extras.ticketNumber && !extras.approvalId) return 0;
  const rows = await store.attachOutboxTickets(callSid, extras, now);
  for (const row of rows) {
    if (row.status === "pending") {
      void flushOutboxRow(row, store, reporter, now).catch(() => {
        console.error("[si-assistant] outbox reattach flush failed");
      });
      continue;
    }
    if (row.status === "delivered" && reporter) {
      try {
        await reporter.report({
          event: "message",
          slug: SI_ASSISTANT_SLUG,
          ticketNumber: row.ticketNumber,
          approvalId: row.approvalId,
          ticketId: row.ticketId,
          message: row.message,
          identityConfirmed: true,
          outboxId: row.id,
          idempotencyKey: row.idempotencyKey ?? undefined,
        });
      } catch {
        console.error("[si-assistant] outbox reattach report failed");
      }
    }
  }
  return rows.length;
}

/** One delivery attempt of a just-persisted pending row. Sweep uses flushDueOutbox. */
export async function flushOutboxRow(
  row: MessageOutboxRow,
  store: PluginStore | null = boundPluginStore(),
  reporter: CallbackReporter | null = createCallbackReporter(),
  now = new Date(),
): Promise<void> {
  if (!store) return;
  // No webhook URL: leave the row pending. Do not count toward dead.
  if (!reporter) return;
  const claimed = await store.markOutbox(
    row.id,
    { status: "sending", attempts: row.attempts + 1, updatedAt: now },
    "pending",
  );
  if (!claimed) return;
  await settleDelivery(store, claimed, await deliverRow(claimed, reporter), now);
}

export async function flushDueOutbox(
  store: PluginStore | null = boundPluginStore(),
  reporter: CallbackReporter | null = createCallbackReporter(),
  now = new Date(),
  limit = 20,
): Promise<number> {
  if (!store) return 0;
  try {
    await reclaimStaleOutboxSending(store, now);
    await purgeOutboxRetention(store, now);
  } catch {
    console.error("[si-assistant] outbox reclaim/purge failed");
  }
  // Unset webhook: keep rows pending. Do not expire them toward dead.
  if (!reporter) return 0;
  const due = await store.claimDueOutbox(now, limit);
  for (const row of due) {
    await settleDelivery(store, row, await deliverRow(row, reporter), now);
  }
  return due.length;
}
