/**
 * The NPX outreach call's own tools (v109), bound by the runtime to the
 * `npx-outreach` lane only (its OutboundLanePolicy.tools), on a call the lane
 * dialled AND on a call somebody made back to it.
 *
 *   confirm_patient_birthdate  the person who answered gives their date of
 *                              birth; it must match the record the call is
 *                              about. NOTHING about the appointment reaches
 *                              the model before it does — the appointment
 *                              is in this tool's answer, not the prompt.
 *   find_sooner_exam           asks NPX for up to two sooner routine exams at
 *                              a partner that takes the patient's medical
 *                              group, in reach of them.
 *   book_sooner_exam           books the one they chose in NPX, cancels the
 *                              Azul appointment it replaces, reports the
 *                              cancel to NPX, and says only what happened.
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
 */
import { registerTool, type ToolFailure, type ToolResult } from './registry';
import { readDobQuietly } from './dobParts';
import { spokenDobFor } from './spokenDob';
import { callbackSessionFor } from './outboundTools';
import { dobOnFile } from '../runtime/outbound/callback';
import type { OutboundContact } from '../runtime/outbound/campaign';
import type { OutboundStore } from '../runtime/outbound/store';
import { createNpxOutreachClient, type NpxOutreachClient, type NpxSlot } from '../services/npxOutreachClient';
import { cancelAzulAppointment, type AzulCancelRequest, type AzulCancelResult } from '../services/outreachAzulCancel';

export const CONFIRM_DOB_TOOL_NAME = 'confirm_patient_birthdate';
export const FIND_SOONER_TOOL_NAME = 'find_sooner_exam';
export const BOOK_SOONER_TOOL_NAME = 'book_sooner_exam';
export const NPX_OUTREACH_TOOLS = [CONFIRM_DOB_TOOL_NAME, FIND_SOONER_TOOL_NAME, BOOK_SOONER_TOOL_NAME] as const;

/** Two tries at the date of birth: once to ask, once in case it was misheard. */
export const MAX_DOB_TRIES = 2;
/** How many times NPX is asked for slots on one call (a taken slot asks again). */
export const MAX_OFFERS = 3;
/** NPX's own default: offer only an exam at least three weeks sooner. */
export const MIN_DAYS_SOONER = 21;

// ── Dependencies, swappable for tests ───────────────────────────────────────

interface Deps {
  npx: NpxOutreachClient;
  cancel: (req: AzulCancelRequest) => Promise<AzulCancelResult>;
  store: () => Promise<OutboundStore>;
}

let storePromise: Promise<OutboundStore> | null = null;
const defaultDeps = (): Deps => ({
  npx: createNpxOutreachClient(),
  cancel: (req) => cancelAzulAppointment(req),
  store: () => (storePromise ??= import('../runtime/outbound/store').then((m) => m.createDbOutboundStore())),
});
let deps: Deps | null = null;
const live = (): Deps => (deps ??= defaultDeps());

/** Tests only. Null restores the production dependencies. */
export function setNpxOutreachDepsForTests(next: Partial<Deps> | null): void {
  deps = next ? { ...defaultDeps(), ...next } : null;
}

// ── The per-call session ────────────────────────────────────────────────────

interface OutreachSession {
  contact: OutboundContact;
  verified: boolean;
  dobTries: number;
  offers: number;
  slots: NpxSlot[];
  booking: { bookingId: string; slot: NpxSlot; cancel: AzulCancelResult } | null;
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
  return {
    sid,
    s: keep(sid, { contact, verified: false, dobTries: 0, offers: 0, slots: [], booking: null, openedAtMs: now }, now),
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

function currentAppointment(c: OutboundContact): string {
  const day = spokenDay(field(c, 'appointment_date'));
  const clock = spokenClock(field(c, 'begin_time'));
  const office = field(c, 'office');
  return `an eye exam on ${day}${clock ? ` at ${clock}` : ''}${office ? ` at our ${office} office` : ''}`;
}

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
        askAs: 'And your date of birth, starting with the month, then the day, then the year?',
      },
    },
    required: ['date_of_birth'],
  },
  handler: async (input): Promise<ToolResult> => {
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { sid, s } = found;
    if (s.verified) return { success: true, verified: true, current_appointment: currentAppointment(s.contact) };
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
        next: `Tell them we have ${currentAppointment(s.contact)}, and that we may be able to get them seen sooner at a partner practice that takes their medical group. Ask if they would like to hear the options; if yes, call find_sooner_exam.`,
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
    const offer = await live().npx.offer({
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

function confirmation(slot: NpxSlot, cancel: AzulCancelResult, currentDay: string): string {
  const booked = `You're booked for ${spokenSlot(slot)}. Their phone number is ${slot.phone}.`;
  return cancel.cancelled
    ? `${booked} I've also cancelled your appointment with us on ${currentDay}, so there's nothing else you need to do.`
    : `${booked} Our team will cancel your appointment with us on ${currentDay}; you don't need to do anything.`;
}

registerTool({
  name: BOOK_SOONER_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 30_000,
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
    const found = await sessionFor(input);
    if ('success' in found) return found;
    const { sid, s } = found;
    if (!s.verified) return notVerified();
    const currentDay = spokenDay(field(s.contact, 'appointment_date'));
    if (s.booking) {
      return { success: true, booked: true, say: confirmation(s.booking.slot, s.booking.cancel, currentDay) };
    }
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
    const book = await live().npx.book({
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
    const cancel = await live().cancel({
      appointmentId,
      personId,
      appointmentDate: field(s.contact, 'appointment_date'),
      comment: `Moved to an NPX partner practice by the Azul outreach call (NPX booking ${book.bookingId}).`,
    });
    const report = await live().npx.reportCancel(
      book.bookingId,
      cancel.cancelled ? 'cancelled' : { failed: cancel.reason },
    );
    if (!report.ok) {
      console.warn(`[NPX OUTREACH] booking ${book.bookingId}: the cancel report did not land (${report.error}); CEC's backup list will show it`);
    }
    s.booking = { bookingId: book.bookingId, slot: book.slot ?? slot, cancel };
    try {
      await (await live().store()).settleContact(s.contact.contactId, 'completed', {
        notes: `npx_booking:${book.bookingId}`,
        exceptStatus: ['do_not_call'],
      });
    } catch (e) {
      console.warn(`[NPX OUTREACH] booking ${book.bookingId}: could not settle the contact —`, e instanceof Error ? e.message : e);
    }
    return {
      success: true,
      booked: true,
      say: confirmation(s.booking.slot, cancel, currentDay),
      fix: 'Say the confirmation as given, ask if there is anything else, then say goodbye and call end_call. The outcome is already recorded.',
    };
  },
});
