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
   *
   * `redirecting` EXTENDS it for a harder reason — Codex P1, round 3 on
   * PR #273. The office has pressed a key and the caller's leg is being moved,
   * and that move can FAIL. Recording `accepted` at that moment claims a
   * completed transfer before one exists, and teardown can snapshot and
   * persist it DURING the redirect's own await — after which nothing corrects
   * it, because teardown has already run. The database would then say a
   * disconnected caller reached a human.
   *
   * So the in-flight state gets its own word. It is true at the instant it is
   * written, it cannot be misread as a connection, and it still leaves a
   * record for the success that races teardown — which is the entire reason
   * anything is written before the redirect at all.
   */
  outcome: 'accepted' | 'redirecting' | 'no_answer' | 'declined' | 'failed' | 'unavailable';
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
 * Which ATTEMPT a record came from, so an attempt may correct itself without
 * looking like a second attempt.
 *
 * A transfer records TWICE on the success path and it has to: once the moment
 * the office presses a key (before the redirect closes the media stream and
 * teardown starts), and again when the whole attempt settles. Without an
 * identity for the attempt, the second record either double-counts it or —
 * worse — the "an accepted transfer is never overwritten" rule pins a
 * provisional `accepted` in place when the redirect afterwards FAILED and the
 * caller never actually moved.
 */
export type TransferAttemptId = number;

let nextAttemptId: TransferAttemptId = 1;

/** A fresh id for one dial-and-wait. Called once per attempt. */
export function newTransferAttemptId(): TransferAttemptId {
  return nextAttemptId++;
}

/**
 * callerCallSid -> the outcome teardown should record.
 *
 * Bounded: a call whose teardown never runs (a crashed process, a lost
 * socket) would otherwise hold its entry forever. The cap is generous
 * relative to concurrent calls and the eviction is oldest-first, so the
 * only thing it can drop is a record nobody came back for.
 */
const outcomes = new Map<string, RuntimeTransferOutcome & { attemptId: TransferAttemptId }>();
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
/**
 * Whether a record REPLACED a value the database already holds.
 *
 * `true` means teardown has been and gone with an earlier version — almost
 * always the in-flight `redirecting` — so the row now disagrees with the
 * truth and needs a targeted update. The caller owns that write; this module
 * only reports the condition, because it has no business knowing about
 * `call_logs`.
 */
export function recordRuntimeTransferOutcome(
  callerCallSid: string,
  outcome: Omit<RuntimeTransferOutcome, 'attempt' | 'at' | 'pipeline'>,
  attemptId: TransferAttemptId,
): { supersededPersisted: boolean } {
  const prior = outcomes.get(callerCallSid);
  /**
   * THE SAME ATTEMPT CORRECTING ITSELF, which is not a second attempt.
   *
   * The success path records at the KEYPRESS and again at settle, because the
   * redirect that follows the keypress closes the media stream and teardown
   * can consume the record before the attempt resolves (Codex P1, PR #273).
   * Two records, one attempt — so the count must not move, and the later one
   * must be able to REPLACE the earlier. That second half matters: when the
   * redirect fails after an accept, the caller never moved, and pinning the
   * provisional `accepted` would record a transfer that did not happen.
   */
  if (prior && prior.attemptId === attemptId) {
    outcomes.set(callerCallSid, {
      ...outcome,
      pipeline: 'grok',
      attempt: prior.attempt,
      at: new Date().toISOString(),
      attemptId,
    });
    /**
     * THE CASE THIS WHOLE MECHANISM EXISTS FOR. Teardown persisted the
     * in-flight `redirecting` and acked it; the redirect has now settled with
     * the real answer, and the row still says the caller was in mid-air.
     */
    return { supersededPersisted: consumePersisted(callerCallSid) };
  }
  const attempt = (prior?.attempt ?? 0) + 1;
  if (prior?.outcome === 'accepted') {
    // A DIFFERENT attempt failing after this call already reached a human.
    // Keep the success; still count the attempt so the record is honest.
    outcomes.set(callerCallSid, { ...prior, attempt });
    return { supersededPersisted: false };
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
    attemptId,
  });
  // A LATER attempt after the row was written — rarer, same consequence.
  return { supersededPersisted: consumePersisted(callerCallSid) };
}

/**
 * Did the database already receive an outcome for this call, and does it now
 * need replacing? Answering clears the flag: the caller is about to write, and
 * a second report would produce a second redundant update.
 */
function consumePersisted(callerCallSid: string): boolean {
  if (!persistedCalls.delete(callerCallSid)) return false;
  return true;
}

/**
 * Read the outcome for a call WITHOUT consuming it.
 *
 * PEEK-AND-ACK, and the ack is deliberately not here. This was delete-on-read,
 * copying the old core's discipline, and Codex found what that costs (P2,
 * PR #273): the read happens while BUILDING the row, so a teardown upsert that
 * REJECTS has already destroyed the only copy of the outcome — and the retry
 * that the surrounding code exists to support then writes the row without it.
 * The failure mode was a transient database error, which is exactly when a
 * retry is supposed to save you.
 *
 * It also makes `toCallLogRow` pure again, which it is documented to be.
 */
export function peekRuntimeTransferOutcome(
  callerCallSid: string,
): RuntimeTransferOutcome | undefined {
  return outcomes.get(callerCallSid);
}

/**
 * Drop the outcome once it is durably written — but ONLY the exact one that
 * was written.
 *
 * Called after a successful upsert. A teardown that runs twice finds nothing
 * on the second pass and `toConflictUpdate` omits an absent outcome rather
 * than nulling it, so the first pass's value survives.
 *
 * `persisted` IS THE VERSION CHECK, and it needs no version field: `record`
 * always `set`s a NEW object, and `peek` hands back the stored one, so
 * reference equality asks exactly the right question — "is what I wrote still
 * what is here?"
 *
 * WHY THAT MATTERS (Codex P1, PR #273). Teardown starts when the redirect
 * closes the media stream, and the redirect has not necessarily settled:
 * `toCallLogRow` can snapshot the provisional `accepted` written at the
 * keypress, the redirect can then settle and REPLACE it — with the complete
 * success, or with the corrective failure when the redirect threw — and the
 * upsert can land afterwards carrying the older snapshot. An unconditional
 * delete then throws away the newer, truer value while the database keeps the
 * older one. A failed redirect recorded as a completed transfer is the worst
 * output this module can produce, because it says a caller reached a human
 * when they did not.
 *
 * A LATE SETTLEMENT IS NO LONGER STRANDED. An earlier version of this comment
 * said the corrective failure "cannot arrive late at all" because
 * `onCallerRedirectFailed` fires synchronously. THAT WAS FALSE — it fires in
 * the catch of the redirect's own await, so teardown can beat it — and the
 * claim survived here after being corrected in `runtimeTransfer.ts`, which is
 * exactly the stale-in-one-place failure this repo keeps re-learning (Codex,
 * PR #273).
 *
 * What happens instead: `recordRuntimeTransferOutcome` REPORTS when it has
 * replaced a value that was already persisted, and the settle path turns that
 * into a targeted update. See `supersededPersisted` below.
 */
export function ackRuntimeTransferOutcome(
  callerCallSid: string,
  persisted?: RuntimeTransferOutcome,
): void {
  if (!persisted) return;
  if (outcomes.get(callerCallSid) !== persisted) return;
  outcomes.delete(callerCallSid);
  /**
   * REMEMBER THAT THIS CALL'S ROW HAS BEEN WRITTEN.
   *
   * Teardown can persist an IN-FLIGHT value — `redirecting`, written before
   * the caller's leg has actually moved — and then the redirect settles with
   * the real answer. Without this, that final `accepted` or `failed` sits in
   * the map until eviction and the database keeps `redirecting` forever: not a
   * false claim any more, but a permanently unfinished one, which under-counts
   * exactly the completed transfers this column exists to count.
   *
   * Bounded the same way the outcomes map is: a call whose settlement never
   * comes leaves one small entry, evicted oldest-first.
   */
  if (persistedCalls.size >= MAX_TRACKED) {
    const oldest = persistedCalls.values().next();
    if (!oldest.done) persistedCalls.delete(oldest.value);
  }
  persistedCalls.add(callerCallSid);
}

/**
 * Calls whose `call_logs` row has already been written with an outcome.
 *
 * A separate set rather than a flag on the record, because the record is
 * REPLACED on settlement and the flag would go with it — which is the whole
 * situation this is here to detect.
 */
const persistedCalls = new Set<string>();

/** Test hook. */
export function clearRuntimeTransferOutcomes(): void {
  outcomes.clear();
}
