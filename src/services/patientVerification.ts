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
  /**
   * v179: how many charts the answer stands for when one person is charted
   * more than once (same first name, date of birth and phone). Absent for an
   * ordinary single chart.
   */
  chartsOnFile?: number;
  /**
   * v179: the other charts' last names, so a caller who gives either surname
   * is still the same patient (a maiden and a married name, a re-registration).
   */
  alsoKnownAs?: string[];
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

/**
 * A MIRROR THAT JUST TIMED OUT IS STILL DOWN A SECOND LATER, and a live caller
 * must not pay the timeout again for the same answer.
 *
 * Codex P1 on PR #292. One `lookup_patient` can reach the mirror THREE times
 * when the Console is slow: `verifyPatient` waits the full budget and falls
 * back, `lookupInPersonBase` then tries `findByPhone`, and `sharedPatientTools`
 * re-enters with `lookupPatient({ phone })` for a third. At the default 2,500ms
 * that is about 7.5 seconds of silence for a caller, ending in exactly the
 * not-found they would have had at 2.5.
 *
 * So the first failure latches for a short window and the rest of that call
 * answers instantly. Deliberately SHORT — this suppresses a recovered mirror
 * for as long as it lasts, and being wrong here costs identifications, which
 * is the whole point of the change it guards. Long enough to cover one call,
 * not a shift.
 *
 * Only TRANSPORT failures latch. A clean `no_match` is the mirror working.
 */
let mirrorDownUntil = 0;

function mirrorCooldownMs(): number {
  const n = Number(process.env.PATIENT_VERIFY_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
}

function mirrorIsDown(): boolean {
  return Date.now() < mirrorDownUntil;
}

function noteMirrorDown(): void {
  mirrorDownUntil = Date.now() + mirrorCooldownMs();
}

/** Tests only. */
export function __resetMirrorBreakerForTests(): void {
  mirrorDownUntil = 0;
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
  /** v179: the newest-chart tie-break when no visit settles it. */
  source_updated_at?: string | null;
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

  // Already established as unreachable on this call. Go straight to the book
  // rather than spend the caller's patience proving it twice.
  if (mirrorIsDown()) return verifyAgainstSchedule(last, first, dob, input.callerPhone);

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
              ARRAY[cell_phone, home_phone, day_phone, alt_phone, sec_home_phone] AS phones,
              to_char(source_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS source_updated_at
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
    noteMirrorDown();
    console.error(
      `[VERIFY] mirror lookup FAILED (${(e as Error).message}) — falling back to the appointment ` +
        `book, and skipping the mirror for ${mirrorCooldownMs()}ms so this caller does not pay ` +
        'the timeout again',
    );
    return verifyAgainstSchedule(last, first, dob, input.callerPhone);
  }

  const candidates = rows.length;
  if (!candidates) return { verified: false, reason: 'no_match', candidates: 0 };

  const narrowed = narrow(rows, first, input.callerPhone);
  if (narrowed.length === 1) {
    return { verified: true, reason: 'match', candidates, patient: toPatient(narrowed[0]), source: 'mirror' };
  }
  // v179: one person charted twice is one patient, not two (operator,
  // 2026-11-05). Same first name, same date of birth, a phone they share.
  if (oneChartedTwice(narrowed)) return oneOfTheCharts(narrowed, candidates);
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
/**
 * The Console pool, for readers that need the schedule MIRROR as well as the
 * person base (`consoleScheduleFacts`). One pool per process; the breaker and
 * the reset helper below govern it for every caller.
 */
export function getConsolePool(): pg.Pool {
  return getPool();
}

export function __resetPoolForTests(): void {
  void pool?.end().catch(() => undefined);
  pool = null;
  /**
   * AND THE BREAKER WITH IT. Codex P2 on PR #292.
   *
   * The latch is module state that outlives the pool, and every `beforeEach`
   * in `patientVerification.test.ts` calls this helper and nothing else. So a
   * test that provokes ECONNREFUSED left the latch ON, and the next test —
   * the one that installs a deliberately non-settling query to prove the
   * TIMEOUT RACE works — returned early through `mirrorIsDown()` without ever
   * reaching it. That test would have stayed green with the race removed,
   * which makes it decoration.
   *
   * Resetting here rather than in each suite means a file that already knows
   * to drop the pool cannot forget the latch.
   */
  __resetMirrorBreakerForTests();
}

/**
 * WHO IS ON THIS NUMBER, asked of the PERSON BASE rather than the appointment
 * book.
 *
 * `verifyPatient` above cannot answer this: it requires a surname AND a date
 * of birth and returns `bad_input` without them, because a first-name-led
 * search over 915k persons is neither fast nor selective. A phone number is
 * different — `patients_master` indexes all five phone columns, and the
 * Console's own `pm_find_by_phone` returns in about 13ms on five index scans.
 *
 * WHY IT EXISTS. Measured 2026-09-12 over ten days of queue calls: 627 of
 * 2,511 substantive calls (25.0%) ran `lookup_patient` and found NOBODY, and
 * 235 of those ended with no ticket. Of 330 distinct caller numbers behind
 * them, 208 (63%) are in `patients_master`. The appointment book only knows
 * people with appointments in its window; the person base knows everyone.
 * That is standing instruction 14, and this is the read it asks for.
 *
 * A UNIQUE HIT IS AN IDENTITY; ANYTHING ELSE IS NOT. Wayne's number resolves
 * to eight records, and 157,001 of 1,095,736 numbers in the mirror are shared.
 * Two or more people means `ambiguous` and a candidate count — never a guess,
 * which is instruction 6 and the rule the rest of this file already keeps.
 */
/**
 * `firstName` is RULE ZERO step 2 inside the person base: a number shared by
 * several people (28 of 135 phone matches resolve to 2-3, the operator's own to
 * eight) is a candidate to CONFIRM, and the greeting's own question — "Am I
 * speaking with <first name>?" — is the confirmation. When exactly one of the
 * people on the number carries the affirmed first name, that one is the match;
 * when none or several do, the answer stays `ambiguous` and nobody is picked.
 * Same narrowing `verifyPatient` has always used (`narrow`), applied one rung
 * earlier, so the tool no longer has to do it on the appointment book's
 * candidates (v54) once this rung answers first (v85).
 */
export async function findByPhone(rawPhone: string | undefined | null, firstName?: string | null): Promise<VerificationResult> {
  const digits = phoneDigits(rawPhone);
  // Ten is the shortest thing that can identify a US line. Anything shorter is
  // a fragment, and a LIKE on a fragment matches strangers.
  if (digits.length < 10) return { verified: false, reason: 'bad_input', candidates: 0 };
  const last10 = digits.slice(-10);
  if (!isVerificationConfigured()) {
    // Deliberately not an error: this reader is an ADDITION to a ladder that
    // already answered. Saying nothing leaves the previous behaviour exactly
    // as it was, and `verifyPatient` already shouts about the missing secret.
    return { verified: false, reason: 'unavailable', candidates: 0 };
  }
  // The same latch `verifyPatient` sets. On a call that already waited out the
  // budget there, this answers in microseconds instead of spending it again.
  if (mirrorIsDown()) return { verified: false, reason: 'unavailable', candidates: 0 };

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
              ARRAY[cell_phone, home_phone, day_phone, alt_phone, sec_home_phone] AS phones,
              to_char(source_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS source_updated_at
         FROM public.patients_master
        WHERE right(regexp_replace(coalesce(cell_phone,''),     '\\D', '', 'g'), 10) = $1
           OR right(regexp_replace(coalesce(home_phone,''),     '\\D', '', 'g'), 10) = $1
           OR right(regexp_replace(coalesce(sec_home_phone,''), '\\D', '', 'g'), 10) = $1
           OR right(regexp_replace(coalesce(day_phone,''),      '\\D', '', 'g'), 10) = $1
           OR right(regexp_replace(coalesce(alt_phone,''),      '\\D', '', 'g'), 10) = $1
        LIMIT 50`,
      [last10],
    );
    rows = (
      await Promise.race([
        q,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), lookupTimeoutMs())),
      ])
    ).rows;
  } catch (e) {
    noteMirrorDown();
    // A caller is waiting and the ladder already has an answer for them.
    console.error(`[VERIFY] mirror phone lookup FAILED (${(e as Error).message}) — leaving the ladder's answer alone`);
    return { verified: false, reason: 'unavailable', candidates: 0 };
  }

  // One PERSON, not one row: the same human can carry the number in two
  // columns, and counting rows would call that an ambiguous pair.
  const byPerson = new Map<string, Row>();
  for (const r of rows) if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, r);
  const people = [...byPerson.values()];

  if (people.length === 0) return { verified: false, reason: 'no_match', candidates: 0 };
  if (people.length === 1) {
    return { verified: true, reason: 'match', candidates: 1, patient: toPatient(people[0]), source: 'mirror' };
  }
  let left = people;
  if (firstName && firstName.trim()) {
    const picked = narrow(people, firstName.trim(), undefined);
    if (picked.length === 1) {
      console.info(`[VERIFY] ${people.length} people share this number; the affirmed first name picked one`);
      return { verified: true, reason: 'match', candidates: people.length, patient: toPatient(picked[0]), source: 'mirror' };
    }
    left = picked;
  }
  // v179: the people left are one person charted twice (operator, 2026-11-05).
  if (oneChartedTwice(left)) return oneOfTheCharts(left, people.length);
  return { verified: false, reason: 'ambiguous', candidates: people.length };
}

/**
 * ONE PERSON CHARTED TWICE IS ONE PATIENT — v179.
 *
 * Operator, 2026-11-05, choosing (a): records that share a first name, a date
 * of birth and a phone are one patient. Measured on 2026-11-04: of 9 queue
 * calls where the caller said yes to the greeting and the lookup still could
 * not tell who it was, 7 were one person with two charts under different
 * last names (a maiden and a married name, a re-registration) and 2 were two
 * people with the same last name and different dates of birth. Before this,
 * the two charts read as two people, standing instruction 6 refused to pick,
 * and the caller was asked again — 11 and 12 lookups on two of the calls.
 *
 * Standing instruction 6 is unchanged for two PEOPLE: a different date of
 * birth, a different first name, or no phone in common keeps them apart.
 * This only decides when two charts are one person.
 */
function foldName(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

export function oneChartedTwice(rows: readonly Pick<Row, 'first_name' | 'date_of_birth' | 'phones'>[]): boolean {
  if (rows.length < 2) return false;
  const first = foldName(rows[0].first_name);
  const dob = rows[0].date_of_birth;
  if (!first || !dob) return false;
  if (!rows.every((r) => foldName(r.first_name) === first && r.date_of_birth === dob)) return false;
  // A number every chart carries — the "same phone" half of the rule.
  const numbers = rows.map(
    (r) => new Set((r.phones ?? []).map((p) => phoneDigits(p)).filter((d) => d.length >= 10).map((d) => d.slice(-10))),
  );
  return [...numbers[0]].some((n) => numbers.every((set) => set.has(n)));
}

/**
 * Which chart answers for the patient: the one with a medical record, then the
 * one with the most recent visit, then the most recently updated, then the
 * lowest person number (so the same call always gets the same chart).
 */
async function oneOfTheCharts(rows: Row[], candidates: number): Promise<VerificationResult> {
  const withRecord = rows.filter((r) => r.has_medical_record);
  let chosen: Row;
  if (withRecord.length === 1) {
    chosen = withRecord[0];
  } else {
    const pool = withRecord.length ? withRecord : rows;
    const visits = await lastVisits(pool.map((r) => r.person_id));
    chosen = [...pool].sort(
      (a, b) =>
        (visits.get(b.person_id) ?? '').localeCompare(visits.get(a.person_id) ?? '') ||
        (b.source_updated_at ?? '').localeCompare(a.source_updated_at ?? '') ||
        String(a.person_nbr ?? a.person_id).localeCompare(String(b.person_nbr ?? b.person_id)),
    )[0];
  }
  const chosenLast = foldName(chosen.last_name);
  const alsoKnownAs = [
    ...new Set(
      rows
        .filter((r) => r !== chosen)
        .map((r) => (r.last_name ?? '').trim())
        .filter((l) => l && foldName(l) !== chosenLast),
    ),
  ];
  // Counts only — never a name, a date or a chart number.
  console.info(`[VERIFY] ${rows.length} charts on file for one patient (same first name, date of birth and phone); answering with one`);
  return {
    verified: true,
    reason: 'match',
    candidates,
    patient: toPatient(chosen),
    source: 'mirror',
    chartsOnFile: rows.length,
    ...(alsoKnownAs.length ? { alsoKnownAs } : {}),
  };
}

/**
 * The most recent visit on each chart, from the Console's schedule mirror.
 * A visit is a past appointment that was not cancelled, not moved and not
 * marked unkept (the NextGen Bible's §2 rule). Bounded; a failure answers an
 * empty map, and the tie-break falls through to the next rule.
 */
async function lastVisits(personIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (personIds.length < 2) return out;
  try {
    const q = getPool().query<{ person_id: string; last_visit: string }>(
      `SELECT person_id::text AS person_id,
              to_char(max(appointment_date), 'YYYY-MM-DD') AS last_visit
         FROM public.si_appointment_facts
        WHERE person_id = ANY($1::uuid[])
          AND appointment_date <= current_date
          AND is_cancelled IS NOT TRUE
          AND (is_rescheduled IS NOT TRUE OR is_kept IS TRUE)
          AND is_kept IS DISTINCT FROM FALSE
        GROUP BY person_id`,
      [personIds],
    );
    const { rows } = await Promise.race([
      q,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), lookupTimeoutMs())),
    ]);
    for (const r of rows) if (r.last_visit) out.set(r.person_id, r.last_visit);
  } catch (e) {
    console.warn(`[VERIFY] last-visit tie-break unavailable (${(e as Error).message}) — using the newest chart`);
  }
  return out;
}
