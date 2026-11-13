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
 *   book_sooner_exam           books the one they chose in NPX, cancels the
 *                              Azul appointment it replaces, reports the
 *                              cancel to NPX, and says only what happened.
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
  NPX_TIMEOUT_MS,
  type NpxOutreachClient,
  type NpxReadOptions,
  type NpxSlot,
} from '../services/npxOutreachClient';
import { cancelAzulAppointment, type AzulCancelRequest, type AzulCancelResult } from '../services/outreachAzulCancel';
import { fold, SCHEDULING } from './queueRouting';
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
  localParts,
  minutesOf,
  slotDateTime,
  type Relaxed,
} from './npxAvailabilitySearch';
import { sanitizeForSms } from '../services/gsm7';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';
import type { BookingOpening, BookingPageLane } from '../runtime/outbound/bookingPage';

export const DESCRIBE_TOOL_NAME = 'describe_upcoming_appointment';
export const CONFIRM_DOB_TOOL_NAME = 'confirm_patient_birthdate';
export const FIND_SOONER_TOOL_NAME = 'find_sooner_exam';
export const BOOK_SOONER_TOOL_NAME = 'book_sooner_exam';
export const STAFF_CALLBACK_TOOL_NAME = 'request_staff_callback';
export const NPX_OUTREACH_TOOLS = [
  DESCRIBE_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  BOOK_SOONER_TOOL_NAME,
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
  booking: { bookingId: string; slot: NpxSlot; cancel: AzulCancelResult } | null;
  /** A book_sooner_exam still running: a second call waits for it rather
   * than booking twice. */
  bookingInFlight: Promise<ToolResult> | null;
  /** The HVA Hub ticket filed when they asked for a person. */
  staffTicket: string | null;
  openedAtMs: number;
}

const sessions = new Map<string, OutreachSession>();
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** Tests and teardown only. */
export function outreachSessionFor(callSid: string): OutreachSession | undefined {
  return sessions.get(callSid);
}
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
 */
export function staffAppointment(c: OutboundContact): string {
  const event = field(c, 'event_name').trim() || 'An appointment';
  const clock = spokenClock(field(c, 'begin_time'));
  const office = field(c, 'office');
  return `${event} on ${spokenDay(field(c, 'appointment_date'))}${clock ? ` at ${clock}` : ''}${office ? ` at our ${office} office` : ''}`;
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

/** `p`, or `fallback` once `ms` has passed — never later. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

export function confirmation(slot: NpxSlot, cancel: AzulCancelResult, currentDay: string): string {
  const booked = `You're booked for ${spokenSlot(slot)}. Their phone number is ${slot.phone}.`;
  return cancel.cancelled
    ? `${booked} I've also cancelled your appointment with us on ${currentDay}, so there's nothing else you need to do.`
    : `${booked} Our team will cancel your appointment with us on ${currentDay}; you don't need to do anything.`;
}

registerTool({
  name: BOOK_SOONER_TOOL_NAME,
  layer: 'agent',
  timeoutMs: BOOK_TOOL_TIMEOUT_MS,
  description:
    'Book the sooner exam the person chose and confirmed: pass the date and time of the choice you said back to them, ' +
    'as find_sooner_exam gave it, and its city. Only a choice read to them on this call can be booked. ' +
    'This also cancels their current appointment with us, so call it only after they have said yes to that.',
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
      return { success: true, booked: true, say: confirmation(s.booking.slot, s.booking.cancel, currentDay) };
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
  const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date.trim()) ? input.date.trim() : '';
  const minutes = typeof input.time === 'string' ? minutesOf(input.time) : null;

  if (date && minutes !== null) {
    let atThatTime = offered.filter((x) => {
      const p = localParts(x);
      return p.day === date && p.minutes === minutes;
    });
    if (atThatTime.length === 0) {
      return {
        refusal: {
          success: false,
          error: 'not_offered',
          fix:
            'Nothing was booked: no choice read to them on this call is at that date and time. Book only a choice you read to them and they confirmed, ' +
            "passing that choice's date and time from find_sooner_exam's answer. If they want a time you have not read them, call find_sooner_exam for that day first.",
        },
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
        refusal: {
          success: false,
          error: 'no_such_option',
          fix: 'That option was not offered. Call find_sooner_exam with what they want, offer its choices, and book only one they chose.',
        },
      };
    }
    return {
      refusal: {
        success: false,
        error: 'which_list',
        fix:
          'Nothing was booked: more than one list of choices was read on this call, so an option number is not one time. ' +
          "Call book_sooner_exam again with the date and time of the choice you said back to them, from find_sooner_exam's answer.",
      },
    };
  }

  return {
    refusal: {
      success: false,
      error: 'no_choice',
      fix: "Nothing was booked. Call book_sooner_exam with the date and time of the choice they confirmed, from find_sooner_exam's answer.",
    },
  };
}

async function bookChosen(
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
  const booked = await bookOutreachSlot({ contact: s.contact, demo: s.demo, slot, callRef: sid, deadline });
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
  s.booking = { bookingId: booked.bookingId, slot: booked.slot, cancel: booked.cancel };
  return {
    success: true,
    booked: true,
    booked_by: chosen.by,
    ...(chosen.optionDisagreed ? { option_disagreed: true } : {}),
    say: confirmation(s.booking.slot, booked.cancel, currentDay),
    fix: 'Say the confirmation as given, ask if there is anything else, then say goodbye and call end_call. The outcome is already recorded.',
  };
}

/** What booking one opening came to (v211): the call and the text's booking
 * page both book through bookOutreachSlot, so the two cannot differ. */
export type OutreachBooking =
  | { ok: true; bookingId: string; slot: NpxSlot; cancel: AzulCancelResult }
  | { ok: false; error: string };

/**
 * BOOK ONE OPENING, THE ONE WAY (v211). Book it in NPX, cancel the Azul
 * appointment it replaces, report the cancel to NPX, and settle the contact
 * `completed` with `npx_booking:<id>`. Shared by book_sooner_exam (the call)
 * and the text's booking page, so the sequence, the deadline and the demo
 * swaps are one copy. `slot_unavailable` is a slot NPX says was just taken,
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

  // Booked. Now the Azul appointment, then tell NPX how that went. A cancel
  // that does not land is still safe: NPX lists the booking for CEC after
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
    await (await live().store()).settleContact(contact.contactId, 'completed', {
      notes: `npx_booking:${book.bookingId}`,
      exceptStatus: ['do_not_call'],
    });
    return true;
  })().catch((e) => {
    console.warn(`[NPX OUTREACH] booking ${book.bookingId}: could not settle the contact —`, e instanceof Error ? e.message : e);
    return false;
  });
  if (!(await within(settle, Math.min(SETTLE_BUDGET_MS, deadline - Date.now()), false))) {
    console.warn(`[NPX OUTREACH] booking ${book.bookingId}: the contact is not settled yet; the booking stands`);
  }
  return { ok: true, bookingId: book.bookingId, slot: book.slot ?? slot, cancel };
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
    return { ok: true, bookingId: booked.bookingId, confirmation: confirmation(booked.slot, booked.cancel, currentDay) };
  },
};

// ── request_staff_callback ──────────────────────────────────────────────────

/** The Hub's own reason for what they asked, by the cues the queue lanes
 * already route on; "reschedule" when their words name none. */
/**
 * Where their appointments stand, said after a staff callback is asked for.
 * A caller who booked on this call and then asked for a person must not be
 * told their old appointment "stays exactly as it is" (Codex P2, #361).
 */
export function appointmentStateLine(booking: OutreachSession['booking']): string {
  if (!booking) return 'Your current appointment stays exactly as it is.';
  return booking.cancel.cancelled
    ? 'Your new appointment stays booked, and your old one with us is cancelled.'
    : 'Your new appointment stays booked, and our team will cancel your old one with us.';
}

export function staffReasonFor(request: string): number {
  const text = fold(request);
  for (const cue of SCHEDULING) {
    if (cue.cues.some((c) => text.includes(fold(c)))) return cue.reasonId;
  }
  return DEFAULT_STAFF_REASON_ID;
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
      say: `I've asked our scheduling team to call you back. ${appointmentStateLine(s.booking)}`,
      fix: 'Say that, ask if there is anything else, then say goodbye and call end_call. The outcome is already recorded.',
    });
    if (s.staffTicket) return already(s.staffTicket);

    const request = String(input.request ?? '').trim();
    const callbackSid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : '';
    const calledFrom = callbackSid ? callbackSessionFor(callbackSid)?.callerPhone ?? '' : '';
    const dob = dobOnFile(s.contact);
    const body = sanitizeForSms(
      [
        'Azul outreach call: an offer of a sooner appointment at an NPX partner practice.',
        'The patient asked to speak with a person.',
        request ? `What they asked: ${request}` : null,
        `Their appointment: ${staffAppointment(s.contact)}.`,
        `Date of birth confirmed on the call: ${s.verified ? 'yes' : 'no'}.`,
        callbackSid ? 'They called us back.' : 'We called them.',
        calledFrom && calledFrom !== s.contact.phone
          ? `They called from ${calledFrom}; the number on file is ${s.contact.phone}.`
          : null,
        s.booking
          ? `A sooner exam was booked on this call (NPX booking ${s.booking.bookingId}).`
          : 'Their appointment has not been changed.',
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
      priority: 'medium',
      idempotencyKey: `${sid}-outreach-staff`,
      callData: { agentUsed: 'npx-outreach', callSid: sid },
    });
    if (!result.success || !result.ticketNumber) {
      console.warn(`[NPX OUTREACH] staff callback ticket not filed (${result.error ?? 'no ticket number'})`);
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
    s.staffTicket = result.ticketNumber;
    try {
      await (await live().store()).settleContact(s.contact.contactId, 'completed', {
        // v216: a booking on this call keeps its marker, first, so a count of
        // `agent_notes LIKE 'npx_booking:%'` still finds it. Before, the staff
        // note replaced it: 4 of 21 bookings to 2026-11-12 read as no booking.
        notes: s.booking
          ? `npx_booking:${s.booking.bookingId}; staff_callback:${result.ticketNumber}`
          : `staff_callback:${result.ticketNumber}`,
        exceptStatus: ['do_not_call'],
      });
    } catch (e) {
      console.warn(`[NPX OUTREACH] staff callback ${result.ticketNumber}: could not settle the contact —`, e instanceof Error ? e.message : e);
    }
    return already(result.ticketNumber);
  },
});
