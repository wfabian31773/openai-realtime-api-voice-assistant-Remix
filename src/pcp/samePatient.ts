/**
 * ONE TICKET PER PATIENT, NOT ONE PER CALL — the agent's half.
 *
 * Operator, 2026-10-16: "go ahead and build the one-ticket-per-patient fix."
 *
 * v87 made a PCP call file ONE ticket: after the first filing, every later
 * `create_pcp_task` skipped the routing doors and either enriched the PCP row
 * or handed back the create-ticket number. That stopped the 61 double tickets
 * it was written for — all of them the SAME request re-filed through a second
 * door. It also assumed a call is about one patient, and a clinic working
 * through a list is not.
 *
 * `CA5f202de2ca35a920f33ab07fd2fc08e5` (2026-10-16 15:51 UTC, 356 s): nine
 * patients, eight confirmations and a cancellation. Thirteen POSTs, twelve
 * answered `cached` on PCP-72764, and the agent told the caller eight times
 * "I've added this to ticket PCP-72764". The ticket ended with the first
 * patient's description, a later patient's name and the first patient's date
 * of birth. Over 2026-10-02..10-16, 11 of 1,850 substantive PCP calls named
 * more than one patient.
 *
 * The ticketing app now opens a ticket per (call, patient) — ticketing-app
 * `lib/pcp/same-patient.ts`. This is the same rule on this side, so the latch
 * opens for a new patient at the same moment the app opens a new ticket: a
 * second patient's request goes through the routing doors as a first filing
 * (a records request reaches Medical Records, a booking reaches the Hub), and
 * a call whose first filing went through create-ticket no longer answers a
 * second patient with the first patient's ticket number.
 *
 * Both repos pin the same case table. Change a row in one, change it in the
 * other.
 *
 * WHEN IN DOUBT, IT SPLITS RATHER THAN MERGES. A duplicate ticket costs a
 * staffer a minute; one ticket carrying two patients puts one person's name
 * beside another person's date of birth.
 */

export type PatientIdentity = {
  firstName?: string | null;
  lastName?: string | null;
  /** YYYY-MM-DD */
  dob?: string | null;
};

/**
 * Case, accents, spacing and punctuation are spelling, not identity. NFKD
 * splits "é" into "e" plus a combining accent, and the strip drops the accent
 * with every other non-alphanumeric — without the split, "é" is one non-ASCII
 * character and the whole letter would go.
 */
export function nameKey(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const key = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
  return key.length > 0 ? key : undefined;
}

function dobKey(dob: string | null | undefined): string | undefined {
  if (!dob) return undefined;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dob.trim());
  if (!m) return undefined;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

export function hasIdentity(p: PatientIdentity): boolean {
  return Boolean(nameKey(p.firstName) || nameKey(p.lastName) || dobKey(p.dob));
}

/**
 * A different date of birth is a different person (a father and a son). A
 * different first name is a different person (twins). A different surname is
 * forgiven only when the first name AND the date of birth agree — a corrected
 * spelling or a maiden name. Absent fields are not conflicts, but at least one
 * name has to actually match.
 */
export function samePatient(a: PatientIdentity, b: PatientIdentity): boolean {
  const fa = nameKey(a.firstName);
  const fb = nameKey(b.firstName);
  const la = nameKey(a.lastName);
  const lb = nameKey(b.lastName);
  const da = dobKey(a.dob);
  const db = dobKey(b.dob);

  const firstBoth = Boolean(fa && fb);
  const lastBoth = Boolean(la && lb);
  const dobBoth = Boolean(da && db);

  if (dobBoth && da !== db) return false;
  if (firstBoth && fa !== fb) return false;
  if (lastBoth && la !== lb) return firstBoth && dobBoth;
  return firstBoth || lastBoth;
}

/**
 * The filing on this call that a request about `patient` belongs to, or
 * `undefined` when it is a new patient and needs a filing of its own.
 * `filings` is oldest first. The same order of tests as the app's
 * `chooseTicketForPatient`:
 *
 *   1. nothing filed yet                        -> undefined (first filing)
 *   2. the current patient is nobody            -> the first filing
 *   3. only a date of birth is known            -> the filing with that date,
 *                                                  else the first filing
 *   4. a filing about the same patient          -> that filing
 *   5. a filing made before anyone was named    -> that filing (claimed)
 *   6. otherwise                                -> undefined (a new patient)
 */
export function filingForPatient<T extends { patient: PatientIdentity }>(
  filings: readonly T[],
  patient: PatientIdentity,
): T | undefined {
  if (filings.length === 0) return undefined;
  const first = filings[0];
  if (!hasIdentity(patient)) return first;

  const named = Boolean(nameKey(patient.firstName) || nameKey(patient.lastName));
  if (!named) {
    const want = dobKey(patient.dob);
    return filings.find((f) => dobKey(f.patient.dob) === want) ?? first;
  }

  return filings.find((f) => samePatient(f.patient, patient))
    ?? filings.find((f) => !hasIdentity(f.patient));
}
