/**
 * Report an SI Assistant callback (or inbound SMS that is not STOP/HELP/START)
 * to the ticketing app so it can land on the ticket and in My Messages.
 *
 * Payload is PHI-bounded: callSid, ticket number, approval id, outcome,
 * duration. No phone numbers, bodies or transcripts. Failures are logged
 * by status only — never by the body we sent or received.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { SI_ASSISTANT_SLUG } from "./siAssistantConstants";

export const CALLBACK_REPORT_TIMEOUT_MS = 5_000;
/** Receiver rejects a timestamp older (or newer) than this. */
export const CALLBACK_SIGNATURE_MAX_AGE_SEC = 5 * 60;

export interface CallbackReport {
  event: "callback" | "inbound_sms" | "message";
  callSid?: string;
  slug: string;
  direction?: "inbound" | "outbound";
  outcome?: string;
  durationSeconds?: number;
  ticketNumber?: string | null;
  approvalId?: string | null;
  ticketId?: string | null;
  smsCommand?: string;
  /** Taken-message text. Delivered only to the ticketing webhook. Never logged. */
  message?: string;
  /** Inbound SMS sender (E.164). PHI. Delivered only to the webhook. Never logged. */
  from?: string;
  /** Twilio MessageSid of an inbound SMS. Receiver may dedupe on it. */
  messageSid?: string;
  /** No confirmed identity — SI Assistant My Messages should route it. */
  unmatched?: boolean;
  /** Ticket number + approval id only. Unmatched My Messages routing hints. */
  suggestions?: Array<{ ticketNumber: string | null; approvalId: string | null }>;
  /** The person we dialled, or name+DOB verified on the call. */
  identityConfirmed?: boolean;
  /** Outbox row id. Receiver dedupes redelivery on this. */
  outboxId?: string;
  /** sha256(callSid + "\\n" + message). Receiver dedupes redelivery on this. */
  idempotencyKey?: string;
  /**
   * Same outbox row as an earlier `message` event, now with ticket keys.
   * Ticketing must treat this as an UPDATE to that item, not a duplicate to drop.
   */
  attachmentUpdate?: boolean;
}

export type TicketExtras = {
  ticketNumber?: string | null;
  approvalId?: string | null;
  ticketId?: string | null;
  suggestions?: Array<{ ticketNumber: string | null; approvalId: string | null }>;
  identityConfirmed?: boolean;
};

export function extrasFromContactData(
  data: Record<string, unknown> | null | undefined,
): TicketExtras {
  if (!data) return {};
  return {
    ticketNumber: typeof data.ticket_number === "string" ? data.ticket_number : null,
    approvalId: typeof data.approval_id === "string" ? data.approval_id : null,
    ticketId: typeof data.ticket_id === "string" ? data.ticket_id : null,
  };
}

export interface CallbackReporter {
  report(payload: CallbackReport): Promise<{ ok: boolean; status?: number }>;
}

/** HMAC-SHA256 over `${unixSeconds}.${rawBody}`. */
export function signCallbackPayload(body: string, secret: string, timestamp: number | string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function verifyCallbackSignature(
  input: {
    body: string;
    secret: string;
    signature: string;
    timestamp: number | string;
    nowSec?: number;
    maxAgeSec?: number;
  },
): boolean {
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = input.maxAgeSec ?? CALLBACK_SIGNATURE_MAX_AGE_SEC;
  if (Math.abs(now - ts) > maxAge) return false;
  const expected = signCallbackPayload(input.body, input.secret, ts);
  try {
    const left = Buffer.from(expected, "hex");
    const right = Buffer.from(input.signature, "hex");
    if (left.length === 0 || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function createCallbackReporter(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): CallbackReporter | null {
  const url = (env.SI_ASSISTANT_CALLBACK_WEBHOOK_URL ?? "").trim();
  const secret = (env.SI_ASSISTANT_CALLBACK_WEBHOOK_SECRET ?? "").trim();
  if (!url || !secret) return null;
  return {
    async report(payload) {
      const body = JSON.stringify({ ...payload, slug: payload.slug || SI_ASSISTANT_SLUG });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signCallbackPayload(body, secret, timestamp);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALLBACK_REPORT_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SI-Assistant-Timestamp": String(timestamp),
            "X-SI-Assistant-Signature": signature,
          },
          body,
          signal: controller.signal,
        });
        return { ok: res.ok, status: res.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function shouldReportSiAssistantCall(slug: string): boolean {
  return slug === SI_ASSISTANT_SLUG;
}

export async function reportSiAssistantCall(
  record: {
    slug: string;
    callSid: string;
    direction?: "inbound" | "outbound";
    outcome: string;
    startedAtMs: number;
    endedAtMs: number;
  },
  extras: TicketExtras = {},
  reporter: CallbackReporter | null = null,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!shouldReportSiAssistantCall(record.slug)) return;
  const dest = reporter ?? createCallbackReporter(env);
  if (!dest) return;
  try {
    const result = await dest.report({
      event: "callback",
      callSid: record.callSid,
      slug: record.slug,
      direction: record.direction ?? "inbound",
      outcome: record.outcome,
      durationSeconds: Math.max(0, Math.round((record.endedAtMs - record.startedAtMs) / 1000)),
      ticketNumber: extras.ticketNumber ?? null,
      approvalId: extras.approvalId ?? null,
      ticketId: extras.ticketId ?? null,
      unmatched: !(extras.ticketNumber || extras.approvalId || extras.ticketId) || undefined,
      suggestions: extras.suggestions?.length ? extras.suggestions : undefined,
      identityConfirmed: extras.identityConfirmed || undefined,
    });
    if (!result.ok) {
      console.error(`[si-assistant] callback webhook returned ${result.status ?? "unknown"}`);
    }
  } catch {
    console.error("[si-assistant] callback webhook failed");
  }
}
