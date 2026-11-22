/**
 * AN AFTER-HOURS TICKET IS NAMED FOR THE PATIENT THE CALL LOOKED UP — v264.
 *
 * The before. On the after-hours line a caller asking for someone else (a
 * parent for a child, a spouse) gives the patient's name and date of birth,
 * `lookup_schedule` confirms that patient, and its answer told the model
 * "file with their first name" (`RECORD_HOLDS_THE_IDENTITY_FIX`). The model
 * read "their" as the caller and filed the CALLER's first name, sometimes the
 * caller's whole name, beside the patient's date of birth. `prepareTicketIdentity`
 * carries the record only when the names agree with it, so the ticket went out
 * under a name that belongs to nobody on file with that date of birth.
 *
 * Measured, no-ivr, `tool_call_payloads` 2026-11-15..22: 110 calls with a found
 * lookup and then a ticket; on 3 the ticket's first name was not the looked-up
 * patient's and its date of birth was:
 *   VA-87261 CA4ce0a96441ccf3658a4763d341d9034a  first and last name the caller's
 *   VA-87782 CA8203233402d094524387c2d4a611741b  first name the caller's
 *   VA-88307 CAcbaf44534d401fb7a2d4369eb44b2374  first name the caller's
 * The control VA-86173 CA234520365651d9181319016c6e4c9a4a filed a second
 * person the call had looked up by that name; it is left as it was.
 *
 * The rule (RULE ZERO step 4, the record wins over a model argument), and every
 * condition must hold or the filing goes out as the model sent it:
 *  1. the call holds a CERTAIN identity (`verifiedIdentityFor`);
 *  2. the filing's date of birth reads and is that identity's;
 *  3. the filing's names are not names that identity answers to
 *     (`validatedPatientFor` finds no match);
 *  4. the filed first name was never sent to `lookup_schedule` on this call,
 *     so the filing is not a second patient the caller named and we looked for;
 *  5. the person base (`patients_master`) does not hold the filed name as a
 *     different patient: it finds nobody with that last name and date of birth,
 *     or it resolves the filed name to the held patient. A twin (same last name
 *     and date of birth, another first name, on file) resolves to the twin and
 *     is never renamed; an ambiguous answer, an unreachable mirror or the
 *     appointment-book fallback renames nothing.
 *
 * What it returns is the record's names and the name the agent filed, for the
 * staff note. The caller's words are never read (standing instruction 3).
 */
import { nameKey, verifiedIdentityFor } from '../tools/verifiedIdentity';
import { readDobQuietly } from '../tools/dobParts';
import { validatedPatientFor } from '../tools/ticketIdentity';
import type { VerificationResult, VerifyInput } from '../services/patientVerification';

export interface FiledName {
  firstName: string;
  lastName: string;
  /** The record's date of birth, ISO (the filing's, read as the same day). */
  dateOfBirth: string;
  /** The name the agent sent, for the staff note on the ticket. */
  filedAs: string;
}

const isoDob = (v?: string): string | undefined => {
  const d = v ? readDobQuietly(v) : null;
  return d ? `${d.year}-${d.month}-${d.day}` : undefined;
};

export async function recordNameForTheFiling(input: {
  callSid?: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  /** nameKey of every first name `lookup_schedule` was called with on this call. */
  lookedUpFirstNames: ReadonlySet<string>;
  verify: (q: VerifyInput) => Promise<VerificationResult>;
}): Promise<FiledName | undefined> {
  const { callSid, firstName, lastName, dateOfBirth } = input;
  const held = verifiedIdentityFor(callSid);
  if (!held || !callSid) return undefined;
  const heldDob = isoDob(held.dateOfBirth);
  const filedDob = isoDob(dateOfBirth);
  if (!heldDob || filedDob !== heldDob) return undefined;
  if (!firstName.trim() || !lastName.trim()) return undefined;
  if (validatedPatientFor(callSid, firstName, lastName, dateOfBirth)) return undefined;
  if (input.lookedUpFirstNames.has(nameKey(firstName))) return undefined;

  let found: VerificationResult;
  try {
    found = await input.verify({ firstName, lastName, dob: filedDob });
  } catch {
    return undefined;
  }
  const nobodyOnFile = found.reason === 'no_match' && found.source !== 'schedule';
  const isTheHeldPatient = found.verified && found.source === 'mirror' && !!found.patient && (
    held.personId
      ? found.patient.personId === held.personId
      : nameKey(found.patient.firstName) === nameKey(held.firstName) &&
        nameKey(found.patient.lastName) === nameKey(held.lastName) &&
        found.patient.dob === heldDob);
  if (!nobodyOnFile && !isTheHeldPatient) return undefined;
  return { firstName: held.firstName, lastName: held.lastName, dateOfBirth: heldDob, filedAs: `${firstName.trim()} ${lastName.trim()}` };
}

/** Staff side of the ticket. It names the agent's filing, which a ticket may carry. */
export function filedUnderAnotherNameNote(filedAs: string): string {
  return `NAME CORRECTED TO THE RECORD: the agent filed this as "${filedAs}" beside the date of birth of the patient ` +
    'this call looked up, and no other patient on file has that name and date of birth, so the record\'s name is used. ' +
    'The caller may be calling for the patient; check the recording if the request is about someone else.';
}
