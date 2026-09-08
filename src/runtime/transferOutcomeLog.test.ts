/**
 * `call_logs.transfer_outcome` WAS NULL ON EVERY RUNTIME CALL EVER MADE.
 *
 * Operator, 2026-09-08: *"that's unacceptable... you climb the steep hill, and
 * then you just relinquish everything you worked for. You have the data, but
 * we're not capturing it properly."*
 *
 * Measured that day, on all three PCP runtime calls: `transfer_outcome` NULL
 * and `transferred_to_human` false — while the TICKET carried the complete
 * record (`pcp_handoff_attempted`, destination `+17149564300`,
 * `pcp_handoff_human_answer_status = NO_ANSWER`, `office_no_answer`). The dial
 * happened, was measured, and was written down in one place and not the other.
 *
 * The cause: `recordTransferOutcome` lives in `voiceAgentRoutes.ts` and keys
 * on `officeLegDials`, a map only the OLD CORE's dial path populates. The
 * runtime dials through `performWarmTransfer` and never registers there.
 *
 * WHY IT IS WORSE THAN A MISSING COLUMN: an absent measurement reads as a
 * negative finding. I stated "no transfer was attempted" about CAa37f1a42 on
 * the strength of this column, from data that could not say so. Same class as
 * the `agent_id` blindness of 2026-09-04 — 100% of old-core rows populated,
 * 0 of 239 runtime rows — where an absent lane looked like a quiet lane.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRuntimeTransferOutcome,
  peekRuntimeTransferOutcome,
  ackRuntimeTransferOutcome,
  newTransferAttemptId,
  clearRuntimeTransferOutcomes,
} from './transferOutcomeLog';
import { toRecordedOutcome } from './runtimeTransfer';

beforeEach(() => clearRuntimeTransferOutcomes());

/** The 2026-09-08 dial, as the runtime saw it. */
const RANG_OUT = {
  outcome: 'no_answer' as const,
  status: 'NO_ANSWER',
  reason: 'office_no_answer',
  dialedNumber: '+17149564300',
  ringSeconds: 30,
};

describe('the outcome survives from the dial to teardown', () => {
  it('records what the ticket recorded and call_logs did not', () => {
    recordRuntimeTransferOutcome('CAa2a3a1c1', RANG_OUT, newTransferAttemptId());

    const stored = peekRuntimeTransferOutcome('CAa2a3a1c1');

    expect(stored?.outcome).toBe('no_answer');
    expect(stored?.reason, 'why it failed, not just that it did').toBe('office_no_answer');
    expect(stored?.dialedNumber, 'WHERE we dialled — 46 of 46 failures once recorded nothing').toBe(
      '+17149564300',
    );
    expect(stored?.ringSeconds).toBe(30);
    expect(stored?.pipeline, 'a reader must be able to tell the two writers apart').toBe('grok');
    expect(stored?.at).toBeTruthy();
  });

  it('SURVIVES a failed write, and is dropped only once the row lands', () => {
    /**
     * Codex P2, PR #273. This was delete-on-read, copying the old core — and
     * the read happens while BUILDING the row, so an upsert that REJECTED had
     * already destroyed the only copy of the outcome. The retry this module
     * exists to support then wrote the row without it. The failure mode is a
     * transient database error, which is exactly when a retry should save you.
     *
     * Peek-and-ack keeps the property delete-on-read was protecting — a second
     * teardown pass after a SUCCESSFUL write finds nothing, and
     * `toConflictUpdate` omits an absent outcome rather than nulling it — and
     * drops the cost.
     */
    recordRuntimeTransferOutcome('CAretry', RANG_OUT, newTransferAttemptId());

    // Teardown builds the row; the write rejects; nothing is acked.
    expect(peekRuntimeTransferOutcome('CAretry'), 'the row is built from it').toBeTruthy();
    expect(peekRuntimeTransferOutcome('CAretry'), 'and the retry still has it').toBeTruthy();

    // The ack now names the exact value that was written — see the version
    // check below; passing nothing is a deliberate no-op.
    ackRuntimeTransferOutcome('CAretry', peekRuntimeTransferOutcome('CAretry'));
    expect(peekRuntimeTransferOutcome('CAretry'), 'gone only once it is durable').toBeUndefined();
  });

  it('a call that never dialled stores nothing at all', () => {
    /**
     * VACUOUS AS ORIGINALLY WRITTEN, and Codex said so (P2, PR #273): it read
     * an untouched store, so it passed without exercising any production
     * wiring — a policy refusal was in fact being recorded as a dial. The real
     * assertion is in runtimeTransfer.test.ts, through
     * `createRuntimeTransfer` with no destination configured. This one is kept
     * only as the statement of the INVARIANT it names.
     *
     * Fourth time on this PR that a test of mine asserted against the store
     * instead of the wiring. Left labelled rather than deleted.
     */
    expect(peekRuntimeTransferOutcome('CAnodial')).toBeUndefined();
  });
});

describe('a call that tried more than once', () => {
  it('NEVER rewrites a success into a failure', () => {
    /**
     * The rule worth arguing about. A call can attempt more than once — the
     * agent may call the handoff tool again, and the sequential path tries a
     * roster. The question this column answers is "did this caller reach a
     * human", so a later failure must not turn a call that DID reach somebody
     * into one that did not. The old core is last-write-wins and would.
     */
    recordRuntimeTransferOutcome('CAwon', {
      outcome: 'accepted',
      status: 'CONNECTED',
      dialedNumber: '+17149564300',
      officeCallSid: 'CAoffice1',
      acceptMethod: 'keypress',
      ringSeconds: 12,
    }, newTransferAttemptId());
    recordRuntimeTransferOutcome('CAwon', RANG_OUT, newTransferAttemptId());

    const stored = peekRuntimeTransferOutcome('CAwon');
    expect(stored?.outcome, 'the caller reached a human on this call').toBe('accepted');
    expect(stored?.officeCallSid).toBe('CAoffice1');
    expect(stored?.attempt, 'and the later attempt is still counted').toBe(2);
  });

  it('otherwise keeps the LAST failure — the one the caller was left with', () => {
    recordRuntimeTransferOutcome('CAtried', RANG_OUT, newTransferAttemptId());
    recordRuntimeTransferOutcome('CAtried', {
      outcome: 'declined',
      status: 'DECLINED',
      reason: 'office_declined',
      dialedNumber: '+17149564300',
      ringSeconds: 8,
    }, newTransferAttemptId());

    const stored = peekRuntimeTransferOutcome('CAtried');
    expect(stored?.outcome).toBe('declined');
    expect(stored?.attempt, 'two attempts is not the same call as one').toBe(2);
  });

  it('counts a single attempt as one', () => {
    recordRuntimeTransferOutcome('CAonce', RANG_OUT, newTransferAttemptId());
    expect(peekRuntimeTransferOutcome('CAonce')?.attempt).toBe(1);
  });
});

describe("'declined' is kept distinct on purpose", () => {
  it('does not flatten a refusal into a no-answer', () => {
    /**
     * The old core's vocabulary has no word for an office that actively
     * refused. Flattening DECLINED into `no_answer` would delete the
     * difference between nobody picking up — a staffing question — and
     * somebody saying no, which is not. Nothing in the tree reads this column
     * today, so extending the vocabulary costs nothing and the lie would have
     * cost the distinction.
     */
    recordRuntimeTransferOutcome('CAno', RANG_OUT, newTransferAttemptId());
    recordRuntimeTransferOutcome('CAdeclined', {
      outcome: 'declined',
      status: 'DECLINED',
      reason: 'office_declined',
      ringSeconds: 5,
    }, newTransferAttemptId());

    expect(peekRuntimeTransferOutcome('CAno')?.outcome).toBe('no_answer');
    expect(peekRuntimeTransferOutcome('CAdeclined')?.outcome).toBe('declined');
  });
});

describe('it cannot grow without bound', () => {
  it('evicts oldest-first when teardown never came', () => {
    // A call whose teardown never runs — a crashed process, a lost socket —
    // would otherwise hold its entry forever.
    for (let i = 0; i < 520; i += 1) recordRuntimeTransferOutcome(`CAleak${i}`, RANG_OUT, newTransferAttemptId());

    expect(peekRuntimeTransferOutcome('CAleak0'), 'the oldest is gone').toBeUndefined();
    expect(peekRuntimeTransferOutcome('CAleak519'), 'the newest is kept').toBeTruthy();
  });
});

describe("the transfer's own result maps onto the stored shape", () => {
  /**
   * TESTED AT THE SOURCE, not only at the store. Mutation testing caught this:
   * flattening DECLINED into `no_answer` inside the mapping failed NOTHING,
   * because the `declined` assertion below exercised the store — which never
   * sees a `TransferOutcome`. A suite that tests the sink and not the source
   * cannot tell a working mapping from a broken one, which is the second time
   * that exact gap appeared today.
   */
  it('an accepted transfer records where it went and how it was accepted', () => {
    const recorded = toRecordedOutcome(
      { ok: true, destination: '+17149564300', officeCallSid: 'CAoffice1' },
      12,
    );

    expect(recorded.outcome).toBe('accepted');
    expect(recorded.status).toBe('CONNECTED');
    expect(recorded.dialedNumber).toBe('+17149564300');
    expect(recorded.officeCallSid).toBe('CAoffice1');
    expect(recorded.acceptMethod, 'the runtime honours exactly one accept').toBe('keypress');
    expect(recorded.ringSeconds).toBe(12);
  });

  it('keeps DECLINED distinct from NO_ANSWER', () => {
    // The one judgement in this mapping. Nobody picking up is a staffing
    // question; somebody refusing is not.
    expect(
      toRecordedOutcome({ ok: false, status: 'NO_ANSWER', reason: 'office_no_answer' }, 30).outcome,
    ).toBe('no_answer');
    expect(
      toRecordedOutcome({ ok: false, status: 'DECLINED', reason: 'office_declined' }, 8).outcome,
    ).toBe('declined');
  });

  it('maps the other two failures without losing the runtime\'s own words', () => {
    const unavailable = toRecordedOutcome(
      { ok: false, status: 'UNAVAILABLE', reason: 'no_destination_configured' },
      0,
    );
    expect(unavailable.outcome).toBe('unavailable');
    expect(unavailable.status, 'the runtime status survives verbatim').toBe('UNAVAILABLE');
    expect(unavailable.reason).toBe('no_destination_configured');

    expect(toRecordedOutcome({ ok: false, status: 'FAILED', reason: 'dial_failed' }, 1).outcome).toBe(
      'failed',
    );
  });

  it('records the destination on a FAILURE, not only on success', () => {
    // 46 of 46 failed PCP handoffs in the 90 days to 2026-08-13 recorded no
    // destination, so "were we dialling the retired roster?" is unanswerable
    // from that data. This is the column that answers it next time.
    const recorded = toRecordedOutcome(
      { ok: false, status: 'NO_ANSWER', reason: 'office_no_answer', destination: '+17149564300' },
      30,
    );

    expect(recorded.dialedNumber).toBe('+17149564300');
  });
});

describe('one attempt that records twice', () => {
  /**
   * THE SUCCESS PATH RECORDS AT THE KEYPRESS AND AGAIN AT SETTLE, and it has
   * to. Codex P1, PR #273: the redirect that follows an accept ends the media
   * stream, and that close can beat the redirect's own resolution — which is
   * why `onCallerRedirectStarting` exists. Teardown starts on the close and
   * synchronously builds the row, so an outcome recorded only when `attempt()`
   * resolves can land AFTER the row is written: the one transfer worth logging,
   * lost to a race the surrounding code already knew about.
   *
   * Two records, one attempt. The attempt id is what keeps that from becoming
   * two attempts — and, more importantly, what lets the second record CORRECT
   * the first.
   */
  it('counts as one attempt, not two', () => {
    const id = newTransferAttemptId();
    recordRuntimeTransferOutcome('CAaccept', {
      outcome: 'accepted', status: 'CONNECTED', acceptMethod: 'keypress', ringSeconds: 12,
    }, id);
    recordRuntimeTransferOutcome('CAaccept', {
      outcome: 'accepted', status: 'CONNECTED', dialedNumber: '+17149564300',
      officeCallSid: 'CAoffice1', acceptMethod: 'keypress', ringSeconds: 13,
    }, id);

    const stored = peekRuntimeTransferOutcome('CAaccept');
    expect(stored?.attempt, 'recording twice is not attempting twice').toBe(1);
    expect(stored?.officeCallSid, 'and the fuller record wins').toBe('CAoffice1');
  });

  it('lets a redirect that FAILED after the accept correct the record', () => {
    /**
     * The half that matters more. When the redirect throws, the caller never
     * moved — so the provisional `accepted` written a moment earlier is now
     * false. Without the attempt id, the "an accepted transfer is never
     * overwritten" rule would pin a transfer that did not happen.
     */
    const id = newTransferAttemptId();
    recordRuntimeTransferOutcome('CAredirectfail', {
      outcome: 'accepted', status: 'CONNECTED', acceptMethod: 'keypress', ringSeconds: 12,
    }, id);
    recordRuntimeTransferOutcome('CAredirectfail', {
      outcome: 'failed', status: 'FAILED', reason: 'caller_redirect_failed', ringSeconds: 13,
    }, id);

    const stored = peekRuntimeTransferOutcome('CAredirectfail');
    expect(stored?.outcome, 'the caller never moved').toBe('failed');
    expect(stored?.reason).toBe('caller_redirect_failed');
    expect(stored?.attempt).toBe(1);
  });

  it('but a DIFFERENT attempt still cannot undo a real transfer', () => {
    // The across-attempts rule is unchanged: a later attempt failing must not
    // rewrite a call that already reached a human.
    recordRuntimeTransferOutcome('CAmixed', {
      outcome: 'accepted', status: 'CONNECTED', acceptMethod: 'keypress', ringSeconds: 12,
    }, newTransferAttemptId());
    recordRuntimeTransferOutcome('CAmixed', RANG_OUT, newTransferAttemptId());

    const stored = peekRuntimeTransferOutcome('CAmixed');
    expect(stored?.outcome).toBe('accepted');
    expect(stored?.attempt).toBe(2);
  });
});

describe('the briefing gaps reach the stored outcome', () => {
  /**
   * "Build it and the telemetry" — operator, 2026-09-08, approving the
   * one-round pre-transfer intake.
   *
   * `outcome: 'accepted'` cannot tell a transfer that arrived briefed from one
   * that connected a stranger the staffer has to interview from scratch. These
   * two fields are what make "does one round actually fill the briefing?" a
   * query instead of a listening exercise.
   */
  it('carries what the office was not told, and whether we asked', () => {
    const recorded = toRecordedOutcome(
      { ok: true, destination: '+17149564300', officeCallSid: 'CAoffice1' },
      12,
      { gaps: ['callerRole'], asked: true },
    );

    expect(recorded.briefingGaps).toEqual(['callerRole']);
    expect(recorded.askedBeforeDial).toBe(true);
  });

  it('distinguishes "asked and answered" from "never asked"', () => {
    // Both have empty gaps and they are different events: one is a caller who
    // replied, the other a caller who arrived complete.
    const answered = toRecordedOutcome({ ok: true, destination: '+1', officeCallSid: 'CAo' }, 1, {
      gaps: [],
      asked: true,
    });
    const complete = toRecordedOutcome({ ok: true, destination: '+1', officeCallSid: 'CAo' }, 1, {
      gaps: [],
      asked: false,
    });

    expect(answered.askedBeforeDial).toBe(true);
    expect(complete.askedBeforeDial).toBe(false);
  });

  it('a lane that does not report it leaves the columns ABSENT, not empty', () => {
    /**
     * Only PCP runs the one-round intake today. An empty array from a lane
     * that never checked would claim a complete briefing it knows nothing
     * about — the same class of lie as writing zeros for a provider that
     * reported no tokens.
     */
    const recorded = toRecordedOutcome({ ok: false, status: 'NO_ANSWER', reason: 'x' }, 30);

    expect(recorded.briefingGaps).toBeUndefined();
    expect(recorded.askedBeforeDial).toBeUndefined();
  });

  it('records them on a FAILED dial too — a caller who rang out was still briefed or not', () => {
    const recorded = toRecordedOutcome(
      { ok: false, status: 'NO_ANSWER', reason: 'office_no_answer', destination: '+17149564300' },
      30,
      { gaps: ['callerName', 'callerRole', 'callPurpose'], asked: true },
    );

    expect(recorded.briefingGaps).toHaveLength(3);
    expect(recorded.askedBeforeDial).toBe(true);
  });
});

describe('the ack only drops what was actually written', () => {
  /**
   * Codex P1, PR #273. Teardown starts when the redirect closes the media
   * stream, and the redirect has not necessarily settled: `toCallLogRow` can
   * snapshot the provisional `accepted`, the redirect can settle and REPLACE
   * it, and the upsert can land afterwards carrying the older snapshot. An
   * unconditional delete then throws away the newer, truer value while the
   * database keeps the older one.
   */
  it('does NOT delete a value that landed after the row was built', () => {
    const id = newTransferAttemptId();
    recordRuntimeTransferOutcome('CAlate', {
      outcome: 'accepted', status: 'CONNECTED', acceptMethod: 'keypress', ringSeconds: 12,
    }, id);
    const snapshot = peekRuntimeTransferOutcome('CAlate');

    // The redirect settles while the upsert is in flight, and corrects itself.
    recordRuntimeTransferOutcome('CAlate', {
      outcome: 'failed', status: 'FAILED', reason: 'caller_redirect_failed', ringSeconds: 13,
    }, id);

    ackRuntimeTransferOutcome('CAlate', snapshot);

    const stillThere = peekRuntimeTransferOutcome('CAlate');
    expect(stillThere?.outcome, 'a failed redirect must not be left recorded as accepted').toBe(
      'failed',
    );
  });

  it('does drop the value when it is still the one that was written', () => {
    recordRuntimeTransferOutcome('CAsame', RANG_OUT, newTransferAttemptId());
    const snapshot = peekRuntimeTransferOutcome('CAsame');

    ackRuntimeTransferOutcome('CAsame', snapshot);

    expect(peekRuntimeTransferOutcome('CAsame')).toBeUndefined();
  });

  it('acking nothing is a no-op — a row with no outcome must not clear one', () => {
    // `persistRuntimeCall` passes `row.transferOutcome`, which is absent on
    // every call that never transferred. That must not delete a record another
    // writer is mid-way through.
    recordRuntimeTransferOutcome('CAuntouched', RANG_OUT, newTransferAttemptId());

    ackRuntimeTransferOutcome('CAuntouched', undefined);

    expect(peekRuntimeTransferOutcome('CAuntouched')).toBeTruthy();
  });
});
