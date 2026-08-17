/**
 * WHAT A PCP TICKET CANNOT BE FILED WITHOUT.
 *
 * Operator, 2026-08-17: *"we should not be filing tickets in 27 seconds, as
 * good as we can be, 27 seconds is not enough to gather the right information,
 * we should not create a ticket unless we have enough information to do so, a
 * ticket should be blocked without required fields."* And on which fields:
 * *"the most important parts of a ticket are who is calling, who is the call
 * about and how do we contact you."*
 *
 * Three questions, and they are the whole list:
 *
 *   who is calling      → callerName
 *   who it is about     → the patient's name (the caller themselves, when the
 *                         caller IS the patient)
 *   how to reach them   → callbackNumber
 *
 * Everything else — role, organisation, facility type, date of birth — is
 * recorded when offered and ANNOTATED on the ticket when it is not. A staffer
 * can work without a job title. They cannot work without a name and a number.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS WAS TRIED BEFORE AND IT DESTROYED REQUESTS. Read this before touching it.
 *
 * `requireState` used to raise `missing_required_field:<field>` and every
 * ticket tool called it first, so one uncaptured field discarded the whole
 * request. The timeline shipped 2026-08-06 and showed the shape within ten
 * minutes:
 *
 *   e0384db1 (253s): record_pcp_intake x5, create_pcp_task, handoff x3, then
 *                    create_pcp_task again — all ten dying on callbackNumber.
 *   e761053a (215s): five attempts, all on callerName.
 *
 * The caller heard "it seems like there was an issue recording" and nothing was
 * filed. Twenty-one medical-records requests reached the line that day and left
 * no ticket at all. That is why blocking was removed.
 *
 * WHAT IS DIFFERENT NOW, and it is the only reason this is safe to reinstate:
 *
 *   1. A refusal carries GUIDANCE (src/pcp/refusals.ts, 2026-08-16). The agent
 *      is told which question to ask, in words, instead of receiving a slug it
 *      can only retry. Ten identical retries was not a policy failure, it was
 *      an agent with no way out.
 *   2. THE STRIKE FLOOR below. A field may block twice. After that it is
 *      annotated and the ticket files. A caller who will not give a job title,
 *      or who answers "that's the number you already have", cannot lose their
 *      request no matter how stubborn they are.
 *   3. A hangup fallback (sweepPcpUnfiledCall) files whatever was gathered when
 *      the caller drops mid-intake. Without it, "file later" simply moves the
 *      lost-request failure from 27 seconds to 40.
 *
 * All three have to hold. Remove any one and this becomes 08-06 again.
 */

import type { PcpConversationState } from './director';
import { getPcpCallPurpose } from './policy';

/** Field names as the caller would hear them, for the spoken question. */
export const REQUIRED_PROMPTS: Record<string, string> = {
  callerName: 'May I have your full name?',
  patientName: "And who is the call about — the patient's first and last name?",
  callbackNumber: 'What is the best callback number?',
};

export type RequiredField = 'callerName' | 'patientName' | 'callbackNumber';

/**
 * How many times a filing may be held on this call, IN TOTAL.
 *
 * A per-FIELD budget was the obvious design and it is wrong. Three required
 * fields at two strikes each is five refusals before a ticket goes through —
 * which is the exact shape of e0384db1 (ten tool calls, all refused) that this
 * whole module exists to avoid. The caller does not experience "two strikes on
 * callerName"; they experience being asked over and over.
 *
 * So the budget is the CONVERSATION's, not the field's. Three questions is
 * what a reasonable person will answer before it starts to feel like an
 * interrogation, and after the third the request goes through with whatever is
 * still missing written on it.
 */
export const MAX_BLOCKS = 3;

export interface Readiness {
  /** Fields still missing that we are willing to BLOCK on. */
  blocking: RequiredField[];
  /** Missing fields we have stopped blocking on — annotate the ticket instead. */
  annotate: RequiredField[];
  ready: boolean;
}

/**
 * NOT EVERY CALL IS ABOUT A PATIENT.
 *
 * The first version of this asked for a patient's name on every purpose except
 * `patient_caller`. `policy.ts` already knows better — seven purposes carry
 * `patientContextRequired: false`, including `service_inquiry`,
 * `plan_participation`, `provider_information` and
 * `pharmaceutical_representative`. A drug rep has no patient.
 *
 * Left as it was, a rep would be asked "who is the call about — the patient's
 * first and last name?" three times and then handed a ticket annotated "the
 * caller was asked and did not provide it", which is a false statement about
 * the caller on a durable record. Caught in review, 2026-08-17, before it took
 * a call.
 *
 * The policy file is the single source of truth for this; do not re-encode it.
 */
function patientContextNeeded(state: PcpConversationState): boolean {
  if (!state.callPurpose) return false; // nothing to judge from yet
  /**
   * KNOWN GAP, NOT CLOSED HERE. `patient_caller` covers "a patient OR THEIR
   * FAMILY" and carries `patientContextRequired: false`, so a daughter ringing
   * about her mother files under the daughter's name and the mother is never
   * identified.
   *
   * I added a branch here to demand the patient's name in that case. The sixth
   * review pass showed it was dead code — `patientIdentified` short-circuits on
   * the same slug a few lines down and answers `Boolean(callerName)` regardless
   * — and untangling the two safely means changing what department 16 is told
   * about the requester, which is the CAP-clock decision deliberately left
   * unshipped in pcpAgent. Removing the dead branch rather than leaving
   * something that reads like a fix and is not one.
   */
  try {
    return getPcpCallPurpose(state.callPurpose).patientContextRequired;
  } catch {
    // Unknown slug: ask, rather than silently skipping the field on a purpose
    // nobody has classified. Failing towards MORE information is safe here
    // because the block budget bounds it either way.
    return true;
  }
}

/**
 * Is the patient identified?
 *
 * When the caller IS the patient, their own name answers "who is the call
 * about" — asking a person ringing about their own eye drops for "the
 * patient's name" is the interrogation this line keeps being corrected for.
 *
 * `callerIsThePatient` is a STICKY flag on the director rather than a read of
 * the current purpose, and that matters: the records tool reclassifies
 * `callPurpose` to `patient_medical_records_request` before this runs, so a
 * purpose check here could never fire for a patient asking for their own
 * records — the exact interrogation this function exists to prevent, in the
 * one place it was most likely to happen. Also caught in review.
 */
function patientIdentified(state: PcpConversationState): boolean {
  if (state.callPurpose === 'patient_caller' || state.callerIsThePatient) {
    return Boolean(state.callerName);
  }
  return Boolean(state.patientFirstName && state.patientLastName);
}

function isPresent(state: PcpConversationState, field: RequiredField): boolean {
  switch (field) {
    case 'callerName':
      return Boolean(state.callerName);
    case 'patientName':
      // Not required at all when the purpose has no patient behind it.
      return !patientContextNeeded(state) || patientIdentified(state);
    case 'callbackNumber':
      return Boolean(state.callbackNumber);
  }
}

/**
 * What is missing, split by whether we will still hold the ticket for it.
 *
 * `blocksUsed` is how many times a filing has ALREADY been held on this call.
 * The caller of this function owns that counter — it is per call, and it is
 * what stops a determined refusal turning into a lost request. Once the budget
 * is spent, everything still missing moves to `annotate` and the ticket files.
 */
export function ticketReadiness(
  state: PcpConversationState,
  blocksUsed = 0,
): Readiness {
  const fields: RequiredField[] = ['callerName', 'patientName', 'callbackNumber'];
  const absent = fields.filter((field) => !isPresent(state, field));
  const spent = blocksUsed >= MAX_BLOCKS;

  return {
    blocking: spent ? [] : absent,
    annotate: spent ? absent : [],
    ready: spent || absent.length === 0,
  };
}

/**
 * The one question to ask next, and the sentence to ask it with.
 *
 * ONE, deliberately — the whole complaint about this line was bundled
 * questions and improvised sequencing. Asking for the first missing field and
 * nothing else is the same discipline the intake script already follows.
 */
export function nextRequiredAsk(readiness: Readiness): { field: RequiredField; prompt: string } | null {
  const field = readiness.blocking[0];
  if (!field) return null;
  return { field, prompt: REQUIRED_PROMPTS[field] ?? `Please provide ${field}.` };
}

/**
 * Human-readable gap note for a ticket that filed anyway.
 *
 * Says plainly that the field is absent, so nobody reads a blank as something
 * the caller said. Same discipline as the existing FIELD_PLACEHOLDERS.
 */
export function annotationFor(fields: RequiredField[]): string | undefined {
  if (!fields.length) return undefined;
  const labels: Record<RequiredField, string> = {
    callerName: "the caller's name",
    patientName: 'which patient the call is about',
    callbackNumber: 'a callback number',
  };
  return `NOT CAPTURED ON THE CALL: ${fields.map((f) => labels[f]).join('; ')}. The caller was asked and did not provide it.`;
}
