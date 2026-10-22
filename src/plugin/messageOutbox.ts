/**
 * Durable taken-message outbox. Persist first, then tell the caller it
 * was taken. The webhook is a retryable delivery of a row that already
 * exists — a missing URL, a 5xx or a timeout must not un-take the
 * message. The body is PHI: never log it, never write it to
 * plugin_audit_log.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ATTACHMENT_UPDATE_MAX_ATTEMPTS,
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

const TWILIO_MESSAGE_SID = /^(SM|MM)[0-9a-f]{32}$/i;

/** Inbound SMS idempotency: one row per Twilio MessageSid, so a webhook retry dedupes. */
export function smsIdempotencyKey(messageSid: string | null | undefined): string | null {
  const sid = (messageSid ?? "").trim();
  return TWILIO_MESSAGE_SID.test(sid) ? `sms:${sid}` : null;
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
    /** Inbound SMS sender. PHI: persisted and forwarded, never logged. */
    fromPhone?: string | null;
    /** Twilio MessageSid of an inbound SMS. Keys the row's idempotency. */
    messageSid?: string | null;
    /** True for an inbound SMS. With no usable MessageSid it gets a unique key. */
    inboundSms?: boolean;
  },
  now = new Date(),
  store: PluginStore | null = boundPluginStore(),
): Promise<MessageOutboxRow | null> {
  if (!store) return null;
  const smsKey = smsIdempotencyKey(input.messageSid);
  // An inbound SMS without a MessageSid has nothing to dedupe on. A key built
  // from the (absent) callSid and the text would merge two senders who wrote
  // the same words, so it gets a random key: never deduped, never merged.
  const idempotencyKey =
    smsKey ??
    (input.inboundSms ? `sms-nosid:${randomUUID()}` : outboxIdempotencyKey(input.callSid, input.message));
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
      idempotencyKey,
      suggestions: input.suggestions ?? [],
      fromPhone: input.fromPhone ?? null,
      messageSid: smsKey ? (input.messageSid ?? "").trim() : null,
      deliveredAt: null,
      attachmentPending: false,
      attachmentAttempts: 0,
      attachmentNextAttemptAt: null,
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
    // Only a row the receiver already accepted (a persisted 2xx) can be an
    // attachmentUpdate. A stale_sending reclaim with no confirmed 2xx is a
    // first delivery as far as anyone can prove.
    const attachmentUpdate = !unmatched && Boolean(row.deliveredAt);
    const result = await reporter.report({
      event: "message",
      slug: SI_ASSISTANT_SLUG,
      ticketNumber: row.ticketNumber,
      approvalId: row.approvalId,
      ticketId: row.ticketId,
      message: row.message,
      from: row.fromPhone || undefined,
      messageSid: row.messageSid || undefined,
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
  // Only an undelivered row comes here. A delivered row owes at most an
  // attachmentUpdate, which has its own budget (scheduleAttachmentRetry).
  const dead = row.attempts >= OUTBOX_MAX_ATTEMPTS;
  await store.markOutbox(
    row.id,
    {
      status: dead ? "dead" : "pending",
      lastError: error,
      nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(row.attempts)),
      updatedAt: now,
    },
    "sending",
  );
  if (dead) {
    await noteDead(store, row);
  }
  console.error(`[si-assistant] outbox ${row.id} ${error}${dead ? " dead" : ""}`);
}

const ATTACHMENT_UPDATE_EXHAUSTED = "attachment_update_exhausted";

async function noteAttachmentUpdateExhausted(store: PluginStore, row: MessageOutboxRow): Promise<void> {
  try {
    await store.writeAudit({
      tokenJti: "system",
      tool: "outbox_attachment_update_exhausted",
      route: "/api/plugin/v1/message_outbox",
      method: "SWEEP",
      approvalId: row.approvalId,
      ticketId: row.ticketId,
      outcome: "failed",
      httpStatus: 408,
    });
  } catch {
    console.error("[si-assistant] outbox attachment audit failed");
  }
}

/**
 * The message is delivered; only the ticket-key follow-up failed. Keep the
 * row delivered and owe the follow-up, retried by the sweep on its own
 * backoff. Running out of attempts stops retrying — it never makes the
 * message dead.
 */
async function scheduleAttachmentRetry(
  store: PluginStore,
  row: MessageOutboxRow,
  error: string,
  now: Date,
): Promise<void> {
  const attempts = (row.attachmentAttempts ?? 0) + 1;
  const exhausted = attempts >= ATTACHMENT_UPDATE_MAX_ATTEMPTS;
  await store.markOutbox(
    row.id,
    {
      attachmentPending: !exhausted,
      attachmentAttempts: attempts,
      attachmentNextAttemptAt: new Date(now.getTime() + outboxBackoffMs(attempts)),
      lastError: exhausted ? ATTACHMENT_UPDATE_EXHAUSTED : error,
      updatedAt: now,
    },
    "delivered",
  );
  if (exhausted) await noteAttachmentUpdateExhausted(store, row);
  console.error(`[si-assistant] outbox ${row.id} ${exhausted ? ATTACHMENT_UPDATE_EXHAUSTED : error}`);
}

async function sendAttachmentUpdate(
  store: PluginStore,
  row: MessageOutboxRow,
  reporter: CallbackReporter,
  now: Date,
): Promise<boolean> {
  const follow = await reportAttachmentUpdate(row, reporter);
  if (follow.ok) {
    if (row.attachmentPending) {
      await store.markOutbox(row.id, { attachmentPending: false, lastError: null, updatedAt: now }, "delivered");
    }
    return true;
  }
  await scheduleAttachmentRetry(store, row, follow.error, now);
  return false;
}

async function settleDelivery(
  store: PluginStore,
  row: MessageOutboxRow,
  delivered: { ok: boolean; error: string },
  now: Date,
  reporter: CallbackReporter | null = null,
): Promise<void> {
  if (delivered.ok) {
    // Persist the confirmed 2xx first. Whatever the follow-up does, this
    // message is delivered and must never become dead.
    const confirmed = { status: "delivered" as const, deliveredAt: now, lastError: null, message: "", updatedAt: now };
    const current =
      (await store.markOutbox(row.id, confirmed, "sending")) ??
      // A stale reclaim may have put it back to pending mid-send.
      (await store.markOutbox(row.id, confirmed, "pending"));
    if (!current) return;
    // Ticket keys live on the outbox row (persisted by attachOutboxTickets).
    // Keys stamped during the send are owed to the receiver as an update.
    if (reporter && hasTicketStamp(current) && ticketStampsDiffer(row, current)) {
      await sendAttachmentUpdate(store, current, reporter, now);
    }
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
    if (row.status === "delivered") {
      if (reporter) {
        await sendAttachmentUpdate(store, row, reporter, now);
      } else {
        // No webhook right now: owe the update; the sweep sends it later.
        await store.markOutbox(
          row.id,
          { attachmentPending: true, attachmentNextAttemptAt: now, lastError: row.lastError, updatedAt: now },
          "delivered",
        );
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
  const owed = await store.claimDueAttachmentUpdates(now, new Date(now.getTime() + STALE_SENDING_MS), limit);
  for (const row of owed) {
    await sendAttachmentUpdate(store, row, reporter, now);
  }
  return due.length + owed.length;
}
