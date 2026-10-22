/**
 * src/runtime/outbound/campaign.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What an OUTBOUND lane is, as the runtime sees it.
 *
 * An outbound campaign is an ordinary lane — its own slug, its own agent,
 * its own prompt — that the runtime DIALS instead of answers. Everything a
 * lane needs that only an outbound call has lives on `OutboundLanePolicy`,
 * carried on the lane's registration beside `spokenLanguages` and
 * `teardownSweep`. One policy per lane, never a mode flag on a shared agent
 * (standing instruction 11: each line gets its own slug).
 *
 * Who to call lives in the database: `campaign_contacts`, one row per
 * person (or per appointment, where the campaign is about one), with the
 * campaign's own fields in `custom_data`. Each attempt is a row in
 * `campaign_contact_attempts`. Those tables predate this layer — the old
 * core's campaign executor wrote them — and the layer reuses them rather
 * than inventing a third shape. See ./store.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AttemptCaps, CallingWindow } from "./callingWindow";

/** The `campaigns.campaign_type` this layer writes. The old core's executor
 * refuses it, so a press of "start" in the old admin screen can never dial
 * a runtime campaign through the old pipeline. */
export const RUNTIME_OUTBOUND_CAMPAIGN_TYPE = "runtime_outbound";

/** The sentence every outbound greeting must carry, so the caller hears it
 * before anything else is said (Cal. Penal Code 632; the inbound lanes carry
 * the same clause since v39). Pinned by a test over every registered lane. */
export const OUTBOUND_RECORDING_CLAUSE = "This call is recorded";

/** One person this campaign is calling, as the call sees them. Loaded from
 * `campaign_contacts` when the call is answered — never from the request. */
export interface OutboundContact {
  contactId: string;
  campaignId: string;
  attemptId: string;
  /** The number dialled, E.164. */
  phone: string;
  firstName: string | null;
  lastName: string | null;
  /** The campaign's own fields for this person (`custom_data`). */
  data: Record<string, unknown>;
}

export interface OutboundLanePolicy {
  /**
   * The campaign's stable key: the `campaigns.name` row the dialer reads.
   * The row is created on first use with RUNTIME_OUTBOUND_CAMPAIGN_TYPE.
   */
  campaignKey: string;
  /** Env var that must equal "1" for THIS campaign to dial, on top of the
   * fleet-wide RUNTIME_OUTBOUND_DIALING. Off by default, one lane at a time. */
  enableEnv: string;
  /** Env var holding the caller-ID number (E.164). Unset means no dialling. */
  callerIdEnv: string;
  window: CallingWindow;
  caps: AttemptCaps;
  /** Calls this campaign may have ringing or in progress at once. */
  concurrency: number;
  /**
   * Minutes to wait after Twilio refuses a dial before trying again.
   * The person cooldown (`caps.minHoursBetween`) is for real call
   * outcomes only — a Twilio outage must not spend the rest of the
   * calling day. Default DEFAULT_INFRA_RETRY_MINUTES (15). A non-number
   * or a value of 0 or less falls back to that default. Values above
   * MAX_INFRA_RETRY_MINUTES (24 hours) are clamped so nextLookAt cannot
   * build an Invalid Date.
   */
  infraRetryMinutes?: number;
  /**
   * How many consecutive Twilio refusals may use the short infrastructure
   * retry before the person cooldown applies. A permanently refused
   * number or a bad caller ID must not retry every 15 minutes for the
   * whole calling window. Default DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES
   * (3). A non-number or a value of 0 or less falls back to that default.
   */
  maxConsecutiveInfraRetries?: number;
  /**
   * The first words the person hears, built for them. Must say that this is
   * an automated assistant calling for Azul Vision and that the call is
   * recorded (OUTBOUND_RECORDING_CLAUSE), before anything else.
   */
  greeting(contact: OutboundContact): string;
  /**
   * What an answering machine hears. The practice's name and a number to
   * call back, and NOTHING about why: a voicemail is heard by whoever plays
   * it back. Pure: no PHI may reach it, so it takes no contact.
   */
  voicemail(): string;
  /**
   * Why this campaign called, as the agent says it to somebody who rang
   * back — ONLY once they are identified (./callback.ts). One sentence,
   * ending in a full stop. The caller-ID number takes the calls back: its
   * Twilio Voice URL must point at this lane's /voice/<slug>, and the
   * dialler will not ring anybody until it does (dialer.callbackRouting).
   * Optional in the type so a test policy need not carry one; every
   * registered lane must (outboundLanes.test.ts).
   */
  callbackPurpose?: string;
  /**
   * Where this campaign's people come from when it is not an import (v107):
   * a live source the dialler refreshes the queue from every
   * `refreshEveryMs`, and re-checks each person against at the moment of
   * the dial. Built lazily — the Console connection is opened only by a
   * campaign that dials. Null from the factory means the source is not
   * configured in this process, and the campaign does not dial.
   */
  source?: () => Promise<ContactSource | null>;
  /**
   * The lane's OWN registry tools (v110), bound by the runtime on a call the
   * lane dialled and on a call made back to it — never on an inbound lane.
   * Each receives who the call is about as injected context (the contact,
   * attempt and CallSid on a dialled call; the CallSid on a returned one),
   * never as a schema field. Registry tools, not hand-built `tool()`s: the
   * agent SDK drops every field description from a hand-built tool with an
   * optional field, and a registry tool's JSON schema reaches the model whole.
   */
  tools?: readonly string[];
  /**
   * Whether the campaign is calling test data or real people right now, for
   * /voice/health (v112): the one fact an operator must be able to confirm
   * after a republish without placing a call. Read from the environment it is
   * given. Optional: a campaign with one mode leaves it out.
   */
  mode?: (env?: Record<string, string | undefined>) => "demo" | "live";
}

/** One person a live source says the campaign may call. */
export interface SourceContact {
  /** The source's own id for this person or appointment: the row's
   * `external_ref`, so the same person is never queued twice. */
  externalRef: string;
  /** E.164, or null when the source holds no number to ring. */
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  /** The campaign's own fields (`custom_data`). A date of birth goes under
   * `date_of_birth` (YYYY-MM-DD), where a returned call looks for it. */
  data: Record<string, unknown>;
}

/** What the source says about one person at the moment of the dial. */
export type SourceRecheck =
  /** Still on the list; `contact` carries today's phone and fields. */
  | { state: "current"; contact: SourceContact }
  /** The reason they were on the list is over (the appointment was cancelled
   * or moved): the row is settled and never rung for it. */
  | { state: "gone" }
  /** Not on the list right now, for a reason that can change back: the row
   * waits for the next rebuild rather than being rung on a stale list. */
  | { state: "off_list" };

export interface ContactSource {
  /** For logs and `custom_data.source`. */
  name: string;
  /** How often the queue is refreshed from the source. */
  refreshEveryMs: number;
  /** How long a row that left the list waits before it is looked at again. */
  parkMs: number;
  /** Everyone the campaign may call right now. */
  list(now: Date): Promise<SourceContact[]>;
  /** One person, re-checked live. Throws when the source cannot answer —
   * and the dialler then does not ring them. */
  recheck(externalRef: string, now: Date): Promise<SourceRecheck>;
}

/** Minutes to wait after Twilio refuses a dial before retrying the same
 * person. Not the person cooldown: nobody was rung. A policy may set
 * `infraRetryMinutes` to override. */
export const DEFAULT_INFRA_RETRY_MINUTES = 15;

/** Consecutive Twilio refusals that may use the short retry. After this,
 * the next wait is the person cooldown so a permanently refused number
 * cannot sit on the 15-minute loop for the whole calling day. */
export const DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES = 3;

/** Upper bound for the infrastructure retry, in minutes. A huge finite
 * value (1e20) would otherwise make `new Date(now + minutes * 60_000)`
 * an Invalid Date and throw inside releaseContact. */
export const MAX_INFRA_RETRY_MINUTES = 24 * 60;

/** How far back consecutiveRefusedAttempts looks. A self-referencing
 * NOT EXISTS over a contact's whole history is more than the cap needs. */
export const REFUSAL_STREAK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A usable infrastructure-retry wait. Non-numbers, non-finite values
 * and anything 0 or less fall back to DEFAULT_INFRA_RETRY_MINUTES so a
 * bad policy cannot produce an Invalid Date or a retry on every tick.
 * Anything above MAX_INFRA_RETRY_MINUTES is clamped to that max. */
export function resolvedInfraRetryMinutes(
  policy: Pick<OutboundLanePolicy, "infraRetryMinutes">,
): number {
  const n = policy.infraRetryMinutes;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_INFRA_RETRY_MINUTES;
  }
  return Math.min(n, MAX_INFRA_RETRY_MINUTES);
}

/** A usable consecutive-refusal cap. Same fallback rule as the retry
 * minutes: a missing or invalid value is the default, never 0. */
export function resolvedMaxConsecutiveInfraRetries(
  policy: Pick<OutboundLanePolicy, "maxConsecutiveInfraRetries">,
): number {
  const n = policy.maxConsecutiveInfraRetries;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES;
  }
  return Math.floor(n);
}

/** The fleet-wide switch. Nothing in this layer places a call unless it is
 * exactly "1"; a typo is off, never on. */
export function outboundDialingEnabled(env: Record<string, string | undefined>): boolean {
  return env.RUNTIME_OUTBOUND_DIALING === "1";
}

export function campaignEnabled(
  policy: OutboundLanePolicy,
  env: Record<string, string | undefined>,
): boolean {
  return outboundDialingEnabled(env) && env[policy.enableEnv] === "1";
}
