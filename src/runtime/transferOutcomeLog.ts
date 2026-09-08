/**
 * WHAT HAPPENED WHEN WE DIALLED — kept until teardown can write it down.
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
 * `transferred_to_human` false, on all three of that day's calls.
 *
 * The cause is that `recordTransferOutcome` lives in `voiceAgentRoutes.ts` and
 * keys on `officeLegDials`, a map only the OLD CORE's dial path populates. The
 * runtime dials through `performWarmTransfer` and never registers there, so
 * every runtime transfer reads from `call_logs` as "no transfer attempted".
 *
 * THAT IS NOT A COSMETIC GAP. It is the same class as the `agent_id` blindness
 * of 2026-09-04 (100% of old-core rows populated, 0 of 239 runtime rows), and
 * it is what led me to state "no transfer was attempted" about CAa37f1a42 from
 * a column that cannot say so. An absent measurement reads as a negative
 * finding, which is worse than no measurement at all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A STORE AND NOT A DIRECT WRITE.
 *
 * The runtime writes `call_logs` once, at teardown, from `callRecord.ts` — a
 * deliberate design (one writer, one row, an explicit column list that breaks
 * the typecheck if the schema moves). A transfer settles DURING the call,
 * often minutes earlier. So the outcome is held here and collected by the
 * teardown writer, rather than opening a second writer onto the same row.
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
   */
  outcome: 'accepted' | 'no_answer' | 'declined' | 'failed' | 'unavailable';
  /** The runtime's own status, verbatim, so nothing is lost in translation. */
  status: string;
  /** The runtime's own reason slug, verbatim. Absent on success. */
  reason?: string;
  /** Where we actually dialled. Recorded on FAILURE too — 46 of 46 failed PCP
   * handoffs in the 90 days to 2026-08-13 recorded no destination, which is
   * why "were we dialling the retired roster?" is unanswerable from the data. */
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
  at: string;
}

/**
 * callerCallSid -> the outcome teardown should record.
 *
 * Bounded: a call whose teardown never runs (a crashed process, a lost
 * socket) would otherwise hold its entry forever. The cap is generous
 * relative to concurrent calls and the eviction is oldest-first, so the
 * only thing it can drop is a record nobody came back for.
 */
const outcomes = new Map<string, RuntimeTransferOutcome>();
const MAX_TRACKED = 500;

/**
 * Record what a transfer attempt did.
 *
 * AN ACCEPTED TRANSFER IS NEVER OVERWRITTEN, and that is the one rule here
 * worth arguing about. A call can attempt more than once — the agent may call
 * the handoff tool again after a refusal, and the sequential path tries a
 * roster. The question the column answers is "did this caller reach a human,
 * and if not why", so:
 *
 *   - a success wins permanently: a later failed attempt must not rewrite a
 *     call that DID reach somebody into one that did not;
 *   - otherwise the latest failure wins, because it is the one the caller was
 *     left with;
 *   - `attempt` counts them, so a call that tried three times is not
 *     indistinguishable from one that tried once.
 *
 * The old core is last-write-wins with no counter, which loses both. This is
 * deliberately not a copy of it.
 */
export function recordRuntimeTransferOutcome(
  callerCallSid: string,
  outcome: Omit<RuntimeTransferOutcome, 'attempt' | 'at' | 'pipeline'>,
): void {
  const prior = outcomes.get(callerCallSid);
  const attempt = (prior?.attempt ?? 0) + 1;
  if (prior?.outcome === 'accepted') {
    // Keep the success; still count the attempt so the record is honest.
    outcomes.set(callerCallSid, { ...prior, attempt });
    return;
  }
  if (outcomes.size >= MAX_TRACKED && !prior) {
    const oldest = outcomes.keys().next();
    if (!oldest.done) outcomes.delete(oldest.value);
  }
  outcomes.set(callerCallSid, {
    ...outcome,
    pipeline: 'grok',
    attempt,
    at: new Date().toISOString(),
  });
}

/**
 * Collect the outcome for a finished call, once.
 *
 * Delete-on-read, the same discipline `recordTransferOutcome` uses on the old
 * core: teardown can run twice (a retry, a racing socket close) and the second
 * pass must not rewrite the row with a value it has already written.
 */
export function takeRuntimeTransferOutcome(
  callerCallSid: string,
): RuntimeTransferOutcome | undefined {
  const found = outcomes.get(callerCallSid);
  if (found) outcomes.delete(callerCallSid);
  return found;
}

/** Test hook. */
export function clearRuntimeTransferOutcomes(): void {
  outcomes.clear();
}
