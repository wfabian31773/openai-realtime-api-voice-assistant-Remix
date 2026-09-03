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

export interface VerifiedIdentity {
  firstName: string;
  lastName: string;
  /** As the record holds it. Parsed by the caller, never displayed. */
  dateOfBirth: string;
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
  if (!isTwilioCallSid(callSid) || !firstName || !lastName || !dateOfBirth) return;
  const now = Date.now();
  sweep(now);
  verified.delete(callSid);
  verified.set(callSid, { firstName, lastName, dateOfBirth, at: now });
}

/**
 * The date of birth we verified for this call, IF the ticket is for that same
 * person. Returns undefined otherwise — including for a caller filing on
 * somebody else's behalf, which is the case this must never guess at.
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
  return { firstName: entry.firstName, lastName: entry.lastName, dateOfBirth: entry.dateOfBirth };
}

/** Tests only. */
export function resetVerifiedIdentities(): void {
  verified.clear();
}
