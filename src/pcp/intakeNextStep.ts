/**
 * WHAT `record_pcp_intake` HANDS THE MODEL WHEN THE INTAKE HAS NOTHING LEFT
 * TO ASK.
 *
 * The tool returned the director's decision as it stood. Two things in that
 * reply sent the model the wrong way, and both are measured:
 *
 * 1. `intakeMissing` WENT TO THE MODEL. v155 (#409, live 2026-10-30) added it
 *    to the decision so the ticket's "[Intake incomplete ...]" note reads the
 *    director's own list, and the tool returned the whole decision, so the
 *    model got it too. On a professional call that list still names the
 *    caller's title and email, which `ENRICHMENT_AFTER_FILING` holds back
 *    until a request is filed (v37). The model read "missing: callerRole,
 *    callerEmail" and asked both, before anything was filed.
 *
 * 2. NOTHING SAID WHAT TO DO NEXT. When `nextQuestion` is empty and no
 *    disposition is recorded, the reply was a disposition slug and four
 *    booleans. On an AUTOMATE purpose (the agent is meant to answer from an
 *    approved lookup) a caller who wanted something no lookup answers left
 *    the model with no step at all. Since v136 (live 2026-10-29) the model
 *    cannot pick `unclassified_call`, and it labels those calls
 *    `service_inquiry`, an AUTOMATE purpose, so this dead end went from rare
 *    to daily.
 *
 * Measured, PCP calls of 30 s or more that reached the end of the intake
 * (`nextField` null), never called create_pcp_task, the records tool,
 * handoff_to_pcp or record_automated_resolution, were not transferred and
 * left no ticket:
 *
 *   2026-10-20..28 (7 days, before v136)   20 calls, 1 asked title or email
 *   2026-10-29 (v136, before v155)          8 calls, 0 asked
 *   2026-10-30, 11-02, 11-03 (both live)   32 calls, 25 asked title or email
 *
 * So the fix is two lines of behaviour:
 *   - the ticket-only list stays on this side (`ticketState()` reads it from
 *     `next()` directly and is unchanged), and
 *   - when the intake is done and nothing is on record, the reply names the
 *     next step: connect a caller who asked for a person, answer from the
 *     purpose's approved lookup, or file. All three are paths the prompt and
 *     the policy table already allow; nothing here grants a transfer or a
 *     disposition the director does not already permit.
 *
 * Model-facing only. `guidance` is the channel the prompt tells the model to
 * follow and never read out.
 */
import { getPcpCallPurpose } from './policy';
import type { PcpConversationState, PcpDirectorDecision } from './director';

/** A short code for the timeline: which next step the reply named. No caller data. */
export type PcpIntakeNextStep = 'connect_answer_or_file' | 'file';

/** The filing line the prompt already scripts for create_pcp_task. */
export const FILING_LINE = 'Let me get this logged for you — one moment.';

const LOOKUP_FOR_SOURCE: Record<string, string> = {
  knowledge_base: 'get_public_practice_information',
  scheduling: 'lookup_patient_appointments',
};

/**
 * The next step when the intake has nothing more to ask, or undefined when it
 * still has a question, a request is already on record, or the director has
 * already granted a transfer (the prompt's own transfer rules take that).
 */
export function nextStepWhenIntakeIsDone(
  decision: PcpDirectorDecision,
  state: PcpConversationState,
): { nextStep: PcpIntakeNextStep; guidance: string } | undefined {
  if (decision.nextQuestion) return undefined;
  if (state.dispositionRecorded) return undefined;
  if (!state.callPurpose) return undefined;
  if (decision.handoffEligible) return undefined;

  const isPatient = state.callPurpose === 'patient_caller' || Boolean(state.callerIsThePatient);
  if (isPatient) {
    return {
      nextStep: 'file',
      // The prompt asks a patient for what they need before filing, and its
      // callback rules (a number seeded from caller ID is not asked for unless
      // the caller offers another) stand as written; this names the step only.
      guidance:
        'The intake has nothing more to ask. If you do not yet know what they need, ask that first. ' +
        `Then say "${FILING_LINE}" and call create_pcp_task.`,
    };
  }

  const purpose = getPcpCallPurpose(state.callPurpose);
  const lookup = purpose.authoritativeSource ? LOOKUP_FOR_SOURCE[purpose.authoritativeSource] : undefined;
  const mayAnswer = Boolean(
    lookup && purpose.allowedDispositions.includes('AUTOMATE') && decision.authoritativeToolAllowed,
  );

  const steps = [
    'If the caller asked to speak to a person, call handoff_to_pcp now, with their words in the narrative.',
    mayAnswer
      ? `If what they want is something ${lookup} answers, call it (follow its description), tell them the answer, then call record_automated_resolution.`
      : undefined,
    `Otherwise say "${FILING_LINE}" and call create_pcp_task.`,
  ].filter(Boolean);

  return {
    nextStep: 'connect_answer_or_file',
    guidance:
      'The intake has nothing more to ask before this request is handled. ' +
      'Do not ask for their title, role or email address now: create_pcp_task hands you those questions after the request is filed. ' +
      `Do one of these on this turn. ${steps.join(' ')}`,
  };
}

/**
 * The reply `record_pcp_intake` returns: the decision without the ticket-only
 * `intakeMissing` list, plus the next step when the intake is done.
 */
export function intakeReplyForTheModel(
  decision: PcpDirectorDecision,
  state: PcpConversationState,
): Omit<PcpDirectorDecision, 'intakeMissing'> & { nextStep?: PcpIntakeNextStep; guidance?: string } {
  const { intakeMissing: _forTheTicketOnly, ...reply } = decision;
  const next = nextStepWhenIntakeIsDone(decision, state);
  return next ? { ...reply, ...next } : reply;
}
