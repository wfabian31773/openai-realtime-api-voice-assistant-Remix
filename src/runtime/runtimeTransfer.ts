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
import { escalationDetailsMap, type EscalationDetails } from "../services/escalationStore";
import { resolveHandoffDestination } from "../services/handoffPolicy";
import { buildPcpTransferBriefing } from "../services/warmTransferBriefing";
import {
  newTransferAttemptId,
  recordRuntimeTransferOutcome,
  type RuntimeTransferOutcome,
  type TransferAttemptId,
} from "./transferOutcomeLog";
import { ACCEPT_WINDOW_MS, conferenceNameFor, performWarmTransfer } from "./warmTransfer";
import { performBlindTransfer } from "./blindTransfer";
import { defaultUrgentTransferAlerts, type UrgentTransferAlerts } from "./urgentTransferAlerts";
import { URGENT_TRANSFER_NOT_ANSWERED, buildUrgentTransferSms, urgentAlertTime } from "../services/urgentTransferAlert";
import { verifiedIdentityFor } from "../tools/verifiedIdentity";
import { decideRoute } from "./onCall/routing";
import type { OnCallConfig } from "./onCall/config";
import type { OnCallRunner, WarmOutcome } from "./onCall/runner";
import type { ChainPlan, RotationData } from "./onCall/rotation";
import { levelLabel } from "./onCall/rotation";
import { storedDetails, type OnCallMode, type OnCallStore, type Query, type RoutingFacts, type StoredDetails } from "./onCall/store";
import {
  handleBlindDialResult,
  type PendingBlindDial,
} from "./blindTransferDialResult";
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

/** The path a BLIND transfer's `<Dial>` posts its finished result to. */
export const TRANSFER_DIAL_RESULT_PATH = "/voice/transfer-dial-result";

/**
 * WHICH LANES HAND THE CALLER STRAIGHT TO THE QUEUE.
 *
 * PCP only, and by operator decision rather than by capability: its
 * destination is a call centre (`PCP_HUMAN_AGENT_NUMBER`), asked and answered
 * 2026-09-08 — *"No, it's a call center."* Every other transfer-capable lane
 * dials a place where a specific person picks up, and there the warm path's
 * proof-of-answer is worth the wait it costs.
 *
 * Overridable per deployment because this is a live behaviour change on the
 * busiest lane and reverting it must not need a code change:
 * `RUNTIME_TRANSFER_MODE=warm` puts every lane back on the warm path;
 * `blind` puts every lane on the blind one. Anything else, including unset,
 * is the per-lane default above.
 */
export function transferModeFor(
  slug: string,
  env: Record<string, string | undefined>,
): "warm" | "blind" {
  const override = env.RUNTIME_TRANSFER_MODE?.trim().toLowerCase();
  if (override === "warm" || override === "blind") return override;
  return slug === "pcp" ? "blind" : "warm";
}

/**
 * WHOSE NUMBER THE QUEUE SEES WHEN THE BLIND TRANSFER RINGS IT.
 *
 * The caller's own, whenever caller ID gave us a real one. Operator,
 * 2026-10-10: *"is there anyway to maintain the original calling number? Right
 * now all calls to the queue get our number."* They did because this file
 * passed `TWILIO_PHONE_NUMBER` as the `<Dial callerId>`, so every one of the
 * 392 PCP queue transfers of the fourteen days to 2026-10-10 reached the call
 * centre showing the AI line's number rather than the office that rang.
 *
 * WHY THIS IS ALLOWED, and why only on the blind path: the blind transfer
 * redirects the caller's OWN inbound leg into a `<Dial>`, and Twilio permits
 * an inbound call's `From` as the caller ID of a dial it makes — the same
 * value it uses when `callerId` is left off, and the shape Twilio recommends
 * for forwarding under STIR/SHAKEN. The warm path dials a NEW REST leg, where
 * presenting a number we do not own needs a `CallToken`; it is not touched.
 *
 * TEN TO FIFTEEN DIGITS OR OURS. A withheld caller ID arrives as a word
 * ("anonymous") — 22 of 2,112 PCP calls in the same window — and a callerId
 * Twilio refuses fails the dial, which would strand a caller who asked for a
 * person. So anything that is not a plain E.164 subscriber number keeps the
 * number we have always sent.
 *
 * `RUNTIME_QUEUE_CALLER_ID=ours` restores the previous behaviour on every
 * call without a code change, the `RUNTIME_TRANSFER_MODE` revert pattern.
 * Anything else, including unset, is the caller's number.
 */
export function queueCallerIdFor(
  callerPhone: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const ours = env.TWILIO_PHONE_NUMBER;
  if (env.RUNTIME_QUEUE_CALLER_ID?.trim().toLowerCase() === "ours") return ours;
  const theirs = callerPhone?.trim();
  if (theirs && /^\+[1-9]\d{9,14}$/.test(theirs)) return theirs;
  return ours;
}

/** Per-call hooks the runtime supplies so the CALL's own record survives
 * the transfer — see WarmTransferDeps for why the mark precedes the
 * redirect (Codex, PR #230 round 2). */
export interface TransferLifecycleHooks {
  onCallerRedirectStarting?: (method: "warm" | "blind") => void;
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
  /**
   * Where a settled outcome is written. Injected for tests; production leaves
   * it unset and gets the dynamic `callRecord` import, which is what keeps a
   * database connection out of the runtime's boot path.
   *
   * It is a SEAM rather than a convenience. Two call sites reach the writer —
   * the transfer settling, and a blind transfer's dial result arriving later
   * on its own HTTP request — and a test that cannot see both cannot tell a
   * wired dial-result callback from an unwired one. Mocking the module instead
   * proved unreliable across the two call paths, which is a fragile thing to
   * rest the only proof of a write on.
   */
  persistOutcome?: (callerCallSid: string, outcome: RuntimeTransferOutcome) => void;
  /**
   * The heads-up text before a clinical dial and the urgent ticket after one
   * that rang out. Injected for tests; production gets the env-built sender in
   * `urgentTransferAlerts.ts`. A SEAM for the same reason `persistOutcome` is:
   * both are fire-and-forget, and a test that cannot see them cannot tell a
   * wired alert from a missing one — which is exactly how the after-hours line
   * moved here on 2026-10-01 without either.
   */
  urgentAlerts?: UrgentTransferAlerts;
  /**
   * THE AFTER-HOURS ON-CALL ROTATION (v268). When present and switched on
   * (`ON_CALL_ROTATION_MODE=test|live`), an urgent call on the after-hours lane
   * rings the week's on-call provider (or a post-op patient's surgeon) instead
   * of `HUMAN_AGENT_NUMBER`, texts them the full details first, and hands what
   * happened to the runner, which retries, nudges and escalates to the region's
   * medical director and then the final director. Absent or off: today's path,
   * byte for byte. See `docs/ON_CALL_ROTATION.md`.
   */
  onCall?: OnCallTransferWiring;
  log?: (line: string) => void;
}

/** What the transfer needs from the on-call system. Injected so tests see it. */
export interface OnCallTransferWiring {
  runner: Pick<OnCallRunner, "afterInCallTransfer">;
  config: OnCallConfig;
  store: Pick<OnCallStore, "available" | "loadRotation" | "getEscalationByCall">;
  rotation: { get(): Promise<RotationData> };
  /** The Console query, or null when the Console is not configured. */
  consoleQuery: Query | null;
  /** The call's CERTAIN identity's person_id. Default: the identity store. */
  personIdFor?: (callSid: string) => string | undefined;
  sendSms(input: { to: string; from: string; body: string }): Promise<{ sid: string }>;
  now?: () => Date;
  /** Tests only: `HANDOFF_RESULT_WAIT_MS`, `HANDOFF_SETTLE_MS` and `CHAIN_READ_WAIT_MS` by default. */
  handoffResultWaitMs?: number;
  handoffSettleMs?: number;
  chainReadWaitMs?: number;
}

/**
 * The lanes whose urgent calls go to the on-call rotation: the after-hours line
 * only. no-ivr-v2 and dev-no-ivr can transfer too, but their agents do not know
 * the chain's "already paging" refusal (CHAIN_RUNNING) and would read it as a
 * failed transfer, so they keep today's path until they do.
 */
export const ON_CALL_LANES: ReadonlySet<string> = new Set(["no-ivr"]);

/**
 * The refusal reason for a second escalation on a call whose on-call chain is
 * already running. The handoff throws `handoff_failed:CHAIN_RUNNING` for it,
 * which the after-hours agent answers with its own directive: the chain is
 * still paging, so the caller is not told the transfer "could not be placed".
 */
export const ON_CALL_CHAIN_RUNNING = "on_call_chain_already_running";

/**
 * The refusal reason for a second escalation while this call's first one is
 * still handing its chain to the runner: the in-call dial is over, but whether
 * the chain's row opened is not known yet. The handoff throws
 * `handoff_failed:CHAIN_PENDING`, whose directive claims neither that the team
 * is being paged nor that it is not (review of #514).
 */
export const ON_CALL_CHAIN_PENDING = "on_call_chain_still_being_handed_over";

/**
 * The slug the after-hours agent hears when its own escalation started the
 * on-call chain and the in-call transfer was not taken: the chain carries on
 * calling the provider and then the directors, so the caller is told the
 * on-call team is being paged, not only that nobody could be reached.
 */
export const HANDOFF_CHAIN_STARTED = "handoff_failed:CHAIN_STARTED";

/** How long the dial waits for the full-details text to be accepted before it rings. */
export const PRE_DIAL_SMS_WAIT_MS = 2_000;
/** How long the runner hand-off waits for that text's answer before recording it as unknown. */
export const PRE_DIAL_SMS_RECORD_MS = 10_000;
/**
 * How long a not-taken dial waits for the hand-off to say whether the chain's
 * row is open, before the agent and the ring-out ticket are told. Past it the
 * chain is NOT claimed as paging: the agent's no-answer words promise only a
 * call back, which holds either way, while "being paged" would be false if the
 * hand-off then failed.
 */
export const HANDOFF_RESULT_WAIT_MS = 2_000;
/**
 * How long a hand-off may hold this call's chain claim. The Hub pools carry no
 * statement timeout, so a write that never answers would otherwise refuse every
 * later escalation on the call as "already paging" for the rest of the call.
 */
export const HANDOFF_SETTLE_MS = 20_000;
/**
 * How long a second escalation on a call waits to read whether the call's
 * earlier chain is still running. The read holds this call's chain claim, and
 * the Hub pools carry no statement timeout, so an unbounded read would refuse
 * every later escalation on the call as "still being handed over" for as long
 * as it hung (review of #514, round 9). Past it the read counts as failed:
 * today's path, a person rung, as for a read that throws.
 */
export const CHAIN_READ_WAIT_MS = 2_000;

const E164 = /^\+\d{10,15}$/;

/**
 * The warm transfer's outcome, in the runner's words. One case per status, so
 * a status added to TransferOutcome fails the build here instead of reading as
 * "failed" unseen.
 *
 * A BUSY office leg reads as `no_answer`: `performWarmTransfer` folds every
 * leg that dies without a key press (no-answer, busy, failed, a hang-up on
 * the briefing) into NO_ANSWER unless the provider pressed decline, so the
 * runner cannot tell busy from unanswered and retries both the same way.
 * UNAVAILABLE (nothing was dialled) reads as `failed`, which the runner also
 * retries: on a rotation route the provider has already been texted.
 */
export function warmOutcomeFor(outcome: TransferOutcome): WarmOutcome {
  if (outcome.ok) return "accepted";
  switch (outcome.status) {
    case "NO_ANSWER":
      return "no_answer";
    case "DECLINED":
      return "declined";
    case "FAILED":
    case "UNAVAILABLE":
      return "failed";
  }
}

/**
 * Whether the handoff policy's answer is a clinical dial the rotation may take
 * over. A dial the policy allowed is one; so is a clinical caller refused only
 * because `HUMAN_AGENT_NUMBER` is not set, because with the rotation on the
 * number to ring comes from the rotation, not from that variable. Every other
 * refusal (a caller type the policy does not transfer, PCP's rules) stands.
 */
export function rotationMayTakeTheDial(policy: ReturnType<typeof resolveHandoffDestination>): boolean {
  if (policy.allowed) return policy.policy !== "pcp";
  return policy.reason === "clinical_destination_not_configured";
}

/**
 * The line at the top of today's urgent text when the rotation took the dial:
 * that text still goes to URGENT_NOTIFICATION_NUMBER on every urgent call, a
 * real caller's in test mode included (docs/ON_CALL_ROTATION.md section 5),
 * so it says whose phone is ringing. In test mode that is a test number, never
 * the provider, which the reader needs to know when the caller is real
 * (review of #514).
 */
export function urgentTextRotationNote(plan: ChainPlan, mode: string | undefined): string | undefined {
  const first = plan.levels[0];
  if (!first) return undefined;
  return mode === "test"
    ? "[TEST MODE] The on-call rotation is ringing test numbers, not the provider."
    : `The on-call rotation is ringing ${levelLabel(first)}.`;
}

/**
 * Who the urgent ring-out ticket says was rung when the rotation took the
 * dial. The level's name and role, never the number; in test mode the phone
 * that rang was a test number, so the ticket says that instead of reading as
 * if the provider had been paged (review of #514, round 6).
 */
export function ringOutDialTarget(plan: ChainPlan, mode: string | undefined): string | undefined {
  const first = plan.levels[0];
  if (!first) return undefined;
  return mode === "test"
    ? `[TEST MODE] a test number, standing in for ${levelLabel(first)}`
    : levelLabel(first);
}

/**
 * The plan the in-call dial uses: leading levels with no usable phone are
 * dropped (and said so in the notes), because the in-call dial needs a number
 * to ring now and the runner cannot ring a level with none either. Null when
 * no level has a phone, so the call takes today's path.
 */
export function dialablePlan(plan: ChainPlan): ChainPlan | null {
  const first = plan.levels.findIndex((l) => E164.test(l.phone));
  if (first < 0) return null;
  if (first === 0) return plan;
  const dropped = plan.levels.slice(0, first).map((l) => `first_level_no_phone:${l.role}:${l.providerId}`);
  return { levels: plan.levels.slice(first), notes: [...plan.notes, ...dropped] };
}

function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
}

/**
 * Route one urgent after-hours call through the rotation, or answer null for
 * today's path. Never throws. On a rotation route the full-details text has
 * been started to the first level (raced against `PRE_DIAL_SMS_WAIT_MS`, so a
 * slow send never holds the dial) and the plan is the one the dial uses.
 */
export async function startOnCallRoute(
  onCall: OnCallTransferWiring,
  input: {
    callSid: string;
    callerPhone?: string;
    details: EscalationDetails | undefined;
  },
  log: (line: string) => void,
): Promise<OnCallRun | null> {
  const now = onCall.now ?? (() => new Date());
  const personIdFor = onCall.personIdFor ?? ((sid: string) => verifiedIdentityFor(sid)?.personId);
  let decision: Awaited<ReturnType<typeof decideRoute>>;
  try {
    let personId: string | undefined;
    try {
      personId = personIdFor(input.callSid);
    } catch {
      personId = undefined;
    }
    decision = await decideRoute({
      at: now(),
      config: onCall.config,
      store: onCall.store,
      rotation: onCall.rotation,
      personId,
      consoleQuery: onCall.consoleQuery,
    });
  } catch (e) {
    log(`[ON-CALL] routing threw for ${input.callSid}; today's path: ${(e as Error)?.message ?? e}`);
    return null;
  }
  if (decision.kind === "legacy") {
    log(`[ON-CALL] ${input.callSid}: today's path (${decision.because})`);
    return null;
  }
  const plan = dialablePlan(decision.plan);
  if (!plan) {
    log(`[ON-CALL] ${input.callSid}: no level of the chain has a phone; today's path`);
    return null;
  }
  const routing: RoutingFacts = decision.routing;
  const first = plan.levels[0];
  const note = [onCall.config.mode === "test" ? "[TEST MODE]" : "", decision.alertNote ?? ""].filter(Boolean).join(" ");
  const body = buildUrgentTransferSms(
    { callerNumber: input.callerPhone, escalationDetails: input.details, ...(note ? { note } : {}) },
    urgentAlertTime(now()),
  );
  const sent: Promise<{ ok: boolean; sid: string | null; at: Date }> = onCall
    .sendSms({ to: first.phone, from: onCall.config.callerId, body })
    .then(
      (r) => ({ ok: true, sid: r.sid ?? null, at: now() }),
      (e) => {
        log(`[ON-CALL] ${input.callSid}: the text to level 0 failed: ${(e as Error)?.message ?? e}`);
        return { ok: false, sid: null, at: now() };
      },
    );
  await settleWithin(sent, PRE_DIAL_SMS_WAIT_MS);
  log(
    `[ON-CALL] ${input.callSid}: ${onCall.config.mode} rotation, ${routing.reason}, ${plan.levels.length} level(s), first ${first.role}:${first.providerId}`,
  );
  return {
    plan,
    routing,
    details: storedDetails(input.details),
    levelStartedAt: now(),
    preDialSms: sent,
  };
}

interface OnCallRun {
  plan: ChainPlan;
  routing: RoutingFacts;
  details: StoredDetails | null;
  levelStartedAt: Date;
  preDialSms: Promise<{ ok: boolean; sid: string | null; at: Date }>;
}

/** One escalation's own state: never shared between two escalations on a call. */
interface AttemptHolder {
  run: OnCallRun | null;
  attemptId: TransferAttemptId;
  /** When this attempt's dial started, so its recorded ring time is its own. */
  dialStartedAt: number;
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
  /** A blind transfer's `<Dial>` finished, for TRANSFER_DIAL_RESULT_PATH:
   * records whether the queue answered, and speaks to a caller left holding
   * a line whose agent died with the redirect. */
  handleDialResult(req: WebhookRequest): WebhookResponse;
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

/**
 * Which lanes actually have somewhere to dial.
 *
 * DELIBERATELY separate from transferUnavailableReason, which gates
 * whether the transfer-capable lanes are served at all. The destination
 * numbers are per-POLICY, not per-transport: the no-IVR family dials
 * HUMAN_AGENT_NUMBER and pcp dials PCP_HUMAN_AGENT_NUMBER
 * (resolveHandoffDestination). A deployment with only one of them set has
 * one working lane and one that refuses at the destination — folding that
 * into the mount-time gate would take the WORKING lane down too.
 *
 * So this is reporting only, and it exists because the health endpoint
 * said `transferReady: true` for a deployment where every transfer fails
 * with destination-not-configured — the exact partial deployment the
 * endpoint was added to catch (Codex, PR #236).
 */
export function transferDestinationStatus(env: Record<string, string | undefined>): {
  clinical: boolean;
  pcp: boolean;
  missing: string[];
} {
  const clinical = Boolean(env.HUMAN_AGENT_NUMBER?.trim());
  const pcp = Boolean(env.PCP_HUMAN_AGENT_NUMBER?.trim());
  const missing: string[] = [];
  if (!clinical) missing.push("HUMAN_AGENT_NUMBER");
  if (!pcp) missing.push("PCP_HUMAN_AGENT_NUMBER");
  return { clinical, pcp, missing };
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
    redirectCallerToQueue: async (input) => (await get()).redirectCallerToQueue(input),
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
  | { ok: true; destination?: string; handedToQueue?: true }
  | {
      ok: false;
      status: "HANDOFF_UNAVAILABLE" | "NO_ANSWER" | "FAILED";
      reason?: string;
      destination?: string;
    } {
  /**
   * A BLIND SUCCESS IS NOT A CONNECTION, and the ticket must not say it was.
   *
   * `handedToQueue` is what stops `handoff_to_pcp` writing
   * `finalStatus: 'CONNECTED'` for a caller nobody has been proven to answer.
   * A staffer reading a CONNECTED ticket reasonably assumes the conversation
   * happened and deprioritises the callback — which is precisely the ticket
   * Rosa asked for on 2026-09-08 ("a ticket should be created even when they
   * are transferred") being made useless by the word on it.
   */
  if (outcome.ok) {
    return {
      ok: true,
      destination: outcome.destination,
      ...(outcome.method === "blind" ? { handedToQueue: true as const } : {}),
    };
  }
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

/**
 * The transfer's own result, in the shape `call_logs.transfer_outcome` stores.
 *
 * EXPORTED BECAUSE IT WAS UNTESTABLE INSIDE THE CLOSURE, and mutation testing
 * is what showed that mattered: flattening DECLINED into `no_answer` — the one
 * translation this mapping makes a judgement about — failed no test at all,
 * because the only `declined` assertion was on the STORE, which never sees a
 * `TransferOutcome`. The same shape as the briefing bug an hour earlier: a
 * test that exercises the sink and not the source cannot tell a working
 * mapping from a broken one.
 *
 * `declined` deliberately extends the old core's vocabulary rather than
 * folding into `no_answer`: nobody picking up is a staffing question and
 * somebody refusing is not, and nothing reads this column today, so the
 * extension costs nothing while the flattening would cost the distinction.
 */
export function toRecordedOutcome(
  outcome: TransferOutcome,
  ringSeconds: number,
  /**
   * What the office was not told, from the agent's side channel. Optional
   * because only PCP runs the one-round intake today; a lane that does not
   * report it leaves the columns absent rather than claiming a full briefing
   * it never checked.
   */
  briefing: { gaps?: string[]; asked?: boolean } = {},
): Parameters<typeof recordRuntimeTransferOutcome>[1] {
  const briefingFields = {
    ...(briefing.gaps ? { briefingGaps: briefing.gaps } : {}),
    ...(briefing.asked !== undefined ? { askedBeforeDial: briefing.asked } : {}),
  };
  if (outcome.ok && outcome.method === "blind") {
    /**
     * THE HONEST FLOOR OF A BLIND TRANSFER. Nothing has answered: the caller
     * was redirected and is no longer ours. `blindTransferDialResult.ts`
     * upgrades this row to `queue_answered` (or down to `no_answer`) when
     * Twilio reports what the dial did — and if that callback never arrives,
     * THIS is what the record says, which is exactly what was known.
     *
     * No `acceptMethod`, because nothing was accepted, and no `officeCallSid`,
     * because there is no office leg. `ringSeconds: 0` is the truth at this
     * instant rather than a placeholder — the ringing has not started.
     */
    return {
      outcome: "handed_to_queue",
      status: "HANDED_TO_QUEUE",
      dialedNumber: outcome.destination,
      ringSeconds: 0,
      method: "blind",
      ...briefingFields,
    };
  }
  if (outcome.ok) {
    return {
      outcome: "accepted",
      status: "CONNECTED",
      dialedNumber: outcome.destination,
      officeCallSid: outcome.officeCallSid,
      acceptMethod: "keypress",
      ringSeconds,
      method: "warm",
      ...briefingFields,
    };
  }
  return {
    ...briefingFields,
    ...(outcome.method ? { method: outcome.method } : {}),
    outcome:
      outcome.status === "NO_ANSWER"
        ? "no_answer"
        : outcome.status === "DECLINED"
          ? "declined"
          : outcome.status === "UNAVAILABLE"
            ? "unavailable"
            : "failed",
    status: outcome.status,
    reason: outcome.reason,
    // Recorded on FAILURE too. 46 of 46 failed PCP handoffs in the 90 days to
    // 2026-08-13 recorded no destination, which is why "were we dialling the
    // retired roster?" is unanswerable from that data.
    ...(outcome.destination ? { dialedNumber: outcome.destination } : {}),
    ringSeconds,
  };
}

/** Who is calling and why, from the agent's own side-channel write. */
export function briefingFor(
  slug: string,
  metadata: LaneCallMetadata,
  details: { reason?: string; providerInfo?: string; callerName?: string } | undefined,
): string {
  if (slug === "pcp") {
    return buildPcpTransferBriefing({
      // The staffer is about to talk to this person; their name is the first
      // thing they need and was not passed here until 2026-09-08.
      callerName: details?.callerName,
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
  const urgentAlerts = options.urgentAlerts ?? defaultUrgentTransferAlerts(env, log);
  const onCall = options.onCall;
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

  /**
   * THE ONE PLACE THIS PROCESS WRITES `call_logs.transfer_outcome`.
   *
   * Two call sites reach it — the transfer settling, and a blind transfer's
   * dial result arriving later on its own HTTP request — and they must not
   * become two writers again. `transferOutcomeLog.ts` documents what two
   * writers over one column cost: five review rounds, each fix creating the
   * next finding, until the second writer was deleted rather than sequenced.
   *
   * Deliberately NOT awaited. This runs on the path returning to the agent (or
   * to Twilio), and a database round trip must not sit between a caller and
   * the next thing they hear. `persistTransferOutcome` never throws; it
   * serialises per call and reports its own failures.
   */
  const writeOutcome =
    options.persistOutcome ??
    ((callerCallSid: string, toPersist: RuntimeTransferOutcome): void => {
      void import("./callRecord")
        .then(({ persistTransferOutcome }) => persistTransferOutcome(callerCallSid, toPersist))
        .catch((err) =>
          log(`[runtime-xfer] outcome write could not start for ${callerCallSid}: ${String(err)}`),
        );
    });

  const acceptUrl = `https://${options.domain}${TRANSFER_ACCEPT_PATH}`;
  const statusUrl = `https://${options.domain}${TRANSFER_STATUS_PATH}`;
  const dialResultUrl = `https://${options.domain}${TRANSFER_DIAL_RESULT_PATH}`;
  /**
   * callerCallSid -> the blind dial still running for it.
   *
   * Bounded the same way the accept registry is: an entry is dropped when the
   * dial result lands, and a stale one is evicted after the window below. The
   * whole point of the map is the attempt id — without it the dial result
   * could be written against a LATER attempt on the same call and overwrite a
   * transfer that had already settled.
   */
  const pendingBlindDials = new Map<string, PendingBlindDial>();
  /** Long enough for a queue to ring out and a caller to sit in hold music;
   * short enough that a process serving 200+ calls a day cannot accumulate.
   * Nothing depends on the exact figure — an evicted entry costs one
   * unattributed dial result, which the handler logs rather than guesses at. */
  const BLIND_DIAL_MEMORY_MS = 60 * 60 * 1000;
  const forgetStaleBlindDials = (nowMs: number): void => {
    for (const [sid, pending] of pendingBlindDials) {
      if (nowMs - pending.redirectedAtMs > BLIND_DIAL_MEMORY_MS) pendingBlindDials.delete(sid);
    }
  };

  return {
    unavailableReason,

    handoffFor(
      slug: string,
      metadata: LaneCallMetadata,
      hooks?: TransferLifecycleHooks,
    ): () => Promise<unknown> {
      const mode = transferModeFor(slug, env);
      /**
       * ONE CHAIN PER CALL. `none`: no chain yet, or the last route attempt
       * came to nothing, so an escalation may start one. `pending`: a route is
       * being decided or its dial is under way, so a second escalation is
       * refused. `handed`: the dial is over and its hand-off to the runner has
       * finished (whether or not it opened a row), so the store decides: an
       * active escalation refuses, a finished one takes today's path, none at
       * all may start a chain.
       */
      let chainState: "none" | "pending" | "handed" = "none";
      /**
       * Claim the chain for this escalation, or say why not. The claim is
       * taken BEFORE the first await: two escalations on one call can arrive
       * in the same tick, and a check that awaited before claiming let both
       * through (found by the "still being routed" test). `route` leaves the
       * claim held and answers what it replaced, so a route that comes to
       * nothing can give it back; `refuse` and `today` leave the state as it
       * was.
       */
      const claimChain = async (): Promise<
        | { kind: "route"; before: "none" | "handed" }
        | { kind: "refuse"; why: "pending" | "active" }
        | { kind: "today" }
      > => {
        if (chainState === "pending") return { kind: "refuse", why: "pending" };
        const before = chainState;
        chainState = "pending";
        if (before === "none" || !onCall) return { kind: "route", before };
        try {
          const waitMs = onCall.chainReadWaitMs ?? CHAIN_READ_WAIT_MS;
          const read = await settleWithin(
            onCall.store.getEscalationByCall(metadata.callSid).then((row) => ({ row })),
            waitMs,
          );
          if (read === null) {
            chainState = before;
            log(
              `[ON-CALL] ${metadata.callSid}: this call's escalation could not be read within ${waitMs} ms; today's path`,
            );
            return { kind: "today" };
          }
          const { row } = read;
          if (!row) return { kind: "route", before };
          chainState = before;
          return row.status === "active" ? { kind: "refuse", why: "active" } : { kind: "today" };
        } catch (e) {
          chainState = before;
          // Ring a person rather than tell an urgent caller a chain is paging
          // when we cannot see whether one is.
          log(
            `[ON-CALL] ${metadata.callSid}: could not read this call's escalation; today's path: ${(e as Error)?.message ?? e}`,
          );
          return { kind: "today" };
        }
      };
      /**
       * The attempt writes the run it started, its own attempt id and the
       * moment its dial started into `holder`, a fresh object per invocation,
       * so two escalations on one call can never read each other's run, ring
       * time or attempt (review of #514, round 8: one closure variable shared
       * by overlapping escalations timed the first one's ring from the
       * second's dial).
       */
      const attempt = async (holder: AttemptHolder): Promise<TransferOutcome> => {
        try {
          // Before anything dials: the whole attempt — dial, briefing,
          // keypress — is bounded by the accept window, and the bridge's
          // watchdog needs that budget, not the tool dispatch's 45
          // seconds (Codex, PR #230 round 3).
          //
          // NOT WIDENED ON THE BLIND PATH, deliberately: it returns the
          // instant the redirect is accepted by Twilio, so the extra budget
          // would keep the dead-air watchdog stood down over a stream that is
          // already being torn down. The whole reason for the blind shape is
          // that nothing waits.
          if (mode !== "blind") hooks?.onAttemptStarting?.(ACCEPT_WINDOW_MS);
          // When the office leg started ringing, so the recorded outcome can
          // say how long it rang. The old core reports this and the runtime
          // reported nothing at all.
          holder.dialStartedAt = Date.now();
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
          /**
           * THE ON-CALL ROTATION (v268). On the after-hours lanes, once the
           * policy has sanctioned a clinical dial, the rotation decides WHO is
           * rung: the week's on-call provider, or a post-op patient's surgeon,
           * with the full details texted to them first (spec a). Anything the
           * rotation cannot answer (switched off, tables absent, weekday
           * daytime, no level with a phone) leaves today's path untouched.
           */
          const onCallEligible =
            onCall !== undefined &&
            onCall.config.mode !== "off" &&
            ON_CALL_LANES.has(slug) &&
            rotationMayTakeTheDial(policy) &&
            mode !== "blind";
          if (onCallEligible && onCall) {
            const claim = await claimChain();
            if (claim.kind === "refuse") {
              if (claim.why === "pending") {
                log(
                  `[ON-CALL] ${metadata.callSid}: this call's first escalation is still handing its chain over; not dialling again`,
                );
                return { ok: false, status: "UNAVAILABLE", reason: ON_CALL_CHAIN_PENDING };
              }
              log(`[ON-CALL] ${metadata.callSid}: a chain is already running for this call; not dialling again`);
              return { ok: false, status: "UNAVAILABLE", reason: ON_CALL_CHAIN_RUNNING };
            }
            if (claim.kind === "today") {
              log(`[ON-CALL] ${metadata.callSid}: this call's chain has finished; today's path`);
            } else {
              // The claim is held through the routing read, so an escalation
              // arriving while it runs is refused rather than starting a second
              // chain. A route that comes to nothing gives the claim back as it
              // was, so a finished chain's row is still read next time.
              try {
                holder.run = await startOnCallRoute(
                  onCall,
                  { callSid: metadata.callSid, callerPhone: metadata.callerPhone, details },
                  log,
                );
              } finally {
                if (!holder.run) chainState = claim.before;
              }
              // The ring is timed from the dial, not from the routing read.
              holder.dialStartedAt = Date.now();
            }
          }
          /**
           * THE HEADS-UP TEXT, BEFORE THE PHONE RINGS — the old core's
           * `sendUrgentTransferSms`, which the runtime never sent.
           *
           * The after-hours line moved here at ~00:23 UTC on 2026-10-01 and the
           * first urgent escalation it dialled (CA3a8fd9cc0f2f79eae30f5785ceba6d22,
           * 2026-10-02 00:15 UTC) rang the on-call phone for 40 seconds with no
           * text in front of it. Operator: "I need those alert sms to let me know
           * who is calling and why." Same text, same recipient, same rule as the
           * old core: only for a dial that is really going to happen (policy
           * allowed it), and never for PCP, whose professional callers go to a
           * call centre that has its own briefing. Fire-and-forget: a text that
           * fails must never delay the dial.
           */
          // With the rotation ringing, the dial happens even when the policy
          // had no number of its own (clinical_destination_not_configured).
          if ((policy.allowed && policy.policy !== "pcp") || holder.run) {
            const note = holder.run ? urgentTextRotationNote(holder.run.plan, onCall?.config.mode) : undefined;
            urgentAlerts.smsBeforeDial({
              callerNumber: metadata.callerPhone,
              escalationDetails: details,
              ...(note ? { note } : {}),
            });
          }
          if (mode === "blind") {
            /**
             * THE BRIEFING GAPS ARE SNAPSHOTTED HERE, not read later.
             *
             * `attempt`'s own `finally` deletes the side channel — it holds a
             * caller's name and callback number — so the dial-result callback,
             * which arrives minutes later on a different HTTP request, cannot
             * read it. Copying the two telemetry fields into the pending entry
             * is what keeps `briefingGaps`/`askedBeforeDial` on the row the
             * webhook writes (the whole point of "build it and the telemetry").
             */
            const blindOutcome = await performBlindTransfer(
              {
                callerCallSid: metadata.callSid,
                destination: policy.allowed ? policy.destination : null,
                // Read off the side channel like the rest, at invoke time: the
                // lane decides per dial whether a ticket exists to mention.
                ...(details?.requestOnRecord !== undefined
                  ? { requestOnRecord: details.requestOnRecord }
                  : {}),
              },
              {
                twilio: ops,
                dialResultUrl,
                callerId: queueCallerIdFor(metadata.callerPhone, env),
                onCallerRedirectStarting: hooks?.onCallerRedirectStarting,
                onCallerRedirectFailed: hooks?.onCallerRedirectFailed,
                log,
              },
            );
            if (blindOutcome.ok) {
              forgetStaleBlindDials(Date.now());
              pendingBlindDials.set(metadata.callSid, {
                attemptId: holder.attemptId,
                destination: blindOutcome.destination,
                redirectedAtMs: Date.now(),
                ...(details?.briefingGaps ? { briefingGaps: details.briefingGaps } : {}),
                ...(details?.askedBeforeDial !== undefined
                  ? { askedBeforeDial: details.askedBeforeDial }
                  : {}),
                // Snapshotted for the same reason as the two above: the side
                // channel is deleted in `attempt`'s finally, and the dial
                // result arrives on a later HTTP request with no closure left.
                ...(details?.onBlindDialSettled
                  ? { onSettled: details.onBlindDialSettled }
                  : {}),
              });
            }
            return blindOutcome;
          }
          const run = holder.run;
          const warmDestination = run ? run.plan.levels[0].phone : policy.allowed ? policy.destination : null;
          // Never the operator line: the rotation's caller ID is validated E.164
          // (config.ts), and today's path keeps today's number.
          const warmFrom = run ? onCall!.config.callerId : env.TWILIO_PHONE_NUMBER ?? "";
          return await performWarmTransfer(
            {
              callerCallSid: metadata.callSid,
              destination: warmDestination,
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
              fromNumber: warmFrom,
              callerId: run ? warmFrom : env.TWILIO_PHONE_NUMBER,
              /**
               * NO PROVISIONAL RECORD HERE ANY MORE. It existed so a success
               * would survive teardown beating the settle — and teardown no
               * longer writes this column at all, so there is nothing to
               * survive. See the redesign note in transferOutcomeLog.ts.
               */
              onCallerRedirectStarting: hooks?.onCallerRedirectStarting,
              // Nothing to correct: the settle below records the failure the
              // redirect produces, and it is the only thing that writes.
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
      /**
       * WRITE THE OUTCOME DOWN BEFORE HANDING IT TO THE AGENT.
       *
       * `call_logs.transfer_outcome` was NULL on every runtime call ever made,
       * because `recordTransferOutcome` keys on `officeLegDials` — a map only
       * the old core's dial path populates. On 2026-09-08 the PCP line dialled
       * +17149564300 and rang out; the TICKET recorded destination, timing and
       * NO_ANSWER, and `call_logs` recorded nothing, so the same call read as
       * "no transfer attempted" from the table every dashboard uses. Operator:
       * "you have the data, but we're not capturing it properly."
       *
       * Wrapped around BOTH slug paths rather than added to one, because the
       * non-PCP path THROWS on failure — recording inside it after the throw
       * would capture successes only, which is the half that needs recording
       * least.
       */
      /**
       * `chainCarriesOn` is this invocation's own answer: true when this
       * attempt handed a chain to the runner, the dial was not taken, and the
       * runner answered inside `HANDOFF_RESULT_WAIT_MS` with the chain's row
       * still active. It is returned, never shared, so two escalations on one
       * call cannot read each other's.
       */
      const settle = async (): Promise<{ outcome: TransferOutcome; chainCarriesOn: boolean }> => {
        /**
         * READ THE SIDE CHANNEL BEFORE `attempt()`, because attempt's own
         * `finally` DELETES it — the entry holds a caller's name, DOB and
         * callback number, so it is cleared per attempt rather than left in a
         * process-wide map (Codex, PR #230). Reading after would report every
         * transfer as fully briefed, which is worse than reporting nothing.
         */
        const briefed = escalationDetailsMap.get(metadata.callId);
        const briefing = { gaps: briefed?.briefingGaps, asked: briefed?.askedBeforeDial };
        const holder: AttemptHolder = {
          run: null,
          attemptId: newTransferAttemptId(),
          dialStartedAt: Date.now(),
        };
        /**
         * HAND THE CHAIN TO THE RUNNER (v268). The in-call dial was level 0's
         * first attempt; the runner records it and, when nobody took the
         * patient, retries and nudges inside five minutes of the call and then
         * escalates (spec c to f). Not awaited: the caller is waiting on the
         * agent's next words, and the runner's Hub writes must never sit in
         * front of them. A pickup closes the chain (spec d).
         *
         * Every run is handed over, whatever the dial did: level 0 was texted
         * before it rang, so even a dial that threw or never started is the
         * first attempt of a chain the runner must carry on.
         *
         * Answers whether the chain's row is open and active once the runner
         * is done, false when it opened nothing or failed. The call's claim is
         * released when the hand-off ends, or after `HANDOFF_SETTLE_MS` if it
         * never does; the release happens once, so a hand-off that answers
         * after the bound cannot overwrite a later escalation's claim.
         */
        const handOff = (handed: OnCallRun, outcome: TransferOutcome): Promise<boolean> => {
          if (!onCall) return Promise.resolve(false);
          const now = onCall.now ?? (() => new Date());
          // The level-0 call ended when its outcome arrived, not after the
          // text's record below: the retry is timed from this.
          const endedAt = now();
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            chainState = "handed";
          };
          const settleMs = onCall.handoffSettleMs ?? HANDOFF_SETTLE_MS;
          const bound = setTimeout(() => {
            if (released) return;
            log(
              `[ON-CALL] ${metadata.callSid}: the hand-off to the runner is still running after ${settleMs} ms; releasing this call's chain claim`,
            );
            release();
          }, settleMs);
          (bound as { unref?: () => void }).unref?.();
          return (async () => {
            const preDialSms = await settleWithin(handed.preDialSms, PRE_DIAL_SMS_RECORD_MS);
            const row = await onCall.runner.afterInCallTransfer({
              callSid: metadata.callSid,
              mode: onCall.config.mode as OnCallMode,
              plan: handed.plan,
              routing: handed.routing,
              details: handed.details,
              callerNumber: metadata.callerPhone ?? null,
              levelStartedAt: handed.levelStartedAt,
              preDialSms,
              warm: {
                outcome: warmOutcomeFor(outcome),
                dialedTo: handed.plan.levels[0].phone,
                endedAt,
                providerCallSid: outcome.officeCallSid ?? null,
              },
            });
            return row?.status === "active";
          })()
            .catch((e) => {
              log(
                `[ON-CALL] ${metadata.callSid}: could not hand the chain to the runner: ${(e as Error)?.message ?? e}`,
              );
              return false;
            })
            .finally(() => {
              clearTimeout(bound);
              release();
            });
        };
        let outcome: TransferOutcome;
        try {
          outcome = await attempt(holder);
        } catch (e) {
          if (holder.run) void handOff(holder.run, { ok: false, status: "FAILED", reason: "transfer_threw" });
          throw e;
        }
        const handed = holder.run ? handOff(holder.run, outcome) : null;
        // The ring is read here, before the hand-off wait below, so the
        // ticket's ring time is the dial's and not the dial's plus that wait
        // (review of #514).
        const ringSeconds = Math.round((Date.now() - holder.dialStartedAt) / 1000);
        /**
         * WHAT THE CALLER AND THE TICKET ARE TOLD WAITS FOR THE HAND-OFF,
         * briefly. A not-taken dial is "the on-call team is being paged" only
         * when the runner has the chain's row open; a hand-off that failed has
         * already texted the urgent number that nobody else will be called,
         * and saying the team is being paged beside that would be false. A
         * hand-off slower than the wait is read as not confirmed: the agent's
         * no-answer words promise a call back, which is true either way.
         */
        let chainCarriesOn = false;
        if (handed && !outcome.ok) {
          const waitMs = onCall?.handoffResultWaitMs ?? HANDOFF_RESULT_WAIT_MS;
          const live = await settleWithin(handed, waitMs);
          chainCarriesOn = live === true;
          if (live === null) {
            log(
              `[ON-CALL] ${metadata.callSid}: the hand-off had not answered after ${waitMs} ms; the agent is not told the chain is paging`,
            );
          }
        }
        try {
          /**
           * A POLICY REFUSAL IS NOT A DIAL. Codex P2, PR #273.
           *
           * `performWarmTransfer` returns UNAVAILABLE before `createOfficeLeg`
           * when there is no destination or policy withheld one — its own
           * comment says "nothing was attempted". Recording it would write a
           * non-null `transfer_outcome` for a call where no number was ever
           * rung, which breaks the meaning this column was just given: NULL is
           * "no transfer was attempted". Reporting would count configuration
           * refusals as dials.
           */
          // A dial the rotation took over was texted first, so it is not a
          // refusal that rang nobody even if the dial itself answered
          // UNAVAILABLE: it carries on to the ticket (review of #514).
          if (!outcome.ok && outcome.status === "UNAVAILABLE" && !holder.run) return { outcome, chainCarriesOn };
          /**
           * THE URGENT SAFETY NET — the old core's `fileUrgentHandoffFallbackTicket`.
           *
           * A clinical transfer that rang and was not taken left NO record on
           * the runtime: CA3a8fd9cc0f2f79eae30f5785ceba6d22 rang out at 00:16 UTC
           * on 2026-10-02, the caller hung up while the agent was offering to
           * take a message, and no ticket of any provenance exists. The old core
           * has filed an URGENT After Hours ticket on exactly this since July.
           * Placed after the UNAVAILABLE return because a refusal rang nobody,
           * and PCP is excluded for the old core's reason: it files its own
           * structured ticket before dialling. When the call holds no ticket
           * yet, the per-call claim lock in `SyncAgentService` makes this and a
           * later `create_ticket` one ticket; when the caller's request was
           * filed FIRST, the record is filed beside it (v95) — the claim used to
           * swallow it, which left an urgent ring-out with only a medium ticket.
           */
          if (!outcome.ok && slug !== "pcp") {
            urgentAlerts.fallbackTicket({
              callSid: metadata.callSid,
              callerNumber: metadata.callerPhone,
              escalationDetails: briefed,
              why:
                outcome.status === "NO_ANSWER" || outcome.status === "DECLINED"
                  ? URGENT_TRANSFER_NOT_ANSWERED
                  : `Transfer dial failed: ${outcome.reason}`,
              // A rotation run rang a provider's own phone: the ticket names
              // who was called, never the number (review of #514).
              dialTarget:
                (holder.run && ringOutDialTarget(holder.run.plan, onCall?.config.mode)) || outcome.destination,
              agentUsed: slug,
              // v163: the failure itself, structured, so the ticket says the
              // caller was never connected and how long the phone rang (70166).
              // UNAVAILABLE reaches here only on a rotation run (the provider
              // was texted); the ticket reads it as a failed dial.
              handoff: { status: outcome.status === "UNAVAILABLE" ? "FAILED" : outcome.status, ringSeconds },
              // v268: the chain this dial started is still calling, so the
              // ticket says so beside its call-back line, only when the runner
              // said its row is open.
              ...(chainCarriesOn ? { onCallChain: true } : {}),
            });
          }
          /**
           * RECORD IT, THEN WRITE IT. One writer, at the moment the answer
           * exists.
           *
           * `recordRuntimeTransferOutcome` returns the value to persist —
           * which is NOT always the value just passed in: a later attempt
           * failing after this call already reached a human keeps the earlier
           * success, with the attempt count advanced. Writing the RETURN value
           * means this code never has to know which branch was taken, and the
           * attempt count is whatever the store actually counted rather than a
           * number reconstructed here (Codex P2, PR #273 round 5, where it was
           * hardcoded to 1 and lost every retry).
           *
           * Deliberately NOT awaited: this runs on the path returning to the
           * agent, and a database round trip must not sit between a caller and
           * the next thing they hear. `persistTransferOutcome` never throws.
           */
          const toPersist = recordRuntimeTransferOutcome(
            metadata.callSid,
            toRecordedOutcome(outcome, ringSeconds, briefing),
            holder.attemptId,
          );
          writeOutcome(metadata.callSid, toPersist);
        } catch (err) {
          // Telemetry must never cost a transfer. This is the whole reason the
          // record is taken here and not inside the dial.
          log(`[runtime-xfer] could not record the outcome for ${metadata.callSid}: ${String(err)}`);
        }
        return { outcome, chainCarriesOn };
      };
      if (slug === "pcp") {
        // See handoffFor's interface doc: PCP records the STRUCTURED
        // outcome on its ticket, success or failure — never a throw.
        return async () => toPcpHandoffOutcome((await settle()).outcome);
      }
      return async () => {
        const { outcome, chainCarriesOn } = await settle();
        if (!outcome.ok) {
          // A fixed slug, because the text reaches the model — the
          // detailed reason stays in the server log (warmTransfer.ts).
          // A second escalation while this call's on-call chain is still
          // paging rang nobody, but it is not "could not be placed": the
          // chain is retrying and escalating on its own, so the agent gets
          // its own slug and its own words (v268).
          // A chain this attempt started is still paging even though the
          // in-call dial was not taken: its own slug and words too (v268).
          throw new Error(
            outcome.reason === ON_CALL_CHAIN_RUNNING
              ? "handoff_failed:CHAIN_RUNNING"
              : outcome.reason === ON_CALL_CHAIN_PENDING
                ? "handoff_failed:CHAIN_PENDING"
                : chainCarriesOn
                ? HANDOFF_CHAIN_STARTED
                : `handoff_failed:${outcome.status}`,
          );
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

    handleDialResult(req: WebhookRequest): WebhookResponse {
      return handleBlindDialResult(req, {
        env,
        pendingFor: (callerCallSid) => pendingBlindDials.get(callerCallSid),
        forget: (callerCallSid) => {
          pendingBlindDials.delete(callerCallSid);
        },
        /**
         * SAME WRITER, SAME ORDER as the settle path: record first (which
         * returns the value to persist, and it is not always the value passed
         * in), then write. Going through `recordRuntimeTransferOutcome` rather
         * than straight to the database is what makes the dial result an
         * UPDATE of this attempt instead of a second, competing row — it keys
         * on the attempt id the redirect stored.
         */
        record: (callerCallSid, outcome, attemptId) => {
          writeOutcome(callerCallSid, recordRuntimeTransferOutcome(callerCallSid, outcome, attemptId));
        },
        log,
      });
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
