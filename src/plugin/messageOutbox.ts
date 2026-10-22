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
    // last_error = stale_sending is persisted by reclaim. A restart that
    // redelivers a row which now has ticket keys is an attachmentUpdate —
    // the in-memory flag does not survive the process.
    const attachmentUpdate =
      !unmatched && (row.lastError === "stale_sending" || row.lastError === ATTACHMENT_UPDATE_ERROR);
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
      attachmentUpdate: attachmentUpdate || undefined,
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

type TicketStamp = {
  ticketId?: string | null;
  ticketNumber?: string | null;
  approvalId?: string | null;
};

function ticketStamp(row: TicketStamp): { ticketId: string | null; ticketNumber: string | null; approvalId: string | null } {
  return {
    ticketId: row.ticketId ?? null,
    ticketNumber: row.ticketNumber ?? null,
    approvalId: row.approvalId ?? null,
  };
}

function hasTicketStamp(row: TicketStamp): boolean {
  const s = ticketStamp(row);
  return Boolean(s.ticketId || s.ticketNumber || s.approvalId);
}

function ticketStampsDiffer(a: TicketStamp, b: TicketStamp): boolean {
  const left = ticketStamp(a);
  const right = ticketStamp(b);
  return left.ticketId !== right.ticketId || left.ticketNumber !== right.ticketNumber || left.approvalId !== right.approvalId;
}

const ATTACHMENT_UPDATE_ERROR = "attachment_update";

async function reportAttachmentUpdate(
  row: { id: string; idempotencyKey?: string | null } & TicketStamp,
  reporter: CallbackReporter,
): Promise<{ ok: boolean; error: string }> {
  try {
    const result = await reporter.report({
      event: "message",
      slug: SI_ASSISTANT_SLUG,
      ticketNumber: row.ticketNumber,
      approvalId: row.approvalId,
      ticketId: row.ticketId,
      identityConfirmed: true,
      outboxId: row.id,
      idempotencyKey: row.idempotencyKey ?? undefined,
      attachmentUpdate: true,
    });
    if (result.ok) return { ok: true, error: "" };
    return { ok: false, error: ATTACHMENT_UPDATE_ERROR };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      ok: false,
      error: name === "AbortError" ? "timeout" : ATTACHMENT_UPDATE_ERROR,
    };
  }
}

async function retryLater(
  store: PluginStore,
  row: MessageOutboxRow,
  error: string,
  now: Date,
): Promise<void> {
  const dead = row.attempts >= OUTBOX_MAX_ATTEMPTS;
  await store.markOutbox(
    row.id,
    {
      status: dead ? "dead" : "pending",
      lastError: error,
      nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(row.attempts)),
      updatedAt: now,
    },
    row.status === "delivered" ? "delivered" : "sending",
  );
  if (dead) {
    await noteDead(store, row);
  }
  console.error(`[si-assistant] outbox ${row.id} ${error}${dead ? " dead" : ""}`);
}

async function settleDelivery(
  store: PluginStore,
  row: MessageOutboxRow,
  delivered: { ok: boolean; error: string },
  now: Date,
  reporter: CallbackReporter | null = null,
): Promise<void> {
  if (delivered.ok) {
    const current = (await store.getOutbox(row.id)) ?? row;
    // Ticket keys live on the outbox row (persisted by attachOutboxTickets).
    // Compare before marking delivered so a 5xx on the follow-up can retry.
    if (reporter && hasTicketStamp(current) && ticketStampsDiffer(row, current)) {
      const follow = await reportAttachmentUpdate(
        { id: row.id, idempotencyKey: current.idempotencyKey ?? row.idempotencyKey, ...ticketStamp(current) },
        reporter,
      );
      if (!follow.ok) {
        await retryLater(store, row, follow.error, now);
        return;
      }
    }
    await store.markOutbox(
      row.id,
      { status: "delivered", lastError: null, message: "", updatedAt: now },
      "sending",
    );
    return;
  }
  await retryLater(store, row, delivered.error, now);
}

/** Test hook: finish an in-flight send the way flushOutboxRow does. */
export async function settleOutboxDelivery(
  store: PluginStore,
  row: MessageOutboxRow,
  delivered: { ok: boolean; error: string },
  now: Date,
  reporter: CallbackReporter | null = null,
): Promise<void> {
  await settleDelivery(store, row, delivered, now, reporter);
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
    if (row.status === "sending") {
      // Keys are already on the row. settleDelivery compares markOutbox's
      // current keys to the send snapshot and reports attachmentUpdate.
      continue;
    }
    if (row.status === "delivered" && reporter) {
      const follow = await reportAttachmentUpdate(row, reporter);
      if (!follow.ok) {
        await retryLater(store, row, follow.error, now);
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
  await settleDelivery(store, claimed, await deliverRow(claimed, reporter), now, reporter);
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
    await settleDelivery(store, row, await deliverRow(row, reporter), now, reporter);
  }
  return due.length;
}
