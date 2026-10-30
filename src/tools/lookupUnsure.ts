/**
 * WHEN A LOOKUP IS UNSURE, DO NOT SAY "NOT FOUND".
 *
 * VA-76221 (internal 67394): the agent told the caller they were "not found
 * in system", then visit history matched the same patient once the spoken
 * name was corrected to the name on the schedule. Two queries, two answers:
 * `lookupByNameAndDOB` is a STRING match on what the caller (or the
 * transcriber) said, and the phone-loaded schedule already held the chart
 * name and the visits. The tool reported the miss; the model spoke the
 * prompt's "not found in system" line.
 *
 * RULE: if a schedule or visit-history match exists — including under the
 * chart's own spelling — do not tell the caller they are not found. Re-run
 * with the chart name when the spoken first name agrees, and when the
 * lookup is still unsure use the line below. The filing tool does not
 * require a match.
 *
 * Spoken-facing copy only. The `fix` is for the model and must not be read
 * aloud (same channel-split as the emergency-rule leak in v43).
 */

import type { PatientScheduleContext } from "../services/scheduleLookupService";

/** The only words the caller should hear when a lookup cannot settle. */
export const LOOKUP_UNSURE_SAY = "Let me make sure the team has your details.";

/** Filing guidance is safe even when the lookup retry budget is exhausted. */
export const LOOKUP_UNSURE_FILE_FIX =
  "Do NOT tell the caller they are not in the system, and do not say we have " +
  "no record of them. A schedule or visit-history match may exist under a " +
  "different spelling of their name. Say exactly: " +
  `"${LOOKUP_UNSURE_SAY}" ` +
  "and file with the name they gave.";

/** Use only while another identity lookup is allowed. */
export const LOOKUP_UNSURE_FIX =
  LOOKUP_UNSURE_FILE_FIX + " If they confirmed the first name on " +
  "file, call this tool again with that chart name.";

/**
 * WHAT THE QUEUE LANES' LOOKUP SAYS ON A MISS — v150.
 *
 * #375 (live 2026-10-28 14:28 UTC) made LOOKUP_UNSURE_SAY the spoken line on
 * EVERY identity miss, and paired it with a fix that said "say exactly this
 * and file" beside "you may ask once more". The line sounds like a sign-off,
 * the two instructions disagree, and the model said it and stopped: on the
 * queue lanes it was said on 0 calls on 2026-10-27, 30 on 10-28 and 32 on
 * 10-29. On 10-28 the silence ladder's "I cannot hear you" broke the silence
 * that followed; v131 (live 10-29 00:56 UTC) correctly stopped saying that to
 * a caller we have heard, and on 10-29 the line was the agent's LAST words on
 * 7 calls, 6 of them with no ticket (tech 4, surgery 1, records 1 of 7).
 *
 * So each miss now speaks the step that comes next, and the model is told one
 * thing, not two. The first miss asks the one re-ask question RULE ZERO 2b
 * shapes (the last name, spelled); the spent ask says the request is being
 * taken and the model files in the same turn. Neither says "not found".
 * LOOKUP_UNSURE_SAY stays for the after-hours line's own lookup.
 */
export const LOOKUP_REASK_SAY = "Could you spell your last name for me, letter by letter?";

/** The miss that spends the identity ask: the request is taken as given. */
export const LOOKUP_CARRY_ON_SAY =
  "Thank you. I'll take your request as given, and the team will match it to your chart.";

const NOT_FOUND_BAN =
  "Do NOT tell the caller they are not in the system, and do not say we have " +
  "no record of them. A schedule or visit-history match may exist under a " +
  "different spelling of their name.";

/** The first identity miss: one re-ask, in the format the funnel needs. */
export const LOOKUP_REASK_FIX =
  NOT_FOUND_BAN +
  " The line in `message` is your next question — have them spell the last name — then ask the date of birth as " +
  "month, then day, then year, and call lookup_patient ONCE more with what they give. " +
  "If they confirmed the first name on file, call this tool again with that chart name. " +
  "If that also misses, do not ask a third time: take the request and file it with what they gave.";

/** The miss that spends the ask: say the line and file in the same turn. */
export function lookupSpentFix(misses: number): string {
  return (
    `This is identity miss number ${misses} on this call. ` +
    NOT_FOUND_BAN +
    " Do NOT call lookup_patient again. Do NOT ask the caller for their name or date of birth again. " +
    "Say the line in `message`, then take the request and file it now with the details they gave, " +
    "in this same turn, before you stop speaking — the filing tool does not require a match."
  );
}

export function chartNameParts(context?: Pick<PatientScheduleContext, "patientName" | "patientData"> | null): {
  first?: string;
  last?: string;
} {
  const fromData = {
    first: context?.patientData?.firstName?.trim() || undefined,
    last: context?.patientData?.lastName?.trim() || undefined,
  };
  const raw = (context?.patientName ?? "").trim();
  if (!raw) return fromData;
  const [first, ...rest] = raw.split(/\s+/);
  return {
    first: first || fromData.first,
    last: rest.join(" ").trim() || fromData.last,
  };
}

/**
 * The book itself matches a first name on a three-character prefix. A
 * spoken "Dana" agreeing with a chart "Danielle" is enough to retry the
 * chart's own spelling; a different first name is a different person.
 */
export function spokenFirstNameAgreesWithChart(
  spokenFirst: string | undefined,
  chartFirst: string | undefined,
): boolean {
  const a = (spokenFirst ?? "").trim().toLowerCase();
  const b = (chartFirst ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.slice(0, 3) === b.slice(0, 3);
}

export function hasVisitHistory(context?: PatientScheduleContext | null): boolean {
  if (!context?.patientFound) return false;
  const past = context.pastAppointments?.length ?? 0;
  const upcoming = context.upcomingAppointments?.length ?? 0;
  return past + upcoming > 0 || (context.totalAppointmentsFound ?? 0) > 0;
}

/** True when a tool payload would teach the model to say the caller is unknown. */
export function payloadSaysNotFound(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    return /\bnot found\b/i.test(value) || /no record found/i.test(value);
  }
  if (typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  // `fix` is model-only and may mention the ban. The caller-facing fields must not.
  return ["message", "say", "spoken"].some((k) => payloadSaysNotFound(rec[k]));
}
