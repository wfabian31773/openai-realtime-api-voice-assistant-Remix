/**
 * WHAT THE AFTER-HOURS CALLER ALREADY SAID, FOR THE TICKET (v163).
 *
 * Tickets 70148/70149, 70150, 70157, 70160, 70162 and 70170 (2026-10-31..11-01)
 * reached staff with no date of birth and no request type. On 70150 the
 * caller answered the date-of-birth question twice before hanging up, and the
 * ticket still read `Unknown`: the teardown floor read the date of birth only
 * from a CERTAIN lookup match, and the live `create_ticket` filed an omitted
 * `date_of_birth` as a B2B "no DOB" without looking at what the caller said.
 *
 * The bridge already keeps the caller's answer to a date-of-birth ASK per call
 * (`spokenDob.ts`, the queue lanes' backstop since 2026-09-10). This module
 * reads it for the after-hours line, and classifies a floor-filed request with
 * department 8's own taxonomy so the ticket carries a request type.
 *
 * Static imports only: a dynamic import of a per-call store is a second empty
 * copy on Node 20 (v141).
 */
import { dobFromCallerAnswer, spokenDobFor } from '../tools/spokenDob';
import { classifyAfterHoursRequest, type AfterHoursClassification } from '../tools/afterHoursTaxonomy';

/** `YYYY-MM-DD` -> `MM/DD/YYYY`, the shape every after-hours DOB parser reads. */
export function isoDobToUs(iso: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso?.trim() ?? '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : undefined;
}

/**
 * The date of birth the caller gave when asked, or undefined.
 *
 * The bridge's store first (it tracks corrections and refused attempts), then
 * the transcript itself, read by the same window rule — a date counts only in
 * the turn that answered a date-of-birth ask, never a mere mention.
 */
export function dobTheCallerGave(callSid: string | undefined, transcript?: string): string | undefined {
  const stored = isoDobToUs(spokenDobFor(callSid));
  if (stored) return stored;
  if (!transcript?.trim()) return undefined;
  return isoDobToUs(dobFromCallerAnswer(transcript.split('\n')));
}

/**
 * Department 8's request-type pair for a floor-filed request. Never null: an
 * unmatched request takes department 8's own "Other - See Description", so the
 * ticket carries a type the department owns instead of none.
 */
export function floorRequestType(callerText: string): AfterHoursClassification {
  return classifyAfterHoursRequest(callerText).classification;
}
