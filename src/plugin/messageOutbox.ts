/**
 * Durable taken-message outbox. Persist first, then tell the caller it
 * was taken. The webhook is a retryable delivery of a row that already
 * exists — a missing URL, a 5xx or a timeout must not un-take the
 * message. The body is PHI: never log it, never write it to
 * plugin_audit_log.
 */
import { newId, OUTBOX_MAX_ATTEMPTS, type MessageOutboxRow, type PluginStore } from "./store";
import { boundPluginStore } from "./bindings";
import { createCallbackReporter, type CallbackReporter } from "./callbackReport";
import { SI_ASSISTANT_SLUG } from "./siAssistantConstants";

const BACKOFF_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

export function outboxBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_MS * 2 ** exp, BACKOFF_CAP_MS);
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
    const result = await reporter.report({
      event: "message",
      slug: SI_ASSISTANT_SLUG,
      ticketNumber: row.ticketNumber,
      approvalId: row.approvalId,
      ticketId: row.ticketId,
      message: row.message,
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

async function settleDelivery(
  store: PluginStore,
  row: MessageOutboxRow,
  delivered: { ok: boolean; error: string },
  now: Date,
): Promise<void> {
  if (delivered.ok) {
    await store.markOutbox(row.id, { status: "delivered", lastError: null, updatedAt: now }, "sending");
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
  console.error(`[si-assistant] outbox ${row.id} ${delivered.error}${dead ? " dead" : ""}`);
}

/** One delivery attempt of a just-persisted pending row. Sweep uses flushDueOutbox. */
export async function flushOutboxRow(
  row: MessageOutboxRow,
  store: PluginStore | null = boundPluginStore(),
  reporter: CallbackReporter | null = createCallbackReporter(),
  now = new Date(),
): Promise<void> {
  if (!store) return;
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
  const due = await store.claimDueOutbox(now, limit);
  for (const row of due) {
    await settleDelivery(store, row, await deliverRow(row, reporter), now);
  }
  return due.length;
}
