import { createHmac } from "node:crypto";
import type { OperatorInboundCallRecord, OperatorSmsRecord, OperatorVoicemailRecord, PluginStore } from "./store";

type Env = Record<string, string | undefined>;
export type OperatorInboundRecord = OperatorInboundCallRecord | OperatorSmsRecord
  | (OperatorVoicemailRecord & { phase: "recording" | "transcript" });
export type OperatorInboundNotifier = (record: OperatorInboundRecord, requestId?: string) => Promise<void>;

export function operatorInboundSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** Explicit allowlist: never spread the stored record into a notification. */
export function operatorInboundPayload(record: OperatorInboundRecord, requestId?: string, deliveryAttempt = 1) {
  const eventId = "messageSid" in record ? `opline:sms:${record.messageSid}`
    : "recordingSid" in record ? `opline:vm:${record.recordingSid}:${record.phase}`
    : requestId ? `opline:${record.callSid}:request:${requestId}` : `opline:${record.callSid}:completed`;
  const delivery = { event_id: eventId, delivery_attempt: deliveryAttempt };
  if ("messageSid" in record) return {
    ...delivery,
    event: "operator_line.sms_received", message_sid: record.messageSid, message_url: record.fetchUrl,
    caller_last4: record.callerNumber?.replace(/\D/g, "").slice(-4) || null,
  };
  if ("recordingSid" in record) return {
    ...delivery,
    event: "operator_line.voicemail_received", call_sid: record.callSid, recording_sid: record.recordingSid,
    voicemail_url: record.fetchUrl,
  };
  return {
    ...delivery,
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
  store?: () => PluginStore | null;
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
    let claim: { store: PluginStore; eventId: string } | null = null;
    let delivered = false;
    // Never let a custom logger, serialization error, or network failure escape.
    try {
      if ("endedAt" in record && !record.endedAt && !requestId) return;
      const basePayload = operatorInboundPayload(record, requestId);
      let claimed = true;
      try {
        const store = deps.store?.();
        if (store) {
          claimed = await store.claimOperatorNotification(basePayload.event_id);
          if (claimed) claim = { store, eventId: basePayload.event_id };
        }
      } catch {
        // Migration/storage may be unavailable: receivers still have event_id.
        log("[operator-inbound] notification claim unavailable; sending");
      }
      if (!claimed) {
        log("[operator-inbound] duplicate suppressed");
        return;
      }
      // A timeout can follow successful receipt. Both attempts share one claim
      // and event_id; receivers MUST deduplicate on event_id before acting.
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timestamp = String(Math.floor((deps.now?.() ?? new Date()).getTime() / 1000));
          const payload = { ...basePayload, delivery_attempt: attempt + 1 };
          const references = "callId" in record ? [record.callId, record.transcriptUrl,
            ...record.queuedRequests.filter((item) => !requestId || item.id === requestId).map((item) => `${record.transcriptUrl}#request-${item.id}`)]
            : "messageSid" in record ? [record.messageSid, record.fetchUrl] : [record.callSid, record.recordingSid, record.fetchUrl];
          const rawBody = mode === "webhook" ? JSON.stringify(payload) : JSON.stringify({
            event_id: payload.event_id, delivery_attempt: payload.delivery_attempt,
            body: [`<!-- ${payload.event} event_id=${payload.event_id} delivery_attempt=${payload.delivery_attempt} -->`, ...references].join("\n"),
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
          headers["X-Operator-Event-Id"] = payload.event_id;
          const response = await Promise.race([
            request(url, { method: "POST", headers, body: rawBody, signal: controller.signal, redirect: "error" }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, deps.timeoutMs ?? 3000);
            }),
          ]);
          // The response body may contain private provider details; never log it.
          void response.body?.cancel().catch(() => undefined);
          if (!response.ok) throw new Error("notification refused");
          delivered = true;
          break;
        } catch {
          if (attempt === 1) log(`[operator-inbound] notifier=${mode} failed after two attempts`);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      if (delivered) log(`[operator-inbound] notifier=${mode} delivered`);
    } catch { /* best effort; the durable fetch endpoint remains available */ }
    finally {
      if (claim) {
        try {
          if (delivered) await claim.store.markOperatorNotificationDelivered(claim.eventId);
          else await claim.store.releaseOperatorNotification(claim.eventId);
        } catch { /* best effort if storage is unavailable */ }
      }
    }
  };
}
