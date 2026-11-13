/**
 * THE BOOKING CONFIRMATION TEXT (v222).
 *
 * Operator, 2026-11-13: "Anything booked on the calls or by sms has to have
 * some message confirming with the appointment details." Before this build a
 * booking was confirmed only in words on the call, and the text's booking
 * page said it on the screen. Of the 46 bookings to 2026-11-12, three callers
 * rang back to ask for the details by text (VA-84162, VA-84603, VA-84678).
 *
 * At booking, bookOutreachSlot queues a confirmation on the contact
 * (`custom_data.outreach_text.confirmation`). The record carries the words
 * already rendered, so the text names nothing the tick would have to look up
 * again. The scheduler's tick sends it:
 *
 * - once per booking: an atomic claim, the text tick's rule;
 * - after the call has ended, for a booking made on a call (a dialled or
 *   returned call still open on the phone puts it back a minute);
 * - inside the campaign's calling window;
 * - never to a number on do_not_contact (a voice opt-out or an SMS STOP).
 *
 * A caller who asks staff on the same call to cancel or change the booking
 * holds the text (`held`). Nothing confirms a booking they have asked to undo.
 *
 * v224: a call booking holds its Azul cancel until hang-up, so its
 * confirmation is queued `awaiting_cancel` and released (`due`, with the real
 * cancel result) once the held cancel runs; a booking the caller undid on the
 * call is `skipped` with reason `booking_undone`.
 *
 * The record lives inside `outreach_text` so the source refresh carries it
 * over (it preserves that key, v211) and a booked contact is never sent the
 * outreach text after it.
 */
import { failureFromUnknown } from "../../plugin/sendFailure";
import { mayDialNow } from "./callingWindow";
import type { OutboundLanePolicy } from "./campaign";
import { CONFIRMATION_FIELD, dncKey, type ContactRow } from "./store";
import { textsEnabled, type TextDeps } from "./outreachText";
import { sanitizeForSms } from "../../services/gsm7";

/** The key inside `custom_data.outreach_text` that holds the confirmation. */
export { CONFIRMATION_FIELD };

/** How long after the booking a call's confirmation waits at the least, so the
 * status callback has closed the call's attempt. */
export const CALL_CONFIRMATION_DELAY_MS = 2 * 60 * 1000;

/** A call booking's confirmation waits this long for the held Azul cancel
 * (v224) before it goes anyway, saying our team will cancel: past the
 * cancel's fallback (heldAzulCancel.HELD_CANCEL_FALLBACK_MS). */
export const CALL_AWAIT_CANCEL_MAX_MS = 20 * 60 * 1000;

/** How long a confirmation waits when the person is still on the phone with us. */
export const CALL_OPEN_RETRY_MS = 60 * 1000;

/** A refused send waits this long; three tries in all, as the text's. */
export const CONFIRMATION_RETRY_MS = 15 * 60 * 1000;
export const MAX_CONFIRMATION_TRIES = 3;

/** How far back an open call on the phone is looked for (the stale-claim window). */
export const OPEN_CALL_WINDOW_MS = 30 * 60 * 1000;

export interface BookingConfirmationRecord {
  /** awaiting_cancel (v224): a call booking's confirmation waits for the
   * held Azul cancel to run at hang-up, which releases it with the real
   * result; one nobody releases goes at `due_at` saying our team will cancel.
   * released (v224, Codex P2 on #474): the hang-up ran the cancel before the
   * booking's confirmation was queued; this placeholder holds what the cancel
   * came to, and the late queue takes it over as due. Never sent itself. */
  state: "due" | "awaiting_cancel" | "held" | "claimed" | "sent" | "unknown" | "failed" | "skipped" | "retry" | "released";
  booking_id: string;
  /** Booked on a call, or on the text's booking page. */
  by: "call" | "link";
  /** The call it was booked on, when `by` is "call". */
  call_sid?: string;
  /** "Tue, Nov 24 at 9:00 AM": the new visit, in the practice's own time zone. */
  when: string;
  /** "Chino Hills Eyecare Optometry, 4200 Chino Hills Pkwy, Chino Hills" */
  place: string;
  /** The partner practice's phone. */
  phone: string;
  /** "Jan 6": the Azul appointment it replaced. */
  replaced_day: string;
  /** Whether the Azul cancel landed: when it was booked on the text link, or,
   * on a call, when the held cancel ran at hang-up (v224). */
  cancel: "cancelled" | "pending";
  /** On a `released` placeholder: when the hang-up released it. */
  released_at?: string;
  queued_at: string;
  /** Not sent before this. */
  due_at: string;
  retry_after?: string;
  claimed_at?: string;
  sent_at?: string;
  message_sid?: string;
  /** A short code, never a body. */
  reason?: string;
  tries?: number;
}

/** The text, as the person reads it. GSM-7 after sanitizeForSms. */
export function confirmationBody(r: Pick<BookingConfirmationRecord, "when" | "place" | "phone" | "replaced_day" | "cancel">): string {
  const cancelLine =
    r.cancel === "cancelled"
      ? `Your ${r.replaced_day} appointment with us is cancelled.`
      : `Our team will cancel your ${r.replaced_day} appointment with us.`;
  const phone = r.phone ? ` Their phone: ${r.phone}.` : "";
  return sanitizeForSms(
    `Azul Vision: you're booked for ${r.when} at ${r.place}.${phone} ${cancelLine} Questions? Call this number. Reply STOP to opt out.`,
  ).value;
}

/** The confirmation held on a contact, or null. */
export function confirmationOf(customData: Record<string, unknown>): BookingConfirmationRecord | null {
  const text = customData.outreach_text;
  if (!text || typeof text !== "object") return null;
  const raw = (text as Record<string, unknown>)[CONFIRMATION_FIELD];
  return raw && typeof raw === "object" ? (raw as BookingConfirmationRecord) : null;
}

export interface ConfirmationTickResult {
  campaign: string;
  skipped?: string;
  sent: number;
  held: Record<string, number>;
}

/**
 * One tick of one campaign's confirmations. Never throws. Off with the
 * campaign's texts (the same switch, caller ID and window): a confirmation is
 * a text from the same number. The counts are the measurement:
 * `[outbound] <campaign>: confirmed N, held {...}`.
 */
export async function runConfirmationTick(
  slug: string,
  policy: OutboundLanePolicy,
  deps: TextDeps,
): Promise<ConfirmationTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: ConfirmationTickResult = { campaign: policy.campaignKey, sent: 0, held: {} };
  const text = policy.textOutreach;
  if (!text) return { ...result, skipped: "no text" };
  if (!textsEnabled(text, deps.env)) return { ...result, skipped: "disabled" };
  const from = deps.env[policy.callerIdEnv];
  if (!from) return { ...result, skipped: `no caller ID (${policy.callerIdEnv})` };
  const window = mayDialNow(now, [], policy.window, policy.caps);
  if (!window.ok) return { ...result, skipped: window.reason };

  try {
    const sender = await deps.sms();
    if (!sender) return { ...result, skipped: "no sms sender" };
    const campaignId = await deps.store.ensureCampaign(policy.campaignKey, slug);
    if (!campaignId) return { ...result, skipped: `no agents row for ${slug}` };
    const perTick = Math.max(0, Math.floor(text.perTick));
    const due = await deps.store.confirmationsDue(campaignId, now, perTick * 3);
    for (const candidate of due) {
      if (result.sent >= perTick) break;
      const held = await confirmOne(candidate, from, now, deps);
      if (held) result.held[held] = (result.held[held] ?? 0) + 1;
      else result.sent += 1;
    }
  } catch (error) {
    log(`[outbound] ${policy.campaignKey}: confirmation tick failed — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.sent > 0 || Object.keys(result.held).length > 0) {
    log(
      `[outbound] ${policy.campaignKey}: confirmed ${result.sent}` +
        (Object.keys(result.held).length ? `, held ${JSON.stringify(result.held)}` : ""),
    );
  }
  return result;
}

/** Claim, check, send one confirmation. Null when it was sent, else the reason. */
async function confirmOne(candidate: ContactRow, from: string, now: Date, deps: TextDeps): Promise<string | null> {
  const claimed = await deps.store.claimConfirmation(candidate.id, now);
  if (!claimed) return "claimed_elsewhere";
  const record = confirmationOf(claimed.customData);
  if (!record) return "claimed_elsewhere";
  const soon = (ms: number) => new Date(now.getTime() + ms).toISOString();

  // Nothing has been sent before the send itself, so a failure in these
  // checks puts the claim back to retry (Codex P2 on #470). Left `claimed`,
  // no later tick would ever select it again.
  let key: string | null;
  let sender: Awaited<ReturnType<TextDeps["sms"]>>;
  try {
    // A booking made on a call is confirmed after the call: a person still
    // on the line with us (the call, or a call back) waits a minute.
    if (await deps.store.callOpenOnPhone(claimed.id, new Date(now.getTime() - OPEN_CALL_WINDOW_MS))) {
      await deps.store.patchConfirmation(claimed.id, { state: "retry", retry_after: soon(CALL_OPEN_RETRY_MS), reason: "call_open" });
      return "call_open";
    }

    key = dncKey(claimed.phone);
    if (!key || (await deps.store.isDoNotContact(claimed.phone))) {
      await deps.store.patchConfirmation(claimed.id, { state: "skipped", reason: "do_not_contact" });
      return "do_not_contact";
    }

    sender = await deps.sms();
    if (!sender) {
      await deps.store.patchConfirmation(claimed.id, { state: "retry", retry_after: soon(CONFIRMATION_RETRY_MS), reason: "no_sms_sender" });
      return "no_sms_sender";
    }
  } catch {
    const tries = (record.tries ?? 0) + 1;
    await deps.store
      .patchConfirmation(
        claimed.id,
        tries >= MAX_CONFIRMATION_TRIES
          ? { state: "failed", reason: "check_failed", tries }
          : { state: "retry", retry_after: soon(CONFIRMATION_RETRY_MS), reason: "check_failed", tries },
      )
      .catch(() => undefined);
    return "check_failed";
  }
  try {
    const sent = await sender.send({ to: `+1${key}`, from, body: confirmationBody(record) });
    await deps.store.patchConfirmation(claimed.id, { state: "sent", sent_at: now.toISOString(), message_sid: sent.sid });
    return null;
  } catch (error) {
    const failure = failureFromUnknown(error);
    if (failure.mayHaveSent) {
      // It may be on their phone already: never sent twice.
      await deps.store.patchConfirmation(claimed.id, { state: "unknown", reason: failure.reason });
      return "send_unknown";
    }
    const tries = (record.tries ?? 0) + 1;
    await deps.store.patchConfirmation(
      claimed.id,
      tries >= MAX_CONFIRMATION_TRIES
        ? { state: "failed", reason: failure.reason, tries }
        : { state: "retry", retry_after: soon(CONFIRMATION_RETRY_MS), reason: failure.reason, tries },
    );
    return "send_refused";
  }
}
