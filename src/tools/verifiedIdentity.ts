/**
 * WHAT WE ALREADY KNOW ABOUT THE PERSON ON THIS CALL.
 *
 * Operator, 2026-09-01: *"it is very rare that a new patient will call that
 * line so verification should succeed, if we do our job and validate and pass
 * the patient records along, you will not have this issue."*
 *
 * He is right on both halves, and the second half is the bug.
 *
 * **Verification succeeds.** Over the 14 days to 2026-09-01, `lookup_patient`
 * found the caller on 95% of the queue calls where it ran — 997 of 1,048 on
 * tech, 651 of 698 on surgery, 421 of 442 on optical, 18 of 18 on records.
 *
 * **And then we asked them for it again.** 45 calls in that same window were
 * refused for a date of birth and ended with no ticket — and on **23 of them
 * `lookup_patient` had already identified the patient**. The service returns
 * `patientData.dateOfBirth` and always has; nothing carried it the twenty
 * lines from the lookup to the filing tool, so the agent asked a question the
 * process could already answer, and when the caller could not answer it the
 * request was lost.
 *
 * This is that carry. It is deliberately narrow:
 *
 *  - Only a CERTAIN match is remembered. A phone number can carry a family and
 *    a surname carries several — Wayne's own number resolves to eight records
 *    in the mirror. `identity.unique === false` is never stored, so an
 *    uncertain match still has to be confirmed out loud.
 *  - It is only ever read back for the SAME NAME. A caller ringing about
 *    somebody else gets no borrowed date of birth; the name on the ticket must
 *    be the name we verified.
 *  - It never replaces something the caller actually said. It fills a gap.
 *
 * In memory, for the length of one call, like `gateAttempts.ts` beside it —
 * this is patient data and it has no business being written anywhere durable
 * for the sake of a twenty-line hand-off.
 */

import { isTwilioCallSid } from './callSid';
import { readDobQuietly } from './dobParts';

export interface VerifiedIdentity {
  firstName: string;
  lastName: string;
  /**
   * As the record holds it. Parsed by the caller, never displayed.
   *
   * OPTIONAL, because a verified NAME and a carried-forward date of birth are
   * two different things. A certain unique phone match whose schedule row has
   * no date of birth used to store nothing at all — so the sweep reported
   * "no-name" and dropped a recoverable request from a caller we had
   * positively identified (Codex, PR #268 round 7). `verifiedDobFor` still
   * refuses to answer without one; only `verifiedIdentityFor` is satisfied by
   * a name.
   */
  dateOfBirth?: string;
  /**
   * The office this patient actually attends, as `lookup_patient` already
   * picked it for this queue — the value it returns as `usual_office` and
   * the comment beside it calls "the field this queue routes on".
   *
   * It was computed, handed to the model, and then dropped on the floor,
   * exactly as the date of birth above it was. `file_optical_ticket` never
   * saw it and had only the caller's own words to work from, so an office it
   * could not match became an UNASSIGNED ticket on the one queue whose
   * assignment IS the location.
   *
   * OPTIONAL, and read back under a stricter guard than the date of birth:
   * see `usualOfficeFor`. A name can be checked against the ticket; an office
   * string cannot, so the certainty flag has to carry that weight instead.
   */
  usualOffice?: string;
  /**
   * The match was UNAMBIGUOUS — not a unique hit on a name or a date of
   * birth alone.
   *
   * `lookup_patient` computes this (`sharedPatientTools.ts`: unique AND
   * matchedBy is neither 'name' nor 'dob') and reports it to the model as
   * `identity_is_certain: false`, precisely so the agent does not treat a
   * name-only hit as the person. It then stored the candidate here anyway,
   * with the certainty dropped on the floor — so anything reading this map
   * saw a name-only guess as a verified identity (Codex, PR #268 round 3).
   *
   * That matters most for the teardown sweep, which files a request under
   * this name with nobody watching. Wayne's standing instruction 6 is that
   * verification "refuses to guess between two people"; a name is exactly
   * the field that collides, and these lines get fathers and sons
   * constantly.
   */
  certain: boolean;
}

interface Entry extends VerifiedIdentity {
  at: number;
}

const verified = new Map<string, Entry>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

function norm(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function sweep(now: number): void {
  for (const [k, v] of verified) {
    if (now - v.at > TTL_MS) verified.delete(k);
  }
  if (verified.size > MAX_ENTRIES) {
    let excess = verified.size - MAX_ENTRIES;
    for (const k of verified.keys()) {
      verified.delete(k);
      if (--excess <= 0) break;
    }
  }
}

/**
 * Remember a match the lookup was CERTAIN about.
 *
 * Silently does nothing without a REAL CallSid, without a date of birth, or
 * without both names — an entry that cannot be matched back to a person is
 * worse than no entry, because the whole guard on reading it is the name.
 *
 * THE KEY MUST BE A REAL CALLSID, not merely a non-empty string — found by
 * Codex on PR #244, and it is the most dangerous thing on this branch.
 * `call_sid` is a declared property on the filing tools, so when the injected
 * value is missing the model supplies a sentinel: "unknown", "latest", "none".
 * A truthiness check accepts those, and every call that emits the same
 * sentinel then shares one map entry. Two callers named the same thing — a
 * father and son, which these lines get constantly — would be one key, and
 * `verifiedDobFor` would hand the second caller the FIRST caller's date of
 * birth for a ticket filed in their name. The name guard cannot catch it,
 * because the names match; that is precisely when it fires.
 *
 * A call with no usable SID keeps the old behaviour: nothing is remembered,
 * and the agent asks for the date of birth out loud.
 */
export function rememberVerifiedIdentity(
  callSid: string | undefined,
  identity: Partial<VerifiedIdentity>,
): void {
  // Absent means NOT certain. A caller that forgets to say so must not get
  // the benefit of the doubt on a field this one is about.
  const certain = identity.certain === true;
  /**
   * STORED AS THE RECORD SPELLS IT, MATCHED CASE-INSENSITIVELY.
   *
   * These used to be stored lower-cased, because the only reader compared them
   * and never showed them. The request sweep now puts this name on a ticket a
   * human reads, and "testpatient example" on a patient record is wrong in a
   * way nobody would have caught from a passing test. Matching is unchanged —
   * `norm` is applied at the comparison instead of at the write.
   */
  const firstName = (identity.firstName ?? '').trim();
  const lastName = (identity.lastName ?? '').trim();
  const dateOfBirth = (identity.dateOfBirth ?? '').trim();
  const usualOffice = (identity.usualOffice ?? '').trim();
  // A NAME IS ENOUGH TO REMEMBER. The date of birth is a bonus that the
  // filing tools carry forward; its absence is not a reason to forget who
  // the caller is.
  if (!isTwilioCallSid(callSid) || !firstName || !lastName) return;
  const now = Date.now();
  sweep(now);
  verified.delete(callSid);
  verified.set(callSid, {
    firstName,
    lastName,
    ...(dateOfBirth ? { dateOfBirth } : {}),
    ...(usualOffice ? { usualOffice } : {}),
    certain,
    at: now,
  });
}

/**
 * The date of birth we verified for this call, IF the ticket is for that same
 * person. Returns undefined otherwise — including for a caller filing on
 * somebody else's behalf, which is the case this must never guess at, and
 * now also for a caller we identified from a record that simply has no date
 * of birth on it. That entry still exists so the sweep knows who called; it
 * just has no date to carry forward, and answering undefined is exactly
 * right (Codex, PR #268 round 7).
 */
export function verifiedDobFor(
  callSid: string | undefined,
  firstName: string,
  lastName: string,
): string | undefined {
  // Validated on the READ as well as the write, not because a sentinel could
  // be in the map (the write refuses it) but so the guard survives someone
  // later relaxing the write. Both ends state the same rule.
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = verified.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  if (norm(firstName) !== norm(entry.firstName) || norm(lastName) !== norm(entry.lastName)) {
    return undefined;
  }
  return entry.dateOfBirth;
}

/**
 * The office this patient attends, IF the ticket is for that same person AND
 * the match was unambiguous.
 *
 * TWO GUARDS, WHERE THE DATE OF BIRTH HAS ONE, AND THE ASYMMETRY IS THE POINT.
 * `verifiedDobFor` can be satisfied by the name alone because a wrong date
 * under the RIGHT name is caught by the name comparison — the ticket says who
 * it is about. An office is a bare string with nothing to compare it against,
 * so a family sharing a phone would hand one member's office to another's
 * ticket and nothing downstream would notice. `certain` is what stands in for
 * the missing comparison, and it is required here.
 *
 * Same TTL and same call-sid validation as the other two readers.
 */
export function usualOfficeFor(
  callSid: string | undefined,
  firstName: string,
  lastName: string,
  /**
   * The date of birth the TICKET is being filed under, when the caller gave
   * one. Codex P1 on PR #291: the name guard alone cannot separate a parent
   * and child who share a name, and on that call the filing input already
   * held a date that says outright they are different people. Ignoring it
   * routed the child's ticket to the parent's office silently.
   *
   * OPTIONAL, and its absence changes nothing — the vast majority of calls
   * reach here with no date at all, and refusing them would delete the
   * feature to fix 0.42% of numbers (measured 2026-09-12: 4,633 of 1,095,736
   * numbers in `patients_master` are shared AND carry a name collision).
   */
  dateOfBirth?: string,
): string | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = verified.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  if (!entry.certain) return undefined;
  if (norm(firstName) !== norm(entry.firstName) || norm(lastName) !== norm(entry.lastName)) {
    return undefined;
  }
  /**
   * ONLY AN EXPLICIT, PARSEABLE CONFLICT REFUSES. This asymmetry is the whole
   * safety of the check.
   *
   * A naive string compare would be worse than no check: the stored date
   * comes off a record ("1950-01-02") and the ticket's comes from the model
   * out of speech ("01/02/1950"), so the two disagree textually on calls that
   * are the SAME person. That would silently switch the feature off for
   * everyone to fix a case in 0.42% of numbers.
   *
   * So both sides are parsed, and the office is withheld only when both
   * parsed AND they name different days. Anything unparseable or absent
   * leaves the previous behaviour exactly as it was.
   */
  if (dateOfBirth && entry.dateOfBirth) {
    /**
     * THE QUIET PARSER, NOT THE ANNOUNCING ONE. Codex P2 on PR #291.
     *
     * `normalizeDobParts` emits the `[DOB]` refusal line and the parser-shape
     * telemetry, and both are LIVE COUNTERS — `dobShape` in `tool_timeline` is
     * what settled the "did the model send it, or did the parser refuse it?"
     * question. `file_optical_ticket` parses the same value again a few lines
     * later, so announcing here double-counts one tool attempt; worse, when
     * the office gate returns first it emits a DOB refusal for an attempt
     * whose recorded outcome is missing only the LOCATION.
     *
     * This reader is a comparison, not a filing decision. It has no business
     * moving an instrument.
     */
    const asked = readDobQuietly(dateOfBirth);
    const held = readDobQuietly(entry.dateOfBirth);
    if (asked && held) {
      const differs =
        asked.year !== held.year || asked.month !== held.month || asked.day !== held.day;
      if (differs) return undefined;
    }
  }
  return entry.usualOffice;
}

/**
 * The whole identity verified for this call, or undefined.
 *
 * Added 2026-09-03 for the request sweep. Operator ruling that afternoon:
 * *"no name no ticket."* The sweep files a caller's request from the
 * transcript when the agent did not, and it must never invent a person to
 * hang it on — so it asks here, and stays its hand when the answer is
 * undefined.
 *
 * Same TTL and same call-sid validation as the date-of-birth read. It does
 * NOT take a name to match against, because it is not answering "is this
 * ticket for that person?" — it is answering "who did we establish this
 * caller to be?", which is the question the sweep has.
 */
export function verifiedIdentityFor(callSid: string | undefined): VerifiedIdentity | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = verified.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  /**
   * AN UNCERTAIN MATCH IS NOT AN IDENTITY, and this reader is the one that
   * must not accept one. Its only caller is the teardown sweep, which puts
   * this name on a ticket a human then acts on, with nobody watching the
   * call. A unique hit on a NAME alone is exactly the case Wayne's
   * instruction 6 refuses — and filing one patient's request under another
   * patient's name is worse than not filing it, which is saying something,
   * because "no name, no ticket" already costs 47 recoveries a day.
   *
   * `verifiedDobFor` deliberately keeps its existing behaviour: it answers a
   * different question ("is this ticket for that same person?") and applies
   * its own name guard, and narrowing it is a ticket-path change that
   * BACKEND_HANDOFF says needs a before/after number. Raised, not done here.
   */
  if (!entry.certain) return undefined;
  return {
    firstName: entry.firstName,
    lastName: entry.lastName,
    ...(entry.dateOfBirth ? { dateOfBirth: entry.dateOfBirth } : {}),
    certain: true,
  };
}

/** Tests only. */
export function resetVerifiedIdentities(): void {
  verified.clear();
}

/**
 * FORGET WHAT THIS CALL ESTABLISHED, when a later lookup comes back AMBIGUOUS
 * about the same name.
 *
 * Codex P1 on PR #291. `rememberVerifiedIdentity` is only ever called under
 * `if (uniqueMatch)`, and there was no `else` — so a call that identified
 * somebody early and then hit an ambiguous lookup kept the FIRST entry, with
 * its `certain: true` intact. Every reader here then answered from a result
 * the tool itself had just stopped believing.
 *
 * The office is what made that reachable: a name can be checked against the
 * ticket, an office string cannot, so `usualOfficeFor` leans on `certain` —
 * and `certain` was stale. A parent and child sharing a name and a chart
 * would trade offices on the one queue that assigns BY office.
 *
 * DELIBERATELY NARROW, and the narrowness is the point. Clearing on ANY
 * ambiguous lookup would throw away a good identification whenever the model
 * ran a second, vaguer search — and that entry is what closed the
 * date-of-birth gate that cost 53 of 75 calls. So it clears only when the
 * ambiguity is about the SAME NAME we are holding, which is exactly the
 * collision the readers' name guard cannot see. An ambiguous lookup about
 * somebody else leaves the entry alone; the name guard already covers that.
 *
 * No name to compare means no collision can be established, so nothing is
 * cleared — the same "do not guess" posture as everything else in this file.
 *
 * Returns whether an entry was actually dropped, so a caller can count it.
 */
export function forgetIfSameName(
  callSid: string | undefined,
  firstName: string | undefined,
  lastName: string | undefined,
): boolean {
  if (!isTwilioCallSid(callSid)) return false;
  if (!norm(firstName) || !norm(lastName)) return false;
  const entry = verified.get(callSid);
  if (!entry) return false;
  if (norm(firstName) !== norm(entry.firstName) || norm(lastName) !== norm(entry.lastName)) {
    return false;
  }
  verified.delete(callSid);
  return true;
}
