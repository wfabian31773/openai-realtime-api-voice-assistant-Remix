/**
 * src/runtime/outbound/dialer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Places outbound calls for one campaign. One tick: reap stuck claims, work
 * out how many calls this campaign may start, and for each person due a
 * call — CLAIM, check, DIAL, in that order, every time.
 *
 *   1. CLAIM the contact row (store.claimContact). Exactly one tick, in one
 *      process, gets it; everyone else moves on. Nothing is checked before
 *      the claim, because a check made on a row you do not hold is a check on
 *      a row somebody else may be dialling.
 *   2. CHECK, holding the claim:
 *        - the phone is not on the do-not-contact list (phone-wide, every
 *          campaign, and an unreadable number is refused);
 *        - the calling window and the per-person caps (./callingWindow.ts).
 *      A failed check hands the row back with the reason's next chance.
 *   3. DIAL: an attempt row first, then Twilio, then the attempt's CallSid.
 *      The attempt row exists before Twilio is asked so a call that rings
 *      while we are still waiting for Twilio's reply has something to land
 *      on. A Twilio refusal settles the attempt as failed and hands the row
 *      back for a later try.
 *
 * Twilio is asked for answering-machine detection that waits for the
 * greeting to end (`DetectMessageEnd`), the 5Star lane's setting since it
 * went live: the answer webhook then knows whether it is talking to a
 * person, a machine or a fax before any agent exists. The webhook URL names
 * the contact and the attempt in its query; Twilio signs the whole URL, so
 * the webhook's signature check also proves the query is the one we sent.
 *
 * NOTHING DIALS unless RUNTIME_OUTBOUND_DIALING=1 AND the campaign's own
 * enable variable is "1" AND a caller-ID number is configured.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { OutboundLanePolicy } from "./campaign";
import { campaignEnabled } from "./campaign";
import { mayDialNow, pacificParts } from "./callingWindow";
import type { ContactRow, OutboundStore } from "./store";

export const OUTBOUND_PATH_PREFIX = "/voice/outbound";

/** How long a row may sit in 'calling' before the tick assumes the process
 * that claimed it died and hands it back. Longer than the longest call. */
export const STALE_CLAIM_MS = 30 * 60 * 1000;

/** Seconds Twilio lets the phone ring before giving up. */
export const RING_TIMEOUT_SECONDS = 25;

export interface OutboundTwilio {
  createCall(opts: {
    to: string;
    from: string;
    url: string;
    method: "POST";
    timeout: number;
    machineDetection: "DetectMessageEnd";
    machineDetectionTimeout: number;
    statusCallback: string;
    statusCallbackMethod: "POST";
    statusCallbackEvent: string[];
  }): Promise<{ sid: string }>;
}

export interface DialerDeps {
  store: OutboundStore;
  twilio: OutboundTwilio;
  env: Record<string, string | undefined>;
  /** The public host Twilio reaches this process on, no scheme. */
  host: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TickResult {
  campaign: string;
  skipped?: string;
  reaped: number;
  dialled: number;
  held: Record<string, number>;
}

/** Where Twilio posts when the call is answered. */
export function answerUrl(host: string, slug: string, contactId: string, attemptId: string): string {
  const q = new URLSearchParams({ contact: contactId, attempt: attemptId });
  return `https://${host}${OUTBOUND_PATH_PREFIX}/${slug}?${q.toString()}`;
}

/** Where Twilio posts the call's status changes. */
export function statusUrl(host: string, slug: string, contactId: string, attemptId: string): string {
  const q = new URLSearchParams({ contact: contactId, attempt: attemptId });
  return `https://${host}${OUTBOUND_PATH_PREFIX}/${slug}/status?${q.toString()}`;
}

/** The next moment a held row should be looked at again. Coarse on purpose:
 * the window and the caps are re-checked at that moment anyway. */
export function nextLookAt(now: Date, reason: string, policy: OutboundLanePolicy): Date {
  const hour = 60 * 60 * 1000;
  switch (reason) {
    case "outside_hours":
    case "closed_day":
    case "holiday":
    case "daily_cap": {
      // Tomorrow, at the window's opening hour in Pacific time — computed by
      // stepping forward an hour at a time until the window opens, so it
      // stays right across a daylight-saving change.
      let t = new Date(now.getTime() + hour);
      for (let i = 0; i < 24 * 8; i++) {
        const p = pacificParts(t);
        if (p.date !== pacificParts(now).date && p.hour === policy.window.startHour) return t;
        t = new Date(t.getTime() + hour);
      }
      return new Date(now.getTime() + 24 * hour);
    }
    case "weekly_cap":
      return new Date(now.getTime() + 24 * hour);
    default:
      return new Date(now.getTime() + policy.caps.minHoursBetween * hour);
  }
}

/** One tick of one campaign. Never throws: a dialler failure is a log line,
 * and the next tick tries again. */
export async function runCampaignTick(
  slug: string,
  policy: OutboundLanePolicy,
  deps: DialerDeps,
): Promise<TickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: TickResult = { campaign: policy.campaignKey, reaped: 0, dialled: 0, held: {} };

  if (!campaignEnabled(policy, deps.env)) return { ...result, skipped: "disabled" };
  const from = deps.env[policy.callerIdEnv];
  if (!from) return { ...result, skipped: `no caller ID (${policy.callerIdEnv})` };
  // No public host means callback URLs Twilio refuses after the attempt row
  // already exists: a person's attempt spent on a call that never rang.
  if (!deps.host) return { ...result, skipped: "no public host" };

  // The window first, with no attempts: outside it nobody is claimed at all.
  const window = mayDialNow(now, [], policy.window, policy.caps);
  if (!window.ok) return { ...result, skipped: window.reason };

  try {
    const campaignId = await deps.store.ensureCampaign(policy.campaignKey, slug);
    if (!campaignId) return { ...result, skipped: `no agents row for ${slug}` };

    result.reaped = await deps.store.reapStaleClaims(
      campaignId,
      new Date(now.getTime() - STALE_CLAIM_MS),
    );
    const inFlight = await deps.store.callsInFlight(
      campaignId,
      new Date(now.getTime() - STALE_CLAIM_MS),
    );
    const capacity = Math.max(0, policy.concurrency - inFlight);
    if (capacity === 0) return { ...result, skipped: "at concurrency" };

    // Read a few more than the capacity: some will be held by a check.
    const due = await deps.store.dialableContacts(campaignId, now, capacity * 3);
    for (const candidate of due) {
      if (result.dialled >= capacity) break;
      const held = await dialOne(slug, policy, candidate, campaignId, from, now, deps);
      if (held) result.held[held] = (result.held[held] ?? 0) + 1;
      else result.dialled += 1;
    }
  } catch (error) {
    log(
      `[outbound] ${policy.campaignKey}: tick failed — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.dialled > 0 || Object.keys(result.held).length > 0) {
    log(
      `[outbound] ${policy.campaignKey}: dialled ${result.dialled}` +
        (Object.keys(result.held).length ? `, held ${JSON.stringify(result.held)}` : ""),
    );
  }
  return result;
}

/**
 * Claim, check, dial one contact. Returns null when a call was placed, or
 * the reason it was not (and the row has been handed back or settled).
 */
async function dialOne(
  slug: string,
  policy: OutboundLanePolicy,
  candidate: ContactRow,
  campaignId: string,
  from: string,
  now: Date,
  deps: DialerDeps,
): Promise<string | null> {
  const contact = await deps.store.claimContact(candidate.id, now);
  if (!contact) return "claimed_elsewhere";

  if (await deps.store.isDoNotContact(contact.phone)) {
    await deps.store.settleContact(contact.id, "do_not_call");
    return "do_not_contact";
  }

  const prior = await deps.store.priorAttemptTimes(contact.id);
  if (prior.length >= policy.caps.total) {
    await deps.store.settleContact(contact.id, "max_attempts");
    return "total_cap";
  }
  const decision = mayDialNow(now, prior.map((at) => ({ at })), policy.window, policy.caps);
  if (!decision.ok) {
    // Back to the status it had before the claim, not 'pending': a row that
    // has already had a voicemail left keeps saying so.
    await deps.store.releaseContact(contact.id, candidate.status, nextLookAt(now, decision.reason, policy));
    return decision.reason;
  }

  const attemptId = await deps.store.startAttempt(contact.id, campaignId, prior.length + 1);
  try {
    const call = await deps.twilio.createCall({
      to: contact.phone,
      from,
      url: answerUrl(deps.host, slug, contact.id, attemptId),
      method: "POST",
      timeout: RING_TIMEOUT_SECONDS,
      machineDetection: "DetectMessageEnd",
      machineDetectionTimeout: 30,
      statusCallback: statusUrl(deps.host, slug, contact.id, attemptId),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed"],
    });
    await deps.store.setAttemptCallSid(attemptId, call.sid);
    return null;
  } catch (error) {
    (deps.log ?? console.log)(
      `[outbound] ${policy.campaignKey}: Twilio refused the dial — ${error instanceof Error ? error.message : String(error)}`,
    );
    await deps.store.finishAttempt(attemptId, { status: "failed" });
    await deps.store.releaseContact(contact.id, "no_answer", nextLookAt(now, "too_soon", policy));
    return "twilio_refused";
  }
}
