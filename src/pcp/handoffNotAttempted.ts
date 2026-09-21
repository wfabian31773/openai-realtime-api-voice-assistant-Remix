import { getPcpCallPurpose } from './policy';
import type { PcpCallPurposeSlug, PcpDisposition } from './policy';

/**
 * WHY NO DIAL WENT OUT, stated on the ticket instead of inferred from its
 * absence.
 *
 * THE DEFECT THIS CLOSES, measured in `voice_agent_api_logs` on 2026-09-19
 * rather than reasoned about. The ticketing app refuses a `CREATE_TASK` on a
 * purpose whose default disposition is `HAND_OFF` unless the payload explains
 * itself, and until ticketing-app #291 that refusal was a bare HTTP 500 with
 * no field guidance — which the model reads as retryable:
 *
 *   7 calls, 41 refused POSTs, worst storm 8 POSTs on one call, 09-15..09-18
 *     grievance_follow_up          4 calls / 25 POSTs
 *     peer_to_peer                 2 calls / 10 POSTs
 *     health_plan_visit_inquiry    1 call  /  6 POSTs
 *
 *   3 calls came through this agent's `handoff_not_eligible` fallback
 *   4 NEVER ATTEMPTED A HANDOFF AT ALL
 *   0 carried a handoff block of any kind
 *
 * `grievance_follow_up` is fixed on the app side alone — its default flips to
 * `CREATE_TASK` and it routes to After Hours (operator, 2026-09-21). What is
 * left for this side is the 3 calls on the two purposes that still default to
 * `HAND_OFF`: `peer_to_peer` and `health_plan_visit_inquiry`.
 *
 * WHY THE GUARD IS WORTH SATISFYING RATHER THAN REMOVING. The reason is the
 * only thing that separates a CORRECTLY ticketed peer-to-peer from a LOST
 * transfer, and nothing in the ticket data can tell those apart today. That is
 * v20's `method: 'blind'` argument: the distinction travels with the record or
 * it is not recoverable.
 *
 * EACH VALUE IS ONE CODE PATH, NOT A RANKED PREDICATE — and that choice is the
 * v29 lesson applied before it could cost anything. Round 2 of #310 keyed a
 * rule on a FIELD and got it wrong because the field was absent on one of the
 * three branches that should have triggered it; the fix was to key on what the
 * code's own discriminator says. So this reads two latches the agent sets at
 * the exact points those things happen, rather than re-deriving overlapping
 * facts like `handoffEligible` and `callerRequestedHuman` and then arguing
 * about which outranks which:
 *
 *   caller_declined_queue  the caller was warned, offered the queue, said no
 *   not_eligible           `handoff_to_pcp` ran and was refused as ineligible
 *   not_requested          neither happened, and the caller never asked for a
 *                          person — which is the operator's own default rule
 *                          (2026-09-04: "never auto-transfer; transfer only
 *                          when the caller ASKS and is an entity")
 *
 * AND `undefined` IS A MEANINGFUL ANSWER, not a gap. A caller who asked for a
 * person, was never refused and never declined, whose request is then filed as
 * a task, IS a lost transfer — so nothing is sent, the app refuses, and after
 * #291 that refusal is a 422 carrying the server's own words and
 * `retryable: false` instead of a storm. The request is not lost either way:
 * `sweepPcpUnfiledCall` admits a caller whose explicit ask went unhonoured
 * (v19), which is exactly this population.
 */
export const PCP_HANDOFF_NOT_ATTEMPTED_REASONS = [
  'caller_declined_queue',
  'not_eligible',
  'not_requested',
] as const;

export type PcpHandoffNotAttemptedReason = (typeof PCP_HANDOFF_NOT_ATTEMPTED_REASONS)[number];

export type HandoffNotAttemptedFacts = {
  /**
   * The purpose's own default, from the policy table — never a model argument.
   *
   * OPTIONAL, AND THAT IS LOAD-BEARING RATHER THAN TIDINESS. `getPcpCallPurpose`
   * THROWS on a slug the table does not know, and the function this feeds is
   * called from `buildPayload`, which eight call sites use — including the
   * teardown sweep at `pcpAgent.ts:2931`, the lost-request floor itself. A
   * throw there would lose exactly the request the floor exists to save, which
   * is the v18 shape arriving through a change written to stop it. So the
   * caller reads the table WITHOUT throwing and passes undefined if it cannot,
   * and an unknown purpose simply sends no reason: the app then decides, and
   * after ticketing-app #291 its refusal is a 422 with words rather than a
   * storm.
   */
  purposeDefaultDisposition?: PcpDisposition;
  /** The disposition being filed. */
  disposition: PcpDisposition;
  /** `pcpDirector` latch: the caller was offered the queue and declined. */
  callerDeclinedTheQueue?: boolean;
  /** `pcpDirector` latch: `handoff_to_pcp` ran and was refused as ineligible. */
  handoffRefusedAsIneligible?: boolean;
  /** `pcpDirector` latch: the caller explicitly asked to speak to a person. */
  callerRequestedHuman?: boolean;
};

/**
 * ONLY ON THE ONE SHAPE THE APP ASKS ABOUT. A purpose that already defaults to
 * `CREATE_TASK` has no dial to explain, and a ticket filed as `HAND_OFF` is a
 * dial rather than an absence of one — sending a reason on either would put a
 * field on the record that answers a question nobody asked.
 */
export function handoffNotAttemptedReason(
  facts: HandoffNotAttemptedFacts,
): PcpHandoffNotAttemptedReason | undefined {
  if (facts.purposeDefaultDisposition !== 'HAND_OFF') return undefined;
  if (facts.disposition !== 'CREATE_TASK') return undefined;
  if (facts.callerDeclinedTheQueue) return 'caller_declined_queue';
  if (facts.handoffRefusedAsIneligible) return 'not_eligible';
  if (facts.callerRequestedHuman) return undefined;
  return 'not_requested';
}

/**
 * The purpose's default disposition, or undefined if the slug is unknown or
 * absent. See `purposeDefaultDisposition` above for why this must not throw.
 */
export function defaultDispositionFor(slug: string | undefined): PcpDisposition | undefined {
  if (!slug) return undefined;
  try {
    return getPcpCallPurpose(slug as PcpCallPurposeSlug).defaultDisposition;
  } catch {
    return undefined;
  }
}
