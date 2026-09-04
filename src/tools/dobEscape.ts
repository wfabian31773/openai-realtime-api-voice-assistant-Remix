/**
 * ASK ONCE. THEN FILE IT ANYWAY, AND SAY WHY IT IS MISSING.
 *
 * Operator ruling, 2026-09-04:
 *
 *   *"You should coach the patient to say, may I please have your date of
 *   birth starting with the month, then the day, and then the year. So this
 *   way you give them some structure. If it doesn't work that way, then I say
 *   you file it anyway. But when you file it, where date of birth would be,
 *   you just put unavailable or unmatched. So this way we know what was
 *   happening, and then hopefully we can get the transcript, the voice
 *   recording."*
 *
 * WHY THIS IS THE SAME RULING HE ALREADY GAVE, AND THE PROOF IT WORKS
 *
 * 2026-09-01, on optical's office gate: *"if you gate the location, the agent
 * will ask and if no answer, unassigned."* That is `gateAttempts.ts`, and it
 * has been live on optical's `location` ever since.
 *
 * The cutover day measured both gates side by side:
 *
 *   gate hit           calls   still filed
 *   optical location     11         9      <- HAS this escape
 *   date_of_birth        23         0      <- DID NOT
 *
 * Same codebase, same day, same callers. One gate asks once and then lets the
 * request through; the other asked forever. That is the entire difference
 * between 82% recovery and none, and it is why nothing else in this file is a
 * guess — the mechanism is proven on the neighbouring field.
 *
 * WHERE "unavailable" ACTUALLY GOES
 *
 * Not in the date-of-birth columns. `patient_birth_month` and `_day` are
 * `varchar(2)` and `_year` is `varchar(4)` in the ticketing app's schema, so
 * the word does not fit and sending it would risk a 400 that loses the whole
 * request — the opposite of the point. The three fields are simply omitted,
 * which is already valid (create-ticket takes them as optional), and the
 * STATUS goes at the top of the description, which is what staff read.
 *
 * The two cases are kept apart because they mean different things to whoever
 * picks the ticket up:
 *
 *   unavailable — we asked, twice, and never got one. Nothing to check.
 *   unmatched   — they gave us something and it would not read as a date.
 *                 The recording has the answer; the transcript may too.
 */
import { gateRefusalsSoFar, noteGateRefusal } from './gateAttempts';

export type DobStatus = 'unavailable' | 'unmatched';

/**
 * What to do about a date of birth we could not use.
 *
 * `askAgain` on the first refusal only. After that the caller has been asked
 * with the coaching wording and it did not work, and a request is worth more
 * than a birthday.
 */
export type DobDecision =
  | { askAgain: true }
  | { askAgain: false; status: DobStatus };

export function decideDobEscape(
  callSid: string,
  toolName: string,
  /** What the model sent, after trimming. Empty means it sent nothing. */
  spokenDob: string,
): DobDecision {
  const askedAlready = gateRefusalsSoFar(callSid, toolName, 'date_of_birth') > 0;
  if (!askedAlready) {
    noteGateRefusal(callSid, toolName, 'date_of_birth');
    return { askAgain: true };
  }
  return { askAgain: false, status: spokenDob ? 'unmatched' : 'unavailable' };
}

/**
 * The line staff see first, above the caller's own words.
 *
 * Deliberately shouty and deliberately free of the date itself — if the caller
 * said something we could not read, that something is PHI and belongs in the
 * recording, not in a description that travels into an SMS.
 */
export function dobStatusNote(status: DobStatus): string {
  return status === 'unavailable'
    ? 'DATE OF BIRTH UNAVAILABLE — asked twice on this call and never given. '
      + 'Confirm identity from the call recording before matching this to a chart.'
    : 'DATE OF BIRTH UNMATCHED — the caller gave one and it could not be read as a date. '
      + 'The call recording has what they said. Confirm before matching this to a chart.';
}

/**
 * DEPLOY MARKER AND LIVE COUNTER. Prints only when the escape is taken, so its
 * first appearance proves the build is live and its rate is how many requests
 * this ruling is saving. Never the date, never a name — see dobShape.
 */
export function dobEscapeMarker(toolName: string, status: DobStatus, callSid: string): string {
  return `[DOB ESCAPE] ${toolName}: asked once and still no usable date of birth — `
    + `filing anyway, marked ${status} (${callSid})`;
}
