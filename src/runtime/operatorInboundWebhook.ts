import { randomUUID } from "node:crypto";
import type { LiveTool } from "./agentBinding";
import type { CallSessionRegistry } from "./sessionRegistry";
import type { TranscriptTurn } from "./transcriptLog";
import { computeRuntimeReadiness } from "./readiness";
import {
  buildStreamTwiml, buildUnavailableTwiml, checkTwilioSignature, handleAfterRedirect, resolveRequestBase,
  type WebhookRequest, type WebhookResponse,
} from "./voiceWebhook";
import { E164, OPERATOR_SLUG, operatorFromProblem } from "../plugin/operatorLine";
import type { PluginStore } from "../plugin/store";
import type { OutboundStore } from "./outbound/store";
import { recordOperatorOptOut } from "../plugin/operatorOptOut";
import { createOperatorInboundNotifier, type OperatorInboundNotifier } from "../plugin/operatorInboundNotifier";

export const OPERATOR_INBOUND_PATH = "/api/voice/operator-line/inbound";
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

  async inbound(req: WebhookRequest): Promise<WebhookResponse> {
    const denied = this.signed(req);
    if (denied) return denied;
    const { env, registry } = this.deps;
    if (operatorFromProblem(env) || req.body.To !== env.OPERATOR_LINE_FROM_NUMBER?.trim()) {
      return buildUnavailableTwiml(200, UNAVAILABLE);
    }
    if (env.OPERATOR_LINE_INBOUND_ENABLED !== "true" || !computeRuntimeReadiness(env).liveReady) {
      return buildUnavailableTwiml(200, UNAVAILABLE);
    }
    const callSid = req.body.CallSid;
    if (!/^CA[0-9a-f]{32}$/i.test(callSid ?? "")) return { status: 400, contentType: "text/plain", body: "invalid CallSid" };
    const existing = registry.get(callSid);
    if (existing && (!existing.operatorInbound || existing.slug !== OPERATOR_SLUG)) return buildUnavailableTwiml(200, UNAVAILABLE);
    try {
      const store = this.deps.store();
      if (!store) return buildUnavailableTwiml(200, UNAVAILABLE);
      const { protocol, host } = resolveRequestBase(req);
      const record = await store.startOperatorInboundCall({
        callId: randomUUID(), callSid, laneSlug: OPERATOR_SLUG, direction: "inbound",
        callerNumber: E164.test(req.body.From ?? "") ? req.body.From : null,
        status: "in_progress", startedAt: this.deps.now?.() ?? new Date(), endedAt: null,
        turns: [], requestSummary: null, optedOut: false,
        transcriptUrl: `${protocol}://${host}/api/plugin/v1/operator-line/inbound/${callSid}`,
      });
      if (record.endedAt) return buildUnavailableTwiml(200, UNAVAILABLE);
      const entry = registry.register({ callSid, slug: OPERATOR_SLUG, callerPhone: record.callerNumber ?? "",
        dialedNumber: req.body.To, operatorInbound: true });
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

  after(req: WebhookRequest): WebhookResponse {
    const denied = this.signed(req);
    if (denied) return denied;
    const outcome = this.deps.registry.get(req.body.CallSid)?.outcome;
    const response = handleAfterRedirect(req, { env: this.deps.env, registry: this.deps.registry, laneIsAvailable: () => true });
    // Operator calls cannot promise an office follow-up after a runtime fault.
    return outcome === "provider_failure" || outcome === "dead_air" ? buildUnavailableTwiml(200, UNAVAILABLE) : response;
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
      { name: "record_call_outcome", description: "Save the request only after reading it back and receiving the caller's confirmation. Exclude patient, medical, and identity information.",
        parameters: { type: "object", properties: { request_summary: { type: "string" }, confirmed: { type: "boolean" } }, required: ["request_summary", "confirmed"] },
        invoke: async (_ctx, raw) => {
          const args = JSON.parse(raw);
          if (args.confirmed !== true || typeof args.request_summary !== "string" || !args.request_summary.trim() || args.request_summary.length > 2000) {
            return { success: false, error: "Read back a short request summary and obtain confirmation first." };
          }
          const store = this.deps.store();
          if (!store) return { success: false, error: "Request storage unavailable" };
          await store.updateOperatorInboundRequest(callSid, { requestSummary: args.request_summary.trim() });
          return { success: true };
        } },
      { name: "opt_out_of_calls", description: "Immediately record a request not to receive calls, then acknowledge and end the call. Do not ask for identifiers.",
        parameters: { type: "object", properties: {} }, invoke: async () => {
          const store = this.deps.store();
          const record = await store?.getOperatorInboundCall(callSid);
          if (!record?.callerNumber || !store) return { success: false, error: "Opt-out could not be saved; end politely without promising it was recorded." };
          await recordOperatorOptOut(record.callerNumber, store, this.deps.outbound);
          await store.updateOperatorInboundRequest(callSid, { optedOut: true });
          return { success: true, message: "Your request not to receive calls has been recorded. Goodbye." };
        } },
    ];
  }
}
