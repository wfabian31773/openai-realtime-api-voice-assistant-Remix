/**
 * v250 — A PATIENT'S REQUEST THAT LEAVES PCP SUPPORT CARRIES THEIR DATE OF
 * BIRTH, OR SAYS IT WAS NOT GIVEN.
 *
 * Operator, 2026-11-14 (v235): "Ask before filing." v235 asks a patient their
 * own date of birth whenever the request concerns a patient
 * (`requestConcernsAPatient`: the purpose's own row, `patient_caller`, the
 * model's `requestIsAboutAPatient`, or a patient named). That leaves one
 * shape: the person on the phone IS the patient (`callerIsThePatient`) and
 * the model recorded a purpose whose row needs no patient, `service_inquiry`
 * on both corpus calls, without the flag. The intake asks nothing more,
 * `create_pcp_task` takes the patient path, the router sends the words to
 * Optical or Technicians, and the ticket reaches a team that works the
 * patient's chart with no date of birth to find it.
 *
 * Measured, PCP agent tickets on the patient path from 2026-11-16 17:23 to
 * 2026-11-19 00:15 UTC (the first and last since v235): 42 tickets, 35 with a
 * date of birth and 7 without. 2 stayed in PCP Support with no ask (practice
 * questions; no chart to find). 3 were asked and the caller did not give one
 * (`askBudgetSpent` holds `patientDob`): 1 in PCP Support, 2 routed out. 2 left
 * PCP Support with no ask at all: VA-87036 to Optical, VA-87143 to
 * Technicians.
 *
 * THE RULE, read at filing because only the router knows where the request
 * goes: a request leaving PCP Support with no date of birth, whose date-of-
 * birth ask is not spent, is asked it once (the same question and budget the
 * intake uses, `OWN_DOB_PROMPT`, `askBudgetFor('patientDob')`). A call inside
 * the 2 s batch window of the ask is the model's own sibling and gets the
 * same question back, spending nothing (the records gate's rule). Past it,
 * the request files, with the gap written on it. A request staying in PCP
 * Support is never asked: the practice questions there need no chart.
 */
import { askBudgetFor, OWN_DOB_PROMPT, type PcpConversationState } from './director';
import { RECORDS_ASK_BATCH_MS, recordsAskKey } from './recordsIntakeGate';

export type OwnDobAsk =
  | { ask: false }
  | { ask: true; spends: boolean; key: string; prompt: string; team: string };

/** `team` is the department the router sends the request to; none means it stays in PCP Support. */
export function ownDobBeforeAnotherTeam(
  state: PcpConversationState,
  team: string | undefined,
  asked: ReadonlyMap<string, number>,
  now: number,
): OwnDobAsk {
  if (!team || state.patientDob) return { ask: false };
  // Keyed on the patient (the director's patient count), so a clinic's
  // second patient on one call is a new ask, as the records gate keys it.
  const key = recordsAskKey('patientDob', state);
  const at = asked.get(key);
  if (at !== undefined && now - at < RECORDS_ASK_BATCH_MS) {
    return { ask: true, spends: false, key, prompt: OWN_DOB_PROMPT, team };
  }
  if ((state.askCounts?.patientDob ?? 0) >= askBudgetFor('patientDob')) return { ask: false };
  return { ask: true, spends: true, key, prompt: OWN_DOB_PROMPT, team };
}

/** What the model is told with the ask. Never spoken. */
export function ownDobAskGuidance(departmentName: string): string {
  return (
    'NOT AN ERROR — say nothing about a system or a problem. This request goes to our ' +
    `${departmentName} team, which works the patient's own chart and needs their date of birth to find it. ` +
    `Ask: "${OWN_DOB_PROMPT}" and stop talking. When the caller answers, call record_pcp_intake with ` +
    'patientDob set to that date (YYYY-MM-DD), then call create_pcp_task again with the same narrative. ' +
    'It is asked once: if they do not give it, call create_pcp_task again and the request files with the gap ' +
    'written on it.'
  );
}
