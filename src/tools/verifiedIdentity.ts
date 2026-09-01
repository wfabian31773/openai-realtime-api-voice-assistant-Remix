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
 * Silently does nothing without a CallSid, without a date of birth, or without
 * both names — an entry that cannot be matched back to a person is worse than
 * no entry, because the whole guard on reading it is the name.
 */
export function rememberVerifiedIdentity(
  callSid: string | undefined,
  identity: Partial<VerifiedIdentity>,
): void {
  const firstName = norm(identity.firstName);
  const lastName = norm(identity.lastName);
  const dateOfBirth = (identity.dateOfBirth ?? '').trim();
  if (!callSid || !firstName || !lastName || !dateOfBirth) return;
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
  if (!callSid) return undefined;
  const entry = verified.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  if (norm(firstName) !== entry.firstName || norm(lastName) !== entry.lastName) return undefined;
  return entry.dateOfBirth;
}

/** Tests only. */
export function resetVerifiedIdentities(): void {
  verified.clear();
}
