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
 *        - the calling window and the per-person caps (./callingWindow.ts),
 *          counted over every row in the campaign carrying the same phone;
 *        - no call to that phone is still on the line, in any campaign.
 *      A failed check hands the row back with the reason's next chance.
 *   3. DIAL: an attempt row first, then Twilio. The attempt row exists
 *      before Twilio is asked so a call that rings while we are still
 *      waiting for Twilio's reply has something to land on. A CLEAR
 *      Twilio refusal — a RestException with an HTTP 4xx status —
 *      records the attempt as NOT_PLACED (nobody was rung) and hands the
 *      row back for a short infrastructure retry, not the person
 *      cooldown. After DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES of those
 *      in a row, the person cooldown applies so a permanently refused
 *      number cannot sit on the 15-minute loop. An AMBIGUOUS createCall
 *      error (a socket reset, a lost response, a 5xx) may have already
 *      created the call: the attempt is left open so callOpenOnPhone
 *      still sees it, and the contact stays 'calling' so the status
 *      callback and record_call_outcome can settle it. If no callback
 *      ever arrives, the stale-claim reaper hands the row back after
 *      30 minutes with a fresh next_attempt_at. Contact bookkeeping
 *      (attempts++, contacted) waits until Twilio has ACCEPTED. Once
 *      Twilio has ACCEPTED, nothing hands the row back.
 *
 * Twilio is asked for answering-machine detection that waits for the
 * greeting to end (`DetectMessageEnd`), the 5Star lane's setting since it
 * went live: the answer webhook then knows whether it is talking to a
 * person, a machine or a fax before any agent exists. The webhook URL names
 * the contact and the attempt in its query; Twilio signs the whole URL, so
 * the webhook's signature check also proves the query is the one we sent.
 *
 * NOTHING DIALS unless RUNTIME_OUTBOUND_DIALING=1 AND the campaign's own
 * enable variable is "1" AND a caller-ID number is configured AND that
 * number's Twilio Voice URL points back at this lane on this deployment.
 *
 * THAT LAST CONDITION IS THE OPERATOR'S RULE, 2026-10-21: "There is no
 * redirect. If a patient calls back, like we expect them to, the voice agent
 * has to handle that call as well." The person we ring sees the caller ID and
 * rings it back, so it must reach the same lane, which answers returned calls
 * (./callback.ts). A campaign whose callbacks would land on another line, on a
 * stale workspace process, or nowhere does not dial at all (callbackRouting).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ContactSource, NotPlacedReason, OutboundLanePolicy, SourceContact } from "./campaign";
import {
  REFUSAL_STREAK_WINDOW_MS,
  campaignEnabled,
  placeByPassed,
  resolvedInfraRetryMinutes,
  resolvedMaxConsecutiveInfraRetries,
} from "./campaign";
import { mayDialNow, pacificParts } from "./callingWindow";
import { NOT_PLACED, dncKey, type ContactRow, type OutboundStore } from "./store";
import { VOICE_PATH_PREFIX } from "../voiceWebhook";

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
    timeLimit?: number;
    machineDetection?: "DetectMessageEnd";
    machineDetectionTimeout?: number;
    statusCallback: string;
    statusCallbackMethod: "POST";
    statusCallbackEvent: string[];
  }): Promise<{ sid: string }>;
  /**
   * The Voice URL configured on one of the account's own numbers, or null
   * when the number is not on this account. Read before dialling: a call
   * back to the caller ID goes wherever this points (callbackRouting).
   */
  voiceUrlFor(phoneNumber: string): Promise<string | null>;
}

/** How long a confirmed callback route is trusted before Twilio is asked
 * again. A route that is wrong is re-read on every tick. */
export const CALLBACK_ROUTE_TTL_MS = 10 * 60 * 1000;

/** Per campaign: the last route Twilio confirmed, and the last problem
 * logged, so a wrong route is said once rather than every minute. */
export type CallbackRouteCache = Map<string, { okAt?: number; lastProblem?: string | null }>;

/**
 * Why a call back to the caller ID would NOT reach this lane on this
 * deployment, or null when it would. Pure, so every refusal is tested.
 * The host matters as much as the path: a number pointed at a workspace URL
 * reaches a different process, which can run a different build (CLAUDE.md,
 * "How to tell whether a deploy actually took").
 */
export function callbackRoutingProblem(voiceUrl: string | null, host: string, slug: string): string | null {
  if (voiceUrl === null) return "the caller-ID number is not on this Twilio account";
  let url: URL;
  try {
    url = new URL(voiceUrl);
  } catch {
    return "the caller-ID number has no usable Voice URL";
  }
  const want = `${VOICE_PATH_PREFIX}/${slug}`;
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== want) {
    return `calls back to the caller ID reach ${path || "/"}, not ${want} — a person ringing back would not reach this lane`;
  }
  if (url.host.toLowerCase() !== host.toLowerCase()) {
    return `calls back to the caller ID reach ${url.host}, not this deployment (${host})`;
  }
  return null;
}

/** Twilio asked, cached, and logged once per change. Fails closed: a route
 * that cannot be read is a route that is not confirmed. */
export async function callbackRouting(
  slug: string,
  from: string,
  deps: Pick<DialerDeps, "twilio" | "host" | "routeCache" | "log">,
  now: number,
): Promise<string | null> {
  const key = `${slug}|${from}`;
  const cached = deps.routeCache?.get(key);
  if (cached?.okAt !== undefined && now - cached.okAt < CALLBACK_ROUTE_TTL_MS) return null;
  let problem: string | null;
  try {
    problem = callbackRoutingProblem(await deps.twilio.voiceUrlFor(from), deps.host, slug);
  } catch (error) {
    problem = `could not read the caller-ID number's Voice URL from Twilio (${
      error instanceof Error ? error.message : String(error)
    })`;
  }
  if (deps.routeCache) {
    if (problem !== null && cached?.lastProblem !== problem) {
      (deps.log ?? console.log)(`[outbound] ${slug}: NOT dialling — ${problem}`);
    }
    deps.routeCache.set(key, problem === null ? { okAt: now, lastProblem: null } : { lastProblem: problem });
  }
  return problem;
}

export interface DialerDeps {
  store: OutboundStore;
  twilio: OutboundTwilio;
  env: Record<string, string | undefined>;
  /** The public host Twilio reaches this process on, no scheme. */
  host: string;
  /** Kept by the scheduler across ticks; absent, Twilio is asked every tick. */
  routeCache?: CallbackRouteCache;
  /** When each source-fed campaign last refreshed its queue (v107). Kept by
   * the scheduler; absent, the queue is refreshed on every tick. */
  sourceRefreshedAt?: Map<string, number>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TickResult {
  campaign: string;
  skipped?: string;
  reaped: number;
  dialled: number;
  held: Record<string, number>;
  /** A source refresh this tick: rows written and rows parked. */
  refreshed?: { written: number; parked: number; listed: number };
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

/**
 * A RestException whose HTTP status is 4xx is the only createCall throw
 * that proves Twilio refused the request and created no call. Anything
 * else — a socket reset, a lost response, a 5xx — can arrive after
 * Twilio has already accepted, so it must not be treated as not_placed.
 */
export function isClearTwilioRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  const ctor = (error as { constructor?: { name?: string } }).constructor?.name ?? "";
  if (name !== "RestException" && ctor !== "RestException") return false;
  const raw = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 400 && raw < 500;
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
    case "twilio_refused": {
      // A Twilio / infrastructure refusal rang nobody, so it must not
      // spend the person cooldown. Retry shortly; a policy may shorten
      // or lengthen it. A non-number or a value of 0 or less is the
      // default, never NaN or a retry on every tick.
      const minutes = resolvedInfraRetryMinutes(policy);
      return new Date(now.getTime() + minutes * 60 * 1000);
    }
    default:
      return new Date(now.getTime() + policy.caps.minHoursBetween * hour);
  }
}

/** When the stale-claim reaper hands a row back, it must not be due
 * again on the same tick. A campaign with minHoursBetween 0 (the
 * proving lane) would otherwise be re-dialled immediately. Floor at
 * the stale window; a real person cooldown that is longer still wins. */
export function reapNextAttemptAt(now: Date, policy: OutboundLanePolicy): Date {
  const cooldown = nextLookAt(now, "too_soon", policy);
  const floor = new Date(now.getTime() + STALE_CLAIM_MS);
  return cooldown.getTime() > floor.getTime() ? cooldown : floor;
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

  // A person who rings the caller ID back must reach this lane. Checked
  // before anybody is claimed, so a wrong route costs nobody an attempt.
  const route = await callbackRouting(slug, from, deps, now.getTime());
  if (route) return { ...result, skipped: route };

  try {
    const campaignId = await deps.store.ensureCampaign(policy.campaignKey, slug);
    if (!campaignId) return { ...result, skipped: `no agents row for ${slug}` };

    // A campaign fed live from a source refreshes its queue from it first,
    // and re-checks each person at the dial (dialOne). A source that is not
    // configured in this process means the campaign does not dial: a list
    // nobody can re-check is a list that may be stale.
    let source: ContactSource | null = null;
    if (policy.source) {
      source = await policy.source().catch(() => null);
      if (!source) return { ...result, skipped: "contact source not available" };
      const refreshed = await refreshFromSource(policy, source, campaignId, now, deps);
      if (refreshed) result.refreshed = refreshed;
    }

    result.reaped = await deps.store.reapStaleClaims(
      campaignId,
      new Date(now.getTime() - STALE_CLAIM_MS),
      reapNextAttemptAt(now, policy),
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
      const held = await dialOne(slug, policy, candidate, campaignId, from, now, deps, source);
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

/** The fields a refresh compares, in a fixed key order. */
function sourceKey(c: { phone: string | null; firstName: string | null; lastName: string | null; data: Record<string, unknown> }): string {
  const ordered = Object.fromEntries(Object.entries(c.data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify([dncKey(c.phone ?? ""), c.firstName ?? "", c.lastName ?? "", ordered]);
}

/**
 * REFRESH THE QUEUE FROM THE LIVE SOURCE (v107), at most once per
 * `refreshEveryMs`. Only what changed is written — a new person, a new
 * phone, new fields — so a quiet refresh writes nothing to the Hub; and a
 * row that has left the list is parked until the next rebuild rather than
 * deleted, because its history stays with it and the list can change back.
 * A source that cannot be read writes nothing and parks nobody: the per-dial
 * re-check, which fails closed, is what guarantees nobody is rung on it.
 */
export async function refreshFromSource(
  policy: OutboundLanePolicy,
  source: ContactSource,
  campaignId: string,
  now: Date,
  deps: Pick<DialerDeps, "store" | "sourceRefreshedAt" | "log">,
): Promise<{ written: number; parked: number; listed: number } | null> {
  const last = deps.sourceRefreshedAt?.get(policy.campaignKey);
  if (last !== undefined && now.getTime() - last < source.refreshEveryMs) return null;
  const log = deps.log ?? console.log;
  let listed: SourceContact[];
  try {
    listed = await source.list(now);
  } catch (error) {
    log(`[outbound] ${policy.campaignKey}: could not read ${source.name} — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const have = new Map((await deps.store.sourceRows(campaignId)).map((r) => [r.externalRef, r]));
  const live = new Map(listed.map((c) => [c.externalRef, c]));
  const changed: Array<SourceContact & { phone: string }> = [];
  for (const c of listed) {
    if (!c.phone) continue; // nothing to ring; the row is not created
    const row = have.get(c.externalRef);
    if (!row || sourceKey({ ...row, data: row.customData }) !== sourceKey(c)) changed.push(c as SourceContact & { phone: string });
  }
  const written = await deps.store.upsertSourceContacts(campaignId, changed);
  const leftList = [...have.values()].filter((r) => !live.has(r.externalRef)).map((r) => r.externalRef);
  const parked = await deps.store.parkContacts(campaignId, leftList, new Date(now.getTime() + source.parkMs));
  deps.sourceRefreshedAt?.set(policy.campaignKey, now.getTime());
  if (written > 0 || parked > 0) {
    log(`[outbound] ${policy.campaignKey}: ${source.name} — ${listed.length} listed, ${written} written, ${parked} parked`);
  }
  return { written, parked, listed: listed.length };
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
  source: ContactSource | null = null,
): Promise<string | null> {
  // Defense against a stale queue read: live approvals never retry.
  if (candidate.customData.plugin_live === true) return "live_call";
  const contact = await deps.store.claimContact(candidate.id, now);
  if (!contact) return "claimed_elsewhere";

  // THE LIVE RE-CHECK (v107), holding the claim and before anything else:
  // the list the queue was refreshed from can be fifteen minutes old, and an
  // appointment cancelled since must not be the reason we ring somebody.
  if (source) {
    if (!contact.externalRef) {
      // A row the source never wrote has nothing to re-check against.
      await deps.store.releaseContact(contact.id, candidate.status, new Date(now.getTime() + source.parkMs));
      return "not_from_source";
    }
    let live;
    try {
      live = await source.recheck(contact.externalRef, now);
    } catch {
      await deps.store.releaseContact(contact.id, candidate.status, nextLookAt(now, "twilio_refused", policy));
      return "source_unavailable";
    }
    if (live.state === "gone") {
      await deps.store.settleContact(contact.id, "rescheduled", {
        notes: `${source.name}: the reason for this call is over (cancelled or moved at the source)`,
      });
      return "source_gone";
    }
    if (live.state === "off_list" || !live.contact.phone) {
      await deps.store.releaseContact(contact.id, candidate.status, new Date(now.getTime() + source.parkMs));
      return live.state === "off_list" ? "off_list" : "no_phone";
    }
    if (dncKey(live.contact.phone) !== dncKey(contact.phone)) {
      // Today's number from the source, before the do-not-contact check reads it.
      await deps.store.updateContactPhone(contact.id, live.contact.phone);
      contact.phone = live.contact.phone;
    }
  }

  // Every attempt on this phone in this campaign, not only this row's: an
  // import can carry one person on two rows, and the caps are per person.
  // A dial Twilio refused is not among them — nobody was rung.
  const prior = await deps.store.priorAttempts(contact.id);
  // Whether THIS row may have rung anybody (v115): any of its own attempts
  // that Twilio did not refuse, an open one included. An ambiguous createCall
  // throw or a lost markContactDialled leaves `contact.attempts` at 0 while
  // the phone may have rung, so the counter cannot answer this.
  const dialledThisRow = prior.some((a) => a.contactId === contact.id);
  // A row settled before it was ever dialled tells the lane, so whoever asked
  // for the call learns it never rang. A row that was dialled is not
  // reported: that call may have rung.
  const notPlaced = async (reason: NotPlacedReason): Promise<void> => {
    if (dialledThisRow || !policy.onNotPlaced) return;
    try {
      await policy.onNotPlaced({ id: contact.id, customData: contact.customData }, reason);
    } catch {
      (deps.log ?? console.log)(`[outbound] ${policy.campaignKey}: could not report a call that was never placed (${reason})`);
    }
  };

  if (await deps.store.isDoNotContact(contact.phone)) {
    await deps.store.settleContact(contact.id, "do_not_call");
    await notPlaced("do_not_contact");
    return "do_not_contact";
  }

  // A contact that had to be FIRST rung by a deadline it has missed (v115):
  // settled, never rung late. An approval acted on hours after it was given
  // is a call nobody asked for any more. THIS ROW's own dials decide it, not
  // the phone's: `prior` is every attempt on the number, so a second approval
  // for a patient already called once would read as a retry and be rung the
  // next morning.
  if (!dialledThisRow && placeByPassed(contact.customData, now)) {
    await deps.store.settleContact(contact.id, "rescheduled", {
      notes: "not placed before its place-by deadline; never rung",
    });
    await notPlaced("place_by_passed");
    return "place_by_passed";
  }
  if (prior.length >= policy.caps.total) {
    await deps.store.settleContact(contact.id, "max_attempts");
    await notPlaced("total_cap");
    return "total_cap";
  }
  // A call to this phone still on the line, from this campaign or any other:
  // never ring a person twice at once.
  if (await deps.store.callOpenOnPhone(contact.id, new Date(now.getTime() - STALE_CLAIM_MS))) {
    await deps.store.releaseContact(contact.id, candidate.status, nextLookAt(now, "too_soon", policy));
    return "call_in_progress";
  }
  const decision = mayDialNow(now, prior, policy.window, policy.caps);
  if (!decision.ok) {
    // Back to the status it had before the claim, not 'pending': a row that
    // has already had a voicemail left keeps saying so.
    await deps.store.releaseContact(contact.id, candidate.status, nextLookAt(now, decision.reason, policy));
    return decision.reason;
  }

  const attemptId = await deps.store.startAttempt(contact.id, campaignId, prior.length + 1);
  let call: { sid: string };
  try {
    call = await deps.twilio.createCall({
      // E.164, the form Twilio requires. The do-not-contact check above has
      // already refused any number dncKey cannot read as ten digits.
      to: `+1${dncKey(contact.phone)}`,
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
  } catch (error) {
    const log = deps.log ?? console.log;
    const detail = error instanceof Error ? error.message : String(error);
    if (isClearTwilioRefusal(error)) {
      log(`[outbound] ${policy.campaignKey}: Twilio refused the dial — ${detail}`);
      // Kept for the audit trail, counted against no cap, and handed back
      // with the status it had: nobody was rung, so nothing about the
      // person changed. The next look is an infrastructure retry, unless
      // this contact has already had the consecutive-refusal cap of them.
      await deps.store.finishAttempt(attemptId, { status: NOT_PLACED });
      const consecutive = await deps.store.consecutiveRefusedAttempts(
        contact.id,
        new Date(now.getTime() - REFUSAL_STREAK_WINDOW_MS),
      );
      const reason =
        consecutive > resolvedMaxConsecutiveInfraRetries(policy) ? "too_soon" : "twilio_refused";
      await deps.store.releaseContact(contact.id, candidate.status, nextLookAt(now, reason, policy));
      return "twilio_refused";
    }
    // Ambiguous: client.calls.create can throw after Twilio has already
    // created the call (socket reset, lost response, 5xx). Ending the
    // attempt would hide a live ring from callOpenOnPhone. Releasing the
    // claim would drop every webhook and record_call_outcome, because
    // they all require 'calling'. Leave the attempt open and the row
    // claimed; the status callback settles a real call, and the
    // stale-claim reaper hands back a call that never existed.
    log(
      `[outbound] ${policy.campaignKey}: Twilio createCall did not return — the call may already be ringing (${detail})`,
    );
    return "twilio_uncertain";
  }
  // Twilio accepted: the phone is ringing, so nothing below may hand the row
  // back. Bookkeeping (attempts / contacted) and the CallSid are each their
  // own try: a database blip after an accepted call must not release it.
  // The webhooks find the contact and the attempt by the ids in their URLs,
  // not by the CallSid, so a CallSid that could not be saved costs a column
  // and nothing else.
  try {
    await deps.store.markContactDialled(contact.id);
  } catch (error) {
    (deps.log ?? console.log)(
      `[outbound] ${policy.campaignKey}: call ${call.sid} placed but the contact could not be marked dialled — the claim stands and the webhooks settle it (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    await deps.store.setAttemptCallSid(attemptId, call.sid);
  } catch (error) {
    (deps.log ?? console.log)(
      `[outbound] ${policy.campaignKey}: call ${call.sid} placed but its CallSid could not be saved — the claim stands and the webhooks settle it (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return null;
}
