/**
 * WHERE AN AFTER-HOURS TICKET GOES WHEN THE APP SHOULD NOT DECIDE IT ALONE.
 *
 * The after-hours line files through `/submit-ticket`, which derives the
 * department server-side; every other call still does. Two kinds of call are
 * the operator's to route, and the app cannot tell them from the rest:
 *
 *   1. A POST-OPERATIVE MEDICATION PROBLEM — a patient who had surgery or a
 *      procedure whose post-op drops never reached the pharmacy, or who has
 *      run out. Operator, 2026-10-02, asked whether that is a reason to ring
 *      the on-call provider: "no, it should record an urgent ticket in after
 *      hours." CAa2e451aba415a1deb97a72374e3e1784 and
 *      CAb475175ff010615e82b9f6799c0fb114 (2026-10-02 00:41/00:46 UTC) are
 *      the shape: two medium tickets, one in Technicians Support, both
 *      unassigned, for a patient whose steroid drops were not at the pharmacy
 *      the evening of their procedure.
 *
 *   2. A SAME-DAY REQUEST — about an appointment today: confirming it,
 *      cancelling or moving it, running late, standing outside the office.
 *      Operator, same message: "same day tickets are worked in the after
 *      hours department." On 2026-10-01, 7 of the 8 tickets filed between 6
 *      and 8 AM Pacific were same-day, every one landed in the HVA Hub or
 *      Surgery Coordination, and staff first touched them at 8:17–8:26 —
 *      after both 8:00 appointments. VA-66656, a patient outside a closed
 *      building for a 7:15 surgery, had no human touch at all.
 *
 *   3. AN OPTICAL REQUEST — glasses, frames, lenses, contacts as products:
 *      order status, pickup, repairs, new orders. The model names this on
 *      `create_ticket` (`request_category: optical_request`). Ticketing
 *      already assigns Optical tickets by location, so the voice side sends
 *      department 1 and the office when known. Classification is the model's
 *      job (standing instruction 3) — this module does not scan the words
 *      for "glasses".
 *
 * Everything else is left to the app exactly as before: this returns
 * `{ kind: 'default' }` and the caller sends no department.
 *
 * SAME-DAY ONLY BEFORE THE OFFICE DAY ENDS. The line runs from 5 PM to 8 AM
 * Pacific and all weekend. A 6 AM call about "today" is about a day that has
 * not started; a 9 PM call about "today's appointment" is about one that is
 * over, and the morning queue it would join is the ordinary one. So a call
 * after 5 PM Pacific is never same-day, whatever the words say.
 *
 * The cue lists err toward the CHEAP direction on both kinds. A false
 * same-day costs a department transfer by a staffer; a false post-op costs an
 * urgent flag on a ticket that is not urgent. Neither ever rings anybody —
 * ringing is the escalation gate's decision, never this module's.
 */
import { AFTER_HOURS_DEPARTMENT_ID } from '../tools/afterHoursTaxonomy';
import { MEDICAL_RECORDS_DEPARTMENT_ID } from '../tools/medicalRecordsTaxonomy';
import { OPTICAL_DEPARTMENT_ID } from '../tools/opticalTaxonomy';

/** The Support Center's own pair for a post-op question in department 8. */
export const POST_PROCEDURE_REQUEST = {
  requestTypeId: 35,
  requestReasonId: 171,
  requestReason: 'Post-Procedure Questions',
} as const;

export type AfterHoursRoute =
  | { kind: 'post_op_medication'; departmentId: number; priority: 'urgent' }
  | { kind: 'same_day'; departmentId: number }
  | { kind: 'optical'; departmentId: number }
  | { kind: 'medical_records'; departmentId: number }
  | { kind: 'default' };

const fold = (s: string) =>
  ` ${s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ')} `;

/**
 * The caller had the operation already. "After my surgery", "had a procedure
 * today", "post-op". A FUTURE operation is deliberately not here: a patient
 * whose pre-op drops are missing before tomorrow's surgery is a different
 * request, and the ruling was about after.
 */
const POST_OP_TERMS = [
  'post-op', 'post op', 'postop', 'post-operative', 'post operative', 'postoperative',
  'postoperatorio', 'post operatorio', 'post-operatorio', 'me operaron', 'me opere',
  'despues de la cirugia', 'despues de mi cirugia', 'despues de la operacion',
];
/**
 * "Had surgery", "after the procedure" — and NOT "had surgery scheduled for
 * tomorrow" or "after my surgery next week", where the trigger word is there
 * and the operation has not happened (Codex P2, #345). The lookahead reads
 * only the words straight after the operation, so a completed operation
 * followed later in the sentence by a scheduled follow-up still counts.
 */
const POST_OP_PATTERN =
  /\b(recent|recently|after|following|post|had|since|from)\s+(\w+\s+){0,2}(surgery|surgical|operation|procedure)\b(?!\s+(is\s+|was\s+|has been\s+)?(scheduled|booked|set|planned|tomorrow|next|coming|upcoming|later)\b)/;

/** A medication or prescription is the subject. */
const MEDICATION_TERMS = [
  'prescription', 'pharmacy', 'drops', 'eye drop', 'medication', 'medicine', 'refill',
  'steroid', 'antibiotic', 'receta', 'farmacia', 'gotas', 'medicamento', 'medicina',
];

export function mentionsPostOp(text: string): boolean {
  const t = fold(text);
  return POST_OP_TERMS.some((term) => t.includes(term)) || POST_OP_PATTERN.test(t);
}

export function mentionsMedication(text: string): boolean {
  const t = fold(text);
  return MEDICATION_TERMS.some((term) => t.includes(term));
}

/** Post-op AND a medication problem — the shape the 2026-10-02 ruling covers. */
export function mentionsPostOpMedication(text: string): boolean {
  return mentionsPostOp(text) && mentionsMedication(text);
}

const TODAY = /\b(today|tonight|this morning|hoy|esta manana)\b/;
const VISIT = /\b(appointment|appt|cita|surgery|surgical|cirugia|procedure|exam|visit|consulta)\b/;
/** Time-critical without the word "today": the 8:00 running-late call never said it. */
const ON_THE_WAY =
  /\b(running late|run late|be late|late for|on (my|our|his|her) way|outside the (office|building|clinic)|voy tarde|vamos tarde|llego tarde|estoy afuera)\b/;

export function soundsSameDay(text: string): boolean {
  const t = fold(text);
  return (TODAY.test(t) && VISIT.test(t)) || ON_THE_WAY.test(t);
}

/** The request is ABOUT an appointment — the words, not the procedure or the subject. */
const APPOINTMENT_WORD = /\b(appointment|appt|cita|visit|consulta|check[- ]?in)\b/;

export function soundsAboutAnAppointment(text: string): boolean {
  const t = fold(text);
  return APPOINTMENT_WORD.test(t) || ON_THE_WAY.test(t);
}

/** The practice's clock, whatever the server's is. */
export function pacificNow(now: Date = new Date()): { isoDate: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    isoDate: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** "8:00 AM" -> 480. Undefined when the time is missing or unreadable. */
export function minutesOf(time: string | undefined): number | undefined {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((time ?? '').trim());
  if (!m) return undefined;
  const hour = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return hour * 60 + Number(m[2]);
}

/**
 * The confirmed record holds an appointment later today. A time we cannot
 * read counts as later — the date alone says it is today, and the office day
 * has not ended (the caller checks that first).
 */
export function recordHasAppointmentLaterToday(
  upcoming: ReadonlyArray<{ isoDate?: string; startTime?: string }> | undefined,
  now: Date = new Date(),
): boolean {
  const { isoDate, minutes } = pacificNow(now);
  return (upcoming ?? []).some((apt) => {
    if (apt.isoDate !== isoDate) return false;
    const at = minutesOf(apt.startTime);
    return at === undefined || at > minutes;
  });
}

const OFFICE_DAY_ENDS_AT = 17 * 60;

export function routeAfterHoursTicket(input: {
  /** The model's own reading — `post_op_prescription` on create_ticket. */
  postOpMedication?: boolean;
  /** The model's own reading — `appointment_today` on create_ticket. */
  appointmentToday?: boolean;
  /**
   * The model's own reading — `request_category: optical_request`.
   * Never inferred from the words. A glasses request the model left as
   * `general_question` stays the app's to route.
   */
  opticalRequest?: boolean;
  /** What the caller needs, as the model wrote it. */
  text: string;
  /** Only a CONFIRMED record's appointments; a phone candidate's are not the caller's. */
  confirmedUpcoming?: ReadonlyArray<{ isoDate?: string; startTime?: string }>;
  /** The request's own category is an appointment one (confirm, cancel, move, book). */
  appointmentIntent?: boolean;
  /**
   * v190: a medical records request — the model's category, or a records
   * request the escalation gate refused on this call. Files to Medical
   * Records (operator, 2026-11-09: records requests never ring the on-call).
   */
  recordsRequest?: boolean;
  now?: Date;
}): AfterHoursRoute {
  const now = input.now ?? new Date();
  if (input.postOpMedication === true) {
    return { kind: 'post_op_medication', departmentId: AFTER_HOURS_DEPARTMENT_ID, priority: 'urgent' };
  }
  // A records request outranks the post-op WORDS: records about a surgery
  // name the surgery and its drops, and are still a records request. The
  // model's own post-op flag above still wins.
  if (input.recordsRequest === true) {
    return { kind: 'medical_records', departmentId: MEDICAL_RECORDS_DEPARTMENT_ID };
  }
  if (mentionsPostOpMedication(input.text)) {
    return { kind: 'post_op_medication', departmentId: AFTER_HOURS_DEPARTMENT_ID, priority: 'urgent' };
  }
  // The model named Optical. A pickup or repair "today" is still Optical's
  // work; same-day After Hours is for appointments, not eyewear.
  if (input.opticalRequest === true) {
    return { kind: 'optical', departmentId: OPTICAL_DEPARTMENT_ID };
  }
  if (pacificNow(now).minutes >= OFFICE_DAY_ENDS_AT) return { kind: 'default' };
  // The record says WHEN the caller is due, never WHAT they are calling about:
  // a refill or a billing question from a patient who happens to be due this
  // afternoon is not a same-day ticket (Codex P2, #345). So the record only
  // backs up a request that is already about an appointment.
  const aboutAnAppointment = input.appointmentIntent === true || soundsAboutAnAppointment(input.text);
  if (
    input.appointmentToday === true ||
    soundsSameDay(input.text) ||
    (aboutAnAppointment && recordHasAppointmentLaterToday(input.confirmedUpcoming, now))
  ) {
    return { kind: 'same_day', departmentId: AFTER_HOURS_DEPARTMENT_ID };
  }
  return { kind: 'default' };
}

/**
 * A time the caller said, read loosely: "8", "8:30", "8 am", "8:30 a.m.",
 * "at 2:15pm", "9:00 AM". Returns minutes after midnight and whether a.m./p.m.
 * was stated. Undefined when no hour can be read.
 */
export function spokenTimeOf(text: string | undefined): { minutes: number; meridiemStated: boolean } | undefined {
  const t = fold(text ?? '');
  // A time has a colon, an a.m./p.m., or follows "at" / "a las". A bare number
  // (a date part, a count) is not a time.
  const m =
    /\b(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/i.exec(t) ??
    /\b(\d{1,2})()\s*(a\.?\s?m\.?|p\.?\s?m\.?)/i.exec(t) ??
    /\b(?:at|a las)\s+(\d{1,2})()(?![\d/:])()/i.exec(t);
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) {
    // A 24-hour time ("14:30") is still a time; anything else is not.
    if (hour >= 13 && hour <= 23 && minute <= 59 && !m[3]) return { minutes: hour * 60 + minute, meridiemStated: true };
    return undefined;
  }
  if (!m[3]) return { minutes: (hour % 12) * 60 + minute, meridiemStated: false };
  const pm = /^p/i.test(m[3]);
  return { minutes: ((hour % 12) + (pm ? 12 : 0)) * 60 + minute, meridiemStated: true };
}

export interface SameDayTimeConflict {
  callerTime: string;
  recordTimes: string[];
}

/**
 * THE CALLER'S TIME TODAY DISAGREES WITH THE RECORD'S — v166.
 *
 * A caller who believes their appointment today is at one time while the
 * confirmed record holds another is about to miss it, or arrive for it at the
 * wrong hour. Only a CONFIRMED record's appointments count (a phone
 * candidate's are somebody else's), only appointments dated today in the
 * practice's time zone, and only record times that can be read. A caller time
 * with no a.m./p.m. matches either half of the clock, so "eight" never
 * conflicts with 8:00 PM or 8:00 AM.
 */
export function sameDayTimeConflict(input: {
  callerTime: string | undefined;
  confirmedUpcoming?: ReadonlyArray<{ isoDate?: string; startTime?: string }>;
  now?: Date;
}): SameDayTimeConflict | null {
  const spoken = spokenTimeOf(input.callerTime);
  if (!spoken) return null;
  const { isoDate } = pacificNow(input.now ?? new Date());
  const today = (input.confirmedUpcoming ?? [])
    .filter((apt) => apt.isoDate === isoDate)
    .map((apt) => ({ label: apt.startTime ?? '', at: minutesOf(apt.startTime) }))
    .filter((apt): apt is { label: string; at: number } => apt.at !== undefined);
  if (today.length === 0) return null;
  const matches = today.some((apt) =>
    spoken.meridiemStated ? apt.at === spoken.minutes : apt.at % 720 === spoken.minutes % 720,
  );
  if (matches) return null;
  return { callerTime: (input.callerTime ?? '').trim(), recordTimes: today.map((apt) => apt.label) };
}

export function sameDayTimeConflictNote(conflict: SameDayTimeConflict): string {
  return (
    `APPOINTMENT TIME CONFLICT — TODAY: the caller said ${conflict.callerTime}; the patient record shows ` +
    `${conflict.recordTimes.join(', ')} today. Confirm the correct time with the patient before the appointment.`
  );
}

/** The line a staffer reads first, in `additionalDetails`. Never the caller's words. */
export function afterHoursRouteNote(kind: AfterHoursRoute['kind']): string | null {
  switch (kind) {
    case 'post_op_medication':
      return 'POST-OP MEDICATION — URGENT: a post-operative patient with a medication or prescription problem. Filed urgent to After Hours (operator ruling 2026-10-02); not a reason to ring the on-call provider.';
    case 'same_day':
      return 'SAME-DAY: this request is about an appointment today. Routed to After Hours, who work same-day tickets.';
    case 'optical':
      return 'OPTICAL: the model classified this as glasses, frames, lenses or contacts (order, status, pickup or repair). Filed to Optical Support; the ticketing app assigns by location.';
    case 'medical_records':
      return 'MEDICAL RECORDS: an after-hours records request. Filed to Medical Records; records requests never ring the on-call (operator ruling 2026-11-09).';
    default:
      return null;
  }
}
