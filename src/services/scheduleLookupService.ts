import { db } from '../../server/db';
import { schedule } from '../../shared/schema';
import { eq, or, desc, gte, and, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { normalizePhone } from '../utils/phone';
// The ONE PersonID comparison in the repo, cast to uuid. See its own comment:
// a bare `uuid = text` fails at runtime, inside a catch, on a live call, and
// reads as "this patient has no history" rather than as a bug.
import { byPerson } from './appointmentAnswers';

/**
 * Who this lookup could have meant.
 *
 * A phone number is not an identity and neither is a surname, so a lookup can
 * legitimately land on more than one person. Every context reports which case
 * it is, because the answer changes what a caller is allowed to SAY:
 *
 *   unique: true   — safe to open by confirming a name ("Am I speaking with X?")
 *   unique: false  — the context is still one real person's, but it is a guess
 *                    among `candidateCount`. Ask, do not assert.
 *
 * This is the same refusal contract the tool library runs on: when the data
 * cannot settle something, say so in a form the caller can act on rather than
 * picking and sounding certain.
 */
export interface PatientIdentity {
  unique: boolean;
  candidateCount: number;
  /** Newest-seen first. The first entry is the one this context describes. */
  candidates: Array<{
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
    appointmentCount: number;
  }>;
}

export interface PatientScheduleContext {
  patientFound: boolean;
  patientName?: string;
  matchedBy?: 'phone' | 'name' | 'dob' | 'name_and_dob';
  upcomingAppointments: AppointmentSummary[];
  pastAppointments: AppointmentSummary[];
  lastProviderSeen?: string;
  /**
   * The last PHYSICIAN the patient saw — see SURGEON_DOCTOR_TYPES: `MD` (which
   * covers DOs; Brett Tompkins, DO is typed MD) and `Retina`.
   *
   * Separate from `lastProviderSeen` because the two answer different
   * questions. "Who did you last see?" is legitimately an optometrist. "Who is
   * your surgeon?" never is, and department 2 is assigned BY SURGEON — a ticket
   * without one lands on a coordinator with no way to route it.
   *
   * Measured 2026-08-17: of 51 surgery callers whose record resolved uniquely,
   * `lastProviderSeen` was a piece of diagnostic EQUIPMENT for 12 of them
   * (`A-Scan`, `OCT-VF`) and an optometrist for several more. Only 44 had a
   * physician as their most recent past provider — and every one of the
   * equipment cases had an obvious surgeon one row further down.
   */
  lastPhysicianSeen?: string;
  lastLocationSeen?: string;
  lastVisitDate?: string;
  /**
   * Always present when a patient was found. Callers that speak a name aloud
   * MUST check `identity.unique` first.
   */
  identity?: PatientIdentity;
  totalAppointmentsFound: number;
  patientData?: PatientData;
}

export interface PatientData {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  email?: string;
  cellPhone?: string;
  homePhone?: string;
  preferredLocation?: string;
  preferredProvider?: string;
}

export interface AppointmentSummary {
  date: string;
  isoDate: string;
  dayOfWeek: string;
  timeOfDay: string;
  startTime?: string;
  endTime?: string;
  location: string;
  provider: string;
  status: string;
  appointmentType?: string;
  category?: string;
  /**
   * `DoctorType` off the schedule row: 'MD' for ophthalmology (DOs included),
   * 'Retina' for vitreoretinal surgeons, 'OD' for optometrists, and 'Equipment'
   * for diagnostic resources. See SURGEON_DOCTOR_TYPES.
   *
   * Carried through because `provider` alone cannot tell a surgeon from an
   * A-Scan machine, and two callers of this data need to.
   */
  doctorType?: string;
}

/**
 * WHICH DoctorType VALUES ARE SURGEONS.
 *
 * The schedule types every appointment, and there are four values, not two.
 * Measured on 2026-08-18, one day of the book:
 *
 *     OD          1,455    optometry
 *     MD            606    ophthalmology
 *     Retina        192    vitreoretinal
 *     Equipment     186    A-Scan, OCT-VF, DRS
 *
 * `Retina` is the one that bit us. My first version filtered on `MD` alone, so
 * every retina surgeon was treated as no physician at all — 8.6% of the book.
 * Terry Harper and Regino Marchan both have Samira Khan, MD on 2026-09-10 typed
 * `Retina`, and both tickets filed unrouted because of that filter.
 *
 * OD is excluded on purpose: an optometrist is a clinician the patient really
 * saw, and the honest answer to "who did you last see", but never the surgeon
 * this queue assigns by. Equipment is not a person.
 */
const SURGEON_DOCTOR_TYPES = new Set(['MD', 'Retina']);

function getPacificDate(): Date {
  const now = new Date();
  const pacificFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = pacificFormatter.formatToParts(now);
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '2024');
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '1') - 1;
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '1');
  return new Date(year, month, day);
}

function getPacificDateString(): string {
  const date = getPacificDate();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T12:00:00');
    return date.toLocaleDateString('en-US', { 
      weekday: 'long',
      month: 'long', 
      day: 'numeric', 
      year: 'numeric' 
    });
  } catch {
    return dateStr;
  }
}

function formatTimeString(timeStr: string | null | undefined): string | undefined {
  if (!timeStr) return undefined;
  
  try {
    let hours: number;
    let minutes: number;
    
    if (timeStr.includes(':')) {
      [hours, minutes] = timeStr.split(':').map(Number);
    } else if (/^\d{3,4}$/.test(timeStr)) {
      const padded = timeStr.padStart(4, '0');
      hours = parseInt(padded.slice(0, 2), 10);
      minutes = parseInt(padded.slice(2, 4), 10);
    } else {
      return undefined;
    }
    
    if (isNaN(hours) || isNaN(minutes) || hours > 23 || minutes > 59) return undefined;
    
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch {
    return undefined;
  }
}

function formatAppointmentTime(appointmentDateTime: Date | string | null | undefined, sessionPartOfDay?: string): string {
  if (!appointmentDateTime) {
    return sessionPartOfDay || 'Unknown';
  }
  
  try {
    const date = appointmentDateTime instanceof Date 
      ? appointmentDateTime 
      : new Date(appointmentDateTime);
    
    if (isNaN(date.getTime())) {
      return sessionPartOfDay || 'Unknown';
    }
    
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    
    return timeFormatter.format(date);
  } catch {
    return sessionPartOfDay || 'Unknown';
  }
}

// Month name to number mapping for natural language date parsing
const MONTH_MAP: Record<string, string> = {
  'jan': '01', 'january': '01',
  'feb': '02', 'february': '02',
  'mar': '03', 'march': '03',
  'apr': '04', 'april': '04',
  'may': '05',
  'jun': '06', 'june': '06',
  'jul': '07', 'july': '07',
  'aug': '08', 'august': '08',
  'sep': '09', 'sept': '09', 'september': '09',
  'oct': '10', 'october': '10',
  'nov': '11', 'november': '11',
  'dec': '12', 'december': '12',
};

/**
 * Exported for testing. The mirror's equivalent
 * (patientVerification.normalizeDob) is exported for the same reason: a date
 * parser that only runs behind a database call is a parser nobody can prove
 * anything about, and this one silently returned '' for the commonest spoken
 * form in production for as long as it has existed.
 */
export function normalizeDOB(dob: string): string {
  if (!dob) return '';
  
  const cleaned = dob.trim();
  
  // Already in ISO format YYYY-MM-DD - validate before returning
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    if (isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return cleaned;
    }
    console.warn(`[normalizeDOB] Invalid ISO date: ${cleaned}`);
    return '';
  }
  
  // MM/DD/YYYY format
  const mmddyyyy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) {
    const [, month, day, year] = mmddyyyy;
    if (isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // MM/DD/YY format (with smart year windowing)
  const mmddyy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mmddyy) {
    const [, month, day, shortYear] = mmddyy;
    const fullYear = parseInt(shortYear) > 30 ? `19${shortYear}` : `20${shortYear}`;
    if (isValidDate(parseInt(fullYear), parseInt(month), parseInt(day))) {
      return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // MM-DD-YYYY format
  const mmddyyyyDash = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mmddyyyyDash) {
    const [, month, day, year] = mmddyyyyDash;
    if (isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // Natural language: "March 12, 1975", "Mar 12 1975", "March 17th, 1973".
  //
  // The ordinal suffix is not a nicety — it is how people SAY a date, so it
  // is what the transcriber writes down. Without `(?:st|nd|rd|th)?` this
  // matched "17" and then demanded a comma or a space and found the "t" of
  // "17th", so every spoken date fell through to the warn and verification
  // silently degraded to the caller-ID match. Observed on both live optical
  // calls, 2026-08-31: "[normalizeDOB] Unable to parse date: March 17th, 1973".
  //
  // The mirror's own normalizer (patientVerification.normalizeDob) has always
  // had this. This is the appointment-book copy catching up — and the fact
  // that there are two of these is the argument for standing instruction 14,
  // not an argument for keeping them in step by hand.
  const naturalLang = cleaned.match(/^([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (naturalLang) {
    const [, monthName, day, year] = naturalLang;
    const month = MONTH_MAP[monthName.toLowerCase()];
    if (month && isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }
  
  // Natural language: "12 March 1975" or "12 Mar 1975"
  const naturalLangReverse = cleaned.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+),?\s+(\d{4})$/i);
  if (naturalLangReverse) {
    const [, day, monthName, year] = naturalLangReverse;
    const month = MONTH_MAP[monthName.toLowerCase()];
    if (month && isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }
  
  // Natural language with 2-digit year: "March 12, 75" or "Mar 12 75"
  const naturalLang2Digit = cleaned.match(/^([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2})$/i);
  if (naturalLang2Digit) {
    const [, monthName, day, shortYear] = naturalLang2Digit;
    const month = MONTH_MAP[monthName.toLowerCase()];
    const fullYear = parseInt(shortYear) > 30 ? `19${shortYear}` : `20${shortYear}`;
    if (month && isValidDate(parseInt(fullYear), parseInt(month), parseInt(day))) {
      return `${fullYear}-${month}-${day.padStart(2, '0')}`;
    }
  }
  
  // Try JavaScript's Date parser as fallback
  try {
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = parsed.getMonth() + 1;
      const day = parsed.getDate();
      // Only accept if year is reasonable (1900-2025 for DOBs)
      if (year >= 1900 && year <= new Date().getFullYear()) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  } catch {
    // Fall through
  }
  
  console.warn(`[normalizeDOB] Unable to parse date: ${cleaned}`);
  return '';
}

// Validate that month (1-12) and day (1-31 depending on month) are in range
function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 1900 || year > new Date().getFullYear()) return false;
  
  // Check days in month
  const daysInMonth = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month]) return false;
  
  return true;
}

/**
 * How many rows one lookup pulls back.
 *
 * It used to be 20, and 20 is not enough: the window is taken BEFORE cancelled
 * rows are discarded, so a patient with a run of cancellations can have their
 * last real visit pushed out of it and be told they have never been seen.
 * Wayne has 43 rows, 34 of them cancelled.
 *
 * Measured on the live table (965,838 rows): 2,315 patients have more than 20
 * rows, 29 have more than 60. Sixty covers 99.99% of patients and, once the
 * lookup is an index scan rather than a sequential scan, costs nothing.
 */
const LOOKUP_ROW_LIMIT = 60;

/**
 * A case-insensitive prefix match that Postgres can actually answer from an
 * index.
 *
 * `Schedule` carries these two indexes, and has for a long time:
 *
 *   Schedule_PatientLastName_lower_idx  ON (lower("PatientLastName")  text_pattern_ops)
 *   Schedule_PatientFirstName_lower_idx ON (lower("PatientFirstName") text_pattern_ops)
 *
 * The name lookups were written with Drizzle's `ilike`, which emits `col ILIKE
 * 'x%'`. Postgres cannot use a `lower(col)` expression index for that — the
 * indexed expression and the queried expression are not the same thing — so
 * every name lookup was a parallel sequential scan of 965,838 rows, and the two
 * indexes had never once been used.
 *
 * Writing the predicate the way the index is built turns it into an index scan.
 * Measured on production, same row, same result set:
 *
 *   ILIKE                  Parallel Seq Scan   2,235 ms
 *   lower(col) LIKE        Index Scan              8.5 ms
 *
 * `value` must already be lower-cased — both callers do that.
 */
function nameStartsWith(column: AnyPgColumn, value: string) {
  return sql`lower(${column}) like ${`${value}%`}`;
}

/**
 * Split a result set into the one person it describes, and who else it hit.
 *
 * A person is first name + last name + date of birth. DOB is what makes this
 * safe — two Maria Garcias at one household number are two people, and merging
 * their histories would tell one of them about the other's appointments.
 *
 * The primary is whoever has the most recent row, which is what the previous
 * code effectively picked by sort order. The difference is that it now picks
 * that person's rows ONLY, instead of everyone's, and says how many others
 * there were.
 */
function splitByPerson(rows: any[]): { primary: any[]; identity: PatientIdentity } {
  const groups = new Map<string, { rows: any[]; newest: string }>();

  for (const r of rows) {
    const key = [
      String(r.patientFirstName ?? '').trim().toLowerCase(),
      String(r.patientLastName ?? '').trim().toLowerCase(),
      String(r.patientDateOfBirth ?? '').trim(),
    ].join('|');
    const date = String(r.appointmentDate ?? '');
    const g = groups.get(key);
    if (g) {
      g.rows.push(r);
      if (date > g.newest) g.newest = date;
    } else {
      groups.set(key, { rows: [r], newest: date });
    }
  }

  const ordered = [...groups.values()].sort((a, b) => b.newest.localeCompare(a.newest));
  const primary = ordered[0]?.rows ?? [];

  return {
    primary,
    identity: {
      unique: ordered.length <= 1,
      candidateCount: ordered.length,
      candidates: ordered.map((g) => ({
        firstName: g.rows[0]?.patientFirstName || undefined,
        lastName: g.rows[0]?.patientLastName || undefined,
        dateOfBirth: g.rows[0]?.patientDateOfBirth || undefined,
        appointmentCount: g.rows.length,
      })),
    },
  };
}

/**
 * Rows that came back on the PERSON KEY are one person by construction.
 *
 * `splitByPerson` exists because a phone number and a surname are not
 * identities, so it groups on `first|last|dob` and keeps the newest group.
 * PersonID is a different kind of answer: it is the primary key of the person
 * base, and every row carrying it belongs to that person whatever the row
 * SPELLS their name as.
 *
 * MEASURED 2026-09-12 over 1,500 person_ids seen in the last 21 days (1,372 of
 * them carrying more than one row): **33 — 2.4% — disagree with themselves**
 * across their own rows. 15 vary by last name, 13 by first name, 8 by date of
 * birth: married and maiden names, a nickname against a legal name, a
 * corrected birthday. Every one is the same human being under one key.
 *
 * Put those rows through `splitByPerson` and the 2.4% are reported
 * `unique: false` — AMBIGUOUS, on a primary-key join — and the smaller group's
 * visits are dropped from their own history. So the grouping is bypassed here,
 * and ONLY here: it still guards every lookup that matched on a name or a
 * number, which is every lookup that can genuinely have meant two people.
 */
function onePerson(rows: any[]): { primary: any[]; identity: PatientIdentity } {
  const newest = rows[0] ?? {};
  return {
    primary: rows,
    identity: {
      unique: true,
      candidateCount: 1,
      candidates: [
        {
          firstName: newest.patientFirstName || undefined,
          lastName: newest.patientLastName || undefined,
          dateOfBirth: newest.patientDateOfBirth || undefined,
          appointmentCount: rows.length,
        },
      ],
    },
  };
}

export class ScheduleLookupService {

  async lookupByPhone(phone: string): Promise<PatientScheduleContext> {
    const normalizedPhone = normalizePhone(phone);
    
    if (normalizedPhone.length < 10) {
      return this.emptyContext();
    }

    try {
      const appointments = await db.select()
        .from(schedule)
        .where(
          or(
            eq(schedule.patientCellPhone, normalizedPhone),
            eq(schedule.patientHomePhone, normalizedPhone)
          )
        )
        .orderBy(desc(schedule.appointmentDate))
        .limit(LOOKUP_ROW_LIMIT);

      if (appointments.length === 0) {
        console.log(`[ScheduleLookup] No appointments found for phone: ${normalizedPhone.slice(-4)}`);
        return this.emptyContext();
      }

      console.log(`[ScheduleLookup] Found ${appointments.length} appointments for phone ending in ${normalizedPhone.slice(-4)}`);
      return this.buildContext(appointments, 'phone');
      
    } catch (error) {
      console.error('[ScheduleLookup] Error looking up by phone:', error);
      return this.emptyContext();
    }
  }

  async lookupByName(firstName: string, lastName: string): Promise<PatientScheduleContext> {
    try {
      const normalizedFirst = firstName.trim().toLowerCase();
      const normalizedLast = lastName.trim().toLowerCase();
      
      const appointments = await db.select()
        .from(schedule)
        .where(
          and(
            nameStartsWith(schedule.patientLastName, normalizedLast),
            nameStartsWith(schedule.patientFirstName, normalizedFirst.substring(0, 3)),
          )
        )
        .orderBy(desc(schedule.appointmentDate))
        .limit(LOOKUP_ROW_LIMIT);

      if (appointments.length === 0) {
        return this.emptyContext();
      }

      console.log(`[ScheduleLookup] Found ${appointments.length} appointments for ${firstName} ${lastName}`);
      return this.buildContext(appointments, 'name');
      
    } catch (error) {
      console.error('[ScheduleLookup] Error looking up by name:', error);
      return this.emptyContext();
    }
  }

  async lookupByNameAndDOB(
    firstName: string,
    lastName: string,
    dob: string,
    options: { logIdentifiers?: boolean } = {},
  ): Promise<PatientScheduleContext> {
    try {
      const normalizedFirst = firstName.trim().toLowerCase();
      const normalizedLast = lastName.trim().toLowerCase();
      const normalizedDOB = normalizeDOB(dob);
      
      if (!normalizedDOB) {
        console.warn(options.logIdentifiers === false ? '[ScheduleLookup] Invalid DOB format' : `[ScheduleLookup] Invalid DOB format: ${dob}`);
        return this.emptyContext();
      }
      
      const appointments = await db.select()
        .from(schedule)
        .where(
          and(
            nameStartsWith(schedule.patientLastName, normalizedLast),
            nameStartsWith(schedule.patientFirstName, normalizedFirst.substring(0, 3)),
            eq(schedule.patientDateOfBirth, normalizedDOB)
          )
        )
        .orderBy(desc(schedule.appointmentDate))
        .limit(LOOKUP_ROW_LIMIT);
      
      if (appointments.length === 0) {
        return this.emptyContext();
      }

      if (options.logIdentifiers === false) {
        console.log(`[ScheduleLookup] Found ${appointments.length} appointments for verified professional lookup`);
      } else {
        console.log(`[ScheduleLookup] Found ${appointments.length} appointments for ${firstName} ${lastName} (DOB: ${normalizedDOB})`);
      }
      return this.buildContext(appointments, 'name_and_dob');
      
    } catch (error) {
      console.error('[ScheduleLookup] Error looking up by name and DOB:', error instanceof Error ? error.message : 'unknown');
      return this.emptyContext();
    }
  }

  /**
   * THE WHOLE RECORD, ON THE KEY THAT CANNOT BE MISSPELLED.
   *
   * Operator, 2026-09-12: *"When you find the patient in the patient master,
   * you automatically join the UID or UUID, whatever, to the schedule to pull
   * up the entire record. Right? Simple. Basic."*
   *
   * Every other rung in this class searches the appointment book by STRING —
   * a phone number as it was typed into the chart, a surname, a date of birth.
   * That is why they miss: the strings drift, and the book is not the person
   * base. `patients_master` answers WHO on its own key, and `Schedule` carries
   * that same key in `PersonID`, so once the mirror has identified somebody
   * their appointments come back with no matching of any kind.
   *
   * MEASURED 2026-09-12 on the 64 callers the book had just told us it had no
   * record of: **52 (81%) have schedule history on this join** — 51 with
   * Active visits, 49 with past visits, 19 with an UPCOMING appointment, 51
   * with an office on file across 27 distinct offices, averaging 4.8 rows.
   * The book did not lack their appointments. It could not find them by name.
   *
   * IT NEEDED AN INDEX AND HAD NONE. `Schedule` is 1,024,785 rows / 1,494 MB
   * and carried sixteen indexes, not one of them on `PersonID`, so this query
   * was a sequential scan and timed out at 60s — for a SINGLE person.
   * `idx_schedule_personid_apptdate` makes it an index-only scan, 0 heap
   * fetches, **1.305 ms**. That index is a live database object created by
   * migration, not a file in this repo; if this method ever goes slow again,
   * check that it still exists before changing any code here.
   */
  async lookupByPersonId(
    personId: string,
    matchedBy: 'phone' | 'name' | 'dob' | 'name_and_dob',
  ): Promise<PatientScheduleContext> {
    if (!personId) return this.emptyContext();

    try {
      const appointments = await db
        .select()
        .from(schedule)
        .where(byPerson(personId))
        .orderBy(desc(schedule.appointmentDate))
        .limit(LOOKUP_ROW_LIMIT);

      if (appointments.length === 0) {
        // Not a failure. This is the caller who really is on file and really
        // has never had an appointment — we still know exactly who they are.
        console.log('[ScheduleLookup] PersonID join: identified, and genuinely no appointments on file');
        return this.emptyContext();
      }

      console.log(`[ScheduleLookup] PersonID join returned ${appointments.length} row(s) — no name matching`);
      return this.buildContext(appointments, matchedBy, { keyedByPerson: true });
    } catch (error) {
      // A failed join is NOT an empty history, and the caller above must not
      // let it erase the identity the mirror just established.
      console.error(
        '[ScheduleLookup] PersonID join FAILED — this is not the same as having no appointments:',
        error instanceof Error ? error.message : 'unknown',
      );
      return this.emptyContext();
    }
  }

  async lookupPatient(params: {
    phone?: string;
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
  }): Promise<PatientScheduleContext> {
    const { phone, firstName, lastName, dateOfBirth } = params;

    if (firstName && lastName && dateOfBirth) {
      const result = await this.lookupByNameAndDOB(firstName, lastName, dateOfBirth);
      if (result.patientFound) return result;
    }

    if (phone) {
      const result = await this.lookupByPhone(phone);
      if (result.patientFound) return result;
    }

    if (firstName && lastName) {
      const result = await this.lookupByName(firstName, lastName);
      if (result.patientFound) return result;
    }

    /**
     * THE APPOINTMENT BOOK HAS SAID NOBODY. ASK THE PERSON BASE BEFORE GIVING UP.
     *
     * Every rung above reads `schedule` — the Operations Hub's appointment
     * book — so a real patient with no appointment inside its window cannot be
     * found, and from outside that failure looks random. Standing instruction
     * 14: identity belongs to the Eye Care Patient Console.
     *
     * MEASURED 2026-09-12, ten days of queue calls, duration >= 30:
     *   627 of 2,511 substantive calls (25.0%) ran this and found NOBODY
     *     tech 277/1173 · surgery 158/638 · optical 122/501 · records 70/199
     *   235 of those 627 ended with no ticket at all
     *   of 330 distinct caller numbers behind them, 208 (63%) ARE in
     *     patients_master — optical 76/100, tech 132/230
     *
     * DELIBERATELY LAST, AND THAT IS THE SAFETY PROPERTY. It runs only where
     * this method already returned `emptyContext()`, so it can ADD a match and
     * can never change one the schedule already made. Nothing above it moves,
     * and the 1,214 calls that currently reach a certain match take exactly
     * the path they take today.
     *
     * IT BRINGS THE HISTORY TOO, ON THE PERSON KEY. An earlier version of this
     * comment said it brought none, and called that correct on the reasoning
     * that these people must have no appointments — which is why the book
     * missed them. THAT WAS WRONG, and measuring it is what settled it: of 64
     * such callers, **52 (81%) have schedule history** reachable on
     * `PersonID`, 19 of them with an appointment still upcoming. The book was
     * not missing their appointments, it was missing THEM — it searches by
     * name and phone STRINGS, and those drift. So identity comes from the
     * mirror and then `lookupByPersonId` pulls the record on the key.
     *
     * The risk here runs OPPOSITE to most of this file: the danger is
     * verification becoming permissive, not strict. `findByPhone` and
     * `verifyPatient` both refuse to choose between two people and report a
     * candidate count instead — instruction 6, unchanged.
     */
    const fromMirror = await this.lookupInPersonBase({ phone, firstName, lastName, dateOfBirth });
    // `identity` alone is a real answer: it is the AMBIGUOUS case, where the
    // person base holds several people for this lookup. Returning only on
    // `patientFound` discarded it and reported a plain "not found", which is
    // the opposite of what the comment below it promises — caught by
    // `lookupPersonBaseRung.test.ts` rather than by reading.
    if (fromMirror.patientFound || fromMirror.identity) return fromMirror;

    return this.emptyContext();
  }

  /**
   * Identity from `patients_master`, shaped as a context with no history.
   *
   * Ambiguity is reported, never resolved: `identity.unique` is false and
   * `candidateCount` carries the number, so `lookup_patient` reports
   * `identity_is_certain: false` exactly as it does for an ambiguous schedule
   * hit, and no caller of this gets to treat a shared number as a person.
   */
  private async lookupInPersonBase(params: {
    phone?: string;
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
  }): Promise<PatientScheduleContext> {
    const { phone, firstName, lastName, dateOfBirth } = params;
    const { verifyPatient, findByPhone } = await import('./patientVerification');

    // Name + date of birth first: it is the stronger claim, and it is the one
    // the caller actually made out loud.
    let matchedBy: 'phone' | 'name_and_dob' = 'name_and_dob';
    let result =
      firstName && lastName && dateOfBirth
        ? await verifyPatient({ firstName, lastName, dob: dateOfBirth, callerPhone: phone })
        : null;

    if (!result || (!result.verified && result.reason !== 'ambiguous')) {
      if (phone) {
        const byPhone = await findByPhone(phone);
        if (byPhone.verified || byPhone.reason === 'ambiguous') {
          result = byPhone;
          matchedBy = 'phone';
        }
      }
    }

    if (!result) return this.emptyContext();

    if (!result.verified) {
      if (result.reason !== 'ambiguous') return this.emptyContext();
      // Somebody is here, but which one is not established. Say so; do not pick.
      console.info(
        `[ScheduleLookup] the person base holds ${result.candidates} people for this lookup — ` +
          'reporting ambiguity rather than choosing',
      );
      return {
        ...this.emptyContext(),
        identity: { unique: false, candidateCount: result.candidates, candidates: [] },
      };
    }

    const p = result.patient!;

    /**
     * IDENTIFIED — SO PULL THE RECORD. This is the join, and it is the point
     * of verifying against the person base at all: the mirror answers WHO on
     * its own key, and `Schedule.PersonID` is that same key.
     */
    const joined = await this.lookupByPersonId(p.personId, matchedBy);

    if (joined.patientFound) {
      console.info(
        `[ScheduleLookup] the appointment book had nobody by name or number; the PERSON BASE ` +
          `identified this caller by ${matchedBy}, and the PersonID join returned ` +
          `${joined.totalAppointmentsFound} row(s)`,
      );
      return {
        ...joined,
        /**
         * The mirror wins on WHO, the schedule supplies everything else.
         *
         * Standing instruction 14 puts identity in the Console, and this is
         * exactly where the two disagree: 2.4% of person_ids are spelled more
         * than one way across their own appointment rows (maiden names,
         * nicknames, a corrected birthday). The name we just verified against
         * `patients_master` is the one staff will see on the chart, so it is
         * the one to carry. Office, provider, history and contact details have
         * no counterpart in the mirror and come from the rows untouched.
         */
        patientName: `${p.firstName} ${p.lastName}`.trim() || joined.patientName,
        patientData: {
          ...joined.patientData,
          firstName: p.firstName || joined.patientData?.firstName,
          lastName: p.lastName || joined.patientData?.lastName,
          dateOfBirth: p.dob || joined.patientData?.dateOfBirth,
        },
      };
    }

    // Identified, but the join brought nothing back — either they genuinely
    // have no appointments, or it failed (the two log differently, one line
    // up). WHO still stands: an unavailable schedule must never unidentify a
    // caller the person base already vouched for.
    console.info(
      `[ScheduleLookup] the appointment book had nobody; the PERSON BASE identified this caller ` +
        `by ${matchedBy}, and the PersonID join returned no rows`,
    );
    return {
      patientFound: true,
      patientName: `${p.firstName} ${p.lastName}`.trim(),
      matchedBy,
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 0,
      identity: { unique: true, candidateCount: 1, candidates: [] },
      patientData: { firstName: p.firstName, lastName: p.lastName, dateOfBirth: p.dob },
    };
  }

  private buildContext(
    rows: any[],
    matchedBy: 'phone' | 'name' | 'dob' | 'name_and_dob',
    options: { keyedByPerson?: boolean } = {},
  ): PatientScheduleContext {
    const todayStr = getPacificDateString();

    // ONE PERSON PER CONTEXT.
    //
    // A phone number is not an identity, and neither is a surname. This method
    // used to take every row the query returned and build a single history out
    // of them, which silently merged people: +1 845 531 7471 carries Wayne
    // Fabian (43 rows) and a John Doe test record (1 row), and John Doe's visit
    // was appearing in Wayne's recent visits. A name-only lookup does the same
    // thing to every family that shares a surname.
    //
    // So: group first, then build from ONE person's rows. Who the others are is
    // reported rather than discarded, because a caller that intends to say a
    // name out loud needs to know whether it is the only one this lookup could
    // have meant.
    // ...unless the rows came back on the person key, which cannot mean two
    // people. See `onePerson`: grouping them by spelling would report 2.4% of
    // real patients as ambiguous and discard part of their own history.
    const { primary, identity } = options.keyedByPerson ? onePerson(rows) : splitByPerson(rows);
    const appointments = primary;

    const upcoming: AppointmentSummary[] = [];
    const past: AppointmentSummary[] = [];

    for (const apt of appointments) {
      const aptDateStr = apt.appointmentDate || '';
      const aptDate = aptDateStr ? new Date(aptDateStr + 'T12:00:00') : new Date();
      
      const summary: AppointmentSummary = {
        date: formatDate(aptDateStr),
        isoDate: aptDateStr,
        dayOfWeek: aptDate.toLocaleDateString('en-US', { weekday: 'long' }),
        timeOfDay: formatTimeString(apt.appointmentStart) || apt.sessionPartOfDay || 'Unknown',
        startTime: formatTimeString(apt.appointmentStart),
        endTime: formatTimeString(apt.appointmentEnd),
        location: apt.officeLocation || 'Unknown',
        provider: apt.renderingPhysician || 'Unknown',
        status: apt.appointmentStatus || 'Unknown',
        appointmentType: apt.serviceCategory1 || undefined,
        category: apt.serviceCategory1, // Using serviceCategory1 instead of removed appointmentCategory
        doctorType: apt.doctorType || undefined,
      };

      const status = String(apt.appointmentStatus ?? '');

      // A future appointment that was cancelled is not upcoming — and it is
      // not a visit that happened either, so it belongs in neither list.
      //
      // Sorting on "not upcoming" alone is what put a REMOVED appointment
      // dated 2026-12-30 at the top of the past list and had the agent tell a
      // caller on 2026-08-10 that their last appointment was four months in
      // the future, in the same breath as "you have no upcoming
      // appointments". Both sentences came from that one row.
      if (aptDateStr >= todayStr) {
        if (status === 'Active') upcoming.push(summary);
        continue;
      }

      // Only a visit the patient actually had is reported as one. Cancelled
      // (Removed) and NoShow rows are history, not appointments they attended.
      if (status === 'Active') past.push(summary);
    }

    upcoming.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    past.sort((a, b) => b.isoDate.localeCompare(a.isoDate));

    // What this lookup actually decided, in one line. A caller was told their
    // last appointment was a cancelled one four months in the future, and
    // afterwards there was no way to tell from the log whether the corrected
    // code was even running. Now there is.
    console.log(
      `[ScheduleLookup] ${appointments.length} row(s) as of ${todayStr} -> ` +
        `${past.length} past visit(s), ${upcoming.length} upcoming; ` +
        `last visit ${past[0]?.isoDate ?? 'none'}; ` +
        `${appointments.length - past.length - upcoming.length} not counted (cancelled, no-show, or cancelled-future)` +
        (identity.unique
          ? ''
          : `; AMBIGUOUS — ${identity.candidateCount} people on this lookup, ` +
            `${rows.length - appointments.length} row(s) belonging to someone else were excluded`),
    );

    /**
     * A MACHINE IS NOT A PROVIDER.
     *
     * `past[0].provider` was taken raw, so the most recent visit being an
     * A-Scan or a visual field made `A-Scan` / `OCT-VF` the patient's "last
     * provider seen" — spoken to callers, and passed by the surgery agent as
     * the surgeon, where it matched nothing and the ticket filed with
     * provider_id NULL. Department 2 routes by surgeon, so those tickets
     * reached no one.
     *
     * Equipment rows are skipped rather than blanked: the clinician the
     * patient actually saw is nearly always the next row down. Rows with no
     * DoctorType at all are kept — failing open preserves the previous answer
     * for any row the schedule has not typed.
     */
    const isEquipment = (a: AppointmentSummary) => a.doctorType === 'Equipment';
    const named = past.filter((a) => a.provider !== 'Unknown' && !isEquipment(a));
    const lastProviderSeen = named[0]?.provider;

    /**
     * The surgeon, for the queue that is assigned by surgeon. 'MD' covers DOs.
     */
    /**
     * THE SURGEON IS USUALLY IN THE FUTURE, NOT THE PAST.
     *
     * A caller on the surgery line is typically PRE-operative: the operation is
     * booked, it has not happened, and the physician who will do it appears
     * only on an UPCOMING appointment. Looking backwards finds an optometrist,
     * an A-Scan, or — for someone whose first ever visit is the surgery —
     * nothing at all.
     *
     * Gail Herrick, 2026-08-17, is the whole case: no past appointments of any
     * kind, one upcoming Laser with Samuel Asanad, MD. A past-only rule returns
     * undefined and her ticket files unrouted, which is exactly what happened.
     *
     * So: the next physician they are BOOKED with, else the last physician they
     * actually saw. `upcoming` is already Active-only and sorted ascending, so
     * its first physician is the soonest.
     */
    const isPhysician = (a: AppointmentSummary) =>
      SURGEON_DOCTOR_TYPES.has(a.doctorType ?? '') && a.provider !== 'Unknown';
    const lastPhysicianSeen =
      upcoming.find(isPhysician)?.provider ?? past.find(isPhysician)?.provider;

    const lastLocationSeen = past[0]?.location !== 'Unknown' ? past[0]?.location : undefined;

    const firstApt = appointments[0];
    const patientName = `${firstApt.patientFirstName || ''} ${firstApt.patientLastName || ''}`.trim();

    const patientData: PatientData = {
      firstName: firstApt.patientFirstName || undefined,
      lastName: firstApt.patientLastName || undefined,
      dateOfBirth: firstApt.patientDateOfBirth || undefined,
      email: firstApt.patientEmailAddress || undefined,
      cellPhone: firstApt.patientCellPhone || undefined,
      homePhone: firstApt.patientHomePhone || undefined,
      preferredLocation: lastLocationSeen || firstApt.officeLocation || undefined,
      preferredProvider: lastProviderSeen || firstApt.renderingPhysician || undefined,
    };

    return {
      patientFound: true,
      patientName: patientName || undefined,
      matchedBy,
      upcomingAppointments: upcoming.slice(0, 5),
      pastAppointments: past.slice(0, 5),
      lastProviderSeen,
      lastPhysicianSeen,
      lastLocationSeen,
      lastVisitDate: past[0]?.date,
      identity,
      totalAppointmentsFound: appointments.length,
      patientData,
    };
  }

  private emptyContext(): PatientScheduleContext {
    return {
      patientFound: false,
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 0,
    };
  }

  formatContextForAgent(context: PatientScheduleContext): string {
    if (!context.patientFound) {
      return 'No appointment history found for this patient. They may be a new patient or calling from a different phone number.';
    }

    const parts: string[] = [];
    
    parts.push(`Patient: ${context.patientName || 'Unknown'}`);
    parts.push(`Total appointments in system: ${context.totalAppointmentsFound}`);

    if (context.upcomingAppointments.length > 0) {
      parts.push('\nUPCOMING APPOINTMENTS:');
      context.upcomingAppointments.forEach((apt, i) => {
        let timeInfo = apt.startTime || apt.timeOfDay;
        if (apt.startTime && apt.endTime) {
          timeInfo = `${apt.startTime} - ${apt.endTime}`;
        }
        parts.push(`  ${i + 1}. ${apt.date} (${timeInfo}) at ${apt.location} with ${apt.provider}`);
        if (apt.appointmentType) parts.push(`     Appointment Type: ${apt.appointmentType}`);
      });
    } else {
      parts.push('\nNo upcoming appointments scheduled.');
    }

    if (context.pastAppointments.length > 0) {
      parts.push('\nRECENT VISITS:');
      context.pastAppointments.slice(0, 3).forEach((apt, i) => {
        parts.push(`  ${i + 1}. ${apt.date} at ${apt.location} with ${apt.provider}`);
      });
    }

    if (context.lastLocationSeen) {
      parts.push(`\nLast location seen: ${context.lastLocationSeen}`);
    }
    if (context.lastProviderSeen) {
      parts.push(`Last provider seen: ${context.lastProviderSeen}`);
    }

    return parts.join('\n');
  }
}

export const scheduleLookupService = new ScheduleLookupService();
