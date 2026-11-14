/**
 * WHAT A PCP RECORDS REQUEST ASKS BEFORE IT FILES — and where the answers go.
 *
 * Operator, 2026-11-10, on PCP-82755 and the tickets like it: "what good does
 * it do us if we create a ticket that leads us to more work than had we taken
 * the call ourselves." And on 2026-09-16, opening every other PCP gate: "The
 * only thing that we are gating is if it's medical records."
 *
 * MEASURED, PCP records tickets 2026-10-27..11-10 (171): 23 named no patient,
 * and on 18 of those the agent never asked whose records they were; 15 said
 * "Delivery method NOT captured", and on all 15 the caller had answered "by
 * fax, by email, or by mail?". Two causes, both in code:
 *
 *   1. The records tool held only for the delivery method. Its patient check
 *      went through `ticketReadiness` with the module default, and
 *      `FILING_MAY_BE_HELD` has been false since 2026-09-16, so whose records
 *      they were was never asked on the one path that ruling kept gated.
 *   2. The tool asked for the method and had nowhere to put the answer: its
 *      only argument was a narrative, and the field lived on
 *      `record_pcp_intake`, which its refusal never named. On
 *      CAcb222de3b32c7449aa01c3188adc5b6d the caller said "Fax." and the model
 *      called the records tool three more times with "fax" in the narrative;
 *      the strike budget ran out and the ticket said both "fax" and "NOT
 *      captured".
 *
 * So the gate asks, in the order the operator's interview runs (who is
 * calling and from where, who it is about, how to send, where to send), ONE
 * field at a time, and EACH FIELD ONCE. The records tool takes every field it
 * asks for, so the answer lands in the tool that asked. A field asked and not
 * answered is not asked again; when nothing is left to ask, the request files
 * with what is missing written on it, as every PCP filing does.
 *
 * A second call inside `RECORDS_ASK_BATCH_MS` of an ask is the model's own
 * batch, not the caller's answer: it gets the same question and spends
 * nothing (the v79 rule).
 */
import { OWN_DOB_PROMPT, PROMPTS, askBudgetFor, type PcpConversationState } from './director';
import { deliveryAskFor } from './recordsDelivery';
import { REQUIRED_PROMPTS, ticketReadiness, MAX_BLOCKS, type RequiredField } from './ticketRequirements';

export const RECORDS_ASK_BATCH_MS = 2_000;

export type RecordsAskField = RequiredField | 'patientDob' | 'recordsDeliveryMethod' | 'recordsDeliveryDestination';

/** The records tool's own arguments that answer each question. */
export const ANSWERED_BY: Record<RecordsAskField, string> = {
  callerName: 'callerName (and callerOrganization)',
  patientName: 'patientFirstName and patientLastName (or callerIsThePatient: true when the caller is the patient)',
  patientDob: 'patientDob (YYYY-MM-DD)',
  callbackNumber: 'callbackNumber',
  recordsDeliveryMethod: "recordsDeliveryMethod ('fax', 'email', 'mail', or 'unspecified' if they do not know)",
  recordsDeliveryDestination: 'recordsDeliveryDestination (the fax number, email address or mailing address)',
};

export interface RecordsAsk {
  field: RecordsAskField;
  /** What `asked` is keyed on: the field, or the destination for one method. */
  key: string;
  prompt: string;
  /** False when this is a sibling inside the batch window: same question, nothing spent. */
  spends: boolean;
}

/**
 * Every field still missing, in the order they are asked. `asked` is this
 * gate's own asks on the call: a date of birth this gate asked is decided by
 * them (the same question inside the batch window, not asked again after it),
 * never as an ask the intake spent.
 */
export function recordsFieldsMissing(
  state: PcpConversationState,
  asked: ReadonlyMap<string, number> = new Map(),
): Array<{ field: RecordsAskField; prompt: string }> {
  const missing: Array<{ field: RecordsAskField; prompt: string }> = [];
  for (const field of ticketReadiness(state, 0, true).blocking) {
    missing.push({ field, prompt: REQUIRED_PROMPTS[field] ?? `Please provide ${field}.` });
  }
  /**
   * WHOSE RECORDS, THEN THEIR DATE OF BIRTH (v235, operator 2026-11-14: "Ask
   * before filing"). Medical Records finds the chart by it, and 11 of the PCP
   * records tickets of 2026-11-12/13 carried a patient name and no date of
   * birth nobody asked for. Asked once, like every field here, and of the
   * patient themselves in their own words.
   */
  if (!state.patientDob && (asked.has(recordsAskKey('patientDob', state)) || !dobAskSpentByTheIntake(state))) {
    missing.push({ field: 'patientDob', prompt: state.callerIsThePatient ? OWN_DOB_PROMPT : PROMPTS.patientDob! });
  }
  // The delivery ask is sequential (method, then the destination it needs),
  // so only its next field is known at a time.
  const delivery = deliveryAskFor(state);
  if (delivery) missing.push({ field: delivery.field, prompt: delivery.prompt });
  return missing;
}

/**
 * What an ask is remembered by. The destination is asked per method (Box
 * Codex review of 7c8df0ca, P2): a fax number asked and then a switch to email
 * clears the destination, and the email address is a different question that
 * has not been asked. A caller switching back to a method already asked is not
 * asked again.
 */
export function recordsAskKey(field: RecordsAskField, state: PcpConversationState): string {
  if (field === 'recordsDeliveryDestination') return `${field}:${state.recordsDeliveryMethod ?? ''}`;
  /**
   * The date of birth is asked per PATIENT (Codex P2 on #479, round 3). A
   * clinic asking for two patients' records on one call gets the second
   * patient's date of birth asked too. The director decides when the patient
   * changes and counts it (`patientOrdinal`, bumped by the same switch that
   * clears the date of birth and its ask count), so this key follows it and
   * nothing here decides what a new patient resets.
   */
  if (field === 'patientDob') return `${field}:${state.patientOrdinal ?? 0}`;
  return field;
}

/**
 * The next question, or null when the request may file.
 *
 * `asked` maps an ask's key (`recordsAskKey`) to when it was first asked on
 * this call. The caller stamps `ask.key` when `spends` is true.
 */
export function recordsAskFor(
  state: PcpConversationState,
  asked: ReadonlyMap<string, number>,
  now: number,
): RecordsAsk | null {
  for (const { field, prompt } of recordsFieldsMissing(state, asked)) {
    const key = recordsAskKey(field, state);
    const at = asked.get(key);
    if (at === undefined) return { field, key, prompt, spends: true };
    if (now - at < RECORDS_ASK_BATCH_MS) return { field, key, prompt, spends: false };
    // Asked and not answered: not asked again.
  }
  return null;
}

/**
 * ONE DATE-OF-BIRTH ASK PER CALL, WHICHEVER TOOL MADE IT (v235, Codex P2 on
 * #479). The date of birth is asked once (`ASKS_FOR_FIELD`), and the intake
 * (`record_pcp_intake`) and this gate are two places that can ask it. When the
 * intake has spent the ask and the caller could not give it, this gate does
 * not ask again; and the gate's own ask is charged to the intake's count by
 * the records tool, so the intake does not ask after it either. That charge
 * does not make the gate's own ask read as the intake's: a date of birth this
 * gate asked is decided by its own `asked` map, so a sibling call inside the
 * batch window gets the same question and spends nothing (Codex P2 on #479,
 * round 2).
 */
export function dobAskSpentByTheIntake(state: PcpConversationState): boolean {
  return (state.askCounts?.patientDob ?? 0) >= askBudgetFor('patientDob');
}

/** The date of birth, when it was asked and not given — for the ticket's gap note (v235). */
export function recordsDobGap(state: PcpConversationState, asked: ReadonlyMap<string, number>): string | undefined {
  return !state.patientDob && (asked.has(recordsAskKey('patientDob', state)) || dobAskSpentByTheIntake(state))
    ? "NOT CAPTURED ON THE CALL: the patient's date of birth."
    : undefined;
}

/** The identity fields still missing once the asking is over, for the ticket's gap note. */
export function recordsIdentityGaps(state: PcpConversationState): RequiredField[] {
  return ticketReadiness(state, MAX_BLOCKS, true).annotate;
}

/** What the model is told with each ask. Never spoken. */
export function recordsAskGuidance(ask: RecordsAsk): string {
  return (
    'NOT AN ERROR — say nothing about a system or a problem. A records request cannot be worked until we know ' +
    `who is asking, whose records they are and how to send them. Ask: "${ask.prompt}" and stop talking. When ` +
    'the caller answers, call handle_patient_medical_records_request again with the same narrative and ' +
    `${ANSWERED_BY[ask.field]} set to what they said, in their own words. Do not put the answer only in the ` +
    'narrative: the ticket reads the field. Each question is asked once; if they do not answer, call the tool ' +
    'again without it and the request files with the gap written on it.'
  );
}
