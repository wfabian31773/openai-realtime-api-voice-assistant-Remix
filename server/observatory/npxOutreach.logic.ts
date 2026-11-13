/**
 * server/observatory/npxOutreach.logic.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NPX OUTREACH TRACKING SCREEN, the pure half. Operator, 2026-11-13:
 * "We need to create a screen ... where we track what we are doing, who we
 * outreached, the result, if they opted out, etc... we can't be flying blind
 * here. I also need to know who booked so I can check NPX and see how those
 * are coming over to NPX."
 *
 * Rows come in from ./npxOutreach.ts (read only, the Hub) and leave as one
 * record per contact, the top-row totals and the "needs a person" list.
 * Nothing here reads a database, a clock or the environment, so every number
 * the page shows is decided by a function a test can call.
 *
 * WHERE EACH FACT COMES FROM (one source per fact, named so the page and the
 * PR can say it):
 *   on the list         campaign_contacts, one row per appointment
 *   called              campaign_contact_attempts, outbound, status not
 *                       'not_placed' (a dial Twilio refused rang nobody)
 *   answered by a person  the call's call_logs.transcript has a CALLER: line.
 *                       AMD says "human" on silent lines too (v213), so the
 *                       transcript is the evidence that somebody spoke.
 *   returned call       an inbound attempt (written only once the caller
 *                       was identified, callback.ts)
 *   text                custom_data.outreach_text.state / sent_at
 *   link                custom_data.outreach_text.dob_tries / verified_at
 *   booked by link      custom_data.outreach_text.booking_id / booked_at
 *   booked by phone     a successful book_sooner_exam event in the call's
 *                       call_logs.tool_timeline. The `npx_booking:<id>` note
 *                       on the contact gives the NPX id; on 2026-11-13 12 of
 *                       45 phone-booked contacts had lost it to a later
 *                       `staff_callback:` note (the v216 shape), so the
 *                       timeline, not the note, decides THAT they booked.
 *   Azul cancel         first the booking's recorded result: v222's
 *                       `azul_cancel` on the booking event, or the v222
 *                       confirmation on the contact for that booking id
 *                       (`cancel`: cancelled | pending), which is also how a
 *                       link booking's cancel is read. Before v222 neither
 *                       exists, so a phone booking falls back to its `say`:
 *                       one of two fixed sentences (npxOutreachTools
 *                       `confirmation`). A link booking made before v222
 *                       has no cancel result in the Hub.
 *   staff ticket        `staff_callback:<ticket>` on the contact, and the
 *                       ticket_number of a successful request_staff_callback
 *                       event in the call's timeline
 *   tickets on a call   the call log's ticket_number, then every other
 *                       ticket number its timeline recorded (Wayne,
 *                       2026-11-13: every call shows its ticket)
 *   opted out           do_not_contact by phone (sms_stop = SMS STOP, any
 *                       other source = a voice opt-out), and the contact's
 *                       own `do_not_call` status when no STOP explains it
 *                       (the dialler sets it on finding any do-not-contact
 *                       row, a STOP included)
 *   declined / wrong number  the contact's outreach_status
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The live campaign's row name, and the demo's (npxOutreachTools.ts). */
export const NPX_CAMPAIGN_NAMES = { live: 'npx-outreach', demo: 'npx-outreach-demo' } as const;
export type NpxCampaignKey = keyof typeof NPX_CAMPAIGN_NAMES;

/** The tool names the timeline is read for (npxOutreachTools.ts). */
export const BOOK_TOOL = 'book_sooner_exam';
export const STAFF_TOOL = 'request_staff_callback';

/**
 * The two sentences book_sooner_exam's confirmation can carry about the Azul
 * cancel (npxOutreachTools `confirmation`). A test holds them to the real
 * function, so a reworded confirmation turns that test red rather than every
 * cancel silently reading "not recorded".
 */
export const CANCEL_LANDED_PHRASE = "I've also cancelled your appointment with us";
export const CANCEL_NOT_LANDED_PHRASE = 'Our team will cancel your appointment with us';

/** The statuses the dialler may still ring (store.ts DIALABLE_STATUSES), plus
 * a row on a call right now. A contact here is still being tried. */
const STILL_TRYING = new Set(['pending', 'no_answer', 'voicemail', 'callback_scheduled', 'calling']);

// ── What the reader hands over ───────────────────────────────────────────────

/** One campaign_contacts row, as the reader selects it. No date of birth is
 * ever selected, and the phone arrives as its last four digits only. */
export interface RawContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneLast4: string | null;
  status: string;
  agentNotes: string | null;
  nextAttemptAt: string | null;
  eventName: string | null;
  appointmentDate: string | null;
  beginTime: string | null;
  office: string | null;
  textState: string | null;
  textSentAt: string | null;
  textClaimedAt: string | null;
  textReason: string | null;
  dobTries: number | null;
  verifiedAt: string | null;
  linkBookedAt: string | null;
  linkBookingId: string | null;
  /**
   * The v222 booking confirmation on the contact: which booking it is for and
   * what it says about the Azul cancel (`cancelled` | `pending`).
   */
  confirmationBookingId: string | null;
  confirmationCancel: string | null;
  /** do_not_contact rows on this contact's ten digits. */
  smsStopAt: string | null;
  voiceOptOutAt: string | null;
}

/** One campaign_contact_attempts row, with the call it made if any. */
export interface RawAttempt {
  id: string;
  contactId: string;
  direction: string;
  status: string;
  answeredBy: string | null;
  durationSec: number | null;
  callSid: string | null;
  attemptedAt: string | null;
  callLogId: string | null;
  runtimeOutcome: string | null;
  callerSpoke: boolean;
  /** The newest successful book_sooner_exam on the call: when, and its say. */
  bookingAt: string | null;
  bookingSay: string | null;
  /** v222: the same booking's recorded Azul cancel (`cancelled` | `not_cancelled`). */
  bookingAzulCancel: string | null;
  /** The newest successful request_staff_callback on the call. */
  staffAt: string | null;
  staffTicket: string | null;
  /** Every ticket the call created: its call_logs ticket, then any other in its timeline. */
  tickets: string[];
}

// ── What the page receives ───────────────────────────────────────────────────

export type CancelState = 'landed' | 'not_landed' | 'not_recorded';
export type BookedBy = 'phone' | 'link';

/** The contact's one headline result, by precedence (resultOf). */
export type ContactResult =
  | 'booked'
  | 'staff_ticket'
  | 'opted_out'
  | 'declined'
  | 'wrong_number'
  | 'appointment_over'
  | 'reached'
  | 'not_called'
  | 'no_answer_yet'
  | 'never_reached';

export interface AttemptView {
  id: string;
  at: string | null;
  direction: 'outbound' | 'inbound';
  status: string;
  /** A short human label: "Answered", "Voicemail", "Picked up, silent". */
  label: string;
  answeredBy: string | null;
  durationSec: number | null;
  callSid: string | null;
  callLogId: string | null;
  runtimeOutcome: string | null;
  callerSpoke: boolean;
  booked: boolean;
  staffTicket: string | null;
  /** Every ticket the call created (the call log's, then its timeline's). */
  tickets: string[];
}

export interface BookingView {
  /** The NPX booking id, or null when the Hub no longer holds it. */
  id: string | null;
  by: BookedBy;
  at: string | null;
  cancel: CancelState;
  /** The call it was booked on (phone), for the call page link. */
  callLogId: string | null;
}

export interface ContactView {
  id: string;
  name: string;
  phoneLast4: string | null;
  appointment: { event: string | null; date: string | null; time: string | null; office: string | null };
  status: string;
  result: ContactResult;
  calls: { placed: number; returned: number; latestAt: string | null; latestLabel: string | null };
  reached: boolean;
  text: { state: string; sentAt: string | null; reason: string | null } | null;
  link: { dobTried: boolean; verifiedAt: string | null };
  booking: BookingView | null;
  staffTickets: string[];
  bookedThenStaffSameCall: boolean;
  optOut: { voice: boolean; voiceAt: string | null; sms: boolean; smsAt: string | null };
  nextAttemptAt: string | null;
  attempts: AttemptView[];
}

export type NeedsPersonReason = 'staff_ticket' | 'cancel_not_landed' | 'cancel_not_recorded' | 'booked_then_staff_same_call';

export interface NeedsPersonItem {
  contactId: string;
  name: string;
  reasons: NeedsPersonReason[];
  staffTickets: string[];
  bookingId: string | null;
  bookedBy: BookedBy | null;
  /** The newest time behind any of the reasons, for ordering. */
  at: string | null;
}

export interface Totals {
  onList: number;
  called: number;
  answeredByPerson: number;
  /** AMD put the call through to the agent (status completed), heard or not. */
  connected: number;
  returnedCalls: number;
  textsSent: number;
  /** A send that may have gone out (state 'unknown'). */
  textsUnknown: number;
  /** Null with a day filter: a date-of-birth try carries no time. */
  linkDobTried: number | null;
  linkDobConfirmed: number;
  bookedByPhone: number;
  bookedByLink: number;
  cancelLanded: number;
  cancelNotLanded: number;
  cancelNotRecorded: number;
  staffTickets: number;
  /** Contacts that opted out on either channel: one contact with a voice and an SMS STOP row counts once. */
  optedOut: number;
  optedOutVoice: number;
  optedOutSms: number;
  declined: number;
  wrongNumber: number;
}

export type DayKey = 'all' | 'today' | 'yesterday';

export interface Tracking {
  day: { key: DayKey; date: string | null };
  totals: Totals;
  needsPerson: NeedsPersonItem[];
  contacts: ContactView[];
}

// ── Small pure readers ───────────────────────────────────────────────────────

/** The practice's day for an instant, YYYY-MM-DD, in Pacific time. */
export function pacificDay(at: Date): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** The day before a YYYY-MM-DD, by the calendar, not by subtracting 24 hours:
 * on a 23-hour spring-forward day, "now minus 24 h" lands two days back. */
export function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** The Pacific date a day key names, or null for all time. */
export function dayDate(key: DayKey, now: Date): string | null {
  if (key === 'all') return null;
  const today = pacificDay(now);
  return key === 'today' ? today : dayBefore(today);
}

/** Whether an event at `at` counts for `date` (null = all time). An event
 * with no time counts only for all time. */
export function inDay(at: string | null | undefined, date: string | null): boolean {
  if (date === null) return true;
  if (!at) return false;
  const t = new Date(at);
  return !Number.isNaN(t.getTime()) && pacificDay(t) === date;
}

/** The NPX booking id a contact's note carries (`npx_booking:<id>`). */
export function bookingIdFromNotes(notes: string | null): string | null {
  const m = /npx_booking:([^;\s]+)/.exec(notes ?? '');
  return m ? m[1] : null;
}

/** Every staff ticket a contact's note carries (`staff_callback:<ticket>`). */
export function staffTicketsFromNotes(notes: string | null): string[] {
  return [...(notes ?? '').matchAll(/staff_callback:([^;\s]+)/g)].map((m) => m[1]);
}

/**
 * Every ticket a call created: the call log's own ticket first, then any other
 * ticket number its timeline recorded, once each. Pure.
 */
export function ticketsOnCall(callTicket: string | null, timelineTickets: unknown): string[] {
  const out: string[] = [];
  const add = (t: unknown) => {
    if (typeof t !== 'string') return;
    const v = t.trim();
    if (/^[A-Z]+-\d+$/.test(v) && !out.includes(v)) out.push(v);
  };
  add(callTicket);
  if (Array.isArray(timelineTickets)) for (const t of [...timelineTickets].sort()) add(t);
  return out;
}

/**
 * The Azul cancel of a booking, from the best record there is: the booking's
 * own recorded result (v222 `azul_cancel` on the timeline, or the v222
 * confirmation for that booking), else what the agent was given to say.
 */
export function cancelOf(args: {
  azulCancel?: string | null;
  confirmationCancel?: string | null;
  say?: string | null;
}): CancelState {
  if (args.azulCancel === 'cancelled') return 'landed';
  if (args.azulCancel === 'not_cancelled') return 'not_landed';
  if (args.confirmationCancel === 'cancelled') return 'landed';
  if (args.confirmationCancel === 'pending') return 'not_landed';
  return cancelFromSay(args.say ?? null);
}

/** What the booking confirmation said about the Azul cancel. */
export function cancelFromSay(say: string | null): CancelState {
  if (!say) return 'not_recorded';
  if (say.includes(CANCEL_LANDED_PHRASE)) return 'landed';
  if (say.includes(CANCEL_NOT_LANDED_PHRASE)) return 'not_landed';
  return 'not_recorded';
}

/** A short label for one attempt. */
export function attemptLabel(a: Pick<RawAttempt, 'direction' | 'status' | 'callerSpoke'>): string {
  if (a.direction === 'inbound') return 'Returned call';
  switch (a.status) {
    case 'not_placed':
      return 'Not placed (Twilio refused)';
    case 'initiated':
      return 'In progress';
    case 'completed':
      return a.callerSpoke ? 'Answered' : 'Picked up, silent';
    case 'voicemail':
      return 'Voicemail';
    case 'no-answer':
      return 'No answer';
    case 'busy':
      return 'Busy';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Canceled';
    case 'fax':
      return 'Fax';
    case 'not_ready':
      return 'Not ready (runtime)';
    default:
      return a.status;
  }
}

function newest(...ats: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const at of ats) if (at && (!best || at > best)) best = at;
  return best;
}

/** ISO strings compare as instants only when they are the same shape, so
 * every time this module compares goes through here first. */
function iso(at: string | null | undefined): string | null {
  if (!at) return null;
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

// ── One contact ──────────────────────────────────────────────────────────────

/** The headline result, by precedence. A booking outranks everything (it is
 * the outcome the campaign exists for); a staff ticket is a person's job; an
 * opt-out ends the outreach; then what the call recorded; then how far the
 * dialling got. */
export function resultOf(c: Omit<ContactView, 'result'>): ContactResult {
  if (c.booking) return 'booked';
  if (c.staffTickets.length > 0) return 'staff_ticket';
  if (c.optOut.voice || c.optOut.sms || c.status === 'do_not_call') return 'opted_out';
  if (c.status === 'declined') return 'declined';
  if (c.status === 'wrong_number') return 'wrong_number';
  if (c.status === 'rescheduled') return 'appointment_over';
  if (c.reached) return 'reached';
  if (c.calls.placed === 0) return 'not_called';
  return STILL_TRYING.has(c.status) ? 'no_answer_yet' : 'never_reached';
}

export function buildContact(raw: RawContact, attempts: RawAttempt[]): ContactView {
  const sorted = [...attempts].sort((a, b) => (iso(a.attemptedAt) ?? '').localeCompare(iso(b.attemptedAt) ?? ''));
  const views: AttemptView[] = sorted.map((a) => ({
    id: a.id,
    at: iso(a.attemptedAt),
    direction: a.direction === 'inbound' ? 'inbound' : 'outbound',
    status: a.status,
    label: attemptLabel(a),
    answeredBy: a.answeredBy,
    durationSec: a.durationSec,
    callSid: a.callSid,
    callLogId: a.callLogId,
    runtimeOutcome: a.runtimeOutcome,
    callerSpoke: a.callerSpoke,
    booked: Boolean(a.bookingAt),
    staffTicket: a.staffTicket,
    tickets: [...new Set([...(a.tickets ?? []), ...(a.staffTicket ? [a.staffTicket] : [])])],
  }));
  const placed = sorted.filter((a) => a.direction !== 'inbound' && a.status !== 'not_placed');
  const returned = sorted.filter((a) => a.direction === 'inbound');
  const latest = views[views.length - 1] ?? null;

  // Booking. A phone booking is a successful book_sooner_exam on one of the
  // contact's calls; the newest wins. The NPX id comes from the note, unless
  // that id is the link's.
  const noteId = bookingIdFromNotes(raw.agentNotes);
  const phoneEvent = [...sorted].reverse().find((a) => a.bookingAt) ?? null;
  let booking: BookingView | null = null;
  // The v222 confirmation speaks for the booking it names, and only that one.
  const confirmationFor = (id: string | null) =>
    id && raw.confirmationBookingId === id ? raw.confirmationCancel : null;
  if (phoneEvent) {
    const id = noteId && noteId !== raw.linkBookingId ? noteId : null;
    booking = {
      id,
      by: 'phone',
      at: iso(phoneEvent.bookingAt),
      cancel: cancelOf({
        azulCancel: phoneEvent.bookingAzulCancel,
        confirmationCancel: confirmationFor(id),
        say: phoneEvent.bookingSay,
      }),
      callLogId: phoneEvent.callLogId,
    };
  } else if (raw.linkBookingId) {
    booking = {
      id: raw.linkBookingId,
      by: 'link',
      at: iso(raw.linkBookedAt),
      cancel: cancelOf({ confirmationCancel: confirmationFor(raw.linkBookingId) }),
      callLogId: null,
    };
  } else if (noteId) {
    // The note says booked and no call on the Hub shows it: the booking stands,
    // its time is not recorded here, and its cancel only if a confirmation was.
    booking = { id: noteId, by: 'phone', at: null, cancel: cancelOf({ confirmationCancel: confirmationFor(noteId) }), callLogId: null };
  }

  const staffTickets = [...new Set([...staffTicketsFromNotes(raw.agentNotes), ...sorted.map((a) => a.staffTicket).filter((t): t is string => Boolean(t))])];
  const bookedThenStaffSameCall = sorted.some(
    (a) => a.bookingAt && a.staffAt && (iso(a.bookingAt) ?? '') <= (iso(a.staffAt) ?? ''),
  );

  const reached =
    sorted.some((a) => a.callerSpoke) || Boolean(raw.verifiedAt) || Boolean(booking);

  const base: Omit<ContactView, 'result'> = {
    id: raw.id,
    name: [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim() || '(no name on file)',
    phoneLast4: raw.phoneLast4,
    appointment: { event: raw.eventName, date: raw.appointmentDate, time: raw.beginTime, office: raw.office },
    status: raw.status,
    calls: { placed: placed.length, returned: returned.length, latestAt: latest?.at ?? null, latestLabel: latest?.label ?? null },
    reached,
    text: raw.textState ? { state: raw.textState, sentAt: iso(raw.textSentAt), reason: raw.textReason } : null,
    link: { dobTried: (raw.dobTries ?? 0) > 0 || Boolean(raw.verifiedAt), verifiedAt: iso(raw.verifiedAt) },
    booking,
    staffTickets,
    bookedThenStaffSameCall,
    optOut: {
      // The dialler settles a row `do_not_call` when it finds ANY do-not-contact
      // row for the phone (dialer.ts), an SMS STOP included, so the status
      // alone is a voice opt-out only when no STOP explains it.
      voice: Boolean(raw.voiceOptOutAt) || (raw.status === 'do_not_call' && !raw.smsStopAt),
      voiceAt: iso(raw.voiceOptOutAt),
      sms: Boolean(raw.smsStopAt),
      smsAt: iso(raw.smsStopAt),
    },
    nextAttemptAt: iso(raw.nextAttemptAt),
    attempts: views,
  };
  return { ...base, result: resultOf(base) };
}

// ── Timing: when each counted fact happened, for the day filter ──────────────

interface ContactTimes {
  called: string[];
  answered: string[];
  connected: string[];
  returned: string[];
  textSent: string | null;
  textUnknown: string | null;
  verified: string | null;
  booked: string | null;
  staff: string | null;
  smsStop: string | null;
  voiceOptOut: string | null;
  /** The newest placed or returned call: the time a status-only outcome
   * (declined, wrong number, a do_not_call with no list row) is read at. */
  latestCall: string | null;
}

function timesOf(raw: RawContact, attempts: RawAttempt[], view: ContactView): ContactTimes {
  const out = attempts.filter((a) => a.direction !== 'inbound' && a.status !== 'not_placed');
  const at = (a: RawAttempt) => iso(a.attemptedAt);
  const staffEventAt = newest(...attempts.filter((a) => a.staffTicket).map((a) => iso(a.staffAt)));
  const latestCall = newest(...attempts.filter((a) => a.status !== 'not_placed').map(at));
  return {
    called: out.map(at).filter((t): t is string => Boolean(t)),
    answered: out.filter((a) => a.callerSpoke).map(at).filter((t): t is string => Boolean(t)),
    connected: out.filter((a) => a.status === 'completed').map(at).filter((t): t is string => Boolean(t)),
    returned: attempts.filter((a) => a.direction === 'inbound').map(at).filter((t): t is string => Boolean(t)),
    textSent: raw.textState === 'sent' ? iso(raw.textSentAt) ?? '' : null,
    textUnknown: raw.textState === 'unknown' ? iso(raw.textClaimedAt) ?? '' : null,
    verified: view.link.verifiedAt,
    booked: view.booking ? view.booking.at ?? '' : null,
    staff: view.staffTickets.length > 0 ? staffEventAt ?? '' : null,
    smsStop: view.optOut.sms ? view.optOut.smsAt ?? '' : null,
    voiceOptOut: view.optOut.voice ? view.optOut.voiceAt ?? latestCall ?? '' : null,
    latestCall,
  };
}

/**
 * An empty string means "this happened and its time is not recorded": it
 * counts for all time and for no single day. Null means it did not happen.
 */
function happened(at: string | null, date: string | null): boolean {
  if (at === null) return false;
  if (date === null) return true;
  return at !== '' && inDay(at, date);
}

function anyIn(ats: string[], date: string | null): boolean {
  return ats.some((t) => happened(t, date));
}

/** Whether anything about this contact happened on `date`. */
function activeOn(t: ContactTimes, date: string | null): boolean {
  if (date === null) return true;
  return (
    anyIn(t.called, date) ||
    anyIn(t.returned, date) ||
    [t.textSent, t.textUnknown, t.verified, t.booked, t.staff, t.smsStop, t.voiceOptOut].some((x) => happened(x, date))
  );
}

// ── The whole campaign ───────────────────────────────────────────────────────

export function buildTracking(
  input: { contacts: RawContact[]; attempts: RawAttempt[] },
  opts: { day: DayKey; now: Date },
): Tracking {
  const date = dayDate(opts.day, opts.now);
  const byContact = new Map<string, RawAttempt[]>();
  for (const a of input.attempts) {
    const list = byContact.get(a.contactId);
    if (list) list.push(a);
    else byContact.set(a.contactId, [a]);
  }

  const totals: Totals = {
    onList: input.contacts.length,
    called: 0,
    answeredByPerson: 0,
    connected: 0,
    returnedCalls: 0,
    textsSent: 0,
    textsUnknown: 0,
    linkDobTried: date === null ? 0 : null,
    linkDobConfirmed: 0,
    bookedByPhone: 0,
    bookedByLink: 0,
    cancelLanded: 0,
    cancelNotLanded: 0,
    cancelNotRecorded: 0,
    staffTickets: 0,
    optedOut: 0,
    optedOutVoice: 0,
    optedOutSms: 0,
    declined: 0,
    wrongNumber: 0,
  };
  const contacts: ContactView[] = [];
  const needsPerson: NeedsPersonItem[] = [];

  for (const raw of input.contacts) {
    const attempts = byContact.get(raw.id) ?? [];
    const view = buildContact(raw, attempts);
    const t = timesOf(raw, attempts, view);

    if (anyIn(t.called, date)) totals.called++;
    if (anyIn(t.answered, date)) totals.answeredByPerson++;
    if (anyIn(t.connected, date)) totals.connected++;
    if (anyIn(t.returned, date)) totals.returnedCalls++;
    if (happened(t.textSent, date)) totals.textsSent++;
    if (happened(t.textUnknown, date)) totals.textsUnknown++;
    if (date === null && view.link.dobTried) totals.linkDobTried = (totals.linkDobTried ?? 0) + 1;
    if (happened(t.verified, date)) totals.linkDobConfirmed++;
    if (view.booking && happened(t.booked, date)) {
      if (view.booking.by === 'phone') totals.bookedByPhone++;
      else totals.bookedByLink++;
      if (view.booking.cancel === 'landed') totals.cancelLanded++;
      else if (view.booking.cancel === 'not_landed') totals.cancelNotLanded++;
      else totals.cancelNotRecorded++;
    }
    if (happened(t.staff, date)) totals.staffTickets++;
    const voiceOut = happened(t.voiceOptOut, date);
    const smsOut = happened(t.smsStop, date);
    if (voiceOut) totals.optedOutVoice++;
    if (smsOut) totals.optedOutSms++;
    if (voiceOut || smsOut) totals.optedOut++;
    if (view.status === 'declined' && happened(t.latestCall ?? '', date)) totals.declined++;
    if (view.status === 'wrong_number' && happened(t.latestCall ?? '', date)) totals.wrongNumber++;

    if (activeOn(t, date)) contacts.push(view);

    // Needs a person: all time, whatever the day filter, because an open
    // item does not stop needing a person at midnight.
    const reasons: NeedsPersonReason[] = [];
    if (view.staffTickets.length > 0) reasons.push('staff_ticket');
    if (view.booking?.cancel === 'not_landed') reasons.push('cancel_not_landed');
    if (view.booking?.cancel === 'not_recorded') reasons.push('cancel_not_recorded');
    if (view.bookedThenStaffSameCall) reasons.push('booked_then_staff_same_call');
    if (reasons.length > 0) {
      needsPerson.push({
        contactId: view.id,
        name: view.name,
        reasons,
        staffTickets: view.staffTickets,
        bookingId: view.booking?.id ?? null,
        bookedBy: view.booking?.by ?? null,
        at: newest(t.staff || null, t.booked || null),
      });
    }
  }

  needsPerson.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  contacts.sort((a, b) => (b.calls.latestAt ?? b.text?.sentAt ?? '').localeCompare(a.calls.latestAt ?? a.text?.sentAt ?? ''));
  return { day: { key: opts.day, date }, totals, needsPerson, contacts };
}
