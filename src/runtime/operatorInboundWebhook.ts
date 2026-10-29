import { randomUUID } from "node:crypto";
import type { LiveTool } from "./agentBinding";
import type { CallSessionRegistry } from "./sessionRegistry";
import type { TranscriptTurn } from "./transcriptLog";
import { computeRuntimeReadiness } from "./readiness";
import {
  buildStreamTwiml, buildUnavailableTwiml, checkTwilioSignature, handleAfterRedirect, resolveRequestBase,
  twimlResponse, xmlEscape,
  type WebhookRequest, type WebhookResponse,
} from "./voiceWebhook";
import { E164, OPERATOR_SLUG, operatorFromProblem, operatorMaxDurationSec } from "../plugin/operatorLine";
import type { PluginStore } from "../plugin/store";
import type { OutboundStore } from "./outbound/store";
import { recordOperatorOptOut } from "../plugin/operatorOptOut";
import { createOperatorInboundNotifier, type OperatorInboundNotifier } from "../plugin/operatorInboundNotifier";
import { operatorLineEnabled } from "../plugin/operatorLineSettings";

export const OPERATOR_INBOUND_PATH = "/api/voice/operator-line/inbound";
export const OPERATOR_SMS_PATH = "/api/voice/operator-line/sms";
export const OPERATOR_FALLBACK_PATH = "/api/voice/operator-line/fallback";
export const OPERATOR_VOICEMAIL_PATH = "/api/voice/operator-line/voicemail";
const UNAVAILABLE = "I'm sorry, Wayne Fabian's operator line is unavailable right now. Please try again later. Goodbye.";
const empty = (): WebhookResponse => ({ status: 204, contentType: "text/plain", body: "" });

/** Uses the runtime's signature/public-URL and stream gate, without patient context. */
export class OperatorInboundWebhook {
  private readonly notify: OperatorInboundNotifier;
  private readonly completing = new Map<string, Promise<boolean>>();
  constructor(private readonly deps: {
    env: Record<string, string | undefined>;
    registry: CallSessionRegistry;
    store: () => PluginStore | null;
    outbound: () => Promise<OutboundStore>;
    notifier?: OperatorInboundNotifier;
    now?: () => Date;
  }) { this.notify = deps.notifier ?? createOperatorInboundNotifier(deps.env); }

  private signed(req: WebhookRequest): WebhookResponse | null {
    return checkTwilioSignature(req, this.deps.env) === "valid" ? null
      : { status: 403, contentType: "text/plain", body: "invalid signature" };
  }

  private addressed(req: WebhookRequest): boolean {
    return !operatorFromProblem(this.deps.env) && req.body.To === this.deps.env.OPERATOR_LINE_FROM_NUMBER?.trim();
  }

  private async available(req: WebhookRequest): Promise<boolean> {
    return this.addressed(req) && await operatorLineEnabled(this.deps.env, this.deps.store());
  }

  private fetchUrl(req: WebhookRequest, path: string): string {
    const { protocol, host } = resolveRequestBase(req);
    return `${protocol}://${host}/api/plugin/v1/operator-line/${path}`;
  }

  private start(req: WebhookRequest, store: PluginStore) {
    return store.startOperatorInboundCall({
      callId: randomUUID(), callSid: req.body.CallSid, laneSlug: OPERATOR_SLUG, direction: "inbound",
      callerNumber: E164.test(req.body.From ?? "") ? req.body.From : null,
      status: "in_progress", startedAt: this.deps.now?.() ?? new Date(), endedAt: null,
      turns: [], queuedRequests: [], optedOut: false, transcriptUrl: this.fetchUrl(req, `inbound/${req.body.CallSid}`),
    });
  }

  private voicemailTwiml(): WebhookResponse {
    // Twilio's native transcription supports recordings up to 120 seconds.
    // Explicit action prevents Twilio from requesting inbound again in a loop.
    return twimlResponse(200, `<Say>${xmlEscape("I'm sorry, Grok Bot is unavailable right now. You may leave a recorded voicemail after the beep. Hang up if you prefer not to be recorded.")}</Say>` +
      `<Record action="${OPERATOR_VOICEMAIL_PATH}" method="POST" maxLength="120" playBeep="true" transcribe="true"` +
      ` transcribeCallback="${OPERATOR_VOICEMAIL_PATH}" recordingStatusCallback="${OPERATOR_VOICEMAIL_PATH}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/><Hangup/>`);
  }

  async sms(req: WebhookRequest): Promise<WebhookResponse> {
    const denied = this.signed(req);
    if (denied) return denied;
    if (!this.addressed(req) || this.deps.env.OPERATOR_LINE_INBOUND_ENABLED !== "true") return twimlResponse(200, "");
    const messageSid = req.body.MessageSid;
    if (!/^(SM|MM)[0-9a-f]{32}$/i.test(messageSid ?? "") || typeof req.body.Body !== "string") {
      return { status: 400, contentType: "text/plain", body: "invalid SMS" };
    }
    try {
      const store = this.deps.store();
      // A deliberate kill acknowledges/discards new messages. A storage outage
      // must instead return 503 so a message is not silently lost as "disabled".
      if (!store) throw new Error("operator message storage unavailable");
      if (!(await store.getOperatorLineEnabled())) return twimlResponse(200, "");
      const record = await store.saveOperatorSms({ messageSid,
        callerNumber: E164.test(req.body.From ?? "") ? req.body.From : null, body: req.body.Body,
        receivedAt: this.deps.now?.() ?? new Date(), fetchUrl: this.fetchUrl(req, `sms/${messageSid}`) });
      if (record) void this.notify(record).catch(() => undefined);
      return twimlResponse(200, "");
    } catch {
      return { status: 503, contentType: "text/plain", body: "operator message storage unavailable" };
    }
  }

  /** Also suitable as the number's Twilio Voice Fallback URL. */
  async fallback(req: WebhookRequest): Promise<WebhookResponse> {
    const denied = this.signed(req);
    if (denied) return denied;
    if (!(await this.available(req))) return buildUnavailableTwiml(200, UNAVAILABLE);
    if (!/^CA[0-9a-f]{32}$/i.test(req.body.CallSid ?? "")) return { status: 400, contentType: "text/plain", body: "invalid CallSid" };
    const entry = this.deps.registry.get(req.body.CallSid);
    if (entry && !entry.operatorInbound) return buildUnavailableTwiml(200, UNAVAILABLE);
    try {
      await this.start(req, this.deps.store()!);
      return this.voicemailTwiml();
    } catch { return buildUnavailableTwiml(200, UNAVAILABLE); }
  }

  async voicemail(req: WebhookRequest): Promise<WebhookResponse> {
    const denied = this.signed(req);
    if (denied) return denied;
    const { CallSid: callSid, RecordingSid: recordingSid } = req.body;
    if (!/^CA[0-9a-f]{32}$/i.test(callSid ?? "") || !/^RE[0-9a-f]{32}$/i.test(recordingSid ?? "")) {
      return { status: 400, contentType: "text/plain", body: "invalid voicemail identifiers" };
    }
    try {
      const store = this.deps.store();
      // Callbacks can arrive after staff disables new admission. Preserve an
      // already accepted recording, but never attach one to a patient/SI call.
      if (!store || !(await store.getOperatorInboundCall(callSid))) {
        return { status: 404, contentType: "text/plain", body: "operator call not found" };
      }
      const record = await store.saveOperatorVoicemail({ recordingSid, callSid,
        recordingUrl: req.body.RecordingUrl || null, transcript: req.body.TranscriptionText || null,
        transcriptionStatus: req.body.TranscriptionStatus || null, receivedAt: this.deps.now?.() ?? new Date(),
        fetchUrl: this.fetchUrl(req, `voicemail/${recordingSid}`) });
      if (record) void this.notify(record).catch(() => undefined);
      return twimlResponse(200, "");
    } catch { return { status: 503, contentType: "text/plain", body: "operator voicemail storage unavailable" }; }
  }

  async inbound(req: WebhookRequest): Promise<WebhookResponse> {
    const denied = this.signed(req);
    if (denied) return denied;
    const { env, registry } = this.deps;
    if (operatorFromProblem(env) || req.body.To !== env.OPERATOR_LINE_FROM_NUMBER?.trim()) {
      return buildUnavailableTwiml(200, UNAVAILABLE);
    }
    if (!(await operatorLineEnabled(env, this.deps.store()))) {
      return buildUnavailableTwiml(200, UNAVAILABLE);
    }
    const callSid = req.body.CallSid;
    if (!/^CA[0-9a-f]{32}$/i.test(callSid ?? "")) return { status: 400, contentType: "text/plain", body: "invalid CallSid" };
    const existing = registry.get(callSid);
    if (existing && (!existing.operatorInbound || existing.slug !== OPERATOR_SLUG)) return buildUnavailableTwiml(200, UNAVAILABLE);
    try {
      const store = this.deps.store();
      if (!store) return buildUnavailableTwiml(200, UNAVAILABLE);
      // NO daily cap and NO peak window: inbound is an open operator line.
      const record = await this.start(req, store);
      if (record.endedAt) return buildUnavailableTwiml(200, UNAVAILABLE);
      if (!computeRuntimeReadiness(env).liveReady) return this.voicemailTwiml();
      const entry = registry.register({ callSid, slug: OPERATOR_SLUG, callerPhone: record.callerNumber ?? "",
        dialedNumber: req.body.To, operatorInbound: true, retentionMs: (operatorMaxDurationSec(env) + 600) * 1000 });
      return buildStreamTwiml(req, entry, `${OPERATOR_INBOUND_PATH}/after`, `${OPERATOR_INBOUND_PATH}/status`);
    } catch {
      console.error("[operator-inbound] admission storage unavailable");
      return buildUnavailableTwiml(200, UNAVAILABLE);
    }
  }

  async status(req: WebhookRequest): Promise<WebhookResponse> {
    const denied = this.signed(req);
    if (denied) return denied;
    // A claimed stream owns the final transcript. Stream-stop callbacks can
    // arrive before its teardown; they must never win with an empty snapshot.
    const terminal = ["completed", "failed", "busy", "no-answer", "canceled"].includes(req.body.CallStatus)
      || ["stream-stopped", "stream-error"].includes(req.body.StreamEvent);
    if (terminal && !this.deps.registry.get(req.body.CallSid)?.streamStarted) {
      await this.complete(req.body.CallSid, [], req.body.CallStatus || "provider_failure");
    }
    return empty();
  }

  async after(req: WebhookRequest): Promise<WebhookResponse> {
    const denied = this.signed(req);
    if (denied) return denied;
    const outcome = this.deps.registry.get(req.body.CallSid)?.outcome;
    const response = handleAfterRedirect(req, { env: this.deps.env, registry: this.deps.registry, laneIsAvailable: () => true });
    if (!(await this.available(req))) return buildUnavailableTwiml(200, UNAVAILABLE);
    // A failed provider setup or an unestablished stream offers voicemail.
    return outcome === "provider_failure" || outcome === "dead_air" || outcome == null ? this.fallback(req) : response;
  }

  complete(callSid: string, turns: TranscriptTurn[], status: string, endedAt = this.deps.now?.() ?? new Date()): Promise<boolean> {
    const pending = this.completing.get(callSid);
    if (pending) return pending;
    const work = this.finish(callSid, turns, status, endedAt);
    this.completing.set(callSid, work);
    void work.finally(() => this.completing.delete(callSid));
    return work;
  }

  private async finish(callSid: string, turns: TranscriptTurn[], status: string, endedAt: Date): Promise<boolean> {
    try {
      const record = await this.deps.store()?.finishOperatorInboundCall(callSid, endedAt, status, turns);
      if (record) void this.notify(record).catch(() => undefined);
      return Boolean(record);
    } catch {
      console.error("[operator-inbound] completion storage unavailable");
      return false;
    }
  }

  tools(callSid: string): LiveTool[] {
    return [
      { name: "end_call", description: "End the call after a brief goodbye.",
        parameters: { type: "object", properties: {} }, invoke: async () => ({ success: true, ended: true }) },
      { name: "queue_request_for_grok_bot", description: "Queue an action request privately for Grok Bot, then continue the conversation. Notification runs in the background; queued does not mean delivered or completed.",
        parameters: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
        invoke: async (_ctx, raw) => {
          const args = JSON.parse(raw);
          if (typeof args.request !== "string" || !args.request.trim()) {
            return { success: false, error: "A request is required." };
          }
          const request = { id: randomUUID(), text: args.request.trim(), createdAt: (this.deps.now?.() ?? new Date()).toISOString() };
          const record = await this.deps.store()?.appendOperatorInboundRequest(callSid, request);
          if (!record) return { success: false, error: "Request storage unavailable or call ended" };
          // Await durable storage only. Webhook retries and network latency must
          // never hold a function result or the next conversational turn open.
          void this.notify(record, request.id).catch(() => undefined);
          return { success: true, status: "queued", request_id: request.id };
        } },
      { name: "opt_out_of_calls", description: "Immediately record a request not to receive calls, then acknowledge and end the call. Do not ask for identifiers.",
        parameters: { type: "object", properties: {} }, invoke: async () => {
          const store = this.deps.store();
          const record = await store?.getOperatorInboundCall(callSid);
          if (!record?.callerNumber || !store) return { success: false, error: "Opt-out could not be saved; end politely without promising it was recorded." };
          await recordOperatorOptOut(record.callerNumber, store, this.deps.outbound);
          await store.setOperatorInboundOptOut(callSid);
          return { success: true, message: "Your request not to receive calls has been recorded. Goodbye." };
        } },
    ];
  }
}
