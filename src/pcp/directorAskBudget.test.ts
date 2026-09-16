import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PcpDirector, MAX_ASKS_PER_FIELD, type PcpConversationState } from './director';

/**
 * THE SEVEN-TIMES CALL.
 *
 * `CA908f93dae322ed0e0dd862673ebf77fb`, PCP, 2026-09-15, 150 seconds, no
 * ticket of any provenance. The operator named this shape the same morning as
 * one of his three priorities for the line — *"one that asks somebody
 * something seven times or something like that, like that shouldn't be
 * possible, right?"* — and the exact-match count on that call's transcript is
 * SEVEN.
 *
 * RULE THREE: the real SID and the real SHAPE live here; the caller's words
 * stay on disk and in `call_logs`. Every value below is synthetic.
 *
 * The shape, from that call's `tool_timeline`: the model called
 * `record_pcp_intake` eight times in a row recording `statedRelationship`
 * from the same one-word reply, every call SUCCEEDED, and the director
 * returned `nextField: patientFirstName` every time. Because they succeeded,
 * `toolCeiling`'s failure counters never advanced; `tool_call_count` reached
 * 15 against a `perCallDispatches` of 40. Nothing in the system could stop it.
 */
const SEVEN_TIMES_CALL = 'CA908f93dae322ed0e0dd862673ebf77fb';

/**
 * The lunch clock is pinned on every director built here.
 *
 * `isLunchClosure()` downgrades HAND_OFF to CREATE_TASK for one hour of every
 * Pacific weekday, and CLAUDE.md's v32 row records
 * `schedulingReachesTheHub.test.ts` going red for exactly that hour because it
 * was the one PCP file that did not pin it.
 */
const director = () => new PcpDirector({ lunchClosure: () => false });

/** A professional intake, complete except for the patient's first name. */
const upToPatientFirstName: Partial<PcpConversationState> = {
  callPurpose: 'outside_referral_status',
  callerName: 'A Caller',
  callerRole: 'coordinator',
  callerOrganization: 'An Organization',
  callerFacilityType: 'ipa_medical_group',
  callbackNumber: '5555550100',
  statedRelationship: 'referral coordinator',
};

/** Ask, then record that we asked — what `record_pcp_intake` does per turn. */
function askOnce(d: PcpDirector, callId: string) {
  const decision = d.next(callId);
  if (decision.nextQuestion) d.noteAsked(callId, decision.nextQuestion.field);
  return decision;
}

describe('the ask budget', () => {
  it('offers a field at most MAX_ASKS_PER_FIELD times, not seven', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);

    // Drive the same turn the live call drove: the caller never answers.
    const asked: string[] = [];
    for (let turn = 0; turn < 7; turn++) {
      const decision = askOnce(d, SEVEN_TIMES_CALL);
      if (decision.nextQuestion) asked.push(String(decision.nextQuestion.field));
    }

    const timesAskedForFirstName = asked.filter((f) => f === 'patientFirstName').length;
    expect(timesAskedForFirstName).toBe(MAX_ASKS_PER_FIELD);
    expect(timesAskedForFirstName).toBeLessThan(7);
  });

  it('moves ON to the next unanswered field rather than stopping the intake dead', () => {
    const d = director();
    // `outside_referral_status` sets patientContextRequired and does not allow
    // HAND_OFF, so PATIENT_FIELDS is appended: with statedRelationship cleared
    // the outstanding list is statedRelationship, patientFirstName,
    // patientLastName, patientDob. The caller answers none of them.
    d.update(SEVEN_TIMES_CALL, { ...upToPatientFirstName, statedRelationship: undefined });
    const outstanding = ['statedRelationship', 'patientFirstName', 'patientLastName', 'patientDob'];

    const asked: string[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const decision = askOnce(d, SEVEN_TIMES_CALL);
      if (decision.nextQuestion) asked.push(String(decision.nextQuestion.field));
    }

    // Each gets its two asks and no more, and the form does not stall on the
    // first one forever — twenty turns produce eight questions, not twenty.
    for (const field of outstanding) {
      expect(asked.filter((f) => f === field).length, field).toBe(MAX_ASKS_PER_FIELD);
    }
    expect(asked.length).toBe(MAX_ASKS_PER_FIELD * outstanding.length);
  });

  it('lets the intake read as complete afterwards, so the request can file', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);
    // Three fields are outstanding on this purpose (patientFirstName,
    // patientLastName, patientDob); drive well past their budgets.
    for (let turn = 0; turn < 20; turn++) askOnce(d, SEVEN_TIMES_CALL);

    // This is the whole point: a request that files short beats one that never
    // files. The filing gate (ticketRequirements) still has its own say.
    expect(d.next(SEVEN_TIMES_CALL).nextQuestion).toBeUndefined();
  });

  it('names the exhausted field, so a stuck line is countable from SQL', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);
    expect(d.next(SEVEN_TIMES_CALL).askBudgetSpent).toBeUndefined();

    for (let turn = 0; turn < MAX_ASKS_PER_FIELD; turn++) askOnce(d, SEVEN_TIMES_CALL);
    // Only the field we actually spent — the others are still being asked.
    expect(d.next(SEVEN_TIMES_CALL).askBudgetSpent).toEqual(['patientFirstName']);
  });

  it('does not invent the field — it stays unset', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);
    for (let turn = 0; turn < MAX_ASKS_PER_FIELD; turn++) askOnce(d, SEVEN_TIMES_CALL);
    expect(d.get(SEVEN_TIMES_CALL).patientFirstName).toBeUndefined();
  });

  it('charges nothing for a field the caller ANSWERS', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);

    askOnce(d, SEVEN_TIMES_CALL);
    d.update(SEVEN_TIMES_CALL, { patientFirstName: 'Given' });
    const decision = askOnce(d, SEVEN_TIMES_CALL);

    // The ordinary path is untouched: answered, so it moves on, and nothing is
    // reported as exhausted.
    expect(decision.nextQuestion?.field).toBe('patientLastName');
    expect(decision.askBudgetSpent).toBeUndefined();
  });

  it('is charged by noteAsked, NOT by reading next()', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);

    // pcpAgent reads next() four more times per call for handoffEligible,
    // disposition and mayTerminate (lines 785, 842, 1154, 1852) without
    // speaking to anybody. Those reads must not burn the caller's two asks.
    for (let read = 0; read < 10; read++) d.next(SEVEN_TIMES_CALL);
    expect(d.next(SEVEN_TIMES_CALL).nextQuestion?.field).toBe('patientFirstName');
    expect(d.next(SEVEN_TIMES_CALL).askBudgetSpent).toBeUndefined();
  });
});

/**
 * THE DECOUPLING, AND IT IS THE LOAD-BEARING HALF.
 *
 * `handoffEligible`'s second arm is "a complete intake on a HAND_OFF purpose"
 * — the AUTO-transfer the operator withdrew on 2026-09-04 ("never
 * auto-transfer; transfer only when the caller ASKS and is an entity"). It
 * used to read the same `missing` value the question does.
 *
 * Had the budget been wired into that one value, spending it would complete
 * the intake by fiat and DIAL — a caller put into the PCP queue because we
 * gave up asking them a question. That is the `connectsToHuman` welding
 * CLAUDE.md already records, pointed at something far worse than a long
 * intake.
 */
describe('spending the budget changes what we SAY, never who we CONNECT', () => {
  it('leaves handoffEligible false while the intake is genuinely short', () => {
    const d = director();
    const callId = 'CAtest0000000000000000000000000001';
    // peer_to_peer defaults to HAND_OFF. Everything present but the facility type.
    d.update(callId, {
      callPurpose: 'peer_to_peer',
      callerName: 'A Caller',
      callerRole: 'physician',
      callerOrganization: 'An Organization',
      callbackNumber: '5555550100',
    });

    expect(d.next(callId).handoffEligible).toBe(false);
    for (let turn = 0; turn < MAX_ASKS_PER_FIELD; turn++) askOnce(d, callId);

    const after = d.next(callId);
    expect(after.nextQuestion).toBeUndefined();          // we stopped asking
    expect(after.askBudgetSpent).toEqual(['callerFacilityType']);
    expect(after.handoffEligible).toBe(false);           // and we still do not dial
  });

  it('still hands off once the intake is genuinely complete', () => {
    const d = director();
    const callId = 'CAtest0000000000000000000000000002';
    d.update(callId, {
      callPurpose: 'peer_to_peer',
      callerName: 'A Caller',
      callerRole: 'physician',
      callerOrganization: 'An Organization',
      callerFacilityType: 'referring_provider',
      callbackNumber: '5555550100',
    });
    expect(d.next(callId).handoffEligible).toBe(true);
  });
});

/**
 * WIRING, READ FROM THE SOURCE.
 *
 * The budget is inert unless the one tool that speaks a question charges it.
 * Asserting only against the director would be testing the sink instead of the
 * source — failure mode 10, and the device `ticketRequirements.test.ts`
 * already uses for the sweep's wiring.
 */
describe('the intake tool charges the budget', () => {
  const agent = readFileSync(path.resolve(__dirname, '../agents/pcpAgent.ts'), 'utf8');
  const timeline = readFileSync(path.resolve(__dirname, '../services/toolTimeline.ts'), 'utf8');

  it('record_pcp_intake calls noteAsked on the field it hands back', () => {
    expect(agent).toContain('pcpDirector.noteAsked(callId, decision.nextQuestion.field)');
  });

  it('nothing else in the agent charges it', () => {
    // Four other call sites read next() for handoffEligible, disposition and
    // mayTerminate. A second noteAsked would burn asks nobody spoke.
    expect((agent.match(/noteAsked\(/g) ?? []).length).toBe(1);
  });

  it('askBudgetSpent reaches tool_timeline, so it is countable from SQL', () => {
    // The tool ceiling's own stops are console-only and cannot be counted at
    // all. This signal exists so priority 3 is measurable, not anecdotal.
    expect(timeline).toContain("'askBudgetSpent'");
  });
});
