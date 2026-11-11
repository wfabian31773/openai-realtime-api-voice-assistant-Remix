/**
 * src/runtime/outbound/outreachText.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OUTREACH TEXT (v211). Operator, 2026-11-11: "i want them all to receive
 * a text message as well", "they should get a customized link that lets them
 * book in 4 easy steps", "there is already a number that NPX uses, we should
 * use that number, wording is fine."
 *
 * One text per contact on a campaign that registers `textOutreach`, from the
 * campaign's own caller-ID number, carrying a link to its booking page
 * (./bookingLink.ts). The link names nobody: it is a random token, and the
 * contact row holds only the token's SHA-256.
 *
 * THE TEXT STATE LIVES IN ONE RESERVED KEY, `custom_data.outreach_text`. Not a
 * top-level `sms_sent_at`: the queue refresh (dialer.refreshFromSource)
 * rewrites a source-fed row's custom_data whenever the source's fields change,
 * so a top-level key would be wiped and the person texted again. The refresh
 * neither compares nor overwrites this key (OUTREACH_TEXT_KEY).
 *
 * CLAIM, CHECK, SEND — the dialler's order, for the same reason (dialer.ts):
 *   1. CLAIM the row's text (store.claimText): one atomic UPDATE moves it to
 *      `claimed` only when no text is held, or a retry is due. Two ticks or
 *      two processes can never text the same row twice.
 *   2. CHECK, holding the claim: the source still lists the appointment (a
 *      cancelled one is never the reason we text), and the number is on no
 *      do-not-contact row of any source.
 *   3. SEND through Twilio. A send that may have gone out is never retried:
 *      a second text is worse than a missing one. A clear refusal waits a
 *      short while and is tried again, at most MAX_SEND_TRIES times.
 *
 * NOTHING IS TEXTED unless the campaign's own text switch is "1" (for NPX,
 * NPX_OUTREACH_TEXTS) — on top of everything the dialler needs:
 * RUNTIME_OUTBOUND_DIALING=1, the campaign's call switch, its caller ID and a
 * public host. Only inside the campaign's calling window, so a closed holiday
 * holds the texts as it holds the calls.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomBytes } from "node:crypto";
import type { ContactSource, OutboundLanePolicy } from "./campaign";
import { mayDialNow } from "./callingWindow";
import { OUTREACH_TEXT_KEY, TEXTABLE_STATUSES, dncKey, type ContactRow, type OutboundStore } from "./store";
import { failureFromUnknown } from "../../plugin/sendFailure";
import type { SmsSender } from "../../plugin/sms";
import type { BookingPageLane } from "./bookingPage";

// The reserved custom_data key and who may be texted live with the store,
// whose SQL reads both; they are re-exported here for the text's readers.
export { OUTREACH_TEXT_KEY, TEXTABLE_STATUSES };

/** The path the booking page is served on: /book/<token>. */
export const BOOKING_PATH_PREFIX = "/book";

/** A link works for this long after the text is sent. */
export const BOOKING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Random bytes in a token: 32 (256 bits), base64url, 43 characters. */
export const BOOKING_TOKEN_BYTES = 32;

/** A clear Twilio refusal is tried this many times in all, then given up. */
export const MAX_SEND_TRIES = 3;

/** How long a refused send, or a row the source could not answer for, waits. */
export const TEXT_RETRY_MS = 60 * 60 * 1000;


/** What one row's text came to, and what its booking page has done since. */
export interface OutreachTextRecord {
  state: "claimed" | "sent" | "unknown" | "failed" | "skipped" | "retry";
  /** The lane that texted it: the booking page reads this lane's page. */
  lane?: string;
  /** SHA-256 of the link's token, hex. The token itself is only in the text. */
  token_hash?: string;
  /** ISO instants. */
  claimed_at?: string;
  expires_at?: string;
  sent_at?: string;
  retry_after?: string;
  /** Twilio's MessageSid, for the audit trail. */
  message_sid?: string;
  /** Why it was skipped, failed or put back; a short code, never a body. */
  reason?: string;
  /** Clear refusals so far. */
  tries?: number;
  /** The booking page: date-of-birth tries, the verified session, the booking. */
  dob_tries?: number;
  verified_at?: string;
  session_hash?: string;
  session_expires_at?: string;
  booking_started_at?: string | null;
  booked_at?: string;
  booking_id?: string;
}

/** The campaign's text, as its lane registers it (OutboundLanePolicy.textOutreach). */
export interface OutboundTextPolicy {
  /** Env var that must equal "1" for this campaign to text. Off by default. */
  enableEnv: string;
  /** Texts sent per minute tick, at most. */
  perTick: number;
  /** The text, carrying the link. GSM-7 only, so it is never sent as UCS-2. */
  body(link: string): string;
  /** What the link opens: the lane's booking page (./bookingPage.ts). A
   * campaign that texts without one sends a link that only says expired. */
  page?: BookingPageLane;
}

/** The SHA-256 of a token, hex: what the row holds and the page looks up. */
export function hashBookingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new link token and its hash. Random; names nobody. */
export function newBookingToken(): { token: string; hash: string } {
  const token = randomBytes(BOOKING_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashBookingToken(token) };
}

/** A token is the shape newBookingToken makes, or nothing is looked up. */
export function isBookingTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** The link in the text. */
export function bookingLinkUrl(host: string, token: string): string {
  return `https://${host}${BOOKING_PATH_PREFIX}/${token}`;
}

/** The row's text record, or null. */
export function textRecordOf(customData: Record<string, unknown>): OutreachTextRecord | null {
  const raw = customData[OUTREACH_TEXT_KEY];
  return raw && typeof raw === "object" ? (raw as OutreachTextRecord) : null;
}

/** custom_data without the reserved key: what the queue refresh compares. */
export function withoutTextRecord(customData: Record<string, unknown>): Record<string, unknown> {
  if (!(OUTREACH_TEXT_KEY in customData)) return customData;
  const { [OUTREACH_TEXT_KEY]: _held, ...rest } = customData;
  return rest;
}

/** The fleet's switch for this campaign's texts. */
export function textsEnabled(text: OutboundTextPolicy, env: Record<string, string | undefined>): boolean {
  return env[text.enableEnv] === "1";
}

export interface TextDeps {
  store: OutboundStore;
  env: Record<string, string | undefined>;
  host: string;
  /** Null when Twilio credentials are not configured. */
  sms: () => Promise<SmsSender | null>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TextTickResult {
  campaign: string;
  skipped?: string;
  sent: number;
  held: Record<string, number>;
}

/**
 * One tick of one campaign's texts. Never throws: a failure is a log line, and
 * the next tick tries again. The counts are the measurement:
 * `[outbound] <campaign>: texted N, held {...}`.
 */
export async function runTextTick(
  slug: string,
  policy: OutboundLanePolicy,
  deps: TextDeps,
): Promise<TextTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: TextTickResult = { campaign: policy.campaignKey, sent: 0, held: {} };
  const text = policy.textOutreach;
  if (!text) return { ...result, skipped: "no text" };
  if (!textsEnabled(text, deps.env)) return { ...result, skipped: "disabled" };
  // A link that could only say "expired" is never sent.
  if (!text.page) return { ...result, skipped: "no booking page" };
  const from = deps.env[policy.callerIdEnv];
  if (!from) return { ...result, skipped: `no caller ID (${policy.callerIdEnv})` };
  // The link must name a host the person's phone can open.
  if (!deps.host) return { ...result, skipped: "no public host" };
  const window = mayDialNow(now, [], policy.window, policy.caps);
  if (!window.ok) return { ...result, skipped: window.reason };

  try {
    const sender = await deps.sms();
    if (!sender) return { ...result, skipped: "no sms sender" };
    const campaignId = await deps.store.ensureCampaign(policy.campaignKey, slug);
    if (!campaignId) return { ...result, skipped: `no agents row for ${slug}` };
    let source: ContactSource | null = null;
    if (policy.source) {
      source = await policy.source().catch(() => null);
      if (!source) return { ...result, skipped: "contact source not available" };
    }
    const perTick = Math.max(0, Math.floor(text.perTick));
    const due = await deps.store.textableContacts(campaignId, now, perTick * 3);
    for (const candidate of due) {
      if (result.sent >= perTick) break;
      const held = await textOne(slug, candidate, text, from, now, deps, source);
      if (held) result.held[held] = (result.held[held] ?? 0) + 1;
      else result.sent += 1;
    }
  } catch (error) {
    log(`[outbound] ${policy.campaignKey}: text tick failed — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.sent > 0 || Object.keys(result.held).length > 0) {
    log(
      `[outbound] ${policy.campaignKey}: texted ${result.sent}` +
        (Object.keys(result.held).length ? `, held ${JSON.stringify(result.held)}` : ""),
    );
  }
  return result;
}

/** Claim, check, send one row's text. Null when it was sent, else the reason. */
async function textOne(
  slug: string,
  candidate: ContactRow,
  text: OutboundTextPolicy,
  from: string,
  now: Date,
  deps: TextDeps,
  source: ContactSource | null,
): Promise<string | null> {
  // A row the source never wrote has nothing to re-check against.
  if (source && !candidate.externalRef) return "not_from_source";
  const { token, hash } = newBookingToken();
  const prior = textRecordOf(candidate.customData);
  const claimed = await deps.store.claimText(candidate.id, now, {
    state: "claimed",
    lane: slug,
    ...(prior?.tries ? { tries: prior.tries } : {}),
    token_hash: hash,
    claimed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + BOOKING_LINK_TTL_MS).toISOString(),
  });
  if (!claimed) return "claimed_elsewhere";
  const later = new Date(now.getTime() + TEXT_RETRY_MS).toISOString();

  let phone = claimed.phone;
  if (source && claimed.externalRef) {
    let live;
    try {
      live = await source.recheck(claimed.externalRef, now);
    } catch {
      await deps.store.patchText(claimed.id, { state: "retry", retry_after: later, reason: "source_unavailable" });
      return "source_unavailable";
    }
    if (live.state === "gone") {
      // The appointment the text would be about is over: never texted for it.
      await deps.store.patchText(claimed.id, { state: "skipped", reason: "source_gone" });
      return "source_gone";
    }
    if (live.state === "off_list" || !live.contact.phone) {
      await deps.store.patchText(claimed.id, { state: "retry", retry_after: later, reason: "off_list" });
      return live.state === "off_list" ? "off_list" : "no_phone";
    }
    phone = live.contact.phone;
  }

  const key = dncKey(phone);
  // An unreadable number is refused, and any do-not-contact row — a voice
  // "don't call me" or an SMS STOP — blocks a text.
  if (!key || (await deps.store.isDoNotContact(phone))) {
    await deps.store.patchText(claimed.id, { state: "skipped", reason: "do_not_contact" });
    return "do_not_contact";
  }

  const sender = await deps.sms();
  if (!sender) {
    await deps.store.patchText(claimed.id, { state: "retry", retry_after: later, reason: "no_sms_sender" });
    return "no_sms_sender";
  }
  try {
    const sent = await sender.send({ to: `+1${key}`, from, body: text.body(bookingLinkUrl(deps.host, token)) });
    await deps.store.patchText(claimed.id, { state: "sent", sent_at: now.toISOString(), message_sid: sent.sid });
    return null;
  } catch (error) {
    const failure = failureFromUnknown(error);
    if (failure.mayHaveSent) {
      // It may be on their phone already, link and all: never sent twice.
      await deps.store.patchText(claimed.id, { state: "unknown", reason: failure.reason });
      return "send_unknown";
    }
    const tries = (prior?.tries ?? 0) + 1;
    await deps.store.patchText(
      claimed.id,
      tries >= MAX_SEND_TRIES
        ? { state: "failed", reason: failure.reason, tries }
        : { state: "retry", retry_after: later, reason: failure.reason, tries },
    );
    return "send_refused";
  }
}
