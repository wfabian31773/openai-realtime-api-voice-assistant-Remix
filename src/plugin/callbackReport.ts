/**
 * Report an SI Assistant callback (or inbound SMS that is not STOP/HELP/START)
 * to the ticketing app so it can land on the ticket and in My Messages.
 *
 * Payload is PHI-bounded: callSid, ticket number, approval id, outcome,
 * duration. No phone numbers, bodies or transcripts. Failures are logged
 * by status only — never by the body we sent or received.
 */

import { createHmac } from "node:crypto";
import { SI_ASSISTANT_SLUG } from "./siAssistantConstants";

export const CALLBACK_REPORT_TIMEOUT_MS = 5_000;

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
}

export function extrasFromContactData(
  data: Record<string, unknown> | null | undefined,
): { ticketNumber?: string | null; approvalId?: string | null; ticketId?: string | null } {
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

export function signCallbackPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
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
      const signature = signCallbackPayload(body, secret);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALLBACK_REPORT_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
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
  extras: { ticketNumber?: string | null; approvalId?: string | null; ticketId?: string | null } = {},
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
    });
    if (!result.ok) {
      console.error(`[si-assistant] callback webhook returned ${result.status ?? "unknown"}`);
    }
  } catch {
    console.error("[si-assistant] callback webhook failed");
  }
}
