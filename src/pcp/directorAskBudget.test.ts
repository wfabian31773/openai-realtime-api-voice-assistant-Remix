import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PcpDirector, MAX_ASKS_PER_FIELD, askBudgetFor, DESTINATION_PROMPTS, type PcpConversationState } from './director';

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
  callerOrganization: 'An Organization',
  callbackNumber: '5555550100',
};

/**
 * One turn of `record_pcp_intake`.
 *
 * THIS CALLS THE REAL METHOD rather than re-implementing the sequence. The
 * first version of this helper hand-rolled `next()` + `noteAsked()` to mirror
 * the call site, and so reproduced Codex's P2 (#315) instead of catching it:
 * the exhaustion was reported one invocation late and a helper written from
 * the same misunderstanding could not see it. A helper that duplicates
 * production logic tests the helper.
 */
const askOnce = (d: PcpDirector, callId: string) => d.askNext(callId);

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
    // HAND_OFF, so PATIENT_FIELDS is appended. Since 2026-09-16 that list is
    // the patient's name and nothing else — statedRelationship and patientDob
    // are recorded when volunteered but never asked. The caller answers
    // neither.
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);
    // A disposition is on the record, so the enrichment block is offered too
    // and this walk covers the whole remaining form. Without it `callerRole`
    // and `callerEmail` are held back until the request is filed — see
    // `ENRICHMENT_AFTER_FILING` and `enrichmentFollowsTheFiling.test.ts`.
    d.recordDisposition(SEVEN_TIMES_CALL, 'CREATE_TASK');
    // The patient's name, then the enrichment block that follows it.
    // `callbackNumber` is seeded and so never offered.
    const outstanding = ['patientFirstName', 'patientLastName', 'callerRole', 'callerEmail'];

    const asked: string[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const decision = askOnce(d, SEVEN_TIMES_CALL);
      if (decision.nextQuestion) asked.push(String(decision.nextQuestion.field));
    }

    // Each gets ITS OWN budget and no more, and the form does not stall on the
    // first one forever — twenty turns produce seven questions, not twenty.
    // `callerEmail` is one rather than two: operator, 2026-09-16.
    for (const field of outstanding) {
      expect(asked.filter((f) => f === field).length, field)
        .toBe(askBudgetFor(field as keyof PcpConversationState));
    }
    expect(asked.length).toBe(
      outstanding.reduce((n, f) => n + askBudgetFor(f as keyof PcpConversationState), 0),
    );
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
 * THE TWO CODEX P2s ON #315, both on this change, both confirmed in the source
 * before they were fixed.
 */
describe('the exhaustion is reported on the turn it happens', () => {
  it('names the field on the SAME decision that spends its last ask', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);

    // First ask: not spent yet.
    const first = askOnce(d, SEVEN_TIMES_CALL);
    expect(first.askBudgetSpent).toBeUndefined();

    // Second ask IS the last one. `next()` read the counts before this ask was
    // charged, so without the fold-back the field would only appear on a THIRD
    // invocation — which never happens when the caller hangs up here, and that
    // is exactly the population the signal exists to count.
    const second = askOnce(d, SEVEN_TIMES_CALL);
    expect(second.nextQuestion?.field).toBe('patientFirstName');
    expect(second.askBudgetSpent).toContain('patientFirstName');
  });

  it('still asks the question it just charged — only the reporting changes', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);
    askOnce(d, SEVEN_TIMES_CALL);
    const second = askOnce(d, SEVEN_TIMES_CALL);
    // The model must put this question to the caller. Suppressing it here
    // would spend the ask without asking.
    expect(second.nextQuestion?.prompt).toBeTruthy();
  });

  it('noteAsked reports exhaustion for the field it charged, and only then', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);
    expect(d.noteAsked(SEVEN_TIMES_CALL, 'patientFirstName')).toBe(false);
    expect(d.noteAsked(SEVEN_TIMES_CALL, 'patientFirstName')).toBe(true);
  });

  it('does not list the same field twice', () => {
    const d = director();
    d.update(SEVEN_TIMES_CALL, upToPatientFirstName);
    askOnce(d, SEVEN_TIMES_CALL);
    const second = askOnce(d, SEVEN_TIMES_CALL);
    const spent = second.askBudgetSpent ?? [];
    expect(spent.filter((f) => f === 'patientFirstName')).toHaveLength(1);
  });
});

describe('a changed delivery method gets its own asks', () => {
  /** A records caller who has chosen fax and been asked for the number. */
  const recordsCaller = {
    callPurpose: 'patient_medical_records_request' as const,
    callerName: 'A Caller',
    callbackNumber: '5555550100',
    callerIsThePatient: true,
    recordsDeliveryMethod: 'fax' as const,
  };

  it('asks for the email address afresh after the caller switches from fax', () => {
    const d = director();
    const callId = 'CAtest0000000000000000000000000003';
    d.update(callId, recordsCaller);

    // Spend both asks on the FAX number, then let the caller answer it.
    for (let turn = 0; turn < MAX_ASKS_PER_FIELD; turn++) askOnce(d, callId);
    d.update(callId, { recordsDeliveryDestination: '5555550199' });

    // "Actually, email it" — the destination is invalidated.
    d.update(callId, { recordsDeliveryMethod: 'email' });
    d.clearRecordsDestination(callId);

    // This is a DIFFERENT question ("What is the email address?"), so it gets
    // its own budget. Without the reset it would get none and the case would
    // file with nowhere to send the records.
    const asked: string[] = [];
    for (let turn = 0; turn < 5; turn++) {
      const decision = askOnce(d, callId);
      if (decision.nextQuestion) asked.push(String(decision.nextQuestion.field));
    }
    expect(asked.filter((f) => f === 'recordsDeliveryDestination').length).toBe(MAX_ASKS_PER_FIELD);
  });

  it('asks the question in the words of the NEW method', () => {
    const d = director();
    const callId = 'CAtest0000000000000000000000000004';
    d.update(callId, recordsCaller);
    for (let turn = 0; turn < MAX_ASKS_PER_FIELD; turn++) askOnce(d, callId);
    d.update(callId, { recordsDeliveryDestination: '5555550199', recordsDeliveryMethod: 'email' });
    d.clearRecordsDestination(callId);

    expect(d.next(callId).nextQuestion?.prompt).toBe(DESTINATION_PROMPTS.email);
  });

  it('resets the destination\'s count and leaves every other field alone', () => {
    const d = director();
    const callId = 'CAtest0000000000000000000000000005';
    d.update(callId, recordsCaller);

    // THE DESTINATION MUST HAVE BEEN ASKED, or the reset branch is never
    // entered and this test cannot see what it does. Mutation testing caught
    // exactly that: an earlier version charged only `patientFirstName`, so
    // replacing the targeted reset with a whole-map wipe passed every
    // assertion. A test that does not reach the branch is not testing it.
    d.noteAsked(callId, 'recordsDeliveryDestination');
    d.noteAsked(callId, 'callerName');

    d.clearRecordsDestination(callId);

    expect(d.get(callId).askCounts?.recordsDeliveryDestination).toBe(0);
    // A reset that swept the whole map would hand every field its asks back —
    // including ones the caller has already been asked twice, which is the
    // seven-times loop returning through a side door.
    expect(d.get(callId).askCounts?.callerName).toBe(1);
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
    // peer_to_peer defaults to HAND_OFF. Everything present but the
    // organisation — the caller who will not say where they are calling from.
    d.update(callId, {
      callPurpose: 'peer_to_peer',
      callerName: 'A Caller',
      callbackNumber: '5555550100',
    });

    expect(d.next(callId).handoffEligible).toBe(false);
    for (let turn = 0; turn < MAX_ASKS_PER_FIELD; turn++) askOnce(d, callId);

    const after = d.next(callId);
    expect(after.nextQuestion).toBeUndefined();          // we stopped asking
    expect(after.askBudgetSpent).toEqual(['callerOrganization']);
    expect(after.handoffEligible).toBe(false);           // and we still do not dial
  });

  it('still hands off once the intake is genuinely complete', () => {
    const d = director();
    const callId = 'CAtest0000000000000000000000000002';
    d.update(callId, {
      callPurpose: 'peer_to_peer',
      callerName: 'A Caller',
      callerOrganization: 'An Organization',
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

  it('record_pcp_intake goes through askNext, which charges as it decides', () => {
    expect(agent).toContain('pcpDirector.askNext(callId)');
  });

  it('the agent never charges the budget itself', () => {
    // Four other call sites read next() for handoffEligible, disposition and
    // mayTerminate without speaking to anybody. A noteAsked out here would
    // burn asks nobody spoke — and orchestrating decide/charge/report at the
    // call site is what put the exhaustion one invocation late (Codex P2,
    // #315). The sequence belongs to the director; the agent just asks.
    // A CALL, not a mention — a comment explaining why the charge lives in the
    // director is documentation, not a second charge. Same distinction
    // `recognisedCallerBlock.test.ts` draws when it strips comments before
    // looking for an inlined copy.
    expect(agent).not.toMatch(/\.noteAsked\s*\(/);
  });

  it('noteAsked has exactly one caller, and it is askNext', () => {
    const director = readFileSync(path.resolve(__dirname, './director.ts'), 'utf8');
    // Its definition, plus the single call inside askNext.
    expect((director.match(/\bnoteAsked\(/g) ?? []).length).toBe(2);
    expect(director).toContain('const nowSpent = this.noteAsked(callId, field);');
  });

  it('askBudgetSpent reaches tool_timeline, so it is countable from SQL', () => {
    // The tool ceiling's own stops are console-only and cannot be counted at
    // all. This signal exists so priority 3 is measurable, not anecdotal.
    expect(timeline).toContain("'askBudgetSpent'");
  });
});
