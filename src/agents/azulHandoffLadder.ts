/**
 * WHAT HAPPENS WHEN A CALLER ASKS FOR A PERSON.
 *
 * Operator's ruling, 2026-08-16/17:
 *
 *   "Before we can pass any call onto the front desk, we gather the
 *    information patient, verify the intent, what's the call about... At that
 *    point, if it's a scheduling situation, that's where the agent needs to
 *    say, hey, I can get this done for you and probably a lot quicker than the
 *    front desk... But if it's something else regarding a situation that we're
 *    not prepared to do outside of scheduling, then you go ahead and pass it
 *    through. But on first iteration, we should at least push back to try to
 *    minimize those calls that are moving forward that shouldn't be."
 *
 * WHY THIS EXISTS AT ALL. `patient_requested_human` is the single dominant
 * reason this line hands off: 237 of 455 handoffs, at a median of 24 seconds
 * into the call, and the FIRST tool call on 33 of them. Corroborated against
 * the transcripts at 91% — the callers really are asking, and they are asking
 * almost immediately. Meanwhile only 12% of calls ever reach a booking attempt,
 * and booking confirms 71% of the time once it is reached. A large share of
 * those transfers are people who could have been finished on the line.
 *
 * TWO GATES, NOT ONE, because the ruling has two clauses.
 *
 *   1. THE INTENT GATE. Nothing reaches the front desk before we know who is
 *      calling and what about. This is not a deflection — it is the packet the
 *      warm transfer briefing is built from, and it applies to every reason.
 *   2. THE OFFER. Only when the request is something this line can actually
 *      finish. Once per call. If they say no, or ask again, they go through.
 *
 * WHY THE MODEL CLASSIFIES AND THE SERVER ENFORCES. Deciding whether "I need
 * to move my Tuesday appointment" is schedulable is a language judgement, and
 * the standing instruction is explicit that this is the model's job, not a
 * regex's — the operator settled that argument in July and was right. So
 * `schedulableHere` is a parameter the model fills in. What the server owns is
 * the LADDER: how many times we may push back, and what is said when we do.
 * That split is the same one the PCP refusals landed on this morning.
 *
 * WHAT THIS NEVER DOES. It never refuses a transfer outright, never says no,
 * and never pushes back twice. A caller who asks a second time is a caller who
 * has told us the answer.
 */

export type Schedulable = 'yes' | 'no' | 'not_established';

/**
 * Reasons that go straight through. A caller who is angry, in pain, or stuck
 * behind a broken tool is not someone to negotiate with — the deflection is
 * only ever for the plain "can I speak to someone".
 */
export const NEVER_DEFLECTED = new Set([
  'urgent_symptom',
  'patient_frustrated',
  'api_failure',
  'multiple_patient_matches',
  'patient_identity_uncertain',
  'queue_transfer_failure',
  'booking_status_unknown',
  'surgery_or_post_op_issue',
]);

export interface LadderInput {
  handoffReason: string;
  /** The model's judgement: can THIS line finish what they need? */
  schedulableHere?: Schedulable;
  /** What the call is about, in the model's words. Absent = not established. */
  reasonForCall?: string;
  /** Has the one permitted offer already been made on this call? */
  offerAlreadyMade: boolean;
}

export type LadderVerdict =
  | { allow: true }
  | { allow: false; code: 'intent_required' | 'offer_first'; say: string; guidance: string };

/**
 * The lines. Operator gave the substance and left the wording to me.
 *
 * `askIntent` acknowledges and asks in ONE breath. It deliberately does not say
 * "before I can transfer you" — that frames the question as a hoop, and the
 * people most likely to resent a hoop are exactly the ones who already did not
 * want to talk to a machine. It promises the transfer and gathers the packet at
 * the same time.
 *
 * `offer` gives a REASON (faster) and asks permission rather than announcing a
 * refusal. "Shall I go ahead?" is answerable with one word in either direction,
 * which matters when the caller is already slightly impatient.
 */
export const LADDER_LINES = {
  askIntent: "Of course — so I can get you to the right person, what's it regarding?",
  offer:
    'I can take care of that for you right now — usually quite a bit quicker than waiting for the front desk. ' +
    'Shall I go ahead?',
} as const;

export function ladderVerdict(input: LadderInput): LadderVerdict {
  const { handoffReason, schedulableHere, reasonForCall, offerAlreadyMade } = input;

  // Urgency and genuine breakage outrank the ladder entirely.
  if (NEVER_DEFLECTED.has(handoffReason)) return { allow: true };

  /**
   * THE INTENT GATE — every reason, not just a request for a person.
   *
   * "Before we can pass any call onto the front desk, we gather the
   * information patient, verify the intent, what's the call about."
   *
   * A handoff with no stated reason also produces a briefing with nothing in
   * it, so the staffer who picks up starts from zero and the patient repeats
   * themselves — the thing the warm transfer exists to prevent.
   */
  const intentKnown = Boolean(reasonForCall && reasonForCall.trim().length >= 3);
  if (!intentKnown) {
    return {
      allow: false,
      code: 'intent_required',
      say: LADDER_LINES.askIntent,
      guidance:
        'NOT AN ERROR — do not apologize and do not mention a system. You have not established what this call is about, ' +
        'so there is nothing to tell the front desk. Say the `say` line, listen, then call sage_handoff again with ' +
        'reasonForCall filled in and schedulableHere set. Never tell the caller you cannot transfer them.',
    };
  }

  // Only a plain request for a person is ever deflected, and only once.
  if (handoffReason !== 'patient_requested_human' || offerAlreadyMade) return { allow: true };

  /**
   * THE OFFER — only when this line can actually finish the job.
   *
   * `no` means billing, records, prescriptions, a clinical question: things
   * this line cannot do, where holding the caller up would be pure friction.
   * Those pass straight through with the packet already gathered.
   */
  if (schedulableHere !== 'yes') return { allow: true };

  return {
    allow: false,
    code: 'offer_first',
    say: LADDER_LINES.offer,
    guidance:
      'NOT AN ERROR — say nothing about transfers being restricted. This is something you can finish on this call. ' +
      'Say the `say` line, then FOLLOW THEIR ANSWER. If they accept, handle it now — you can book, reschedule, ' +
      'cancel and confirm appointments. If they decline, or ask for a person again, call sage_handoff once more and ' +
      'they will go through. Ask ONCE. Never push back a second time.',
  };
}
