/**
 * Everything voiceRuntime needs to offer a real transfer, in one object.
 *
 * The pieces exist separately — the mechanism (`warmTransfer.ts`), the waiting
 * room (`transferAccepts.ts`), the Twilio adapter (`transferTwilioOps.ts`),
 * the accept webhook (`transferAcceptWebhook.ts`) — and this composes them so
 * `mountVoiceRuntime` adds one route and passes one callback builder to
 * `resolveLane`, instead of assembling five parts inline in a file that
 * already carries the stream lifecycle.
 *
 * ## The same side channel the SIP path uses, read at the same moment
 *
 * A factory handoff is `() => Promise<void>` — no arguments — so the caller
 * type and the reason cannot arrive through the call. On the SIP path the
 * agent's escalate tool writes `escalationDetailsMap` (keyed by callId) BEFORE
 * invoking the callback, and `addHumanAgent` reads it. This module reads the
 * identical map at the identical moment: pcpAgent, noIvrAgent, noIvrAgentV2
 * and azulSchedulingAgent all populate it already, unchanged. That is what
 * keeps "same exact agent, different voice pipeline" true for transfers —
 * the agent's own gates and its own side-channel write drive both transports.
 *
 * Destination policy is `resolveHandoffDestination`, the production rule:
 * lunch closure, caller-type gates, env-configured numbers. The model never
 * supplies a number on either path.
 */
import { escalationDetailsMap } from "../services/escalationStore";
import { resolveHandoffDestination } from "../services/handoffPolicy";
import { buildPcpTransferBriefing } from "../services/warmTransferBriefing";
import { ACCEPT_WINDOW_MS, conferenceNameFor, handoffCallbackFor } from "./warmTransfer";
import type { TransferTwilioOps } from "./warmTransfer";
import { TransferAcceptRegistry } from "./transferAccepts";
import { createTransferTwilioOps, type MinimalTwilioClient } from "./transferTwilioOps";
import { handleTransferAccept } from "./transferAcceptWebhook";
import type { LaneCallMetadata } from "./laneRegistry";
import type { WebhookRequest, WebhookResponse } from "./voiceWebhook";

/** The path the office leg's <Gather> posts to. Mounted by voiceRuntime. */
export const TRANSFER_ACCEPT_PATH = "/voice/transfer-accept";

export interface RuntimeTransferOptions {
  env: Record<string, string | undefined>;
  /** Injected for tests; defaults to a client built from env credentials. */
  ops?: TransferTwilioOps;
  /** Public host the accept URL is built on (no protocol). */
  domain?: string;
  log?: (line: string) => void;
}

export interface RuntimeTransfer {
  /** Null when transfers can work; otherwise the reason they cannot. When
   * non-null, voiceRuntime must NOT pass a handoff to resolveLane, so the
   * transfer-capable lanes keep being refused rather than served broken. */
  unavailableReason: string | null;
  /** Builds the per-call handoff for a transfer-capable lane. */
  handoffFor(slug: string, metadata: LaneCallMetadata): () => Promise<void>;
  /** The accept webhook body, for voiceRuntime to mount at TRANSFER_ACCEPT_PATH. */
  handleAccept(req: WebhookRequest): WebhookResponse;
  /** For health reporting. */
  pendingAccepts(): number;
  /** Office legs whose conference mapping is still held. Tracks
   * pendingAccepts exactly; a persistent gap between the two is the map
   * leaking — one orphaned entry per transfer, forever. */
  pendingConferences(): number;
}

/**
 * Why the transfer is unavailable, or null. Checked once at mount: a
 * deployment missing any of these serves the non-transfer lanes exactly as
 * before, and `laneSupportStatus` keeps refusing the rest with its own
 * logged reason.
 */
export function transferUnavailableReason(
  env: Record<string, string | undefined>,
  opts: { hasInjectedOps: boolean; domain?: string },
): string | null {
  const missing: string[] = [];
  if (!opts.hasInjectedOps) {
    if (!env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
    if (!env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  }
  if (!env.TWILIO_PHONE_NUMBER) missing.push("TWILIO_PHONE_NUMBER");
  if (!opts.domain) missing.push("DOMAIN (or REPLIT_DOMAINS)");
  return missing.length > 0 ? `transfer unavailable: missing ${missing.join(", ")}` : null;
}

function defaultOps(
  env: Record<string, string | undefined>,
  log: (line: string) => void,
): TransferTwilioOps {
  // Lazy: the twilio client is only constructed if a transfer is attempted,
  // so an unconfigured process still boots and the health check still answers.
  let ops: TransferTwilioOps | null = null;
  const get = async (): Promise<TransferTwilioOps> => {
    if (!ops) {
      const twilio = (await import("twilio")).default;
      const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
      ops = createTransferTwilioOps(client as unknown as MinimalTwilioClient, {
        fromNumber: env.TWILIO_PHONE_NUMBER ?? "",
        callerId: env.TWILIO_PHONE_NUMBER,
        log,
      });
    }
    return ops;
  };
  return {
    createOfficeLeg: async (input) => (await get()).createOfficeLeg(input),
    redirectCallerToConference: async (input) => (await get()).redirectCallerToConference(input),
    endCall: async (sid) => (await get()).endCall(sid),
  };
}

/** Who is calling and why, from the agent's own side-channel write. */
export function briefingFor(
  slug: string,
  metadata: LaneCallMetadata,
  details: { reason?: string; providerInfo?: string } | undefined,
): string {
  if (slug === "pcp") {
    return buildPcpTransferBriefing({
      providerInfo: details?.providerInfo,
      reason: details?.reason,
    });
  }
  const last4 = (metadata.callerPhone ?? "").replace(/\D/g, "").slice(-4);
  return [
    "This is the Azul Vision assistant with a live caller transfer.",
    last4 ? `Caller number ending ${last4}.` : null,
    details?.reason ? `Reason: ${details.reason}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function createRuntimeTransfer(options: RuntimeTransferOptions): RuntimeTransfer {
  const log = options.log ?? ((line: string) => console.log(line));
  const env = options.env;
  const unavailableReason = transferUnavailableReason(env, {
    hasInjectedOps: Boolean(options.ops),
    domain: options.domain,
  });

  const ops = options.ops ?? defaultOps(env, log);
  const accepts = new TransferAcceptRegistry({ windowMs: ACCEPT_WINDOW_MS, log });
  /** officeCallSid -> the conference its caller will be sent to. Written when
   * the wait begins, read by the accept webhook BEFORE the settle, dropped
   * after the wait ends either way. */
  const officeConferences = new Map<string, string>();

  const acceptUrl = `https://${options.domain}${TRANSFER_ACCEPT_PATH}`;

  return {
    unavailableReason,

    handoffFor(slug: string, metadata: LaneCallMetadata): () => Promise<void> {
      return handoffCallbackFor(
        () => {
          // Read at INVOKE time, not build time: the agent's escalate tool
          // writes the side channel during the call, after the factory ran.
          const details = escalationDetailsMap.get(metadata.callId);
          const policy = resolveHandoffDestination({
            agentSlug: slug,
            callerType: details?.callerType,
            callerRequestedHuman: details?.callerRequestedHuman,
            clinicalNumber: env.HUMAN_AGENT_NUMBER,
            pcpNumber: env.PCP_HUMAN_AGENT_NUMBER,
          });
          if (!policy.allowed) {
            log(`[runtime-xfer] policy refused ${slug}/${metadata.callId}: ${policy.reason}`);
          }
          return {
            callerCallSid: metadata.callSid,
            destination: policy.allowed ? policy.destination : null,
            briefing: briefingFor(slug, metadata, details),
          };
        },
        {
          twilio: ops,
          awaitAccept: (officeCallSid) => {
            officeConferences.set(officeCallSid, conferenceNameFor(metadata.callSid));
            return accepts
              .waitFor(officeCallSid)
              .finally(() => officeConferences.delete(officeCallSid));
          },
          acceptUrl,
          fromNumber: env.TWILIO_PHONE_NUMBER ?? "",
          callerId: env.TWILIO_PHONE_NUMBER,
          log,
        },
      );
    },

    handleAccept(req: WebhookRequest): WebhookResponse {
      return handleTransferAccept(req, {
        env,
        accepts,
        conferenceFor: (officeCallSid) => officeConferences.get(officeCallSid),
        log,
      });
    },

    pendingAccepts: () => accepts.pendingCount(),
    pendingConferences: () => officeConferences.size,
  };
}
