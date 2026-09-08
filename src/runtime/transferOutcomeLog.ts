/**
 * WHAT HAPPENED WHEN WE DIALLED — recorded once, by the code that knows.
 *
 * Operator, 2026-09-08, on finding `call_logs.transfer_outcome` NULL for every
 * runtime call: *"that's unacceptable... you climb the steep hill, and then you
 * just relinquish everything you worked for. You have the data, but we're not
 * capturing it properly."*
 *
 * He is right and the shape is specific. On 2026-09-08 the PCP line dialled
 * `+17149564300`, rang out, and recorded the whole thing — destination,
 * attempted-at, NO_ANSWER, `office_no_answer` — on the TICKET
 * (`tickets.pcp_handoff_*`). `call_logs.transfer_outcome` was NULL, and
 * `transferred_to_human` false, on all three of that day's calls, because
 * `recordTransferOutcome` keys on `officeLegDials`, a map only the OLD CORE's
 * dial path populates.
 *
 * AN ABSENT MEASUREMENT READS AS A NEGATIVE FINDING. I stated "no transfer was
 * attempted" about CAa37f1a42 on the strength of that column, from data that
 * could not say so — the `agent_id` blindness of 2026-09-04 in a second place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS MODULE WAS REDESIGNED AT ROUND 5, AND THE DELETION IS THE FIX.
 *
 * The first design had TEARDOWN write this column, from a snapshot of an
 * in-memory store. Teardown runs when the media stream closes, which a
 * transfer can straddle, so the snapshot could be older than the truth — and
 * every round of review found another consequence:
 *
 *   1  an outcome recorded only at settle arrived after the row was written
 *   2  a rejected upsert destroyed the only copy before the retry
 *   3  the provisional value said `accepted` before the caller had moved, and
 *      teardown could persist that permanently
 *   4  a settlement after teardown was stranded, leaving the row unfinished
 *   5  the reconciliation for (4) had three holes of its own — a settlement
 *      landing DURING the upsert reconciled nothing, the late write hardcoded
 *      `attempt: 1`, and a failed late write was never retried
 *
 * Five rounds, and each fix created the next finding. That is the shape
 * CLAUDE.md calls "patching symptoms — fix on top of fix on top of fix", and
 * the cause was never any individual hole: it was TWO WRITERS racing over one
 * column, coordinated by a marker that had to grow a state for every race.
 *
 * So there is one writer now. The transfer settles, and the code that settles
 * it writes the value — a targeted UPDATE on a row `openRuntimeCall` created
 * when the call began. Teardown does not touch this column at all.
 *
 * WHAT WENT WITH IT: the peek/ack pair, the persisted-call marker, the
 * reference-equality version check, the `redirecting` in-flight value, the
 * accept-time and redirect-failure hooks, and the reconciliation path. None of
 * them described anything about a phone call; all of them existed to sequence
 * two writers.
 *
 * WHAT THIS COSTS, stated rather than discovered: a transfer whose settlement
 * never runs — the process dies mid-redirect — leaves the column NULL. Under
 * the old design it might have left a provisional value. NULL means "no record
 * of a transfer", which is honest about a process that died; a stuck
 * `redirecting` was not.
 */

/** The payload written to `call_logs.transfer_outcome`. */
export interface RuntimeTransferOutcome {
  /**
   * The shared vocabulary the old core writes, so one reader can serve both
   * pipelines. `declined` EXTENDS it: the old core has no word for an office
   * that actively refused, and flattening it into `no_answer` would delete the
   * distinction between nobody picking up and somebody saying no. Nothing in
   * the tree reads this column today, so the extension costs nothing and the
   * lie would have cost the distinction.
   *
   * There is no in-flight value. The record is written when the transfer has
   * settled, so every value here is a final answer.
   */
  outcome: 'accepted' | 'no_answer' | 'declined' | 'failed' | 'unavailable';
  /** The runtime's own status, verbatim, so nothing is lost in translation. */
  status: string;
  /** The runtime's own reason slug, verbatim. Absent on success. */
  reason?: string;
  /** Where we actually dialled. Recorded on FAILURE too — 46 of 46 failed PCP
   * handoffs in the 90 days to 2026-08-13 recorded no destination, which is
   * why "were we dialling the retired roster?" is unanswerable from that
   * data. */
  dialedNumber?: string;
  officeCallSid?: string;
  /** How long the office leg rang before it settled. */
  ringSeconds: number;
  /** The runtime honours exactly one accept: a keypress. Stated rather than
   * implied, because the old core's payload carries this field and a reader
   * comparing pipelines needs it present on both. */
  acceptMethod?: 'keypress';
  /** Which stack produced this row. The two writers are genuinely different
   * code, and a reader that cannot tell them apart cannot compare them. */
  pipeline: 'grok';
  /** How many times this CALL attempted a transfer, including this one. */
  attempt: number;
  /**
   * WHAT THE OFFICE WAS NOT TOLD, at the moment we dialled.
   *
   * Operator, 2026-09-08, approving the one-round intake: "build it and the
   * telemetry." A transfer that connects a stranger the staffer has to
   * interview from scratch is a different event from one that arrives briefed,
   * and `outcome: 'accepted'` cannot tell them apart. Empty array means a
   * complete briefing; absent means a pipeline that does not report it.
   */
  briefingGaps?: string[];
  /**
   * Whether the one round of intake actually fired on this call.
   *
   * The pair is what makes the round measurable: gaps AND asked says the
   * caller declined; gaps AND not-asked says the round never ran, which would
   * be a defect in the gate rather than in the caller.
   */
  askedBeforeDial?: boolean;
  at: string;
}

/**
 * Which ATTEMPT a record came from.
 *
 * A call can attempt a transfer more than once — the agent may call the
 * handoff tool again, and the sequential path tries a roster — and the answer
 * to "did this caller reach a human" must not be rewritten by a later failure.
 * The id is what distinguishes a second attempt from the same one speaking
 * twice.
 */
export type TransferAttemptId = number;

let nextAttemptId: TransferAttemptId = 1;

/** A fresh id for one dial-and-wait. Called once per attempt. */
export function newTransferAttemptId(): TransferAttemptId {
  return nextAttemptId++;
}

/**
 * callerCallSid -> what has been recorded for this call so far.
 *
 * Kept ONLY to answer two questions that span attempts: has this call already
 * reached a human, and how many times has it tried? It is not a write buffer
 * any more — the settle writes straight through — so nothing durable depends
 * on an entry surviving.
 *
 * Bounded: a call whose entry is never superseded would otherwise sit here
 * forever. Oldest-first eviction can only drop a record nobody came back for.
 */
const outcomes = new Map<string, RuntimeTransferOutcome & { attemptId: TransferAttemptId }>();
const MAX_TRACKED = 500;

/**
 * Record what a transfer attempt did, and return the record to persist.
 *
 * AN ACCEPTED TRANSFER IS NEVER OVERWRITTEN BY A LATER ATTEMPT. The question
 * this column answers is "did this caller reach a human", so a subsequent
 * failure must not rewrite a call that DID into one that did not. `attempt`
 * counts them, so a call that tried three times is not indistinguishable from
 * one that tried once. The old core is last-write-wins with no counter and
 * loses both; this is deliberately not a copy of it.
 *
 * Returns the value the caller should write. When a later attempt is refused
 * by the rule above, that is the EARLIER success with its attempt count
 * advanced — so writing the return value is always correct, and the caller
 * never has to know which branch it took.
 */
export function recordRuntimeTransferOutcome(
  callerCallSid: string,
  outcome: Omit<RuntimeTransferOutcome, 'attempt' | 'at' | 'pipeline'>,
  attemptId: TransferAttemptId,
): RuntimeTransferOutcome {
  const prior = outcomes.get(callerCallSid);
  const sameAttempt = prior?.attemptId === attemptId;
  const attempt = sameAttempt ? prior!.attempt : (prior?.attempt ?? 0) + 1;

  // A DIFFERENT attempt failing after this call already reached a human.
  const keepPriorSuccess = !sameAttempt && prior?.outcome === 'accepted';
  const next: RuntimeTransferOutcome & { attemptId: TransferAttemptId } = keepPriorSuccess
    ? { ...prior!, attempt }
    : { ...outcome, pipeline: 'grok', attempt, at: new Date().toISOString(), attemptId };

  if (!prior && outcomes.size >= MAX_TRACKED) {
    const oldest = outcomes.keys().next();
    if (!oldest.done) outcomes.delete(oldest.value);
  }
  outcomes.set(callerCallSid, next);

  const { attemptId: _internal, ...payload } = next;
  return payload;
}

/** Test hook: what the store currently holds for a call. */
export function peekRuntimeTransferOutcome(
  callerCallSid: string,
): RuntimeTransferOutcome | undefined {
  return outcomes.get(callerCallSid);
}

/** Test hook. */
export function clearRuntimeTransferOutcomes(): void {
  outcomes.clear();
}
