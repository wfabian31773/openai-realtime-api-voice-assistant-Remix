/**
 * THE HELD AZUL CANCEL (v224).
 *
 * Wayne, 2026-11-13: "Hold the cancel until hang-up: the Azul cancel runs only
 * when the call ends. If the caller backs out on the call, their Azul
 * appointment is kept." Before this build the outreach call cancelled the Azul
 * appointment seconds after booking the NPX one, so a caller who changed their
 * mind before hanging up had already lost it: 5 of 46 bookings to 2026-11-12
 * had the caller try to undo on the same call (CAa73b9fea680caad6b075c32167464f2c,
 * CAe91152bd2fbc5055319e1249a4389827, CA27a67f6ad80ff9be334268efd0247324 among
 * them).
 *
 * A booking made on a call now records what it will cancel here, inside
 * `custom_data.outreach_text.held_cancel` (the key the source refresh carries
 * over, v211), and cancels nothing. Two paths run it, and an atomic claim lets
 * only one of them:
 *
 * - THE HANG-UP: the runtime's teardown (npxOutreachTools.endOutreachSession)
 *   runs it the moment the call ends. This is the path every call takes.
 * - THE FALLBACK: a call whose process died before its teardown leaves the
 *   record `held`. The scheduler's tick runs it once HELD_CANCEL_FALLBACK_MS
 *   have passed since the booking (past the ten-minute call ceiling) and no
 *   call is open on the phone. A claim older than HELD_CANCEL_STALE_MS (a run
 *   that died part way) is run again: the cancel reads the appointment back
 *   first, so a second run of a cancel that landed changes nothing.
 *
 * If neither runs it (the scheduler is off: RUNTIME_OUTBOUND_DIALING unset),
 * nothing is cancelled and NPX lists the booking on CEC's backup list 15
 * minutes after it was made, the same as a cancel that failed.
 *
 * A caller who backs out on the call drops the record (`dropped`) before
 * anything touches the NPX booking: the call cancels the NPX booking only once
 * the held Azul cancel is provably gone, so a patient can never be left with
 * neither appointment.
 */
import type { OutboundLanePolicy } from "./campaign";
import { HELD_CANCEL_FIELD, type ContactRow, type OutboundStore } from "./store";
import { OPEN_CALL_WINDOW_MS } from "./bookingConfirmation";

export { HELD_CANCEL_FIELD };

/** How long after the booking the fallback waits: past the ten-minute call
 * ceiling (DEFAULT_MAX_CALL_MS), so it cannot run while the call it was made
 * on is still up, and still well inside NPX's 15-minute grace before the
 * backup list. */
export const HELD_CANCEL_FALLBACK_MS = 11 * 60 * 1000;

/** A claim older than this is a run that died; the fallback takes it over. */
export const HELD_CANCEL_STALE_MS = 5 * 60 * 1000;

/** The whole cancel and its report answer inside this, on either path. */
export const HELD_CANCEL_BUDGET_MS = 30_000;

/** At most this many held cancels are run on one tick. */
export const HELD_CANCELS_PER_TICK = 10;

export interface HeldAzulCancelRecord {
  /** held: waiting for the call to end. claimed: running. cancelled /
   * not_cancelled: ran, and what NextGen said. dropped: the caller kept their
   * Azul appointment, nothing was cancelled. */
  state: "held" | "claimed" | "cancelled" | "not_cancelled" | "dropped";
  /** The NPX booking that replaces the Azul appointment. */
  booking_id: string;
  /** The call it was booked on. */
  call_sid: string;
  /** A demo call: the cancel is simulated, the report goes to the demo NPX. */
  demo: boolean;
  /** What to cancel, as it stood when the call booked (the Console's ids). */
  appointment_id: string;
  appointment_date: string;
  person_id: string;
  held_at: string;
  /** The fallback runs it after this, once no call is open on the phone. */
  run_after: string;
  claimed_at?: string;
  done_at?: string;
  /** Which path ran it. */
  by?: "hang_up" | "fallback";
  /** The cancel's own refusal code, or why it was dropped. Codes only. */
  reason?: string;
}

/** The held cancel on a contact, or null. */
export function heldCancelOf(customData: Record<string, unknown>): HeldAzulCancelRecord | null {
  const text = customData.outreach_text;
  if (!text || typeof text !== "object") return null;
  const raw = (text as Record<string, unknown>)[HELD_CANCEL_FIELD];
  return raw && typeof raw === "object" ? (raw as HeldAzulCancelRecord) : null;
}

/** What a held cancel's run came to. */
export type HeldCancelRun = (contactId: string, record: HeldAzulCancelRecord, by: "hang_up" | "fallback") => Promise<unknown>;

export interface HeldCancelTickResult {
  ran: number;
  held: Record<string, number>;
}

/**
 * One tick of one campaign's fallback. Never throws. The counts are the
 * measurement: `[outbound] <campaign>: held Azul cancels run N` — on a healthy
 * fleet 0, because the hang-up runs them.
 */
export async function runHeldCancelTick(
  slug: string,
  policy: Pick<OutboundLanePolicy, "campaignKey">,
  deps: { store: OutboundStore; run: HeldCancelRun; now?: () => Date; log?: (line: string) => void },
): Promise<HeldCancelTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: HeldCancelTickResult = { ran: 0, held: {} };
  const note = (k: string) => (result.held[k] = (result.held[k] ?? 0) + 1);
  try {
    const campaignId = await deps.store.ensureCampaign(policy.campaignKey, slug);
    if (!campaignId) return result;
    const staleBefore = new Date(now.getTime() - HELD_CANCEL_STALE_MS);
    const due = await deps.store.heldCancelsDue(campaignId, now, staleBefore, HELD_CANCELS_PER_TICK);
    for (const row of due) {
      const record = heldCancelOf(row.customData);
      if (!record) continue;
      // The ruling: only once the call has ended. A person still on the phone
      // with us waits for the next tick.
      if (await deps.store.callOpenOnPhone(row.id, new Date(now.getTime() - OPEN_CALL_WINDOW_MS))) {
        note("call_open");
        continue;
      }
      const claimed: ContactRow | null = await deps.store.claimHeldCancel(row.id, record.booking_id, now, staleBefore);
      if (!claimed) {
        note("claimed_elsewhere");
        continue;
      }
      const mine = heldCancelOf(claimed.customData) ?? record;
      await deps.run(claimed.id, mine, "fallback");
      result.ran += 1;
    }
  } catch (error) {
    log(`[outbound] ${policy.campaignKey}: held Azul cancel tick failed — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.ran > 0 || Object.keys(result.held).length > 0) {
    log(
      `[outbound] ${policy.campaignKey}: held Azul cancels run ${result.ran}` +
        (Object.keys(result.held).length ? `, waiting ${JSON.stringify(result.held)}` : ""),
    );
  }
  return result;
}
