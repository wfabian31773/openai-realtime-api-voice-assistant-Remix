/**
 * Verify a caller against the PERSON BASE, not against the appointment book.
 *
 * Operator directive 2026-08-10: "we usually use the mirror from the eye care
 * patient console… ensuring that we are verifying against the patient's
 * mirror is a global part. This is the verification phase and the most
 * important phase because it unlocks everything downstream."
 *
 * Why this file exists at all. Verification used to run through
 * scheduleLookupService.lookupByNameAndDOB, which queries the `schedule`
 * table — the appointment mirror. So "verified" silently meant "this person
 * has an appointment inside our schedule window". A real patient, with a real
 * chart, who simply has no recent or upcoming appointment could not verify no
 * matter how perfectly they said their name, and the failure looked random
 * from the outside. That is the wrong table, and it is why verification has
 * been the hardest part of every line.
 *
 * patients_master is the right one: 909,376 persons as of 2026-08-10, synced
 * daily, carrying person_id and person_nbr — the association the staff work
 * from once a ticket lands.
 *
 * Three rules this file keeps:
 *
 *  1. NEVER throw, and never hang. A caller is on the line; an unreachable
 *     database must degrade to "unverified", never to silence. Everything is
 *     time-boxed.
 *  2. NEVER guess between two people. Two persons sharing a surname and a
 *     birthday is not a match, it is a question — and attaching a ticket to
 *     the wrong chart is worse than attaching it to none.
 *  3. NEVER log identifiers. Reason codes and counts only. Verification runs
 *     on every call, and call logs are read by people who should not be
 *     handed a stream of names and birthdays.
 */
import pg from 'pg';

export interface VerifiedPatient {
  /** The association the ticket carries, so staff open the right chart. */
  personId: string;
  personNbr: string | null;
  firstName: string;
  lastName: string;
  /** ISO yyyy-mm-dd, as stored. */
  dob: string;
  hasMedicalRecord: boolean;
  /**
   * The mirror's language for this person. A HINT for the staff on the
   * ticket — deliberately not wired to the voice. The operator's own record
   * reads "Spanish", so driving the agent from this field would have flipped
   * his test calls into Spanish mid-verification.
   */
  language: string | null;
}

export type VerificationReason =
  | 'match'
  | 'no_match'
  /** More than one person shares that surname and birthday. */
  | 'ambiguous'
  /** Not enough to search on. */
  | 'bad_input'
  /** The mirror could not be reached in time. Says nothing about the caller. */
  | 'unavailable';

export interface VerificationResult {
  verified: boolean;
  reason: VerificationReason;
  patient?: VerifiedPatient;
  /** How many people matched surname + date of birth. */
  candidates: number;
  /** Which table answered. 'schedule' means the mirror was unreachable. */
  source?: 'mirror' | 'schedule';
}

/**
 * A caller is waiting. Past this, we proceed unverified rather than stall.
 * Read per call, not at import: frozen at import it could only be changed by
 * a redeploy, and this is exactly the kind of number you want to turn during
 * an incident.
 */
function lookupTimeoutMs(): number {
  const n = Number(process.env.PATIENT_VERIFY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2500;
}

let pool: pg.Pool | null = null;

export function isVerificationConfigured(): boolean {
  return Boolean(process.env.OBS_CONSOLE_DATABASE_URL);
}

/**
 * Its own pool, deliberately not the Observatory's. That one is sized for
 * dashboards (max 3, 15s statements); a dashboard query queueing ahead of a
 * live caller's verification is not a trade we want to make.
 */
function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.OBS_CONSOLE_DATABASE_URL;
    if (!url) throw new Error('OBS_CONSOLE_DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: false },
      // Read-only at the session level as well as by role: this path has no
      // business writing to the console, and the guarantee should not depend
      // on remembering that.
      options: '-c default_transaction_read_only=on -c statement_timeout=2500',
    });
    pool.on('error', (e) => console.error('[VERIFY] console pool error:', e.message));
  }
  return pool;
}

/** Digits only, and drop a US country code so 1AAA... and AAA... compare equal. */
export function phoneDigits(raw: string | undefined | null): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

/**
 * Spoken dates arrive in every shape. Anything we cannot resolve to a real
 * calendar date returns '' — searching on a malformed date would quietly
 * match nobody and read as "patient not found".
 */
export function normalizeDob(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return isoOrEmpty(+iso[1], +iso[2], +iso[3]);
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (slash) {
    const yr = slash[3].length === 4 ? +slash[3] : +slash[3] > 30 ? 1900 + +slash[3] : 2000 + +slash[3];
    return isoOrEmpty(yr, +slash[1], +slash[2]);
  }
  const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const words = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (words) {
    const m = MONTHS[words[1].slice(0, 3).toLowerCase()];
    if (m) return isoOrEmpty(+words[3], m, +words[2]);
  }
  return '';
}

function isoOrEmpty(y: number, m: number, d: number): string {
  if (!y || !m || !d || m > 12 || d > 31 || y < 1900 || y > new Date().getFullYear()) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

interface Row {
  person_id: string;
  person_nbr: string | null;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string;
  has_medical_record: boolean | null;
  language: string | null;
  phones: string[] | null;
}

export interface VerifyInput {
  firstName?: string | null;
  lastName?: string | null;
  dob?: string | null;
  /** Breaks ties when a surname and birthday are shared. */
  callerPhone?: string | null;
}

/**
 * Surname + date of birth finds the candidates; the first name and then the
 * caller's number narrow them. Surname and DOB are required because those are
 * the two a caller states most reliably and the two the mirror indexes well —
 * a first-name-led search on 909k persons is neither fast nor selective.
 */
export async function verifyPatient(input: VerifyInput): Promise<VerificationResult> {
  const last = String(input.lastName ?? '').trim();
  const first = String(input.firstName ?? '').trim();
  const dob = normalizeDob(input.dob);
  if (!last || !dob) return { verified: false, reason: 'bad_input', candidates: 0 };
  if (!isVerificationConfigured()) {
    console.error(
      '[VERIFY] OBS_CONSOLE_DATABASE_URL is NOT SET in this process — falling back to the ' +
        'appointment book, which only knows patients who have appointments. FIX THE SECRET.',
    );
    return verifyAgainstSchedule(last, first, dob, input.callerPhone);
  }

  let rows: Row[];
  try {
    const q = getPool().query<Row>(
      `SELECT person_id::text            AS person_id,
              person_nbr,
              first_name,
              last_name,
              to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
              has_medical_record,
              language,
              ARRAY[cell_phone, home_phone, day_phone, alt_phone, sec_home_phone] AS phones
         FROM public.patients_master
        WHERE lower(last_name) = lower($1)
          AND date_of_birth = $2::date
        LIMIT 50`,
      [last, dob],
    );
    // The pool has a statement timeout, but a dead socket does not honour it.
    rows = (
      await Promise.race([
        q,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), lookupTimeoutMs())),
      ])
    ).rows;
  } catch (e) {
    console.error(
      `[VERIFY] mirror lookup FAILED (${(e as Error).message}) — falling back to the appointment book`,
    );
    return verifyAgainstSchedule(last, first, dob, input.callerPhone);
  }

  const candidates = rows.length;
  if (!candidates) return { verified: false, reason: 'no_match', candidates: 0 };

  const narrowed = narrow(rows, first, input.callerPhone);
  if (narrowed.length === 1) {
    return { verified: true, reason: 'match', candidates, patient: toPatient(narrowed[0]), source: 'mirror' };
  }
  // Two real people, same surname, same birthday. Guessing here attaches a
  // ticket to the wrong chart, so it stays unverified and a human decides.
  return { verified: false, reason: 'ambiguous', candidates };
}

/**
 * Second best, when the person mirror cannot be reached.
 *
 * The appointment book carries the SAME PersonID as patients_master, so a
 * caller found here is identified just as precisely and everything downstream
 * still works. What it cannot do is find a patient who has no appointments —
 * which is exactly the gap the mirror exists to close, and exactly the failure
 * that made verification look random for weeks.
 *
 * So this is a degraded mode, not an alternative. It keeps a caller moving
 * when a secret is missing instead of telling them we cannot look them up,
 * and it says so loudly in the log every single time.
 */
async function verifyAgainstSchedule(
  last: string,
  first: string,
  dob: string,
  callerPhone: string | null | undefined,
): Promise<VerificationResult> {
  try {
    const { pool } = await import('../../server/db');
    const { rows } = await pool.query<Row>(
      `SELECT DISTINCT ON ("PersonID")
              "PersonID"::text                     AS person_id,
              NULL::text                           AS person_nbr,
              "PatientFirstName"                   AS first_name,
              "PatientLastName"                    AS last_name,
              to_char("PatientDateOfBirth", 'YYYY-MM-DD') AS date_of_birth,
              TRUE                                 AS has_medical_record,
              "PatientLanguage"                    AS language,
              ARRAY["PatientCellPhone", "PatientHomePhone"] AS phones
         FROM public."Schedule"
        WHERE lower("PatientLastName") = lower($1)
          AND "PatientDateOfBirth" = $2::date
          AND "PersonID" IS NOT NULL
        LIMIT 50`,
      [last, dob],
    );
    const candidates = rows.length;
    if (!candidates) return { verified: false, reason: 'no_match', candidates: 0, source: 'schedule' };
    const narrowed = narrow(rows, first, callerPhone);
    if (narrowed.length === 1) {
      console.warn('[VERIFY] verified from the APPOINTMENT BOOK, not the person mirror — degraded');
      return { verified: true, reason: 'match', candidates, patient: toPatient(narrowed[0]), source: 'schedule' };
    }
    return { verified: false, reason: 'ambiguous', candidates, source: 'schedule' };
  } catch (e) {
    console.error(`[VERIFY] the appointment book failed too (${(e as Error).message})`);
    return { verified: false, reason: 'unavailable', candidates: 0 };
  }
}

/** Exact first name, then a prefix, then the caller's own number. */
function narrow(rows: Row[], first: string, callerPhone: string | null | undefined): Row[] {
  let out = rows;
  if (first) {
    const f = first.toLowerCase();
    const exact = out.filter((r) => (r.first_name ?? '').trim().toLowerCase() === f);
    if (exact.length) out = exact;
    else {
      // "Bob" for Robert, "Kathy" for Katherine — a shared opening is worth
      // trying before giving up, but only as a narrowing step.
      const stem = f.slice(0, 3);
      const prefix = out.filter((r) => (r.first_name ?? '').trim().toLowerCase().startsWith(stem));
      if (prefix.length) out = prefix;
    }
  }
  if (out.length > 1 && callerPhone) {
    const want = phoneDigits(callerPhone);
    if (want.length >= 10) {
      const byPhone = out.filter((r) =>
        (r.phones ?? []).some((p) => p && phoneDigits(p) === want),
      );
      if (byPhone.length) out = byPhone;
    }
  }
  return out;
}

function toPatient(r: Row): VerifiedPatient {
  return {
    personId: r.person_id,
    personNbr: r.person_nbr,
    firstName: (r.first_name ?? '').trim(),
    lastName: (r.last_name ?? '').trim(),
    dob: r.date_of_birth,
    hasMedicalRecord: Boolean(r.has_medical_record),
    language: r.language,
  };
}

/** Reason codes and counts only — never a name, never a date of birth. */
export function describeForLog(callId: string, r: VerificationResult): string {
  return `[VERIFY] ${callId} ${r.verified ? 'VERIFIED' : 'not verified'} reason=${r.reason} candidates=${r.candidates}`;
}

/** Tests only: drop the pool so a fake connection string can be installed. */
export function __resetPoolForTests(): void {
  void pool?.end().catch(() => undefined);
  pool = null;
}
