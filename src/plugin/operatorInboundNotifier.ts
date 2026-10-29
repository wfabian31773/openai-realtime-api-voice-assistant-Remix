import { createHmac } from "node:crypto";
import type { OperatorInboundCallRecord, OperatorSmsRecord, OperatorVoicemailRecord } from "./store";

type Env = Record<string, string | undefined>;
export type OperatorInboundRecord = OperatorInboundCallRecord | OperatorSmsRecord | OperatorVoicemailRecord;
export type OperatorInboundNotifier = (record: OperatorInboundRecord, requestId?: string) => Promise<void>;

export function operatorInboundSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** Explicit allowlist: never spread the stored record into a notification. */
export function operatorInboundPayload(record: OperatorInboundRecord, requestId?: string) {
  if ("messageSid" in record) return {
    event: "operator_line.sms_received", message_sid: record.messageSid, message_url: record.fetchUrl,
    caller_last4: record.callerNumber?.replace(/\D/g, "").slice(-4) || null,
  };
  if ("recordingSid" in record) return {
    event: "operator_line.voicemail_received", call_sid: record.callSid, recording_sid: record.recordingSid,
    voicemail_url: record.fetchUrl,
  };
  return {
    event: requestId ? "operator_line.request_queued" : "operator_line.inbound_completed",
    ...(requestId ? { request_id: requestId } : {}),
    queued_requests: record.queuedRequests.filter((request) => !requestId || request.id === requestId).map((request) => ({
      request_id: request.id, request_url: `${record.transcriptUrl}#request-${request.id}`,
    })),
    call_id: record.callId, call_sid: record.callSid,
    started_at: record.startedAt.toISOString(), ended_at: record.endedAt?.toISOString() ?? null,
    duration_seconds: Math.max(0, Math.round(((record.endedAt ?? record.startedAt).getTime() - record.startedAt.getTime()) / 1000)),
    caller_last4: record.callerNumber?.replace(/\D/g, "").slice(-4) || null,
    opted_out: record.optedOut, transcript_url: record.transcriptUrl,
  };
}

function httpsUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function createOperatorInboundNotifier(env: Env, deps: {
  fetch?: typeof fetch; now?: () => Date; timeoutMs?: number;
  log?: (message: string) => void;
} = {}): OperatorInboundNotifier {
  const mode = env.OPERATOR_INBOUND_NOTIFIER ?? "none";
  const auth = env.OPERATOR_INBOUND_WEBHOOK_AUTH ?? "both";
  const webhookUrl = httpsUrl(env.OPERATOR_INBOUND_WEBHOOK_URL);
  const repo = env.OPERATOR_INBOUND_GITHUB_REPO ?? "";
  const issue = env.OPERATOR_INBOUND_GITHUB_ISSUE ?? "";
  const configured = mode === "webhook" ? webhookUrl && env.OPERATOR_INBOUND_WEBHOOK_SECRET && ["hmac", "bearer", "both"].includes(auth)
    : mode === "github" ? /^[\w.-]+\/[\w.-]+$/.test(repo) && /^[1-9]\d*$/.test(issue) && env.OPERATOR_INBOUND_GITHUB_TOKEN
    : false;
  if (!configured) return async () => {};
  const request = deps.fetch ?? fetch;
  const log = deps.log ?? ((message: string) => console.info(message));
  return async (record, requestId) => {
    // Never let a custom logger, serialization error, or network failure escape.
    try {
      if ("endedAt" in record && !record.endedAt && !requestId) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timestamp = String(Math.floor((deps.now?.() ?? new Date()).getTime() / 1000));
          const payload = operatorInboundPayload(record, requestId);
          const references = "callId" in record ? [record.callId, record.transcriptUrl,
            ...record.queuedRequests.filter((item) => !requestId || item.id === requestId).map((item) => `${record.transcriptUrl}#request-${item.id}`)]
            : "messageSid" in record ? [record.messageSid, record.fetchUrl] : [record.callSid, record.recordingSid, record.fetchUrl];
          const rawBody = mode === "webhook" ? JSON.stringify(payload) : JSON.stringify({
            body: [`<!-- ${payload.event} -->`, ...references].join("\n"),
          });
          const url = mode === "webhook" ? webhookUrl! : `https://api.github.com/repos/${repo}/issues/${issue}/comments`;
          const headers: Record<string, string> = mode === "webhook" ? {
            "Content-Type": "application/json",
            ...(auth !== "bearer" ? { "X-Operator-Timestamp": timestamp,
              "X-Operator-Signature": operatorInboundSignature(env.OPERATOR_INBOUND_WEBHOOK_SECRET!, timestamp, rawBody) } : {}),
            ...(auth !== "hmac" ? { Authorization: `Bearer ${env.OPERATOR_INBOUND_WEBHOOK_SECRET}` } : {}),
          } : {
            "Content-Type": "application/json", Accept: "application/vnd.github+json",
            Authorization: `Bearer ${env.OPERATOR_INBOUND_GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28",
          };
          const response = await Promise.race([
            request(url, { method: "POST", headers, body: rawBody, signal: controller.signal, redirect: "error" }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, deps.timeoutMs ?? 3000);
            }),
          ]);
          // The response body may contain private provider details; never log it.
          void response.body?.cancel().catch(() => undefined);
          if (!response.ok) throw new Error("notification refused");
          log(`[operator-inbound] notifier=${mode} delivered`);
          return;
        } catch {
          if (attempt === 1) log(`[operator-inbound] notifier=${mode} failed after two attempts`);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    } catch { /* best effort; the durable fetch endpoint remains available */ }
  };
}
