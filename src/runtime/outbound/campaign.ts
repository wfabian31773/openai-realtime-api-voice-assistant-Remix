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
   * calling day. Default DEFAULT_INFRA_RETRY_MINUTES (15).
   */
  infraRetryMinutes?: number;
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
}

/** Minutes to wait after Twilio refuses a dial before retrying the same
 * person. Not the person cooldown: nobody was rung. A policy may set
 * `infraRetryMinutes` to override. */
export const DEFAULT_INFRA_RETRY_MINUTES = 15;

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
