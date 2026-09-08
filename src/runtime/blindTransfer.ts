/**
 * BLIND TRANSFER — the caller is handed straight into the PCP call-centre
 * queue, told so first, and their ticket is already filed.
 *
 * ## Why this exists, and what it replaces
 *
 * `warmTransfer.ts` never moves the caller until a human has picked up and
 * pressed a key. That is the right shape when the destination is a PERSON: a
 * failed dial leaves the caller with the agent, and the agent takes a message.
 *
 * `PCP_HUMAN_AGENT_NUMBER` is not a person. Operator, 2026-09-08, asked
 * directly: *"No, it's a call center."* Three to four agents, 200-250 calls a
 * day, and the auto-attendant already routes those calls to US — we intercept
 * them BEFORE they reach the queue and hand them back to it.
 *
 * Against a queue the warm shape has a cost the measurements make concrete.
 * Ring-to-accept on the real PCP number ran 17-41 seconds (avg 32) across the
 * 25 recorded transfers, and the runtime says NOTHING while it rings — the old
 * core's HOLD_LADDER lives only in `azulSchedulingAgent`. On 2026-09-08 a
 * caller sat through that silence and hung up. So the warm transfer's own
 * safety property was buying proof-of-answer with the caller's patience, on a
 * destination where a queue answering is the normal case anyway.
 *
 * The operator's supervisor (Rosa, 2026-09-08) settled it: *"we should scrap
 * the warm transfer and provide a verbal warning that they will be transferred
 * to the live queue where there is no guarantee of wait time... a ticket should
 * be created even when they are transferred."*
 *
 * ## What this deliberately gives up, and what it does not
 *
 * GIVEN UP: the keypress. A digit is positive proof that a live person is on
 * the line; a `<Dial>` into an ACD proves only that the ACD answered. Nothing
 * here should ever be recorded as `accepted` — see `outcome: 'handed_to_queue'`
 * and `'queue_answered'` in `transferOutcomeLog.ts`, which exist so a blind
 * transfer cannot be counted as a warm one.
 *
 * NOT GIVEN UP: the ticket, which is filed BEFORE the redirect exactly as it
 * was; the destination policy, which the model still never supplies; or the
 * outcome record — `<Dial action>` posts the real `DialCallStatus` back, so we
 * still learn whether the queue answered and for how long. That callback is
 * handled by `blindTransferDialResult.ts`.
 *
 * ## The warning is spoken by TwiML, not by the agent, and that is on purpose
 *
 * Moving the caller means `calls(sid).update({twiml})`, which ENDS the media
 * stream — so anything the agent is still saying is cut off mid-word. The
 * bridge's mark accounting can tell us when a line has actually played, but
 * gating the redirect on it would put a Twilio round trip between the caller's
 * last word and the transfer, on the path this change exists to make faster.
 *
 * Putting the operator-approved sentence in the redirect TwiML makes it
 * unconditional: it cannot be truncated by a barge-in, a guardrail, or the
 * stream's own death, because it plays on the leg AFTER the stream is gone.
 * The cost is one sentence in a different voice, which is the operator's call
 * to change and is one env var (`BLIND_TRANSFER_VOICE`) wide.
 */
import type { TransferOutcome, TransferTwilioOps } from "./warmTransfer";

/**
 * WHAT THE CALLER HEARS, WORD FOR WORD. Approved by the operator on
 * 2026-09-08: "that wording is fine."
 *
 * Three things it has to do at once, and each clause is one of them:
 *   - say what is about to happen ("put you through to our PCP team's line"),
 *     because the line goes quiet the instant it does;
 *   - refuse to promise a wait, which is Rosa's whole point — the queue's
 *     depth is not ours to predict, and #265 forbids "they'll be right with
 *     you" copy;
 *   - say the details are already recorded, so a caller who gives up in the
 *     queue knows they have not lost their request.
 *
 * Pinned by test. Changing it is an operator decision, not an editing one.
 */
export const BLIND_TRANSFER_WARNING =
  "I'm going to put you through to our PCP team's line now. " +
  "I can't tell you how long the wait will be — and I've taken your details down, " +
  "so they have them either way.";

/**
 * What the caller hears when the queue never answered at all.
 *
 * Same sentence as the `handoff_no_answer` refusal in `src/pcp/refusals.ts`,
 * and it must stay that way: #265 forbids saying anyone is busy or will be
 * available shortly, and standing instruction 10 forbids telling anybody to
 * call back. This states the fact, states the record, and stops.
 */
export const BLIND_TRANSFER_NO_ANSWER =
  "I wasn't able to get someone on the line just now, but I have your request " +
  "recorded and the team will follow up with you.";

/**
 * How long Twilio rings the queue before giving up on it.
 *
 * Deliberately the same 45 seconds the warm path rings for
 * (`OFFICE_DIAL_TIMEOUT_SECONDS`), because it is the same destination and the
 * same measured 17-41s answer window. This timeout governs ANSWERING only —
 * once the ACD picks up, the caller sits in its own hold queue for as long as
 * that takes, which is the entire point of the design.
 */
export const QUEUE_DIAL_TIMEOUT_SECONDS = 45;

export interface BlindTransferRequest {
  /** The caller's live Twilio leg — the one carrying the media stream. */
  callerCallSid: string;
  /** Where to send them. Resolved by policy; the model never supplies it. */
  destination: string | null | undefined;
}

export interface BlindTransferDeps {
  twilio: Pick<TransferTwilioOps, "redirectCallerToQueue">;
  /** Absolute URL Twilio posts the finished `<Dial>` result to. */
  dialResultUrl: string;
  /** Caller ID presented to the queue. */
  callerId?: string;
  /** Invoked immediately BEFORE the redirect — it ends the Media Stream, and
   * the resulting close must be recorded as a transfer rather than a caller
   * hangup. The close races the redirect's own resolution, so the mark has to
   * precede it (the same ordering warmTransfer.ts documents). */
  onCallerRedirectStarting?: () => void;
  /** Invoked FIRST in the failure path, so a later genuine hangup on the
   * still-live call is not mislabeled as a transfer. */
  onCallerRedirectFailed?: () => void;
  log?: (line: string) => void;
}

/**
 * Hand the caller to the queue. Resolves with what we know AT THE REDIRECT —
 * never with a claim that anybody answered.
 *
 * `ok: true` here means "the caller is no longer ours", not "the caller
 * reached a person". The distinction is carried in `method: 'blind'`, and
 * every consumer that turns a `TransferOutcome` into a record or a ticket
 * status branches on it.
 */
export async function performBlindTransfer(
  request: BlindTransferRequest,
  deps: BlindTransferDeps,
): Promise<TransferOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const destination = request.destination?.trim();

  if (!destination) {
    // Identical to the warm path: no number configured is not a dial failure.
    // Nothing was attempted, and saying so lets the agent take a message
    // instead of implying it tried.
    return {
      ok: false,
      status: "UNAVAILABLE",
      reason: "transfer_destination_not_configured",
      method: "blind",
    };
  }

  try {
    // BEFORE the redirect. The redirect ends the Media Stream and the close
    // can beat this await's own resolution; an unmarked close records the
    // transfer as a caller hangup (Codex, PR #230 round 2).
    deps.onCallerRedirectStarting?.();
    await deps.twilio.redirectCallerToQueue({
      callerCallSid: request.callerCallSid,
      destination,
      warning: BLIND_TRANSFER_WARNING,
      actionUrl: deps.dialResultUrl,
      timeoutSeconds: QUEUE_DIAL_TIMEOUT_SECONDS,
      callerId: deps.callerId,
    });
  } catch (err) {
    // FIRST: the caller never moved, so a later genuine hangup on this
    // still-live call must not be mislabeled as a transfer.
    deps.onCallerRedirectFailed?.();
    log(
      `[runtime-xfer] blind redirect to ${destination} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      status: "FAILED",
      reason: "caller_redirect_failed",
      destination,
      method: "blind",
    };
  }

  log(`[runtime-xfer] caller ${request.callerCallSid} handed to the queue on ${destination}`);
  return { ok: true, destination, method: "blind" };
}
