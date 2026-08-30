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
import { ACCEPT_WINDOW_MS, conferenceNameFor, performWarmTransfer } from "./warmTransfer";
import type { TransferOutcome, TransferTwilioOps } from "./warmTransfer";
import { TransferAcceptRegistry } from "./transferAccepts";
import { createTransferTwilioOps, type MinimalTwilioClient } from "./transferTwilioOps";
import { handleTransferAccept, handleTransferStatus } from "./transferAcceptWebhook";
import type { LaneCallMetadata } from "./laneRegistry";
import type { WebhookRequest, WebhookResponse } from "./voiceWebhook";

/** The path the office leg's <Gather> posts to. Mounted by voiceRuntime. */
export const TRANSFER_ACCEPT_PATH = "/voice/transfer-accept";

/** The path the office leg's terminal status posts to. Mounted by voiceRuntime. */
export const TRANSFER_STATUS_PATH = "/voice/transfer-status";

/** Per-call hooks the runtime supplies so the CALL's own record survives
 * the transfer — see WarmTransferDeps for why the mark precedes the
 * redirect (Codex, PR #230 round 2). */
export interface TransferLifecycleHooks {
  onCallerRedirectStarting?: () => void;
  onCallerRedirectFailed?: () => void;
  /** The attempt is starting: the dial plus the briefing-and-keypress
   * wait legitimately runs up to `expectedWaitMs` (the accept window),
   * far past any tool budget — the bridge must widen its dead-air
   * watchdog or it tears the caller down mid-wait and the office leg is
   * abandoned under a staffer hearing the briefing (Codex, PR #230
   * round 3). */
  onAttemptStarting?: (expectedWaitMs: number) => void;
  /** The attempt settled either way; normal watchdog budgets apply. */
  onAttemptSettled?: () => void;
}

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
  /** Builds the per-call handoff for a transfer-capable lane, in that
   * lane's OWN contract: the no-ivr family awaits a void callback that
   * throws a fixed slug on failure, while pcp receives a STRUCTURED
   * HandoffOutcome and no throw at all — its tool records the result on
   * the ticket either way, a throw skips that post-dial update, and a
   * bare void resolve reads as `ok: false` and records an
   * already-connected caller as FAILED (Codex, PR #230). */
  handoffFor(
    slug: string,
    metadata: LaneCallMetadata,
    hooks?: TransferLifecycleHooks,
  ): () => Promise<unknown>;
  /** The accept webhook body, for voiceRuntime to mount at TRANSFER_ACCEPT_PATH. */
  handleAccept(req: WebhookRequest): WebhookResponse;
  /** The office leg's terminal-status webhook, for TRANSFER_STATUS_PATH:
   * settles a dial that died without accepting the moment Twilio knows. */
  handleStatus(req: WebhookRequest): WebhookResponse;
  /** The caller's call ended. Abandon any office leg still ringing for it —
   * without this the office rings up to the full window after the caller
   * is gone, and can even accept into a completed leg (Codex, PR #230
   * round 2). The abandoned wait's own failure path hangs the leg up. */
  abandonFor(callerCallSid: string): void;
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
  }
  // The auth token is NOT a dialing credential: the accept webhook
  // validates Twilio's signature with it, so injected ops replace the
  // account SID but never this. Without it every office keypress gets the
  // expired-transfer hangup and every attempt times out or declines —
  // transfers must stay refused instead (Codex, PR #230 round 4).
  if (!env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
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

/**
 * PCP's `HandoffCallback` result vocabulary (pcpAgent.ts), mapped from the
 * transfer's own. NO_ANSWER and DECLINED both mean nobody accepted the
 * office leg; UNAVAILABLE (policy refused, or no destination configured)
 * is PCP's HANDOFF_UNAVAILABLE. The destination rides along on failure
 * too — 46 of 46 failed PCP handoffs in the 90 days to 2026-08-13
 * recorded no destination, which is why "were we dialling the retired
 * roster?" is unanswerable from the data (pcpAgent's own comment).
 */
export function toPcpHandoffOutcome(
  outcome: TransferOutcome,
):
  | { ok: true; destination?: string }
  | {
      ok: false;
      status: "HANDOFF_UNAVAILABLE" | "NO_ANSWER" | "FAILED";
      reason?: string;
      destination?: string;
    } {
  if (outcome.ok) return { ok: true, destination: outcome.destination };
  return {
    ok: false,
    status:
      outcome.status === "UNAVAILABLE"
        ? "HANDOFF_UNAVAILABLE"
        : outcome.status === "FAILED"
          ? "FAILED"
          : "NO_ANSWER",
    reason: outcome.reason,
    destination: outcome.destination,
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
  /** callerCallSid -> the office legs currently ringing for that caller,
   * so the caller ending can abandon them (Codex, PR #230 round 2). */
  const pendingByCaller = new Map<string, Set<string>>();
  /** Callers whose teardown already ran, sid -> ended-at. A caller can
   * disconnect while createOfficeLeg() is still awaiting Twilio: at that
   * moment pendingByCaller holds nothing, abandonFor is a no-op, and the
   * wait that registers when the create resolves would ring an orphaned
   * office leg toward a dead call for the full window (Codex, PR #230
   * round 5). Entries are pruned after the accept window — no create
   * started before the teardown can still be in flight by then. */
  const endedCallers = new Map<string, number>();

  const acceptUrl = `https://${options.domain}${TRANSFER_ACCEPT_PATH}`;
  const statusUrl = `https://${options.domain}${TRANSFER_STATUS_PATH}`;

  return {
    unavailableReason,

    handoffFor(
      slug: string,
      metadata: LaneCallMetadata,
      hooks?: TransferLifecycleHooks,
    ): () => Promise<unknown> {
      const attempt = async (): Promise<TransferOutcome> => {
        try {
          // Before anything dials: the whole attempt — dial, briefing,
          // keypress — is bounded by the accept window, and the bridge's
          // watchdog needs that budget, not the tool dispatch's 45
          // seconds (Codex, PR #230 round 3).
          hooks?.onAttemptStarting?.(ACCEPT_WINDOW_MS);
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
          return await performWarmTransfer(
            {
              callerCallSid: metadata.callSid,
              destination: policy.allowed ? policy.destination : null,
              briefing: briefingFor(slug, metadata, details),
            },
            {
              twilio: ops,
              awaitAccept: (officeCallSid) => {
                officeConferences.set(officeCallSid, conferenceNameFor(metadata.callSid));
                let forCaller = pendingByCaller.get(metadata.callSid);
                if (!forCaller) {
                  forCaller = new Set();
                  pendingByCaller.set(metadata.callSid, forCaller);
                }
                forCaller.add(officeCallSid);
                const wait = accepts.waitFor(officeCallSid).finally(() => {
                  officeConferences.delete(officeCallSid);
                  const remaining = pendingByCaller.get(metadata.callSid);
                  remaining?.delete(officeCallSid);
                  if (remaining && remaining.size === 0) pendingByCaller.delete(metadata.callSid);
                });
                // The caller's teardown can beat this registration — it
                // found nothing to abandon while the create was still in
                // flight. Abandon NOW; the failure path hangs the office
                // leg up rather than ringing it toward a dead call
                // (Codex, PR #230 round 5).
                if (endedCallers.has(metadata.callSid)) {
                  log(
                    `[runtime-xfer] caller ${metadata.callSid} ended before office leg ${officeCallSid} registered; abandoning`,
                  );
                  accepts.abandon(officeCallSid);
                }
                return wait;
              },
              acceptUrl,
              statusUrl,
              fromNumber: env.TWILIO_PHONE_NUMBER ?? "",
              callerId: env.TWILIO_PHONE_NUMBER,
              onCallerRedirectStarting: hooks?.onCallerRedirectStarting,
              onCallerRedirectFailed: hooks?.onCallerRedirectFailed,
              log,
            },
          );
        } finally {
          // The SIP path clears its side channel after the attempt; the
          // runtime must too. Call IDs are unique, so a kept entry retains
          // the caller's name, DOB, callback number and symptoms in a
          // process-wide map FOREVER — unbounded growth and long-lived PHI
          // in one leak (Codex, PR #230). A retried escalation rewrites
          // the entry before invoking the callback again, so deleting per
          // attempt loses nothing.
          escalationDetailsMap.delete(metadata.callId);
          // Restore the normal watchdog budget whatever way the attempt
          // ended. On a success the redirect is already ending the
          // stream, and the bridge ignores the re-arm once torn down.
          hooks?.onAttemptSettled?.();
        }
      };
      if (slug === "pcp") {
        // See handoffFor's interface doc: PCP records the STRUCTURED
        // outcome on its ticket, success or failure — never a throw.
        return async () => toPcpHandoffOutcome(await attempt());
      }
      return async () => {
        const outcome = await attempt();
        if (!outcome.ok) {
          // A fixed slug, because the text reaches the model — the
          // detailed reason stays in the server log (warmTransfer.ts).
          throw new Error(`handoff_failed:${outcome.status}`);
        }
      };
    },

    handleAccept(req: WebhookRequest): WebhookResponse {
      return handleTransferAccept(req, {
        env,
        accepts,
        conferenceFor: (officeCallSid) => officeConferences.get(officeCallSid),
        log,
      });
    },

    handleStatus(req: WebhookRequest): WebhookResponse {
      return handleTransferStatus(req, { env, accepts, log });
    },

    abandonFor(callerCallSid: string): void {
      // Remember the teardown FIRST, whether or not any leg is registered
      // yet: a createOfficeLeg still awaiting Twilio registers its wait
      // after this runs, and only this memory stops that orphaned leg
      // from ringing toward a dead call (Codex, PR #230 round 5).
      const nowMs = Date.now();
      for (const [sid, at] of endedCallers) {
        if (nowMs - at > ACCEPT_WINDOW_MS) endedCallers.delete(sid);
      }
      endedCallers.set(callerCallSid, nowMs);
      const legs = pendingByCaller.get(callerCallSid);
      if (!legs || legs.size === 0) return;
      // Abandoning settles each wait; performWarmTransfer's own failure
      // path then hangs the office leg up — the caller is gone, and a
      // staffer must not keep ringing toward (or accept into) a
      // completed leg (Codex, PR #230 round 2). Copy first: settling
      // mutates the set through the wait's finally.
      for (const officeCallSid of [...legs]) {
        log(`[runtime-xfer] caller ${callerCallSid} ended; abandoning office leg ${officeCallSid}`);
        accepts.abandon(officeCallSid);
      }
    },

    pendingAccepts: () => accepts.pendingCount(),
    pendingConferences: () => officeConferences.size,
  };
}
