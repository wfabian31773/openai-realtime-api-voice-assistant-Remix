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
 *   find_sooner_exam           asks NPX for up to two sooner routine exams at
 *                              a partner that takes the patient's medical
 *                              group, in reach of them.
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
  type NpxSlot,
} from '../services/npxOutreachClient';
import { cancelAzulAppointment, type AzulCancelRequest, type AzulCancelResult } from '../services/outreachAzulCancel';
import { fold, SCHEDULING } from './queueRouting';
import { sanitizeForSms } from '../services/gsm7';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';

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
/** How many times NPX is asked for slots on one call (a taken slot asks again). */
export const MAX_OFFERS = 3;
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
function npxFor(s: OutreachSession): NpxOutreachClient {
  return s.demo ? live().npxDemo : live().npx;
}
function cancelFor(s: OutreachSession): Deps['cancel'] {
  return s.demo ? simulatedDemoCancel : live().cancel;
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
  offers: number;
  slots: NpxSlot[];
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
  const demo =
    npxOutreachMode() === 'demo' ||
    input.outbound_campaign === NPX_OUTREACH_DEMO_CAMPAIGN_KEY ||
    contact.data.source === NPX_OUTREACH_DEMO_SOURCE;
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
        offers: 0,
        slots: [],
        booking: null,
        bookingInFlight: null,
        staffTicket: null,
        openedAtMs: now,
      },
      now,
    ),
  };
}

// ── What the record says, in words ──────────────────────────────────────────

const field = (c: OutboundContact, k: string): string => (typeof c.data[k] === 'string' ? (c.data[k] as string) : '');

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

/** An offered slot as one sentence, in the clinic's own time zone. */
export function spokenSlot(slot: NpxSlot): string {
  const when = new Date(slot.startAt).toLocaleString('en-US', {
    timeZone: slot.timezone || 'America/Los_Angeles',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${when}, at ${slot.partnerName}, ${slot.address}`;
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
function currentAppointment(c: OutboundContact): string {
  const clock = spokenClock(field(c, 'begin_time'));
  const office = field(c, 'office');
  return `${briefAppointment(c)}${clock ? ` at ${clock}` : ''}${office ? ` at our ${office} office` : ''}`;
}

const DOB_ASK = 'Can I please have your date of birth, starting with the month, then the day, then the year?';

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
    if (s.verified) {
      return {
        success: true,
        appointment,
        verified: true,
        next: 'Their identity is already confirmed. Call find_sooner_exam and read the options it gives you.',
      };
    }
    return {
      success: true,
      appointment,
      say:
        `Our records show you have ${appointment}. The reason for this call is that we'd like to offer you ` +
        'a sooner appointment. Does that interest you?',
      next:
        `If they say yes, say: "In order to continue, let me confirm your identity. ${DOB_ASK}" and call ` +
        `${CONFIRM_DOB_TOOL_NAME} with what they say. If they would rather keep their appointment, thank them, call ` +
        'record_call_outcome with not_interested, say goodbye and call end_call. Say nothing else about the ' +
        'appointment — not the time, the office or the doctor — until the date of birth matches.',
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
    ? `Their identity is confirmed. Call ${FIND_SOONER_TOOL_NAME} now and read the options it gives you.`
    : `Tell them our records show they have ${currentAppointment(s.contact)}, and that we'd like to offer them a ` +
        `sooner appointment at a partner practice that takes their medical group. Ask if that interests them; if yes, ` +
        `call ${FIND_SOONER_TOOL_NAME}.`;
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

registerTool({
  name: FIND_SOONER_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 10_000,
  description:
    'Find up to two sooner routine eye exams at a partner practice that takes this patient\'s medical group. ' +
    'Call it only after confirm_patient_birthdate answered verified and the person wants to hear the options.',
  input_schema: { type: 'object', properties: {}, required: [] },
  handler: async (input): Promise<ToolResult> => {
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { s } = found;
    if (!s.verified) return notVerified();
    if (s.booking) {
      return { success: true, already_booked: true, fix: 'The exam is already booked on this call. Do not look again; confirm the booking with them.' };
    }
    if (s.offers >= MAX_OFFERS) {
      const r: Refusal = {
        success: false,
        error: 'offer_limit',
        fix: 'Stop looking. Tell them their current appointment stays as it is, thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
      return r;
    }
    s.offers += 1;
    const medicalGroup = field(s.contact, 'medical_group');
    const partners = Array.isArray(s.contact.data.partners) ? (s.contact.data.partners as unknown[]).map(String) : [];
    const replaced = field(s.contact, 'appointment_date');
    if (!medicalGroup || partners.length === 0 || !replaced) {
      const r: Refusal = {
        success: false,
        error: 'record_incomplete',
        fix: 'There is nothing to offer from this record. Tell them their current appointment stays as it is, thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
      return r;
    }
    const offer = await npxFor(s).offer({
      medicalGroupName: medicalGroup,
      partnerNames: partners,
      replacedAppointmentDate: replaced,
      minDaysSooner: MIN_DAYS_SOONER,
    });
    if (!offer.ok) {
      const r: Refusal = {
        success: false,
        error: offer.error,
        fix: 'The partner schedule could not be read just now. Do not say anything failed. Tell them their current appointment stays as it is and we may reach out another time, call record_call_outcome with call_back_later, say goodbye and call end_call.',
      };
      return r;
    }
    s.slots = offer.slots;
    if (offer.slots.length === 0) {
      return {
        success: true,
        options: [],
        fix: 'Nothing sooner is open right now. Tell them their current appointment stays as it is, thank them, call record_call_outcome with done, say goodbye and call end_call.',
      };
    }
    return {
      success: true,
      options: offer.slots.map((slot, i) => ({ option: i + 1, when_and_where: spokenSlot(slot), provider: slot.providerName })),
      next:
        'Read the options in order, one at a time, then ask which they would like, or whether they would rather keep their current appointment. ' +
        'On a choice, say it back in full and ask them to confirm before calling book_sooner_exam with that option number. ' +
        'Booking it cancels their current appointment with us; say so before they confirm.',
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

function confirmation(slot: NpxSlot, cancel: AzulCancelResult, currentDay: string): string {
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
    'Book the sooner exam the person chose and confirmed, by its option number from find_sooner_exam. ' +
    'This also cancels their current appointment with us, so call it only after they have said yes to that.',
  input_schema: {
    type: 'object',
    properties: {
      option: {
        type: 'string',
        enum: ['1', '2'],
        description: 'The option number they chose.',
        askAs: 'Which option would you like?',
      },
    },
    required: ['option'],
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

async function bookChosen(
  input: Record<string, unknown>,
  sid: string,
  s: OutreachSession,
  currentDay: string,
  deadline: number,
): Promise<ToolResult> {
  const index = Number(input.option) - 1;
  const slot = s.slots[index];
  if (!slot) {
    const r: Refusal = {
      success: false,
      error: 'no_such_option',
      fix: 'That option was not offered. Call find_sooner_exam first, read the options, and book only one they chose.',
    };
    return r;
  }
  const personId = field(s.contact, 'person_id');
  const appointmentId = field(s.contact, 'appointment_id');
  const dob = dobOnFile(s.contact);
  if (!personId || !appointmentId || !dob || !s.contact.firstName || !s.contact.lastName) {
    const r: Refusal = {
      success: false,
      error: 'record_incomplete',
      fix: 'This record cannot be booked over the phone. Tell them their current appointment stays as it is, call record_call_outcome with done, say goodbye and call end_call.',
    };
    return r;
  }
  const book = await npxFor(s).book({
    slotId: slot.slotId,
    medicalGroupName: field(s.contact, 'medical_group'),
    minDaysSooner: MIN_DAYS_SOONER,
    patient: {
      firstName: s.contact.firstName,
      lastName: s.contact.lastName,
      dateOfBirth: `${dob.year}-${dob.month}-${dob.day}`,
      ngePersonId: personId,
      phone: s.contact.phone,
    },
    replacedAppointment: { ngeAppointmentId: appointmentId, date: field(s.contact, 'appointment_date') },
    callRef: sid,
  });
  if (!book.ok) {
    if (book.next === 'offer_again') {
      s.slots = [];
      const r: Refusal = {
        success: false,
        error: 'slot_unavailable',
        say: 'I\'m sorry, that time was just taken. Let me look again.',
        fix: 'Call find_sooner_exam again and read the new options. Their current appointment has not been touched.',
      };
      return r;
    }
    const r: Refusal = {
      success: false,
      error: book.error,
      fix:
        'It could not be booked over the phone. Do not say anything failed and do not promise a call. Tell them their current appointment stays exactly as it is, ' +
        'call record_call_outcome with done, say goodbye and call end_call.',
    };
    return r;
  }

  // Booked. Now the Azul appointment, then tell NPX how that went. A cancel
  // that does not land is still safe: NPX lists the booking for CEC after
  // 15 minutes with no `cancelled` report.
  const cancel = await cancelFor(s)({
    appointmentId,
    personId,
    appointmentDate: field(s.contact, 'appointment_date'),
    comment: `Moved to an NPX partner practice by the Azul outreach call (NPX booking ${book.bookingId}).`,
    deadlineAt: deadline - NPX_TIMEOUT_MS.report - SETTLE_BUDGET_MS,
  });
  const report = await npxFor(s).reportCancel(
    book.bookingId,
    cancel.cancelled ? 'cancelled' : { failed: cancel.reason },
  );
  if (!report.ok) {
    console.warn(`[NPX OUTREACH] booking ${book.bookingId}: the cancel report did not land (${report.error}); CEC's backup list will show it`);
  }
  s.booking = { bookingId: book.bookingId, slot: book.slot ?? slot, cancel };
  const settle = (async () => {
    await (await live().store()).settleContact(s.contact.contactId, 'completed', {
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
  return {
    success: true,
    booked: true,
    say: confirmation(s.booking.slot, cancel, currentDay),
    fix: 'Say the confirmation as given, ask if there is anything else, then say goodbye and call end_call. The outcome is already recorded.',
  };
}

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
        `Their appointment: ${currentAppointment(s.contact)}.`,
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
        notes: `staff_callback:${result.ticketNumber}`,
        exceptStatus: ['do_not_call'],
      });
    } catch (e) {
      console.warn(`[NPX OUTREACH] staff callback ${result.ticketNumber}: could not settle the contact —`, e instanceof Error ? e.message : e);
    }
    return already(result.ticketNumber);
  },
});
