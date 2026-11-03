/**
 * THE CALLER'S YES TO THE GREETING CONFIRMS A PHONE MATCH THAT IS ONE PERSON — v170.
 *
 * Operator, 2026-11-03, choosing between the two ways #423 could go: "a yes to
 * 'Am I speaking with <name>?' confirms the caller when only one person on file
 * has that number". That is RULE ZERO step 2 as written (MATCH by phone,
 * VALIDATE, and the caller's answer to the greeting's question IS the
 * validation, v27), and it is what production ran through 2026-10-29.
 *
 * #384 (VA-76205, merged 2026-10-29) made `lookup_patient` count an identity as
 * certain only on a unique name-and-date-of-birth match, so a caller who said
 * yes to their own name was still a candidate: the filing tools refused the
 * chart date of birth and asked for it. Recognised callers, 10-29 against
 * 10-30: asked a date of birth 15 against 132, date-of-birth refusals 3 against
 * 30, filed 235 against 187.
 *
 * What this does NOT bring back: a phone match on its own. Until 10-29 a unique
 * phone hit was certain before anybody had answered anything; here the lookup
 * must carry the first name the caller said yes to (the recognised-caller
 * block tells the model to pass it), and that name must be the record's. A
 * caller who says no, or gives another name, passes no matching name and stays
 * a candidate, so a household member is never filed under the record's chart.
 * A date of birth or a surname the caller DID state must agree with the record
 * as well; one that disagrees leaves the match a candidate.
 *
 * #384's other rules (no unvalidated identity on a ticket, no history read
 * before validation, Optical's history filter) are untouched: this decides
 * only when validation has happened.
 */
import { dobKey } from '../services/callFactsLedger';
import type { PatientScheduleContext } from '../services/scheduleLookupService';
import { nameKey } from './verifiedIdentity';

const firstWord = (s: string | undefined) => nameKey(s).split(' ')[0] ?? '';

export function callerAffirmedThePhoneMatch(
  resolved: Pick<PatientScheduleContext, 'matchedBy' | 'identity' | 'patientData'>,
  spoken: { firstName?: string; lastName?: string; dateOfBirth?: string },
): boolean {
  if (resolved.matchedBy !== 'phone') return false;
  // One person on the number. Several never reach here as a pick (standing
  // instruction 6); v54's narrowing re-resolves one of them on their own trio
  // and reports it unique, which is the caller's affirmed name doing its job.
  if (resolved.identity?.unique !== true) return false;

  const chart = resolved.patientData;
  const said = spoken.firstName?.trim();
  if (!said || !chart?.firstName) return false;
  // The record's whole first name, or — for a compound record name such as
  // "Mary Ann" — its first word said ON ITS OWN. Two compound names that only
  // share a first word ("Mary Jane" against "Mary Ann") are two people
  // (Codex P2 on #423), and a name longer than the record's is not the record.
  // (A name of two words can never equal one word, so one comparison covers both.)
  const saidKey = nameKey(said);
  if (saidKey !== nameKey(chart.firstName) && saidKey !== firstWord(chart.firstName)) return false;

  if (spoken.lastName?.trim() && nameKey(spoken.lastName) !== nameKey(chart.lastName)) return false;

  if (spoken.dateOfBirth?.trim()) {
    const saidDob = dobKey(spoken.dateOfBirth);
    const chartDob = dobKey(chart.dateOfBirth);
    if (!saidDob || !chartDob || saidDob !== chartDob) return false;
  }
  return true;
}
