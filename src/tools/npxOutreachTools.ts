/**
 * The NPX outreach call's own tools (v110), bound by the runtime to the
 * `npx-outreach` lane only (its OutboundLanePolicy.tools), on a call the lane
 * dialled AND on a call somebody made back to it.
 *
 *   describe_upcoming_appointment
 *                              once the person says they are the patient (or
 *                              a returned call is identified): the visit type
 *                              and the date, and the offer of a sooner one.
 *                              Nothing else — not the time, the office or the
 *                              doctor — before the date of birth matches.
 *   confirm_patient_birthdate  the person gives their date of birth; it must
 *                              match the record the call is about. The full
 *                              appointment is in this tool's answer.
 *   find_sooner_exam           searches the patient's partner availability for
 *                              the day and time THEY say works best, and hands
 *                              back up to three choices (operator, 2026-11-08:
 *                              "it should always be what day and time works
 *                              best for you as the starting point"). The
 *                              availability is every slot NPX may offer this
 *                              patient — credentialed for their medical group
 *                              at that office, in reach, a routine exam, three
 *                              weeks sooner — read once per call (warmed when
 *                              the call starts) and searched in memory, so
 *                              "what about next week?" answers at once.
 *   book_sooner_exam           books the one they chose in NPX and HOLDS the
 *                              Azul cancel until the call ends (v226: the
 *                              hang-up runs it, then reports it to NPX), and
 *                              says only what happened.
 *   cancel_sooner_booking      the caller changed their mind before hanging
 *                              up (v226): the held Azul cancel is dropped, so
 *                              their Azul appointment is kept, and the NPX
 *                              booking is cancelled; staff are asked when NPX
 *                              cannot cancel it.
 *   request_staff_callback     a person who asks for a person gets a ticket
 *                              for the HVA Hub's schedulers (operator,
 *                              2026-10-21: "if they ask for a person, we'll
 *                              just submit a ticket").
 *
 * THE ORDER IS THE OPERATOR'S (2026-10-21): confirm who answered by name, say
 * who we are and why we called — the visit and its date — offer a sooner
 * appointment, and only once they want it ask the date of birth, "starting
 * with the month, the day, and then the year". The same on a returned call.
 *
 * WHY THE APPOINTMENT IS NOT IN THE PROMPT. A sequencing instruction in front
 * of text the model can already see is not a gate (v47, the after-hours line
 * reading a phone-matched patient's appointment to whoever answered). RULE
 * ZERO step 2: a phone number is a candidate to confirm, never an identity —
 * and this call can cancel an appointment, so the wrong person on a shared
 * phone could lose somebody else's exam.
 *
 * WHO THE CALL IS ABOUT IS INJECTED, never asked (the outboundTools shape):
 * a dialled call carries its contact and attempt; a returned call carries
 * its CallSid, and the contact is whoever identify_callback_caller settled on.
 *
 * Every refusal speaks through `fix`, the model's channel (v43); `say` is the
 * one sentence for the caller where there is one.
 *
 * DEMO OR LIVE IS ONE ENVIRONMENT VARIABLE (v113), NPX_OUTREACH_MODE: `live`
 * calls the Console's movable list and books for real; anything else, unset
 * included, is the demo (operator, 2026-10-22: "switching over to production
 * should be a env switch"). A demo call runs these same tools with three of
 * their dependencies swapped and nothing else: NPX is the demo deployment, and
 * the Azul cancel and the staff ticket are SIMULATED — logged, never sent to
 * NextGen or the ticketing app. A call is a demo call when the process is in
 * demo mode, OR its injected campaign is the demo campaign, OR its contact came
 * from the demo seed; any one is enough, so a demo call never reaches a live
 * system because one of the three was missing.
 */
import { registerTool, type ToolFailure, type ToolResult } from './registry';
import { readDobQuietly } from './dobParts';
import { spokenDobFor } from './spokenDob';
import { callbackSessionFor } from './outboundTools';
import { dobOnFile } from '../runtime/outbound/callback';
import type { OutboundContact } from '../runtime/outbound/campaign';
import type { OutboundStore } from '../runtime/outbound/store';
import {
  createNpxOutreachClient,
  createNpxOutreachDemoClient,
  NPX_CALLER_KEPT_AZUL_REASON,
  NPX_TIMEOUT_MS,
  NPX_UNDO_REASON,
  type NpxOutreachClient,
  type NpxReadOptions,
  type NpxSlot,
} from '../services/npxOutreachClient';
import { cancelAzulAppointment, type AzulCancelRequest, type AzulCancelResult } from '../services/outreachAzulCancel';
import { fold, SCHEDULING } from './queueRouting';
import { correctSurgeryIntake } from './requestClassification';
import {
  OPTIONS_PER_SEARCH,
  WEEKDAYS,
  citiesWithOpenings,
  cityOf,
  joinWords,
  matches,
  offerLine,
  overviewLine,
  practiceToday,
  preferenceFrom,
  searchSlots,
  type SlotPreference,
  spokenAddress,
  spokenSlotDay,
  spokenSlotTime,
  spokenWhen,
  textedWhen,
  localParts,
  minutesOf,
  slotDateTime,
  type Relaxed,
} from './npxAvailabilitySearch';
import { sanitizeForSms } from '../services/gsm7';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';
import type { BookingOpening, BookingPageLane } from '../runtime/outbound/bookingPage';
import {
  CALL_AWAIT_CANCEL_MAX_MS,
  CALL_CONFIRMATION_DELAY_MS,
  type BookingConfirmationRecord,
} from '../runtime/outbound/bookingConfirmation';
import {
  HELD_CANCEL_BUDGET_MS,
  HELD_CANCEL_FALLBACK_MS,
  HELD_CANCEL_STALE_MS,
  heldCancelOf,
  runHeldCancelTick,
  type HeldAzulCancelRecord,
} from '../runtime/outbound/heldAzulCancel';
import type { AfterCallsContext } from '../runtime/outbound/campaign';

export const DESCRIBE_TOOL_NAME = 'describe_upcoming_appointment';
export const CONFIRM_DOB_TOOL_NAME = 'confirm_patient_birthdate';
export const FIND_SOONER_TOOL_NAME = 'find_sooner_exam';
export const BOOK_SOONER_TOOL_NAME = 'book_sooner_exam';
export const STAFF_CALLBACK_TOOL_NAME = 'request_staff_callback';
export const CANCEL_BOOKING_TOOL_NAME = 'cancel_sooner_booking';
export const NPX_OUTREACH_TOOLS = [
  DESCRIBE_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  BOOK_SOONER_TOOL_NAME,
  CANCEL_BOOKING_TOOL_NAME,
  STAFF_CALLBACK_TOOL_NAME,
] as const;

/** The campaign row the lane dials from in demo mode, and the
 * `custom_data.source` of its seeded contacts (src/agents/npxOutreachDemo.ts).
 * A campaign name, not a lane: there is one lane, `npx-outreach`, in both
 * modes, so its caller ID and Twilio Voice URL never change at the switch. */
export const NPX_OUTREACH_DEMO_CAMPAIGN_KEY = 'npx-outreach-demo';
export const NPX_OUTREACH_DEMO_SOURCE = 'npx_outreach_demo';
/** The campaign row the lane dials from in live mode. */
export const NPX_OUTREACH_LIVE_CAMPAIGN_KEY = 'npx-outreach';

export type NpxOutreachMode = 'demo' | 'live';

/**
 * THE SWITCH. `live` (any case) is production: real patients from the
 * Console's movable list, production NPX, the real Azul cancel and the real
 * staff ticket. Anything else — unset, `demo`, a typo — is the demo, so a
 * deployment can only reach a patient by somebody writing `live` on purpose.
 */
export function npxOutreachMode(env: Record<string, string | undefined> = process.env): NpxOutreachMode {
  return (env.NPX_OUTREACH_MODE ?? '').trim().toLowerCase() === 'live' ? 'live' : 'demo';
}

/** The HVA Hub, where every schedule-related request goes (standing
 * instruction 10), and its scheduling request type. */
export const HVA_HUB_DEPARTMENT_ID = 9;
export const HVA_HUB_SCHEDULING_REQUEST_TYPE_ID = 32;
/** "Reschedule Existing Appointment": the request is about an appointment
 * the patient already has, unless their own words say otherwise. */
const DEFAULT_STAFF_REASON_ID = 147;

/** Two tries at the date of birth: once to ask, once in case it was misheard. */
export const MAX_DOB_TRIES = 2;
/** How many searches one call may run. Each is answered from memory, so the
 * bound is against a model in a loop, not against NPX. */
export const MAX_SEARCHES = 12;
/** Slots read from NPX for one patient: the whole sooner window in practice
 * (measured 2026-11-08: a few hundred at most per medical group). */
export const AVAILABILITY_LIMIT = 300;
/** A call's availability is read again after this long. */
export const AVAILABILITY_TTL_MS = 10 * 60 * 1000;
/** How long the opening line waits for the availability to name the city. */
export const DESCRIBE_AVAILABILITY_WAIT_MS = 2_500;
/** find_sooner_exam's timeout, as registered. */
export const FIND_TOOL_TIMEOUT_MS = 15_000;
/**
 * EVERY NPX READ A SEARCH MAKES ANSWERS INSIDE THIS (Codex P2, #439). One
 * availability read may take its whole 10-second limit, and a retry or a
 * range read after it another 10, so a search could outlive the tool's own
 * 15 seconds and the caller hear a timeout instead of the safe answer that
 * their appointment stays as it is. The budget leaves the tool 3 seconds.
 */
export const FIND_BUDGET_MS = 12_000;
/** A second read is not started with less than this left of the budget. */
export const MIN_NPX_READ_MS = 2_000;
/** How many times one search may read on past a cut-short list. */
export const MAX_RANGE_READS = 3;
/** NPX's own default: offer only an exam at least three weeks sooner. */
export const MIN_DAYS_SOONER = 21;

// ── Dependencies, swappable for tests ───────────────────────────────────────

interface Deps {
  npx: NpxOutreachClient;
  /** The demo's NPX: the demo deployment and its own key. */
  npxDemo: NpxOutreachClient;
  cancel: (req: AzulCancelRequest) => Promise<AzulCancelResult>;
  store: () => Promise<OutboundStore>;
  fileTicket: (params: CreateTicketParams) => Promise<CreateTicketResponse>;
}

let storePromise: Promise<OutboundStore> | null = null;
const defaultDeps = (): Deps => ({
  npx: createNpxOutreachClient(),
  npxDemo: createNpxOutreachDemoClient(),
  cancel: (req) => cancelAzulAppointment(req),
  store: () => (storePromise ??= import('../runtime/outbound/store').then((m) => m.createDbOutboundStore())),
  // Imported when used, as every registry tool does: the client reads its
  // environment at import.
  fileTicket: async (params) =>
    (await import('../../server/services/ticketingApiClient')).ticketingApiClient.createTicket(params),
});
let deps: Deps | null = null;
const live = (): Deps => (deps ??= defaultDeps());

/** Tests only. Null restores the production dependencies. */
export function setNpxOutreachDepsForTests(next: Partial<Deps> | null): void {
  deps = next ? { ...defaultDeps(), ...next } : null;
}

/** A demo call's Azul cancel: nothing is sent to NextGen. It answers
 * cancelled so the demo hears the whole booking script; the log line says
 * plainly that nothing happened. */
export async function simulatedDemoCancel(req: AzulCancelRequest): Promise<AzulCancelResult> {
  console.info(
    `[NPX OUTREACH DEMO] Azul cancel SIMULATED for demo appointment ${req.appointmentId} — nothing was sent to NextGen`,
  );
  return { cancelled: true, alreadyCancelled: false };
}

/** A demo call's staff ticket: nothing is filed. The text a scheduler would
 * have read is logged, because seeing it is part of the test. */
export async function simulatedDemoTicket(params: CreateTicketParams): Promise<CreateTicketResponse> {
  console.info(
    `[NPX OUTREACH DEMO] staff callback ticket SIMULATED — nothing was filed. It would have gone to department ` +
      `${params.departmentId}, request type ${params.requestTypeId}, reason ${params.requestReasonId}:\n${params.description}`,
  );
  return { success: true, ticketNumber: 'DEMO-STAFF' };
}

/** What a session's call may reach: the demo NPX and the simulations on a
 * demo call, the live dependencies on any other. */
function npxFor(demo: boolean): NpxOutreachClient {
  return demo ? live().npxDemo : live().npx;
}
function cancelFor(demo: boolean): Deps['cancel'] {
  return demo ? simulatedDemoCancel : live().cancel;
}
function ticketFor(s: OutreachSession): Deps['fileTicket'] {
  return s.demo ? simulatedDemoTicket : live().fileTicket;
}

// ── The per-call session ────────────────────────────────────────────────────

/**
 * WHAT HAPPENED TO THE AZUL APPOINTMENT A BOOKING REPLACES.
 *  - done: the cancel ran when it was booked (the text link) or at hang-up.
 *  - held (v226): a call booking; nothing cancelled yet, the hang-up runs it.
 *    `stored` says whether the held record reached the store: `yes`, `no` (the
 *    write failed) or `unknown` (it did not answer in time).
 *  - dropped (v226): the caller kept their Azul appointment; nothing will be
 *    cancelled. `storeDropPending` when the store could not be told yet.
 */
export type AzulCancelState =
  | { kind: 'done'; result: AzulCancelResult }
  | { kind: 'held'; record: HeldAzulCancelRecord; stored: 'yes' | 'no' | 'unknown' }
  | {
      kind: 'dropped';
      record: HeldAzulCancelRecord;
      /** `yes`: the store says dropped, so nothing will cancel it.
       * `unconfirmed`: the store could not say so (it was down, or the
       * cancel had already been started), so staff must check NextGen. */
      kept: 'yes' | 'unconfirmed';
      storeDropPending: boolean;
    };

/** What a booking did to the Azul appointment it replaces, as the caller
 * and the staff ticket are told it. */
export type AzulStatus = 'cancelled' | 'not_cancelled' | 'held' | 'kept' | 'kept_unconfirmed';
export function azulStatusOf(azul: AzulCancelState): AzulStatus {
  if (azul.kind === 'done') return azul.result.cancelled ? 'cancelled' : 'not_cancelled';
  if (azul.kind === 'held') return 'held';
  return azul.kept === 'yes' ? 'kept' : 'kept_unconfirmed';
}

export interface CallBooking {
  bookingId: string;
  slot: NpxSlot;
  azul: AzulCancelState;
  /** The booking's store writes (held cancel, settle, confirmation), which
   * can outlast the tool's settle budget; an undo waits for them before it
   * writes anything (Codex P2 on #474). */
  writes?: Promise<unknown>;
}

interface OutreachSession {
  contact: OutboundContact;
  /** A demo call: demo NPX, simulated cancel and ticket. */
  demo: boolean;
  /** describe_upcoming_appointment has told them the visit and its date. */
  described: boolean;
  verified: boolean;
  dobTries: number;
  searches: number;
  /** Every list of choices read to the caller on this call, in order (v218).
   * book_sooner_exam books from these and nothing else: an option number
   * only when it means one slot in every list, otherwise the date and time
   * the agent said back to them. */
  offers: NpxSlot[][];
  booking: CallBooking | null;
  /** A book_sooner_exam still running: a second call waits for it rather
   * than booking twice. */
  bookingInFlight: Promise<ToolResult> | null;
  /** NPX bookings the caller undid on this call (v226), oldest first. */
  undone: string[];
  /** Undone bookings whose skip or settle did not land on the call; the
   * hang-up tries them again (Codex P1 on #474). */
  undoCleanupPending?: string[];
  /** A cancel_sooner_booking still running: a second call waits for it. */
  undoInFlight: Promise<ToolResult> | null;
  /** The HVA Hub ticket filed when they asked for a person. */
  staffTicket: string | null;
  /** The caller asked staff to cancel or change what was booked on this call (v222). */
  bookingChangeAsked?: boolean;
  openedAtMs: number;
}

const sessions = new Map<string, OutreachSession>();
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** Tests and teardown only. */
export function outreachSessionFor(callSid: string): OutreachSession | undefined {
  return sessions.get(callSid);
}
/** Drop a call's session and run nothing. Tests only: a real call ends through
 * endOutreachSession, which runs the held Azul cancel. */
export function closeOutreachSession(callSid: string): void {
  sessions.delete(callSid);
}
export function resetOutreachSessionsForTests(): void {
  sessions.clear();
}

function keep(callSid: string, s: OutreachSession, now: number): OutreachSession {
  for (const [sid, old] of sessions) {
    if (now - old.openedAtMs > SESSION_TTL_MS) sessions.delete(sid);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  sessions.set(callSid, s);
  return s;
}

interface Refusal extends ToolFailure {
  fix: string;
  say?: string;
}

const NOT_THIS_CALL: Refusal = {
  success: false,
  error: 'not_an_outreach_call',
  fix: 'This tool only works on an outreach call whose patient is known. Do not call it again.',
};

/**
 * The session for this call, opening it on first use. A dialled call names
 * its contact and attempt; a returned call names its CallSid, and works only
 * once identify_callback_caller has settled who rang.
 */
async function sessionFor(input: Record<string, unknown>): Promise<{ sid: string; s: OutreachSession } | Refusal> {
  const now = Date.now();
  const callbackSid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : '';
  const callSid = typeof input.outbound_call_sid === 'string' ? input.outbound_call_sid : '';
  const sid = callbackSid || callSid;
  if (!sid) return NOT_THIS_CALL;
  const existing = sessions.get(sid);
  if (existing) return { sid, s: existing };

  let contactId = '';
  let attemptId = '';
  if (callbackSid) {
    const cb = callbackSessionFor(callbackSid);
    if (!cb?.chosen || !cb.attemptId) {
      return {
        success: false,
        error: 'caller_not_identified',
        fix: 'Find out who is calling first (identify_callback_caller). Say nothing about any appointment until they are identified.',
      };
    }
    contactId = cb.chosen.contactId;
    attemptId = cb.attemptId;
  } else {
    contactId = typeof input.outbound_contact_id === 'string' ? input.outbound_contact_id : '';
    attemptId = typeof input.outbound_attempt_id === 'string' ? input.outbound_attempt_id : '';
  }
  if (!contactId || !attemptId) return NOT_THIS_CALL;
  const contact = await (await live().store()).loadCallContact(contactId, attemptId);
  if (!contact) return NOT_THIS_CALL;
  const demo = isDemoNpxCall(contact, input.outbound_campaign);
  return {
    sid,
    s: keep(
      sid,
      {
        contact,
        demo,
        described: false,
        verified: false,
        dobTries: 0,
        searches: 0,
        offers: [],
        booking: null,
        bookingInFlight: null,
        undone: [],
        undoInFlight: null,
        staffTicket: null,
        openedAtMs: now,
      },
      now,
    ),
  };
}

// ── The patient's partner availability ─────────────────────────────────────

export interface Availability {
  slots: NpxSlot[];
  truncated: boolean;
  /** `offer`: an NPX without the availability endpoint; at most two slots. */
  from: 'availability' | 'offer';
  fetchedAtMs: number;
}
export type AvailabilityLoad = Availability | { error: string };

/** Keyed on the contact and the mode, so the agent factory can warm it before
 * any tool has opened a session. Holds no patient data: slots only. */
const availabilityCache = new Map<string, { at: number; load: Promise<AvailabilityLoad> }>();
const MAX_AVAILABILITY_ENTRIES = 200;

const availabilityKey = (c: OutboundContact, demo: boolean) => `${demo ? 'demo' : 'live'}:${c.contactId}`;

export function offerAsk(c: OutboundContact): { medicalGroupName: string; partnerNames: string[]; replacedAppointmentDate: string } | null {
  const medicalGroupName = field(c, 'medical_group');
  const partnerNames = Array.isArray(c.data.partners) ? (c.data.partners as unknown[]).map(String) : [];
  const replacedAppointmentDate = field(c, 'appointment_date');
  return medicalGroupName && partnerNames.length && replacedAppointmentDate ? { medicalGroupName, partnerNames, replacedAppointmentDate } : null;
}

/**
 * What is left before `deadlineAt`, as a read limit: undefined when there is
 * no deadline (the read keeps its own limit), null when too little is left
 * to start one.
 */
function readLimit(deadlineAt: number | undefined): NpxReadOptions | undefined | null {
  if (deadlineAt === undefined) return undefined;
  const left = deadlineAt - Date.now();
  return left >= MIN_NPX_READ_MS ? { timeoutMs: left } : null;
}

export async function readAvailability(
  c: OutboundContact,
  demo: boolean,
  range?: { fromDay?: string; toDay?: string },
  deadlineAt?: number,
): Promise<AvailabilityLoad> {
  const ask = offerAsk(c);
  if (!ask) return { error: 'record_incomplete' };
  const npx = demo ? live().npxDemo : live().npx;
  const first = readLimit(deadlineAt);
  if (first === null) return { error: 'timeout' };
  const r = await npx.availability({ ...ask, minDaysSooner: MIN_DAYS_SOONER, limit: AVAILABILITY_LIMIT, ...range }, first);
  if (r.ok) return { slots: r.slots, truncated: r.truncated, from: 'availability', fetchedAtMs: Date.now() };
  if (r.error !== 'not_supported') return { error: r.error };
  // An NPX that predates the endpoint: the two-slot offer, searched the same way.
  const second = readLimit(deadlineAt);
  if (second === null) return { error: 'timeout' };
  const o = await npx.offer({ ...ask, minDaysSooner: MIN_DAYS_SOONER }, second);
  // At most two of the openings, never the schedule: truncated (Codex, #439).
  return o.ok ? { slots: o.slots, truncated: true, from: 'offer', fetchedAtMs: Date.now() } : { error: o.error };
}

/** The contact's availability: the cached read while it is fresh, else a new
 * one, bounded by `deadlineAt` when a search started it. */
export function loadAvailability(c: OutboundContact, demo: boolean, fresh = false, deadlineAt?: number): Promise<AvailabilityLoad> {
  const key = availabilityKey(c, demo);
  const now = Date.now();
  const hit = availabilityCache.get(key);
  if (hit && !fresh && now - hit.at < AVAILABILITY_TTL_MS) return hit.load;
  for (const [k, v] of availabilityCache) if (now - v.at >= AVAILABILITY_TTL_MS) availabilityCache.delete(k);
  while (availabilityCache.size >= MAX_AVAILABILITY_ENTRIES) {
    const oldest = availabilityCache.keys().next().value;
    if (oldest === undefined) break;
    availabilityCache.delete(oldest);
  }
  const load = readAvailability(c, demo, undefined, deadlineAt).then((r) => {
    // A failed read is not kept: the next search tries again.
    if ('error' in r) availabilityCache.delete(key);
    return r;
  });
  availabilityCache.set(key, { at: now, load });
  return load;
}

/**
 * Start reading a dialled patient's availability as the call connects, so it
 * is in hand by the time they say what day and time work best. Called by the
 * agent factory; sends NPX nothing about the patient (the medical group, the
 * practices in reach and the appointment date), and never throws.
 */
/**
 * A demo call: the process is in demo mode, OR the call's injected campaign is
 * the demo campaign, OR its contact came from the demo seed. Any one is enough,
 * and the tools and the greeting's warm-up read decide it the same way, so a
 * demo call never reads production NPX (Codex, #439: the warm-up dropped the
 * campaign and, in live mode, read production for a demo-campaign call).
 */
export function isDemoNpxCall(contact: OutboundContact, campaignKey?: unknown): boolean {
  return (
    npxOutreachMode() === 'demo' ||
    campaignKey === NPX_OUTREACH_DEMO_CAMPAIGN_KEY ||
    contact.data.source === NPX_OUTREACH_DEMO_SOURCE
  );
}

export function warmOutreachAvailability(contact: OutboundContact | undefined, campaignKey?: string): void {
  if (!contact) return;
  const demo = isDemoNpxCall(contact, campaignKey);
  if (!offerAsk(contact)) return;
  void loadAvailability(contact, demo).catch(() => undefined);
}

/** A taken slot leaves the call's list, so it is never offered again. */
function forgetSlot(c: OutboundContact, demo: boolean, slotId: string): void {
  const hit = availabilityCache.get(availabilityKey(c, demo));
  if (!hit) return;
  hit.load = hit.load.then((r) => ('error' in r ? r : { ...r, slots: r.slots.filter((x) => x.slotId !== slotId) }));
}

/** `p`, or null once `ms` has passed. */
async function soon<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only. */
export function resetOutreachAvailabilityForTests(): void {
  availabilityCache.clear();
}

// ── What the record says, in words ──────────────────────────────────────────

export const field = (c: OutboundContact, k: string): string => (typeof c.data[k] === 'string' ? (c.data[k] as string) : '');

/** "Monday, December 7" — a YYYY-MM-DD read as a calendar day, never shifted by a time zone. */
export function spokenDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}

/** "9:00 AM" from NextGen's "0900"; empty when it cannot be read. */
export function spokenClock(hhmm: string): string {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(hhmm.trim());
  if (!m) return '';
  const h = Number(m[1]);
  const min = m[2];
  if (h > 23) return '';
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${suffix}`;
}

/** A booked slot in full, said once, after booking: when, with whom, and
 * where — the street address without the state and ZIP. */
export function spokenSlot(slot: NpxSlot): string {
  const who = slot.providerName ? ` with ${slot.providerName}` : '';
  const at = [slot.partnerName, spokenAddress(slot)].filter(Boolean).join(', ');
  return `${spokenWhen(slot)}${who}${at ? `, at ${at}` : ''}`;
}

/**
 * The visit, as a person would say it. Keyed on NextGen's event names as the
 * movable list carries them (measured 2026-10-21: Dilated Exam, Follow Up,
 * Consult, IOP Check, Refraction Only, Ref+DFE, Diabetic Exam, New Patient
 * Exam, GLE, Recheck). An event not listed is "an eye appointment", never a
 * guess at what it might be. It is said before the date of birth, to whoever
 * answered, so no name here may tell them a condition: a Diabetic Exam is "an
 * eye exam", because "a diabetic eye exam" tells a household member the
 * patient is diabetic.
 */
const SPOKEN_VISITS: Record<string, string> = {
  'dilated exam': 'a dilated eye exam',
  'follow up': 'a follow-up visit',
  consult: 'a consultation',
  'iop check': 'an eye pressure check',
  'refraction only': 'a vision test for glasses',
  'ref+dfe': 'an eye exam',
  'diabetic exam': 'an eye exam',
  'new patient exam': 'an eye exam',
  recheck: 'a recheck visit',
};
export function spokenVisit(eventName: string): string {
  return SPOKEN_VISITS[eventName.trim().toLowerCase().replace(/\s+/g, ' ')] ?? 'an eye appointment';
}

/** Before the date of birth: the visit and its date, nothing more. */
function briefAppointment(c: OutboundContact): string {
  return `${spokenVisit(field(c, 'event_name'))} on ${spokenDay(field(c, 'appointment_date'))}`;
}

/** After it: the time and the office as well. */
export function currentAppointment(c: OutboundContact): string {
  const clock = spokenClock(field(c, 'begin_time'));
  const office = field(c, 'office');
  return `${briefAppointment(c)}${clock ? ` at ${clock}` : ''}${office ? ` at our ${office} office` : ''}`;
}

/**
 * THE APPOINTMENT AS STAFF READ IT: NextGen's own event name (v220).
 *
 * The staff-callback ticket went to the HVA Hub (department 9) with the visit
 * as the caller hears it, and for a Refraction Only that is "a vision test for
 * glasses". The ticketing app re-classifies a Hub request by its words
 * (`correctSurgeryIntake`, mirrored in `requestClassification.ts`), and
 * "glasses" with no medication word is an Optical request (1/66/536), so the
 * ticket was created in Optical Support. Measured, every NPX staff-callback
 * ticket to 2026-11-13: 6 of 29 created in Optical, every one a Refraction
 * Only, every one with "glasses" only in this line; Refraction Only is 128 of
 * the campaign's 603 contacts. NextGen's event names (Dilated Exam, Refraction
 * Only, Consult, New Patient Exam, Ref+DFE, Diabetic Exam, GLE) carry no word
 * the classifier routes on, and they are what a scheduler sees in NextGen. The
 * caller still hears `spokenVisit`; only the ticket changes.
 *
 * The event name comes from the live movable list, so a name NextGen adds
 * later could carry a word the classifier routes on (a "Glasses Check", a
 * "CL Fit", a field-style "Department: Glasses"). So the line is checked with
 * the same classifier exactly as it is sent: the whole "Their appointment:"
 * line, after the SMS normalisation the body goes through. A line that would
 * take the ticket out of the Hub names the visit "An appointment" instead
 * (Codex P2 on #467, three rounds: the name alone, then before normalisation,
 * then outside its line). A name the classifier keeps in the Hub ("Eye Exam")
 * is written as it is. What the caller's own words do to the routing is the
 * ticketing app's decision and is not checked here.
 */
export function staffAppointmentLine(c: OutboundContact): string {
  const clock = spokenClock(field(c, 'begin_time'));
  const office = field(c, 'office');
  const when = `on ${spokenDay(field(c, 'appointment_date'))}${clock ? ` at ${clock}` : ''}${office ? ` at our ${office} office` : ''}`;
  const line = (event: string) => sanitizeForSms(`Their appointment: ${event} ${when}.`).value;
  const named = field(c, 'event_name').trim();
  const asNamed = named ? line(named) : '';
  return asNamed && staysInTheHub(asNamed) ? asNamed : line('An appointment');
}

/** Whether this text, read as the ticketing app reads a department-9 ticket, keeps it in the Hub. */
function staysInTheHub(text: string): boolean {
  const routed = correctSurgeryIntake(text, HVA_HUB_DEPARTMENT_ID);
  return !routed || routed.departmentId === HVA_HUB_DEPARTMENT_ID;
}

const DOB_ASK = 'Can I please have your date of birth, starting with the month, then the day, then the year?';
const WHEN_ASK = 'What day and time work best for you?';

// ── describe_upcoming_appointment ───────────────────────────────────────────

registerTool({
  name: DESCRIBE_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 6000,
  description:
    'Say why we called: the patient\'s upcoming visit and its date, and the offer of a sooner appointment. ' +
    'Call it once the person says they are the patient (on a returned call, once identify_callback_caller ' +
    'has identified them), and before you say anything about any appointment.',
  input_schema: { type: 'object', properties: {}, required: [] },
  handler: async (input): Promise<ToolResult> => {
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { s } = found;
    if (!field(s.contact, 'appointment_date')) {
      const r: Refusal = {
        success: false,
        error: 'record_incomplete',
        fix: 'There is nothing to offer from this record. Say nothing about any appointment. Thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
      return r;
    }
    s.described = true;
    const appointment = briefAppointment(s.contact);
    const today = practiceToday();
    if (s.verified) {
      return {
        success: true,
        appointment,
        verified: true,
        today: today.words,
        today_date: today.date,
        next: `Their identity is already confirmed. Ask: "${WHEN_ASK}" and call ${FIND_SOONER_TOOL_NAME} with what they say.`,
      };
    }
    // The opening names where the openings are, when the availability warmed
    // at call start is in hand; it never waits long for it.
    const avail = await soon(loadAvailability(s.contact, s.demo), DESCRIBE_AVAILABILITY_WAIT_MS);
    const known = avail && !('error' in avail) ? avail : null;
    if (known && known.slots.length === 0) {
      return {
        success: true,
        appointment,
        nothing_sooner: true,
        say:
          `Our records show you have ${appointment}. We were calling to offer you a sooner appointment, but nothing ` +
          'sooner is open right now, so your appointment stays as it is.',
        next: 'Say that, thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
    }
    const cities = known ? citiesWithOpenings(known.slots) : [];
    const where = cities.length
      ? `at our partner ${cities.length > 1 ? 'locations' : 'location'} in ${joinWords(cities)}`
      : 'at one of our partner locations nearby';
    return {
      success: true,
      appointment,
      today: today.words,
      today_date: today.date,
      say: `Our records show you have ${appointment}. We have availability sooner ${where}. ${WHEN_ASK}`,
      next:
        'If they name a day or a time, or say they are interested, remember what they said and say: ' +
        `"In order to continue, let me confirm your identity. ${DOB_ASK}" Then call ${CONFIRM_DOB_TOOL_NAME} with what they say. ` +
        'If they would rather keep their appointment, thank them, call record_call_outcome with not_interested, say goodbye and call end_call. ' +
        'Say nothing else about the appointment — not the time, the office or the doctor — until the date of birth matches.',
    };
  },
});

// ── confirm_patient_birthdate ───────────────────────────────────────────────

registerTool({
  name: CONFIRM_DOB_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 6000,
  description:
    'Confirm the person on the phone is the patient this call is about, by the date of birth THEY say. ' +
    'Call it once they have said their date of birth. Never say a date of birth yourself, and say nothing about ' +
    'any appointment until this answers verified: its answer is where the appointment is.',
  input_schema: {
    type: 'object',
    properties: {
      date_of_birth: {
        type: 'string',
        description: 'The date of birth exactly as the person said it, month first.',
        askAs: DOB_ASK,
      },
    },
    required: ['date_of_birth'],
  },
  handler: async (input): Promise<ToolResult> => {
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { sid, s } = found;
    if (s.verified) return { success: true, verified: true, current_appointment: currentAppointment(s.contact), next: afterVerified(s) };
    // Spent tries stay spent: a third guess must not unlock what two wrong
    // dates closed, or the limit is one more call away from meaning nothing.
    if (s.dobTries >= MAX_DOB_TRIES) return notConfirmed();
    const onFile = dobOnFile(s.contact);
    if (!onFile) {
      const r: Refusal = {
        success: false,
        error: 'no_birthdate_on_file',
        fix: 'This record holds no date of birth, so the person cannot be confirmed. Say nothing about any appointment. Thank them, call record_call_outcome with call_back_later, say goodbye and call end_call.',
      };
      return r;
    }
    const said = String(input.date_of_birth ?? '').trim() || spokenDobFor(sid) || '';
    const heard = said ? readDobQuietly(said) : null;
    s.dobTries += 1;
    const match =
      heard !== null && heard.year === onFile.year && heard.month === onFile.month && heard.day === onFile.day;
    if (match) {
      s.verified = true;
      return {
        success: true,
        verified: true,
        current_appointment: currentAppointment(s.contact),
        next: afterVerified(s),
      };
    }
    if (s.dobTries < MAX_DOB_TRIES) {
      const r: Refusal = {
        success: false,
        error: heard ? 'birthdate_does_not_match' : 'birthdate_not_understood',
        say: 'I may not have heard that right. Could you say your date of birth once more, starting with the month, then the day, then the year?',
        fix: 'Do not say what the date on file is, and do not hint whether it was close. Ask once more, then call this again with what they say.',
      };
      return r;
    }
    return notConfirmed();
  },
});

/** What follows a matching date of birth. They have already said they want
 * a sooner appointment when the offer came first, so it goes straight to the
 * options; otherwise the offer is made now. */
function afterVerified(s: OutreachSession): string {
  return s.described
    ? `Their identity is confirmed. If they already said what day or time works best, call ${FIND_SOONER_TOOL_NAME} now ` +
        `with it. If not, ask: "${WHEN_ASK}" and call ${FIND_SOONER_TOOL_NAME} with their answer.`
    : `Tell them our records show they have ${currentAppointment(s.contact)}, and that we have availability sooner at a ` +
        `partner location that takes their medical group. Ask: "${WHEN_ASK}" and call ${FIND_SOONER_TOOL_NAME} with their answer.`;
}

function notConfirmed(): Refusal {
  return {
    success: false,
    error: 'not_confirmed',
    fix: 'The person could not be confirmed. Say NOTHING about any appointment or why we called. Thank them, say we will try another time, call record_call_outcome with call_back_later, say goodbye and call end_call.',
  };
}

// ── find_sooner_exam ────────────────────────────────────────────────────────

function notVerified(): Refusal {
  return {
    success: false,
    error: 'not_confirmed_yet',
    fix: 'Confirm who you are speaking with first: ask for their date of birth and call confirm_patient_birthdate. Say nothing about any appointment until it answers verified.',
  };
}

/**
 * The part of what was asked that a cut-short list cannot answer, or null.
 *
 * The list stops at its limit, so every day before its last is whole and its
 * last day may be cut part way (Codex P2, #439: a list ending at 11:40 on a
 * Tuesday has nothing to say about Tuesday afternoon). A date asked for, or a
 * range that reaches the last day or past it, is read again from NPX — from
 * the later of that day and the first day asked, to the last day asked — the
 * same rules applied, before any preference is relaxed. A search with no date
 * (a weekday, a time, a city) is read again from the last day on when nothing
 * in the list fits it (Codex round 2, #439: "Thursday afternoons" against a
 * list that stops on a Thursday morning).
 */
export function incompleteRange(
  avail: { slots: NpxSlot[]; truncated: boolean },
  pref: SlotPreference,
): { fromDay: string; toDay?: string } | null {
  if (!avail.truncated || avail.slots.length === 0) return null;
  const from = pref.onDate ?? pref.fromDate;
  const to = pref.onDate ?? pref.toDate;
  const lastDay = avail.slots[avail.slots.length - 1].day;
  if (to && to < lastDay) return null;
  if (!from && !to && avail.slots.some((x) => matches(x, pref))) return null;
  return { fromDay: from && from > lastDay ? from : lastDay, ...(to ? { toDay: to } : {}) };
}

/** The later of two YYYY-MM-DD days. */
function laterDay(a: string, b: string | undefined): string {
  return b && b > a ? b : a;
}

/** Every slot in either list once, in time order. */
export function unionSlots(a: NpxSlot[], b: NpxSlot[]): NpxSlot[] {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((x) => (seen.has(x.slotId) ? false : (seen.add(x.slotId), true)))
    .sort((x, y) => Date.parse(x.startAt) - Date.parse(y.startAt));
}

/** The whole days of `pool` before `fromDay`, then the range read, in time order. */
export function withRange(pool: NpxSlot[], fromDay: string, range: NpxSlot[]): NpxSlot[] {
  const seen = new Set<string>();
  return [...pool.filter((x) => x.day < fromDay), ...range]
    .filter((x) => (seen.has(x.slotId) ? false : (seen.add(x.slotId), true)))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
}

/** The lead-in when a search had to step back from what was asked. */
const RELAXED_LEAD: Record<Exclude<Relaxed, null>, string> = {
  time: "I don't have that time open, but",
  day: "I don't have that day open, but",
  when: "I don't have that day or time open, but",
  city: "I don't have anything open there then, but",
  all: "I don't have anything open then, but",
};

/** The choices as the caller hears them: "On Tuesday, November 17 I have …"
 * or "I have …", after the lead-in when the search stepped back. */
export function choicesLine(picked: NpxSlot[], relaxed: Relaxed): string {
  const line = offerLine(picked);
  if (!relaxed || !line) return line;
  return `${RELAXED_LEAD[relaxed]} ${line.startsWith('On ') ? `on ${line.slice(3)}` : line}`;
}

registerTool({
  name: FIND_SOONER_TOOL_NAME,
  layer: 'agent',
  timeoutMs: FIND_TOOL_TIMEOUT_MS,
  description:
    'Search the sooner openings at our partner locations for the day and time the patient says works best, and get up to ' +
    'three choices to offer. Pass what they asked for: a date, a range of dates, weekdays, morning or afternoon, a time ' +
    'window, a city. Dates are YYYY-MM-DD; today\'s date is in describe_upcoming_appointment\'s answer and in this one. ' +
    'With nothing passed it gives the earliest openings. Every opening it returns is one this patient qualifies for. ' +
    'It answers at once: call it again every time they ask about another day or time. ' +
    'Call it only after confirm_patient_birthdate answered verified.',
  input_schema: {
    type: 'object',
    properties: {
      on_date: { type: 'string', description: 'A single day they asked for, YYYY-MM-DD.' },
      from_date: { type: 'string', description: 'The first day of a range they asked for ("next week", "after the 20th"), YYYY-MM-DD.' },
      to_date: { type: 'string', description: 'The last day of that range, YYYY-MM-DD.' },
      weekdays: {
        type: 'string',
        description: `Days of the week they can come, comma-separated, from: ${WEEKDAYS.join(', ')} ("Tuesdays or Thursdays" is "tuesday,thursday").`,
      },
      time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'any'], description: 'Morning (before noon) or afternoon.' },
      earliest_time: { type: 'string', description: 'No earlier than this, 24-hour HH:MM ("after 10" is 10:00).' },
      latest_time: { type: 'string', description: 'No later than this, 24-hour HH:MM ("before 3" is 15:00).' },
      city: {
        type: 'string',
        description: 'A city they asked for, if they named one, spelled as the city is named (the overview and the choices name them). Only that city matches: "Chino" is not "Chino Hills".',
      },
    },
    required: [],
  },
  handler: async (input): Promise<ToolResult> => {
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { s } = found;
    if (!s.verified) return notVerified();
    if (s.booking) {
      return { success: true, already_booked: true, fix: 'The exam is already booked on this call. Do not look again; confirm the booking with them.' };
    }
    if (s.searches >= MAX_SEARCHES) {
      const r: Refusal = {
        success: false,
        error: 'search_limit',
        fix: 'Stop looking. Offer once more the choices you last read, or tell them their current appointment stays as it is; if they want neither, thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
      return r;
    }
    s.searches += 1;
    if (!offerAsk(s.contact)) {
      const r: Refusal = {
        success: false,
        error: 'record_incomplete',
        fix: 'There is nothing to offer from this record. Tell them their current appointment stays as it is, thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
      return r;
    }
    const pref = preferenceFrom(input);
    const deadline = Date.now() + FIND_BUDGET_MS;
    const left = () => deadline - Date.now();
    // The cached read may be the one the agent factory started, which keeps its
    // own 10 seconds; the race holds it to the budget.
    let avail: AvailabilityLoad = (await soon(loadAvailability(s.contact, s.demo, false, deadline), left())) ?? { error: 'timeout' };
    if ('error' in avail && left() >= MIN_NPX_READ_MS) {
      avail = (await soon(loadAvailability(s.contact, s.demo, true, deadline), left())) ?? { error: 'timeout' };
    }
    if ('error' in avail) {
      const r: Refusal = {
        success: false,
        error: avail.error,
        fix: 'The partner schedule could not be read just now. Do not say anything failed. Tell them their current appointment stays as it is and we may reach out another time, call record_call_outcome with call_back_later, say goodbye and call end_call.',
      };
      return r;
    }
    // Read on until the part that could answer them is in hand. A read that is
    // itself cut short is read on from its own last day (Codex round 3, #439);
    // a read that fails, a budget that runs out, or a day that holds more than a
    // whole list leaves it unread.
    let pool = avail.slots;
    // An NPX without the availability endpoint answers with two openings and
    // cannot be read any further: nothing it lacks is ever stepped back from.
    const offerOnly = avail.from === 'offer';
    let range = offerOnly ? null : incompleteRange(avail, pref);
    // What has been read: `complete` when the pool runs to the end of the
    // window, otherwise `edge`, the day before which every day has been read.
    // A read on that starts later than the edge leaves the days between it
    // unread and does not move it (Codex, #439).
    let complete = !avail.truncated;
    let edge = avail.slots[avail.slots.length - 1]?.day;
    const noteRead = (from: string, to: string | undefined, got: Availability) => {
      if (complete || !edge || from > edge) return;
      if (got.truncated) edge = laterDay(edge, got.slots[got.slots.length - 1]?.day);
      else if (to) edge = laterDay(edge, to);
      else complete = true;
    };
    for (let reads = 0; range && reads < MAX_RANGE_READS && left() >= MIN_NPX_READ_MS; reads++) {
      const more = await soon(readAvailability(s.contact, s.demo, range, deadline), left());
      if (!more || 'error' in more) break;
      pool = withRange(pool, range.fromDay, more.slots);
      noteRead(range.fromDay, range.toDay, more);
      const next = incompleteRange(more, pref);
      if (next && next.fromDay <= range.fromDay) break;
      range = next;
    }
    const unread = range !== null || offerOnly;
    const today = practiceToday();
    const unchecked: ToolResult = {
      success: true,
      options: [],
      unchecked: true,
      today: today.words,
      today_date: today.date,
      fix:
        'That day or time could not be checked just now. Do not say it is full and do not offer another day in its place. ' +
        'Say you could not check that one just now and ask whether another day or time works; call this again with what they say. ' +
        'Any choices you read them before still stand.',
    };
    // "Nothing sooner" only from a list that had nothing: a truncated list whose
    // re-read came back empty says nothing about the days after it.
    if (pool.length === 0 && avail.slots.length > 0) return unchecked;
    if (pool.length === 0) {
      return {
        success: true,
        options: [],
        today: today.words,
        today_date: today.date,
        fix: 'Nothing sooner is open right now. Tell them their current appointment stays as it is, thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
    }
    let { picked, relaxed } = searchSlots(pool, pref, OPTIONS_PER_SEARCH);
    // The part of the schedule that could answer them was not read (Codex
    // round 2, #439): never step back from a day or time nobody checked. What
    // was offered before stays bookable.
    if (unread && relaxed !== null) return unchecked;
    // What was asked was read and has nothing; before stepping back from it,
    // read the openings the alternatives come from, from the edge on (Codex,
    // #439: Thursday in one city must not give way to another city while that
    // city's Tuesday is unread). Once, inside the budget; then step back over
    // what was read.
    if (relaxed !== null && !complete && !offerOnly && edge && left() >= MIN_NPX_READ_MS) {
      const from = edge;
      const fill = await soon(readAvailability(s.contact, s.demo, { fromDay: from }, deadline), left());
      if (fill && !('error' in fill)) {
        pool = unionSlots(pool, fill.slots);
        noteRead(from, undefined, fill);
        ({ picked, relaxed } = searchSlots(pool, pref, OPTIONS_PER_SEARCH));
      }
    }
    if (picked.length) s.offers.push(picked);
    return {
      success: true,
      exact: relaxed === null,
      options: picked.map((slot, i) => ({
        option: i + 1,
        ...slotDateTime(slot),
        when: spokenWhen(slot),
        city: cityOf(slot),
        provider: slot.providerName,
        practice: slot.partnerName,
      })),
      say: choicesLine(picked, relaxed),
      overview: overviewLine(pool, !complete),
      today: today.words,
      today_date: today.date,
      next:
        'Say the choices as the say line does: the day, date, time and city — not the street address. ' +
        'If they want a different day or time, call this again with what they now say. If they ask what is open, use the overview. ' +
        'When they pick one, say it back with the doctor and the city, say that booking it cancels their current appointment with us, ' +
        'and ask them to confirm; on a yes, call book_sooner_exam with that choice\'s date and time (and its city).',
    };
  },
});

// ── book_sooner_exam ────────────────────────────────────────────────────────

/**
 * THE WHOLE BOOKING ANSWERS INSIDE ONE BUDGET (Codex P1, #361). `runTool`
 * races the handler against the tool's timeout and does not stop it, so a
 * sequence longer than the timeout would tell the model "timed out" while
 * the handler went on to cancel the caller's appointment and settle them —
 * the caller never told, and a retry invited. Worst case in parts: the NPX
 * booking 12 s, the three Azul steps 12 s each, the report 8 s — 56 s. So the
 * cancel is given a deadline (what the budget leaves after the report and the
 * settle are reserved), a step that would not fit is not started, and a
 * cancel that runs out is told to the caller as "our team will cancel" —
 * which NPX's backup list makes true. The budget sits under the tool's
 * timeout, which sits under the bridge's tool-dispatch watchdog
 * (DEFAULT_DEAD_AIR_MS + TOOL_DISPATCH_GRACE_MS, 45 s).
 */
export const BOOK_SEQUENCE_BUDGET_MS = 36_000;
export const BOOK_TOOL_TIMEOUT_MS = 40_000;
const SETTLE_BUDGET_MS = 2_000;
/** A call booking writes three things on the contact (the held cancel, the
 * settle, the confirmation) and cancels nothing, so it has longer for them. */
const HOLD_SETTLE_BUDGET_MS = 5_000;

/** `p`, or `fallback` once `ms` has passed — never later. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The booking said back once. On a call the Azul cancel is held until the
 * call ends (v226), so the caller is told it will be cancelled once we hang
 * up, never that it already has been.
 */
export function confirmation(slot: NpxSlot, cancel: AzulCancelResult | 'held', currentDay: string): string {
  const booked = `You're booked for ${spokenSlot(slot)}. Their phone number is ${slot.phone}.`;
  if (cancel === 'held') {
    return `${booked} Your appointment with us on ${currentDay} will be cancelled once we hang up, so there's nothing else you need to do.`;
  }
  return cancel.cancelled
    ? `${booked} I've also cancelled your appointment with us on ${currentDay}, so there's nothing else you need to do.`
    : `${booked} Our team will cancel your appointment with us on ${currentDay}; you don't need to do anything.`;
}

/** The cancel a booking's confirmation speaks of. */
function spokenCancelOf(azul: AzulCancelState): AzulCancelResult | 'held' {
  if (azul.kind === 'done') return azul.result;
  if (azul.kind === 'held') return 'held';
  return { cancelled: false, reason: 'nextgen_cancel_failed' };
}

registerTool({
  name: BOOK_SOONER_TOOL_NAME,
  layer: 'agent',
  timeoutMs: BOOK_TOOL_TIMEOUT_MS,
  description:
    'Book the sooner exam the person chose and confirmed: pass the date and time of the choice you said back to them, ' +
    'as find_sooner_exam gave it, and its city. Only a choice read to them on this call can be booked. ' +
    'Their current appointment with us is cancelled once the call ends, so call it only after they have said yes to that.',
  input_schema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: "The date of the choice they confirmed, YYYY-MM-DD, as the choice's date in find_sooner_exam's answer.",
      },
      time: {
        type: 'string',
        description: "The time of the choice they confirmed, 24-hour HH:MM, as the choice's time in find_sooner_exam's answer.",
      },
      city: {
        type: 'string',
        description: 'The city of the choice they confirmed, as find_sooner_exam named it.',
      },
      option: {
        type: 'string',
        enum: ['1', '2', '3'],
        description: 'The option number in the find_sooner_exam answer it came from. The date and time decide; this only helps when two choices share them.',
      },
    },
    required: [],
  },
  handler: async (input): Promise<ToolResult> => {
    const deadline = Date.now() + BOOK_SEQUENCE_BUDGET_MS;
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { sid, s } = found;
    if (!s.verified) return notVerified();
    const currentDay = spokenDay(field(s.contact, 'appointment_date'));
    if (s.booking) {
      if (s.booking.azul.kind === 'dropped') {
        const r: Refusal = {
          success: false,
          error: 'booking_being_changed',
          fix: 'Our scheduling team is already calling them back about the booking made on this call. Do not book again; tell them the team will call.',
        };
        return r;
      }
      return { success: true, booked: true, say: confirmation(s.booking.slot, spokenCancelOf(s.booking.azul), currentDay) };
    }
    if (s.bookingInFlight) return s.bookingInFlight;
    const run = bookChosen(input, sid, s, currentDay, deadline).finally(() => {
      s.bookingInFlight = null;
    });
    s.bookingInFlight = run;
    return run;
  },
});

/**
 * WHICH SLOT THE CALLER CONFIRMED (v218). The agent says a choice back with
 * its day, time, doctor and city and asks for a yes; that is what the caller
 * agreed to, so the booking takes the date and time it said, not a position
 * in a list.
 *
 * WHY NOT THE OPTION NUMBER. On CA93903cf32d7636e047cbb5b9a9b109f6
 * (2026-11-12) two find_sooner_exam answers arrived 1.8 s apart in one turn;
 * the agent read both lists as one, the caller chose December 1 at 10:00 AM,
 * the agent said that slot back, and option 2 resolved against the SECOND
 * list: December 9 at 9:20 AM was booked and the January appointment
 * cancelled. A number means one slot only while one list has been read.
 *
 * So, from every list read to the caller on this call and nothing else:
 *  - a date and time match the slots offered at that minute; one is booked,
 *    and when two share it (two doctors, two cities) the city, then the
 *    option, settles it, or the agent is asked which;
 *  - an option number alone books only when it is the same slot in every
 *    list read on the call;
 *  - nothing offered at that date and time books nothing.
 * Every refusal speaks through `fix` (v43): nothing for the caller to hear.
 *
 * v229: a date sent as words or numbers ("November 18", "11/18") is read
 * against the days offered (readChosenDate), and every refusal carries the
 * choices read on the call with the exact date and time to send back
 * (withChoices); `which_list` names the slots the option points at.
 */
export function chosenSlot(
  offers: NpxSlot[][],
  input: Record<string, unknown>,
): { slot: NpxSlot; by: 'date_time' | 'option'; optionDisagreed?: boolean } | { refusal: Refusal } {
  const seen = new Set<string>();
  const offered: NpxSlot[] = [];
  for (const list of offers) for (const x of list) if (!seen.has(x.slotId)) (seen.add(x.slotId), offered.push(x));
  const optionText = typeof input.option === 'string' || typeof input.option === 'number' ? String(input.option).trim() : '';
  const index = /^[1-9]$/.test(optionText) ? Number(optionText) - 1 : -1;
  const byOption = new Map<string, NpxSlot>();
  if (index >= 0) for (const list of offers) if (list[index]) byOption.set(list[index].slotId, list[index]);
  const dateRead = readChosenDate(input.date, offered);
  const timeRead = readChosenTime(input.time, input.date);
  const date = 'day' in dateRead ? dateRead.day : '';
  const minutes = 'minutes' in timeRead ? timeRead.minutes : null;

  if (date && minutes !== null) {
    let atThatTime = offered.filter((x) => {
      const p = localParts(x);
      return p.day === date && p.minutes === minutes;
    });
    if (atThatTime.length === 0) {
      return {
        refusal: withChoices(
          {
            success: false,
            error: 'not_offered',
            fix:
              'Nothing was booked: no choice read to them on this call is at that date and time. Book only a choice you read to them and they confirmed. ' +
              'If they want a time you have not read them, call find_sooner_exam for that day first.',
          },
          offered,
        ),
      };
    }
    const city = typeof input.city === 'string' ? fold(input.city) : '';
    if (atThatTime.length > 1 && city) {
      const inCity = atThatTime.filter((x) => fold(cityOf(x)) === city);
      if (inCity.length) atThatTime = inCity;
    }
    if (atThatTime.length > 1 && byOption.size) {
      const both = atThatTime.filter((x) => byOption.has(x.slotId));
      if (both.length) atThatTime = both;
    }
    if (atThatTime.length > 1) {
      const where = joinWords([...new Set(atThatTime.map((x) => `${x.providerName || 'the provider'} in ${cityOf(x) || 'the partner office'}`))], 'or');
      return {
        refusal: {
          success: false,
          error: 'which_one',
          fix: `Nothing was booked: two choices read to them are at that date and time (${where}). Ask which one they want, then call again with its city.`,
        },
      };
    }
    const slot = atThatTime[0];
    // What the pre-v218 rule would have booked: the option in the last list.
    const last = offers[offers.length - 1];
    const oldRule = index >= 0 && last ? last[index] : undefined;
    return { slot, by: 'date_time', ...(oldRule && oldRule.slotId !== slot.slotId ? { optionDisagreed: true } : {}) };
  }

  if (index >= 0) {
    if (byOption.size === 1) return { slot: [...byOption.values()][0], by: 'option' };
    if (byOption.size === 0) {
      return {
        refusal: withChoices(
          {
            success: false,
            error: 'no_such_option',
            fix: 'That option was not offered. Book only a choice you read to them and they confirmed.',
          },
          offered,
        ),
      };
    }
    // v229: name the slots the number points at, with the exact date and
    // time to send back, instead of telling the model to find them (it did
    // not, four times running, on CA3eec4f155e08f15868b34008bd15d988).
    const candidates = [...byOption.values()];
    return {
      refusal: withChoices(
        {
          success: false,
          error: 'which_list',
          fix:
            `Nothing was booked: more than one list of choices was read on this call, so option ${index + 1} is more than one time: ` +
            `${joinWords(candidates.map(choiceWords), 'or')}. ` +
            'Call book_sooner_exam again with the date and time, exactly as written here, of the one you said back to them and they confirmed.',
        },
        candidates,
      ),
    };
  }

  // v229: a date or time that arrived in a form this cannot read is named,
  // so the model sends it again in the form it can.
  const unreadable = [
    ...(dateRead.form === 'unreadable' ? ['the date'] : []),
    ...(timeRead.form === 'unreadable' ? ['the time'] : []),
  ];
  return {
    refusal: withChoices(
      {
        success: false,
        error: 'no_choice',
        fix:
          'Nothing was booked. ' +
          (unreadable.length ? `${joinWords(unreadable)} could not be read. ` : '') +
          'Call book_sooner_exam with the date and time, exactly as written here, of the choice they confirmed.',
      },
      offered,
    ),
  };
}

/** "Wednesday, November 18 at 11:00 AM in Beaumont (date 2026-11-18, time 11:00)". */
function choiceWords(s: NpxSlot): string {
  const { date, time } = slotDateTime(s);
  const city = cityOf(s);
  return `${spokenWhen(s)}${city ? ` in ${city}` : ''} (date ${date}, time ${time})`;
}

/** At most this many choices are written into a refusal. */
const CHOICES_IN_A_REFUSAL = 9;

/**
 * v229: a booking refusal carries the choices read on the call, each with the
 * exact date and time to send back, so the model can book one without going
 * back to find_sooner_exam's answer. Slot times and cities only, no PHI.
 */
function withChoices(r: Refusal, slots: NpxSlot[]): Refusal {
  const listed = slots.slice(0, CHOICES_IN_A_REFUSAL);
  if (!listed.length) return r;
  return {
    ...r,
    choices: listed.map((s) => ({ ...slotDateTime(s), when: spokenWhen(s), city: cityOf(s) })),
  } as Refusal;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** "nov" / "november" -> 11, "sept" -> 9; anything else -> 0. */
function monthOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return 0;
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(w));
  return i + 1;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The clock every slot is offered on and every choice is written in. */
const PRACTICE_TIME_ZONE = 'America/Los_Angeles';

/** "2041-02-13T09:00" or "2041-02-13 09:00", then the rest of the string. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(.*)$/i;

/**
 * A DATE-TIME SENT AS ISO 8601, ON THE PRACTICE'S CLOCK (v229, Codex P2 on
 * #476). A choice is written as a Pacific date and time, so a date-time with
 * no zone ("2041-02-13T09:00") is read as written. One with an offset
 * ("2041-02-13T17:00:00Z", "...-08:00") is a moment, and is turned into the
 * Pacific day and minute it names: 17:00Z is 09:00 in Los Angeles, and
 * reading its 17:00 against the slots would refuse the slot the caller chose
 * or book another one at 17:00. A Pacific zone name ("PST", "PT") is read as
 * written; any other zone word cannot be placed and is unreadable, so the
 * refusal names the choices. Null when the string is not an ISO date-time.
 */
export function readIsoDateTime(raw: string): { day: string; minutes: number } | 'unreadable' | null {
  const m = ISO_DATE_TIME.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, rest] = m;
  if (Number(hh) > 23 || Number(mi) > 59) return 'unreadable';
  const tail = rest.trim();
  if (!tail || /^(?:pst|pdt|pt|pacific(?: time)?)$/i.test(tail)) {
    return { day: `${y}-${mo}-${d}`, minutes: Number(hh) * 60 + Number(mi) };
  }
  const ampm = /^([ap])\.?\s?m\.?$/i.exec(tail);
  if (ampm) {
    const minutes = minutesOf(`${hh}:${mi} ${ampm[1]}m`);
    return minutes === null ? 'unreadable' : { day: `${y}-${mo}-${d}`, minutes };
  }
  let offset: string;
  if (/^(?:z|utc|gmt)$/i.test(tail)) {
    offset = 'Z';
  } else {
    const o = /^(?:utc|gmt)?\s*([+-])(\d{2})(?::?(\d{2}))?$/i.exec(tail);
    if (!o || Number(o[2]) > 14 || Number(o[3] ?? 0) > 59) return 'unreadable';
    offset = `${o[1]}${o[2]}:${o[3] ?? '00'}`;
  }
  const instant = new Date(`${y}-${mo}-${d}T${hh}:${mi}:${ss ?? '00'}${offset}`);
  if (Number.isNaN(instant.getTime())) return 'unreadable';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PRACTICE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

/**
 * THE DATE THE MODEL SENT, READ AGAINST THE DAYS OFFERED (v229).
 *
 * v218 took only YYYY-MM-DD and read anything else as no date at all, so a
 * date sent as "November 18" or "11/18" fell through to the option number
 * and, with two lists read, was refused `which_list` every time: 2 of the 4
 * NPX calls since v218 that tried to book hit it, and
 * CA3eec4f155e08f15868b34008bd15d988 lost the slot the caller chose. Now a
 * month and day in words or numbers are read too, and only ever to a day
 * that a choice read on the call is on, so nothing is invented: a month and
 * day no choice is on is a day not offered, and refused as one.
 */
export function readChosenDate(
  raw: unknown,
  offered: NpxSlot[],
): { day: string; form: 'iso' | 'words' } | { form: 'unreadable' | 'none' } {
  if (typeof raw !== 'string' || !raw.trim()) return { form: 'none' };
  const text = raw.trim();
  const dateTime = readIsoDateTime(text);
  if (dateTime === 'unreadable') return { form: 'unreadable' };
  if (dateTime) return { day: dateTime.day, form: 'iso' };
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(text);
  if (iso) return { day: `${iso[1]}-${iso[2]}-${iso[3]}`, form: 'iso' };

  let month = 0;
  let dayOfMonth = 0;
  let year = 0;
  // Punctuation that ends a sentence or a list item is not part of a date:
  // "2/13/2042." and "February 13, 2042." carry their year (Codex P1 on
  // #476: the year with a full stop after it was dropped, and the date was
  // read to the offered February 13 a year earlier).
  const bare = text.replace(/[\s.,;:!?)\]]+$/, '');
  const numeric = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(bare);
  if (numeric) {
    month = Number(numeric[1]);
    dayOfMonth = Number(numeric[2]);
    if (numeric[3]) year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
  } else {
    const words = bare
      .toLowerCase()
      .split(/[\s,]+/)
      .map((w) => w.replace(/^[(\[]+/, '').replace(/[.;:!?)\]]+$/, ''))
      .filter(Boolean);
    for (const w of words) {
      const m = monthOf(w);
      if (m && !month) {
        month = m;
        continue;
      }
      const d = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(w);
      if (d && !dayOfMonth) {
        dayOfMonth = Number(d[1]);
        continue;
      }
      // A year is read or the date is not: a year that cannot be read is
      // never replaced by the year of a choice on offer.
      const y4 = /^\d{4}$/.test(w) ? Number(w) : /^['’]\d{2}$/.test(w) ? 2000 + Number(w.slice(1)) : 0;
      if (y4) {
        if (year && year !== y4) return { form: 'unreadable' };
        year = y4;
        continue;
      }
      if (/^\d{3}$|^\d{5,}$/.test(w)) return { form: 'unreadable' };
    }
  }
  if (!(month >= 1 && month <= 12 && dayOfMonth >= 1 && dayOfMonth <= 31)) return { form: 'unreadable' };

  const suffix = `-${pad2(month)}-${pad2(dayOfMonth)}`;
  const days = [...new Set(offered.map((x) => localParts(x).day))];
  const matching = days.filter((d) => d.endsWith(suffix) && (!year || d.startsWith(`${year}-`)));
  if (matching.length === 1) return { day: matching[0], form: 'words' };
  if (matching.length > 1) return { form: 'unreadable' };
  // A month and day no choice is on: read as that day in the year of the
  // first choice (or the year given), so it is refused as not offered.
  const y = year || Number((days[0] ?? '').slice(0, 4)) || new Date().getUTCFullYear();
  return { day: `${y}${suffix}`, form: 'words' };
}

/**
 * The time the model sent: "11:00", "11 AM", "11:00 a.m.", "11:00:00", a
 * whole date-time, or, when no time was sent, the time of a date sent as
 * "2026-11-18T11:00". A date-time with a UTC offset is read on the
 * practice's clock (`readIsoDateTime`); a bare time with an offset
 * ("17:00Z") cannot be placed on a day and is unreadable.
 */
export function readChosenTime(
  raw: unknown,
  dateRaw?: unknown,
): { minutes: number; form: 'read' } | { form: 'unreadable' | 'none' } {
  if (typeof raw === 'string' && raw.trim()) {
    const dateTime = readIsoDateTime(raw);
    if (dateTime === 'unreadable') return { form: 'unreadable' };
    if (dateTime) return { minutes: dateTime.minutes, form: 'read' };
    const text = raw.trim().replace(/^(\d{1,2}:\d{2}):\d{2}/, '$1').replace(/\b([ap])\.?\s?m\.?$/i, '$1m');
    const m = minutesOf(text);
    return m === null ? { form: 'unreadable' } : { minutes: m, form: 'read' };
  }
  if (typeof dateRaw === 'string') {
    const dateTime = readIsoDateTime(dateRaw);
    if (dateTime === 'unreadable') return { form: 'unreadable' };
    if (dateTime) return { minutes: dateTime.minutes, form: 'read' };
  }
  return { form: 'none' };
}

/**
 * WHAT book_sooner_exam RECEIVED (v229), as fixed words for the timeline:
 * whether a date and a time arrived and in what form, and whether an option
 * number did. Never the values. Until now the timeline kept nothing of the
 * booking's arguments, so "did the model send the date at all?" could not be
 * answered for the 7 refusals of 2026-11-13.
 */
export function bookingArgsReceived(input: Record<string, unknown>, offers: NpxSlot[][]): {
  received_date: 'iso' | 'words' | 'unreadable' | 'none';
  received_time: 'read' | 'unreadable' | 'none';
  received_option: boolean;
} {
  const offered = offers.flat();
  const optionText = typeof input.option === 'string' || typeof input.option === 'number' ? String(input.option).trim() : '';
  return {
    received_date: readChosenDate(input.date, offered).form,
    received_time: readChosenTime(input.time, input.date).form,
    received_option: optionText !== '',
  };
}

async function bookChosen(
  input: Record<string, unknown>,
  sid: string,
  s: OutreachSession,
  currentDay: string,
  deadline: number,
): Promise<ToolResult> {
  // Read before booking: a slot taken on the way empties s.offers.
  const received = bookingArgsReceived(input, s.offers);
  const result = await bookChosenSlot(input, sid, s, currentDay, deadline);
  return { ...result, ...received } as ToolResult;
}

async function bookChosenSlot(
  input: Record<string, unknown>,
  sid: string,
  s: OutreachSession,
  currentDay: string,
  deadline: number,
): Promise<ToolResult> {
  const chosen = chosenSlot(s.offers, input);
  if ('refusal' in chosen) return chosen.refusal;
  const { slot } = chosen;
  if (chosen.optionDisagreed) {
    console.warn(`[NPX OUTREACH] ${sid}: option ${String(input.option)} in the last list read is not the date and time confirmed; booking the date and time`);
  }
  const booked = await bookOutreachSlot({
    contact: s.contact, demo: s.demo, slot, callRef: sid, deadline, superseded: (id) => s.undone.includes(id),
  });
  if (!booked.ok) {
    if (booked.error === 'record_incomplete') {
      const r: Refusal = {
        success: false,
        error: 'record_incomplete',
        fix: 'This record cannot be booked over the phone. Tell them their current appointment stays as it is, call record_call_outcome with done, say goodbye and call end_call.',
      };
      return r;
    }
    if (booked.error === 'slot_unavailable') {
      s.offers = [];
      const r: Refusal = {
        success: false,
        error: 'slot_unavailable',
        say: 'I\'m sorry, that time was just taken. Let me check what else is open.',
        fix: 'Call find_sooner_exam again with what they asked for and offer what it gives you. Their current appointment has not been touched.',
      };
      return r;
    }
    const r: Refusal = {
      success: false,
      error: booked.error,
      fix:
        'It could not be booked over the phone. Do not say anything failed and do not promise a call. Tell them their current appointment stays exactly as it is, ' +
        'call record_call_outcome with done, say goodbye and call end_call.',
    };
    return r;
  }
  s.booking = { bookingId: booked.bookingId, slot: booked.slot, azul: booked.azul, writes: booked.writes };
  return {
    success: true,
    booked: true,
    booked_by: chosen.by,
    ...(chosen.optionDisagreed ? { option_disagreed: true } : {}),
    // v222: what happened to the Azul appointment, as a fixed code the
    // timeline keeps (Wayne, 2026-11-13: record it). v226: on a call it is
    // `held`, because nothing is cancelled until the call ends.
    ...azulCancelOutcomeFor(booked.azul),
    say: confirmation(booked.slot, spokenCancelOf(booked.azul), currentDay),
    fix:
      'Say the confirmation as given and ask if there is anything else. If they change their mind before hanging up and want to keep ' +
      `their appointment with us, call ${CANCEL_BOOKING_TOOL_NAME}; for a different time, call it first, then find and book the new one. ` +
      'Otherwise say goodbye and call end_call. The outcome is already recorded.',
  };
}

/**
 * The Azul cancel as the timeline records it (v222): `cancelled`, or
 * `not_cancelled` with the cancel's own refusal code. Codes only, no patient
 * details; `toolTimeline` keeps both keys.
 */
export function azulCancelOutcome(cancel: AzulCancelResult): { azul_cancel: 'cancelled' | 'not_cancelled'; azul_cancel_reason?: string } {
  return cancel.cancelled ? { azul_cancel: 'cancelled' } : { azul_cancel: 'not_cancelled', azul_cancel_reason: cancel.reason };
}

/** v226: a call booking's Azul cancel is `held` until the call ends; what it
 * came to is written on the contact at hang-up (held_cancel, confirmation). */
export function azulCancelOutcomeFor(azul: AzulCancelState): { azul_cancel: 'cancelled' | 'not_cancelled' | 'held'; azul_cancel_reason?: string } {
  return azul.kind === 'done' ? azulCancelOutcome(azul.result) : { azul_cancel: 'held' };
}

/** The text's booking reference prefix (bookingPage.textLinkCallRef). */
const TEXT_LINK_CALL_REF_PREFIX = 'text-link-';

/** "Jan 6": the Azul appointment a text names, read as a calendar day. */
export function textedDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return 'current';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

/** What a booking's confirmation text will say, rendered when it is booked (v222). */
export function confirmationRecordFor(args: {
  contact: OutboundContact;
  slot: NpxSlot;
  bookingId: string;
  callRef: string;
  cancelled: boolean;
  /** v226: a call booking's Azul cancel is held until the call ends, so its
   * confirmation waits for the hang-up to release it with the real result. */
  awaitCancel?: boolean;
  now?: Date;
}): BookingConfirmationRecord {
  const now = args.now ?? new Date();
  const byLink = args.callRef.startsWith(TEXT_LINK_CALL_REF_PREFIX);
  const awaiting = !byLink && args.awaitCancel === true;
  return {
    state: awaiting ? 'awaiting_cancel' : 'due',
    booking_id: args.bookingId,
    by: byLink ? 'link' : 'call',
    ...(byLink ? {} : { call_sid: args.callRef }),
    when: textedWhen(args.slot),
    place: [args.slot.partnerName, spokenAddress(args.slot)].filter(Boolean).join(', '),
    phone: args.slot.phone ?? '',
    replaced_day: textedDay(field(args.contact, 'appointment_date')),
    cancel: !awaiting && args.cancelled ? 'cancelled' : 'pending',
    queued_at: now.toISOString(),
    // A call's confirmation waits for the call to end; a link's goes now. One
    // waiting for its held cancel goes at the latest after
    // CALL_AWAIT_CANCEL_MAX_MS, saying our team will cancel.
    due_at: new Date(
      now.getTime() + (byLink ? 0 : awaiting ? CALL_AWAIT_CANCEL_MAX_MS : CALL_CONFIRMATION_DELAY_MS),
    ).toISOString(),
  };
}

/** What booking one opening came to (v211): the call and the text's booking
 * page both book through bookOutreachSlot, so the two cannot differ. */
export type OutreachBooking =
  | { ok: true; bookingId: string; slot: NpxSlot; azul: AzulCancelState; writes?: Promise<unknown> }
  | { ok: false; error: string };

/**
 * BOOK ONE OPENING, THE ONE WAY (v211). Book it in NPX, then the Azul
 * appointment it replaces, and settle the contact `completed` with
 * `npx_booking:<id>`. Shared by book_sooner_exam (the call) and the text's
 * booking page, so the sequence, the deadline and the demo swaps are one copy.
 *
 * THE AZUL CANCEL (v226, Wayne 2026-11-13: "Hold the cancel until hang-up").
 * On the text link it runs here and is reported to NPX, as before. On a call
 * it is HELD: nothing is cancelled now; the held record is written on the
 * contact (heldAzulCancel.ts), the confirmation text waits for it, and the
 * call's teardown runs it (endOutreachSession), or the scheduler's fallback
 * if the process died. A caller who backs out before hanging up keeps the
 * Azul appointment (cancel_sooner_booking). `slot_unavailable` is a slot NPX says was just taken,
 * already forgotten; `record_incomplete` is a record nothing can be booked
 * from. Any other error is NPX's own.
 */
export async function bookOutreachSlot(args: {
  contact: OutboundContact;
  demo: boolean;
  slot: NpxSlot;
  /** For tracing in NPX: the CallSid on a call, the link's own ref on the page. */
  callRef: string;
  /** The whole sequence answers inside this (BOOK_SEQUENCE_BUDGET_MS). */
  deadline: number;
  /** On a call: true once the caller has undone this booking. The booking's
   * own writes that are still running after the tool has answered stop
   * there, so a late settle or confirmation never lands over the undo or a
   * later booking (Codex P2 on #474). */
  superseded?: (bookingId: string) => boolean;
}): Promise<OutreachBooking> {
  const { contact, demo, slot, callRef, deadline } = args;
  const personId = field(contact, 'person_id');
  const appointmentId = field(contact, 'appointment_id');
  const dob = dobOnFile(contact);
  if (!personId || !appointmentId || !dob || !contact.firstName || !contact.lastName) {
    return { ok: false, error: 'record_incomplete' };
  }
  const npx = npxFor(demo);
  const book = await npx.book({
    slotId: slot.slotId,
    medicalGroupName: field(contact, 'medical_group'),
    minDaysSooner: MIN_DAYS_SOONER,
    patient: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      dateOfBirth: `${dob.year}-${dob.month}-${dob.day}`,
      ngePersonId: personId,
      phone: contact.phone,
    },
    replacedAppointment: { ngeAppointmentId: appointmentId, date: field(contact, 'appointment_date') },
    callRef,
  });
  if (!book.ok) {
    if (book.next === 'offer_again') {
      forgetSlot(contact, demo, slot.slotId);
      return { ok: false, error: 'slot_unavailable' };
    }
    return { ok: false, error: book.error };
  }

  const bookedSlot = book.slot ?? slot;
  const store = async () => live().store();

  if (callRef.startsWith(TEXT_LINK_CALL_REF_PREFIX)) {
    // The text link: nobody is on the phone to change their mind, so the Azul
    // appointment is cancelled now and NPX told how that went. A cancel that
    // does not land is still safe: NPX lists the booking for CEC after
    // 15 minutes with no `cancelled` report.
    const cancel = await cancelFor(demo)({
      appointmentId,
      personId,
      appointmentDate: field(contact, 'appointment_date'),
      comment: `Moved to an NPX partner practice by the Azul outreach call (NPX booking ${book.bookingId}).`,
      deadlineAt: deadline - NPX_TIMEOUT_MS.report - SETTLE_BUDGET_MS,
    });
    const report = await npx.reportCancel(book.bookingId, cancel.cancelled ? 'cancelled' : { failed: cancel.reason });
    if (!report.ok) {
      console.warn(`[NPX OUTREACH] booking ${book.bookingId}: the cancel report did not land (${report.error}); CEC's backup list will show it`);
    }
    const settle = (async () => {
      const st = await store();
      // The settle and the confirmation are independent: a settle that
      // throws must not cost the booking its confirmation (Codex P1 on #470).
      const settled = await settleBooked(st, contact.contactId, book.bookingId);
      // v222: the confirmation text, sent by the scheduler
      // (./runtime/outbound/bookingConfirmation.ts).
      await st.queueConfirmation(contact.contactId, confirmationRecordFor({
        contact, slot: bookedSlot, bookingId: book.bookingId, callRef, cancelled: cancel.cancelled,
      }));
      return settled;
    })().catch((e) => {
      console.warn(`[NPX OUTREACH] booking ${book.bookingId}: could not settle the contact —`, e instanceof Error ? e.message : e);
      return false;
    });
    if (!(await within(settle, Math.min(SETTLE_BUDGET_MS, deadline - Date.now()), false))) {
      console.warn(`[NPX OUTREACH] booking ${book.bookingId}: the contact is not settled yet; the booking stands`);
    }
    return { ok: true, bookingId: book.bookingId, slot: bookedSlot, azul: { kind: 'done', result: cancel } };
  }

  // A call (v226): hold the cancel until the call ends. The record is written
  // first, so the fallback knows of it before anything else can go wrong.
  const heldAt = new Date();
  const record: HeldAzulCancelRecord = {
    state: 'held',
    booking_id: book.bookingId,
    call_sid: callRef,
    demo,
    appointment_id: appointmentId,
    appointment_date: field(contact, 'appointment_date'),
    person_id: personId,
    held_at: heldAt.toISOString(),
    run_after: new Date(heldAt.getTime() + HELD_CANCEL_FALLBACK_MS).toISOString(),
  };
  const azul: Extract<AzulCancelState, { kind: 'held' }> = { kind: 'held', record, stored: 'unknown' };
  const settle = (async () => {
    const st = await store();
    try {
      azul.stored = (await st.queueHeldCancel(contact.contactId, record)) ? 'yes' : 'no';
    } catch (e) {
      azul.stored = 'no';
      console.warn(`[NPX OUTREACH] booking ${book.bookingId}: could not hold the Azul cancel on the contact — the hang-up runs it from the call —`, e instanceof Error ? e.message : e);
    }
    // Undone while this was still running: the undo has the contact now.
    if (args.superseded?.(book.bookingId)) return false;
    // Independent of the confirmation, as on the text link (Codex P1 on #470).
    // The confirmation needs no check of its own: an undo holds it before
    // NPX cancels the booking, and the store refuses this booking's queue
    // over that hold, as it refuses an older booking's over a newer one's.
    // v228: and the store lands it only while this booking still owns the
    // contact, so a settle that started before the undo, or before a later
    // booking, and lands after it changes nothing.
    const settled = await settleBooked(st, contact.contactId, book.bookingId, {
      bookingId: book.bookingId, heldAt: record.held_at,
    });
    await st.queueConfirmation(contact.contactId, confirmationRecordFor({
      contact, slot: bookedSlot, bookingId: book.bookingId, callRef, cancelled: false, awaitCancel: true, now: heldAt,
    }));
    return settled;
  })().catch((e) => {
    console.warn(`[NPX OUTREACH] booking ${book.bookingId}: could not settle the contact —`, e instanceof Error ? e.message : e);
    return false;
  });
  if (!(await within(settle, Math.min(HOLD_SETTLE_BUDGET_MS, deadline - Date.now()), false))) {
    console.warn(`[NPX OUTREACH] booking ${book.bookingId}: the contact is not settled yet; the booking stands`);
  }
  console.info(`[NPX OUTREACH] booking ${book.bookingId}: the Azul cancel is held until the call ends (stored: ${azul.stored})`);
  return { ok: true, bookingId: book.bookingId, slot: bookedSlot, azul, writes: settle };
}

/**
 * Settle a booked contact `completed` with its booking marker. A settle that
 * throws is logged and answers false, never thrown, so the confirmation that
 * follows it is queued whatever the settle did (Codex P1 on #470).
 */
async function settleBooked(
  st: OutboundStore,
  contactId: string,
  bookingId: string,
  holds?: { bookingId: string; heldAt: string },
): Promise<boolean> {
  try {
    const landed = await st.settleContact(contactId, 'completed', {
      notes: `npx_booking:${bookingId}`,
      exceptStatus: ['do_not_call'],
      ...(holds ? { onlyWhileBookingHolds: holds } : {}),
    });
    if (holds && !landed) {
      console.info(`[NPX OUTREACH] booking ${bookingId}: not settled — the caller undid it, or a later booking has the contact`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[NPX OUTREACH] booking ${bookingId}: could not settle the contact; the confirmation is still queued —`, e instanceof Error ? e.message : e);
    return false;
  }
}

// ── The text's booking page (v211) ──────────────────────────────────────────

/** One NPX opening as the booking page shows it: when, where, with whom. */
export function bookingOpening(slot: NpxSlot): BookingOpening {
  return {
    id: slot.slotId,
    day: localParts(slot).day,
    dayLabel: spokenSlotDay(slot),
    timeLabel: spokenSlotTime(slot),
    city: cityOf(slot),
    place: [slot.partnerName, spokenAddress(slot)].filter(Boolean).join(', '),
    provider: slot.providerName || 'a doctor',
  };
}

/**
 * THE BOOKING PAGE'S NPX HALF (v211): the same availability find_sooner_exam
 * searches and the same bookOutreachSlot book_sooner_exam books through, so
 * a text link and a call cannot offer or book differently. Demo is decided
 * the call's way, by isDemoNpxCall.
 */
export const npxBookingPageLane: BookingPageLane = {
  isDemo: (contact, campaignKey) => isDemoNpxCall(contact, campaignKey),
  currentAppointment: (contact) => currentAppointment(contact),
  async openings(contact, demo) {
    const read = await loadAvailability(contact, demo);
    if ('error' in read) return { error: read.error };
    return { openings: read.slots.map(bookingOpening) };
  },
  async book({ contact, demo, openingId, callRef, deadline }) {
    const read = await loadAvailability(contact, demo);
    if ('error' in read) return { ok: false, error: read.error };
    const slot = read.slots.find((x) => x.slotId === openingId);
    // Only an opening this person's availability holds is ever booked.
    if (!slot) return { ok: false, error: 'slot_unavailable' };
    const booked = await bookOutreachSlot({ contact, demo, slot, callRef, deadline });
    if (!booked.ok) return booked;
    const currentDay = spokenDay(field(contact, 'appointment_date'));
    return { ok: true, bookingId: booked.bookingId, confirmation: confirmation(booked.slot, spokenCancelOf(booked.azul), currentDay) };
  },
};

// ── request_staff_callback ──────────────────────────────────────────────────

/** The Hub's own reason for what they asked, by the cues the queue lanes
 * already route on; "reschedule" when their words name none. */
/** The first line of every NPX outreach staff ticket. */
export const NPX_RECALL_FIRST_LINE =
  'NPX Recall: an Azul outreach call offering a sooner appointment at an NPX partner practice.';

/**
 * Where their appointments stand, said after a staff callback is asked for.
 * A caller who booked on this call and then asked for a person must not be
 * told their old appointment "stays exactly as it is" (Codex P2, #361).
 */
export function appointmentStateLine(booking: OutreachSession['booking']): string {
  if (!booking) return 'Your current appointment stays exactly as it is.';
  switch (azulStatusOf(booking.azul)) {
    case 'cancelled':
      return 'Your new appointment stays booked, and your old one with us is cancelled.';
    case 'held':
      return 'Your new appointment stays booked, and your old one with us will be cancelled once we hang up.';
    case 'kept':
    case 'kept_unconfirmed':
      return 'Your appointment with us is kept, and our team will call you about the new one.';
    default:
      return 'Your new appointment stays booked, and our team will cancel your old one with us.';
  }
}

/** What the caller hears when they asked to change what was just booked (v222). */
export function bookingChangeStateLine(booking: NonNullable<OutreachSession['booking']>): string {
  switch (azulStatusOf(booking.azul)) {
    case 'cancelled':
      return 'Until they call, the new appointment is still booked, and your old one with us has been cancelled.';
    case 'held':
      return 'Until they call, the new appointment is still booked, and your old one with us will be cancelled once we hang up.';
    case 'kept_unconfirmed':
      return 'Until they call, the new appointment is still booked, and they will make sure your appointment with us is still on file.';
    default:
      return 'Until they call, the new appointment is still booked, and your appointment with us is still on file.';
  }
}

/** The ticket line that tells staff what to do when the caller asked to change
 * the booking made on the call (v222, v226). */
export function bookingChangeLine(contact: OutboundContact, booking: NonNullable<OutreachSession['booking']>): string {
  const day = spokenDay(field(contact, 'appointment_date'));
  const asked = `URGENT: they asked to cancel or change the NPX booking ${booking.bookingId}.`;
  const tail = 'No confirmation text was sent.';
  switch (azulStatusOf(booking.azul)) {
    case 'cancelled':
      return `${asked} Their Azul appointment on ${day} was cancelled on this call: rebook it if they want it back, and cancel or move the NPX booking in NPX. ${tail}`;
    case 'held':
      return `${asked} Their Azul appointment on ${day} will be cancelled when this call ends: rebook it if they want it back, and cancel or move the NPX booking in NPX. ${tail}`;
    case 'kept':
      return `${asked} Their Azul appointment on ${day} was kept (the call did not cancel it): do not cancel it unless they still want the move, and cancel or move the NPX booking in NPX. ${tail}`;
    case 'kept_unconfirmed':
      return `${asked} Their Azul appointment on ${day} was meant to be kept, but the call could not confirm it: check NextGen that it is still booked and rebook it if not, and cancel or move the NPX booking in NPX. ${tail}`;
    default:
      return `${asked} Their Azul appointment on ${day} is still on file: do not cancel it, and cancel or move the NPX booking in NPX. ${tail}`;
  }
}

export function staffReasonFor(request: string): number {
  const text = fold(request);
  for (const cue of SCHEDULING) {
    if (cue.cues.some((c) => text.includes(fold(c)))) return cue.reasonId;
  }
  return DEFAULT_STAFF_REASON_ID;
}

/**
 * File the HVA Hub staff ticket for this call, hold the confirmation text of
 * a booking they asked to change, and settle the contact. Shared by
 * request_staff_callback and cancel_sooner_booking's fallback, so the ticket
 * and the settle are one copy. Idempotent on the call: one ticket per call.
 */
async function fileStaffCallback(
  sid: string,
  s: OutreachSession,
  args: { request: string; changesBooking: boolean; callbackSid: string },
): Promise<{ ok: true; ticketNumber: string } | { ok: false; error: string }> {
  const { request, changesBooking, callbackSid } = args;
  // One ticket per call, except a booking change asked after another
  // request was already filed (an insurance question, then "cancel it"):
  // that change still needs its own urgent ticket and a held text, or the
  // confirmation goes out and staff never see the undo (Codex P2, #470).
  const earlierTicket = s.staffTicket;
  const changeAfterTicket = !!earlierTicket && changesBooking && !!s.booking && !s.bookingChangeAsked;
  if (earlierTicket && !changeAfterTicket) return { ok: true, ticketNumber: earlierTicket };
  const calledFrom = callbackSid ? callbackSessionFor(callbackSid)?.callerPhone ?? '' : '';
  const dob = dobOnFile(s.contact);
  const body = sanitizeForSms(
    [
      // Operator, 2026-11-13: the person working the ticket must see what it is
      // about before opening it. The ticketing app also starts the subject
      // "NPX Recall -" for this agent (ticketing-app #454).
      NPX_RECALL_FIRST_LINE,
      'The patient asked to speak with a person.',
      request ? `What they asked: ${request}` : null,
      staffAppointmentLine(s.contact),
      `Date of birth confirmed on the call: ${s.verified ? 'yes' : 'no'}.`,
      callbackSid ? 'They called us back.' : 'We called them.',
      calledFrom && calledFrom !== s.contact.phone
        ? `They called from ${calledFrom}; the number on file is ${s.contact.phone}.`
        : null,
      s.booking
        ? `A sooner exam was booked on this call (NPX booking ${s.booking.bookingId}).`
        : s.undone.length
          ? `A sooner exam was booked on this call and cancelled again before they hung up (NPX booking ${s.undone[s.undone.length - 1]}); their appointment with us was kept.`
          : 'Their appointment has not been changed.',
      changesBooking && s.booking ? bookingChangeLine(s.contact, s.booking) : null,
      changeAfterTicket ? `This adds to ${earlierTicket}, filed earlier on this call.` : null,
    ]
      .filter((l) => l !== null)
      .join('\n'),
  ).value;

  const result = await ticketFor(s)({
    departmentId: HVA_HUB_DEPARTMENT_ID,
    requestTypeId: HVA_HUB_SCHEDULING_REQUEST_TYPE_ID,
    requestReasonId: staffReasonFor(request),
    patientFirstName: s.contact.firstName?.trim() || undefined,
    patientLastName: s.contact.lastName?.trim() || undefined,
    patientPhone: s.contact.phone,
    preferredContactMethod: 'phone',
    ...(dob ? { patientBirthMonth: dob.month, patientBirthDay: dob.day, patientBirthYear: dob.year } : {}),
    description: body,
    priority: changesBooking ? 'urgent' : 'medium',
    idempotencyKey: changeAfterTicket ? `${sid}-outreach-staff-change` : `${sid}-outreach-staff`,
    callData: { agentUsed: 'npx-outreach', callSid: sid },
  });
  if (!result.success || !result.ticketNumber) {
    console.warn(`[NPX OUTREACH] staff callback ticket not filed (${result.error ?? 'no ticket number'})`);
    return { ok: false, error: result.error ?? 'no_ticket_number' };
  }
  s.staffTicket = result.ticketNumber;
  if (changesBooking && s.booking) {
    s.bookingChangeAsked = true;
    try {
      await (await live().store()).holdConfirmation(s.contact.contactId, s.booking.bookingId, 'staff_change');
    } catch (e) {
      console.warn(`[NPX OUTREACH] staff callback ${result.ticketNumber}: could not hold the confirmation text —`, e instanceof Error ? e.message : e);
    }
  }
  try {
    await (await live().store()).settleContact(s.contact.contactId, 'completed', {
      // v216: a booking on this call keeps its marker, first, so a count of
      // `agent_notes LIKE 'npx_booking:%'` still finds it. Before, the staff
      // note replaced it: 4 of 21 bookings to 2026-11-12 read as no booking.
      notes: [
        s.booking ? `npx_booking:${s.booking.bookingId}` : null,
        earlierTicket ? `staff_callback:${earlierTicket}` : null,
        `staff_callback:${result.ticketNumber}`,
      ]
        .filter(Boolean)
        .join('; '),
      exceptStatus: ['do_not_call'],
    });
  } catch (e) {
    console.warn(`[NPX OUTREACH] staff callback ${result.ticketNumber}: could not settle the contact —`, e instanceof Error ? e.message : e);
  }
  return { ok: true, ticketNumber: result.ticketNumber };
}

registerTool({
  name: STAFF_CALLBACK_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 15_000,
  description:
    'When the person asks to speak with a person, or for something this call cannot do, ask our scheduling ' +
    'team to call them back. This call cannot transfer. Say what it tells you.',
  input_schema: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'What they want, in a few words of their own.',
        askAs: 'What would you like our team to help you with?',
      },
      changes_booking: {
        type: 'boolean',
        description:
          'True when they want the sooner exam booked on this call cancelled or moved, or their old appointment with us back. ' +
          'False or left out for anything else, such as an insurance question or wanting the details by text.',
      },
    },
    required: ['request'],
  },
  handler: async (input): Promise<ToolResult> => {
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { sid, s } = found;
    const already = (ticket: string): ToolResult => ({
      success: true,
      ticket_number: ticket,
      say: s.bookingChangeAsked && s.booking
        ? `I've asked our scheduling team to call you back to change that. ${bookingChangeStateLine(s.booking)}`
        : `I've asked our scheduling team to call you back. ${appointmentStateLine(s.booking)}`,
      fix: 'Say that, ask if there is anything else, then say goodbye and call end_call. The outcome is already recorded.',
    });
    const request = String(input.request ?? '').trim();
    // v222: a caller who asks to undo or move what was just booked gets an
    // urgent ticket saying exactly what staff must do, and no confirmation
    // text for a booking they asked to change.
    const changesBooking = !!s.booking && input.changes_booking === true;
    // One ticket per call, except a booking change asked after another
    // request was already filed: fileStaffCallback files that one beside the
    // first (Codex P2, #470).
    if (s.staffTicket && !(changesBooking && !s.bookingChangeAsked)) return already(s.staffTicket);
    // v226: and, before the call ends, their Azul appointment is kept: the
    // held cancel is dropped, so staff are not asked to rebook what the
    // caller wanted back.
    if (changesBooking && s.booking?.azul.kind === 'held') {
      const kept = await keepAzulAppointment(s, 'staff_change');
      // The NPX booking stays for staff: NPX's backup list must ask CEC to
      // cancel it, not the Azul appointment the caller kept.
      if (kept === 'dropped' || kept === 'store_down') await reportAzulKept(s.demo, s.booking.bookingId);
    }
    const callbackSid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : '';
    const filed = await fileStaffCallback(sid, s, { request, changesBooking, callbackSid });
    if (!filed.ok) {
      const r: Refusal = {
        success: false,
        error: 'ticket_not_filed',
        fix:
          'The request could not be sent to the team just now. Do not say anyone will call. Say: "I wasn\'t able to ' +
          `send that to our team just now. ${appointmentStateLine(s.booking)}" Then ` +
          (s.booking
            ? 'say goodbye and call end_call. The booking is already recorded.'
            : 'call record_call_outcome with call_back_later, say goodbye and call end_call.'),
      };
      return r;
    }
    return already(filed.ticketNumber);
  },
});

// ── cancel_sooner_booking (v226) ────────────────────────────────────────────

/** The undo's whole sequence answers inside this, under its tool timeout,
 * which sits under the bridge's tool-dispatch watchdog (45 s). */
export const UNDO_SEQUENCE_BUDGET_MS = 30_000;
export const UNDO_TOOL_TIMEOUT_MS = 36_000;
/** One store step of the undo or the hang-up: never longer than this. */
const STORE_STEP_MS = 3_000;

/**
 * KEEP THE AZUL APPOINTMENT (v226). The caller changed their mind before
 * hanging up: the held cancel is dropped in the store, in one statement, so
 * neither the hang-up nor the fallback can run it. Returns what the store
 * said: `dropped` (provable), `not_dropped` (the cancel had already been
 * started, or another booking's is held there) or `store_down`. NPX is told
 * the patient kept their Azul appointment, so its backup list asks CEC to
 * cancel the NPX booking and not the Azul one, unless the call cancels the
 * NPX booking itself.
 */
async function keepAzulAppointment(s: OutreachSession, reason: string): Promise<'dropped' | 'not_dropped' | 'store_down' | 'not_held'> {
  const b = s.booking;
  if (!b || b.azul.kind !== 'held') return 'not_held';
  const record = b.azul.record;
  const said = await within(
    (async () => {
      const st = await live().store();
      return (await st.dropHeldCancel(s.contact.contactId, record, reason, new Date())) ? ('dropped' as const) : ('not_dropped' as const);
    })().catch(() => 'store_down' as const),
    STORE_STEP_MS,
    'store_down' as const,
  );
  b.azul = { kind: 'dropped', record, kept: said === 'dropped' ? 'yes' : 'unconfirmed', storeDropPending: said === 'store_down' };
  console.info(`[NPX OUTREACH] booking ${b.bookingId}: the caller kept their Azul appointment (${reason}); the held cancel is ${said}`);
  return said;
}

/** NPX is told the patient kept their Azul appointment, so the backup list
 * says to cancel the NPX booking, not the Azul one. Never throws. */
async function reportAzulKept(demo: boolean, bookingId: string): Promise<void> {
  const report = await within(
    npxFor(demo).reportCancel(bookingId, { failed: NPX_CALLER_KEPT_AZUL_REASON }).catch(() => ({ ok: false as const, error: 'threw' })),
    NPX_TIMEOUT_MS.report,
    { ok: false as const, error: 'timeout' },
  );
  if (!report.ok) {
    console.warn(`[NPX OUTREACH] booking ${bookingId}: could not tell NPX the patient kept their Azul appointment (${'error' in report ? String(report.error) : 'failed'})`);
  }
}

registerTool({
  name: CANCEL_BOOKING_TOOL_NAME,
  layer: 'agent',
  timeoutMs: UNDO_TOOL_TIMEOUT_MS,
  description:
    'When the person changes their mind before hanging up about the sooner exam booked on this call and wants to keep ' +
    'their appointment with us, cancel the new booking. Their appointment with us is then kept. Call it only after they ' +
    'have said that is what they want. Say what it tells you.',
  input_schema: { type: 'object', properties: {}, required: [] },
  handler: async (input): Promise<ToolResult> => {
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { sid, s } = found;
    if (s.bookingInFlight) await within(s.bookingInFlight.then(() => undefined, () => undefined), BOOK_TOOL_TIMEOUT_MS, undefined);
    if (s.undoInFlight) return s.undoInFlight;
    const currentDay = spokenDay(field(s.contact, 'appointment_date'));
    if (!s.booking) {
      if (s.undone.length) {
        return {
          success: true,
          booking_undone: true,
          say: `The new booking is cancelled. Your appointment with us on ${currentDay} stays as it is.`,
          fix: 'Say that and ask if there is anything else. The outcome is already recorded.',
        };
      }
      const r: Refusal = {
        success: false,
        error: 'nothing_booked',
        fix: 'Nothing was booked on this call, so there is nothing to cancel. Tell them their appointment with us stays as it is.',
      };
      return r;
    }
    const callbackSid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : '';
    const run = undoBooking(sid, s, currentDay, callbackSid).finally(() => {
      s.undoInFlight = null;
    });
    s.undoInFlight = run;
    return run;
  },
});

/**
 * UNDO THE BOOKING (v226). The order is the safety property: the NPX
 * booking is cancelled only once the store says the held Azul cancel is
 * dropped, so a patient can never be left with neither appointment. When the
 * store cannot say so, or NPX will not cancel, the booking is left for staff
 * on an urgent ticket and the Azul appointment is still kept.
 */
/**
 * AN UNDONE BOOKING ON THE RECORD: its confirmation skipped (it is already
 * held, so this only names why) and the contact settled declined with
 * `npx_booking_undone:<id>`. True when both landed inside the store step.
 * Run on the call, and again at hang-up for one that did not land, unless a
 * later booking on the call has taken the contact over (Codex P1 on #474).
 */
async function recordUndone(s: OutreachSession, bookingId: string): Promise<boolean> {
  return within(
    (async () => {
      const st = await live().store();
      await st.skipConfirmation(s.contact.contactId, bookingId, 'booking_undone');
      await st.settleContact(s.contact.contactId, 'declined', {
        notes: `npx_booking_undone:${bookingId}`,
        exceptStatus: ['do_not_call'],
      });
      return true;
    })().catch((e) => {
      console.warn(`[NPX OUTREACH] booking ${bookingId}: undone, but the contact could not be settled —`, e instanceof Error ? e.message : e);
      return false;
    }),
    STORE_STEP_MS,
    false,
  );
}

async function undoBooking(sid: string, s: OutreachSession, currentDay: string, callbackSid: string): Promise<ToolResult> {
  const deadline = Date.now() + UNDO_SEQUENCE_BUDGET_MS;
  const b = s.booking!;
  const bookingId = b.bookingId;
  // The booking's own writes first, so the undo's land after them (Codex P2
  // on #474). Past the step they stop themselves once the undo is recorded.
  if (b.writes) await within(b.writes.then(() => undefined, () => undefined), STORE_STEP_MS, undefined);
  const kept = b.azul.kind === 'held' ? await keepAzulAppointment(s, 'booking_undone') : b.azul.kind === 'dropped' && b.azul.kept === 'yes' ? 'dropped' : 'not_dropped';

  let npxCancel: string = 'not_tried';
  // The confirmation is held BEFORE NPX is asked to cancel (Codex P2 on #474):
  // a held confirmation is never sent, so once the booking is gone nothing can
  // text the caller about it, whatever happens to the skip below. A hold that
  // cannot be written means the booking is not cancelled here; staff do it.
  const held =
    kept === 'dropped'
      ? await within(
          live()
            .store()
            .then((st) => st.holdConfirmation(s.contact.contactId, bookingId, 'booking_undo'))
            .then(() => true)
            .catch((e) => {
              console.warn(`[NPX OUTREACH] booking ${bookingId}: the confirmation could not be held before the undo —`, e instanceof Error ? e.message : e);
              return false;
            }),
          STORE_STEP_MS,
          false,
        )
      : false;
  if (kept === 'dropped' && !held) {
    npxCancel = 'confirmation_not_held';
    await reportAzulKept(s.demo, bookingId);
  } else if (kept === 'dropped') {
    const cancelled = await within(
      npxFor(s.demo).cancelBooking(bookingId, { callRef: sid, reason: NPX_UNDO_REASON }).catch(() => ({ ok: false as const, error: 'unavailable' as const })),
      Math.min(NPX_TIMEOUT_MS.cancel + 1_000, deadline - Date.now()),
      { ok: false as const, error: 'timeout' as const },
    );
    if (cancelled.ok) {
      npxCancel = cancelled.outcome;
      // Marked undone before anything is written, so the booking's late
      // writes stop rather than land over the undo.
      s.undone.push(bookingId);
      if (!(await recordUndone(s, bookingId))) {
        (s.undoCleanupPending ??= []).push(bookingId);
      }
      s.booking = null;
      s.offers = [];
      console.info(`[NPX OUTREACH] booking ${bookingId}: undone on the call (${cancelled.outcome}); the Azul appointment is kept`);
      return {
        success: true,
        booking_undone: true,
        npx_cancel: cancelled.outcome,
        azul_kept: true,
        say: `I've cancelled the new booking. Your appointment with us on ${currentDay} stays as it is.`,
        fix:
          'Say that and ask if there is anything else. If they want a different time instead, call find_sooner_exam and book again; ' +
          'otherwise say goodbye and call end_call. The outcome is already recorded.',
      };
    }
    npxCancel = cancelled.error;
    // The Azul appointment is kept; NPX is told so, and staff cancel the NPX booking.
    await reportAzulKept(s.demo, bookingId);
  } else if (kept === 'store_down') {
    await reportAzulKept(s.demo, bookingId);
  }

  console.warn(`[NPX OUTREACH] booking ${bookingId}: could not be undone on the call (held cancel ${kept}, NPX ${npxCancel}); asking staff`);
  const filed = await within(
    fileStaffCallback(sid, s, { request: 'Cancel the sooner exam booked on this call and keep my appointment with Azul.', changesBooking: true, callbackSid }),
    Math.max(0, deadline - Date.now()),
    { ok: false as const, error: 'timeout' },
  );
  const keptLine =
    s.booking && azulStatusOf(s.booking.azul) === 'kept'
      ? `Your appointment with us on ${currentDay} is kept.`
      : `They'll make sure your appointment with us on ${currentDay} is still booked.`;
  if (!filed.ok) {
    return {
      success: false,
      error: 'not_undone',
      npx_cancel: npxCancel,
      fix:
        'The new booking could not be cancelled and the team could not be reached just now. Do not say anyone will call. Say: ' +
        `"I wasn't able to cancel the new booking myself just now. ${keptLine}" Then say goodbye and call end_call.`,
    } as Refusal;
  }
  return {
    success: true,
    booking_undone: false,
    npx_cancel: npxCancel,
    azul_kept: kept === 'dropped',
    ticket_number: filed.ticketNumber,
    say: `I wasn't able to cancel the new booking myself, so I've asked our scheduling team to call you back. ${keptLine}`,
    fix: 'Say that, ask if there is anything else, then say goodbye and call end_call. The outcome is already recorded.',
  };
}

// ── The call ends: run the held Azul cancel (v226) ─────────────────────────

/**
 * RUN ONE HELD AZUL CANCEL: the cancel, the report to NPX, the record, then
 * the confirmation text released with what it came to. Used by the hang-up
 * and by the scheduler's fallback. Never throws.
 */
export async function runHeldAzulCancel(
  contactId: string,
  record: HeldAzulCancelRecord,
  by: 'hang_up' | 'fallback',
): Promise<AzulCancelResult> {
  const deadline = Date.now() + HELD_CANCEL_BUDGET_MS;
  let cancel: AzulCancelResult;
  try {
    cancel = await cancelFor(record.demo)({
      appointmentId: record.appointment_id,
      personId: record.person_id,
      appointmentDate: record.appointment_date,
      comment: `Moved to an NPX partner practice by the Azul outreach call (NPX booking ${record.booking_id}).`,
      deadlineAt: deadline - NPX_TIMEOUT_MS.report - STORE_STEP_MS,
    });
  } catch (e) {
    console.warn(`[NPX OUTREACH] booking ${record.booking_id}: the held Azul cancel threw —`, e instanceof Error ? e.message : e);
    cancel = { cancelled: false, reason: 'nextgen_cancel_failed' };
  }
  const report = await npxFor(record.demo)
    .reportCancel(record.booking_id, cancel.cancelled ? 'cancelled' : { failed: cancel.reason })
    .catch(() => ({ ok: false as const, error: 'threw' }));
  if (!report.ok) {
    console.warn(`[NPX OUTREACH] booking ${record.booking_id}: the cancel report did not land; CEC's backup list will show it`);
  }
  await within(
    (async () => {
      const st = await live().store();
      await st.patchHeldCancel(contactId, record.booking_id, {
        state: cancel.cancelled ? 'cancelled' : 'not_cancelled',
        done_at: new Date().toISOString(),
        by,
        ...(cancel.cancelled ? {} : { reason: cancel.reason }),
      });
      await st.releaseConfirmation(contactId, record.booking_id, cancel.cancelled ? 'cancelled' : 'pending', new Date());
    })().catch((e) => {
      console.warn(`[NPX OUTREACH] booking ${record.booking_id}: could not record the held Azul cancel —`, e instanceof Error ? e.message : e);
    }),
    STORE_STEP_MS * 2,
    undefined,
  );
  console.info(
    `[NPX OUTREACH] booking ${record.booking_id}: held Azul cancel run at ${by === 'hang_up' ? 'hang-up' : 'the fallback'} — ` +
      (cancel.cancelled ? 'cancelled' : `not cancelled (${cancel.reason})`),
  );
  return cancel;
}

/**
 * THE CALL HAS ENDED (v226). Called from the runtime's teardown for every
 * call: drops the session, and on an outreach call whose booking holds its
 * Azul cancel, runs it now. One claim in the store decides who runs it, so
 * the fallback never runs it twice; when the held record never reached the
 * store, the call's own copy is run. A booking the caller undid retries the
 * drop if the store was down. Never throws.
 */
export async function endOutreachSession(callSid: string): Promise<void> {
  const s = sessions.get(callSid);
  sessions.delete(callSid);
  if (!s) return;
  try {
    if (s.bookingInFlight) await within(s.bookingInFlight.then(() => undefined, () => undefined), BOOK_TOOL_TIMEOUT_MS, undefined);
    if (s.undoInFlight) await within(s.undoInFlight.then(() => undefined, () => undefined), UNDO_TOOL_TIMEOUT_MS, undefined);
    // An undo whose record did not land on the call is written now (Codex P1
    // on #474). After a later booking on the call there is nothing to write:
    // the undone booking's confirmation was held before NPX cancelled it, the
    // later booking's queue has replaced it, and its settle is the contact's.
    // A skip for the undone booking then would overwrite the later booking's
    // confirmation with a placeholder.
    for (const undoneId of s.undoCleanupPending ?? []) {
      if (s.booking) {
        console.info(`[NPX OUTREACH] booking ${undoneId}: undone, then a later booking on the call settled the contact; nothing to record at hang-up`);
        continue;
      }
      const landed = await recordUndone(s, undoneId);
      console.info(`[NPX OUTREACH] booking ${undoneId}: the undo ${landed ? 'is now recorded' : 'could still not be recorded'} at hang-up`);
    }
    const b = s.booking;
    if (!b) return;
    const st = await live().store();
    if (b.azul.kind === 'dropped') {
      if (b.azul.storeDropPending) {
        const again = await within(st.dropHeldCancel(s.contact.contactId, b.azul.record, 'booking_undone', new Date()).catch(() => false), STORE_STEP_MS, false);
        console.info(`[NPX OUTREACH] booking ${b.bookingId}: the dropped Azul cancel ${again ? 'is now recorded' : 'could still not be recorded'} at hang-up`);
      }
      return;
    }
    if (b.azul.kind !== 'held') return;
    const held = b.azul;
    const now = new Date();
    // A claim the store could not answer (down, or slower than a step) runs
    // the call's own copy: a second run is safe, because the cancel reads the
    // appointment back first. Only a store that answered "not yours" stops it.
    const claim = await within(
      st
        .claimHeldCancel(s.contact.contactId, held.record.booking_id, now, new Date(now.getTime() - HELD_CANCEL_STALE_MS))
        .then((row) => ({ row }), () => 'unanswered' as const),
      STORE_STEP_MS,
      'unanswered' as const,
    );
    if (claim !== 'unanswered' && !claim.row && held.stored === 'yes') {
      // The store holds it and someone else has it, or it was dropped.
      console.info(`[NPX OUTREACH] booking ${b.bookingId}: the held Azul cancel is not ours to run at hang-up`);
      return;
    }
    const record = (claim !== 'unanswered' && claim.row ? heldCancelOf(claim.row.customData) : null) ?? held.record;
    await runHeldAzulCancel(s.contact.contactId, record, 'hang_up');
  } catch (e) {
    console.warn(`[NPX OUTREACH] ${callSid}: the end-of-call step failed —`, e instanceof Error ? e.message : e);
  }
}

/** The NPX lane's after-calls step (v226): the held Azul cancels a call's
 * teardown did not run, once the call is over. The scheduler calls it each
 * tick (OutboundLanePolicy.afterCalls). */
export async function npxOutreachAfterCalls(ctx: AfterCallsContext, campaignKey: string): Promise<Record<string, number>> {
  const r = await runHeldCancelTick(ctx.slug, { campaignKey }, { store: ctx.store, run: runHeldAzulCancel, now: ctx.now, log: ctx.log });
  return { held_cancels_run: r.ran, ...r.held };
}
