import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PcpDirector,
  MAX_ASKS_PER_FIELD,
  ASKS_FOR_FIELD,
  askBudgetFor,
  ENRICHMENT_AFTER_FILING,
  PROFESSIONAL_ENRICHMENT,
  PROMPTS,
  type PcpConversationState,
} from './director';

/**
 * THE TEN CALLS THAT DIED ON THE EMAIL QUESTION — 2026-09-16, the PCP line's
 * first full day on v36.
 *
 * Measured over that day's substantive PCP calls (`duration >= 30`):
 *
 *   asked for an email                                        25
 *   ... the ask is the last thing on the transcript           18
 *   ... and NO ticket of any provenance carries the call SID  10
 *
 * The ten were checked against `tickets` by call SID in the Support Center,
 * not inferred from `call_logs.ticket_number`. Three of them had spelled a
 * complete address out loud before the line went quiet.
 *
 * RULE THREE: the real SIDs and the real SHAPE live here; the callers' words
 * stay on disk and in `call_logs`. Every value below is synthetic.
 *
 *   CA782b4da236a6cc80a485c50e55f4b2a1   78s   "I don't have access to email"
 *   CA46cad3ff36083cf32f6d335afd028f27  107s   spelled it out, then silence
 *   CAab207f35a07d620795f6eecb127dddbe  100s   spelled it out, then "Hello?"
 *   CA40f8d7eab0e7fb2e92ffc94bada1e1b8   59s   gave a complete address
 *
 * WHY THEY LEFT NOTHING. The model files when it runs out of questions, so a
 * question standing in front of the filing is a gate whatever the filing TOOL
 * is willing to accept. `FILING_MAY_BE_HELD = false` opened the gate on the
 * tool on 2026-09-16; these ten died in front of the INTERVIEW.
 */
const NO_EMAIL_TO_GIVE = 'CA782b4da236a6cc80a485c50e55f4b2a1';

/** The lunch clock is pinned on every director built here — see v32. */
const director = () => new PcpDirector({ lunchClosure: () => false });

/** A professional intake with the request complete and nothing enriched. */
const requestComplete: Partial<PcpConversationState> = {
  callPurpose: 'outside_referral_status',
  callerName: 'A Caller',
  callerOrganization: 'An Organization',
  callbackNumber: '+19095551234',
  patientFirstName: 'A',
  patientLastName: 'Patient',
};

const source = (file: string) =>
  readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8');

describe('the email question is asked once, not twice', () => {
  it('gives callerEmail a budget of one and everything else the default', () => {
    expect(askBudgetFor('callerEmail')).toBe(1);
    expect(ASKS_FOR_FIELD.callerEmail).toBe(1);
    // Everything without an entry keeps the two-ask default, which exists
    // because a genuine ASR drop on the first pass is common on this line.
    expect(askBudgetFor('callerRole')).toBe(MAX_ASKS_PER_FIELD);
    expect(askBudgetFor('patientFirstName')).toBe(MAX_ASKS_PER_FIELD);
    expect(MAX_ASKS_PER_FIELD).toBe(2);
  });

  it('offers the email once and the title twice when neither is answered', () => {
    const d = director();
    d.update(NO_EMAIL_TO_GIVE, requestComplete);
    d.recordDisposition(NO_EMAIL_TO_GIVE, 'CREATE_TASK');

    const asked: string[] = [];
    for (let turn = 0; turn < 10; turn++) {
      const decision = d.askNext(NO_EMAIL_TO_GIVE);
      if (decision.nextQuestion) asked.push(String(decision.nextQuestion.field));
    }

    expect(asked.filter((f) => f === 'callerRole').length).toBe(2);
    expect(asked.filter((f) => f === 'callerEmail').length).toBe(1);
  });

  it('reports the spent email budget on the turn it is spent, not a turn later', () => {
    // Codex P2 (#315): a caller who hangs up on the final prompt produces no
    // next invocation, so reporting exhaustion late makes the SQL signal miss
    // exactly the calls worth counting. At a budget of one, "late" would mean
    // never — the first ask is also the last.
    const d = director();
    d.update(NO_EMAIL_TO_GIVE, { ...requestComplete, callerRole: 'Referral coordinator' });
    d.recordDisposition(NO_EMAIL_TO_GIVE, 'CREATE_TASK');
    const decision = d.askNext(NO_EMAIL_TO_GIVE);
    expect(decision.nextQuestion?.field).toBe('callerEmail');
    expect(decision.askBudgetSpent).toContain('callerEmail');
  });

  it('enforces the budget from ONE table, so it cannot be enforced in one place and not the other', () => {
    // `noteAsked` and both filters in `next()` read `askBudgetFor`. A bare
    // comparison against the constant is the drift that let two noun lists in
    // `explicitAsk.ts` disagree and cost the operator his own transfer.
    const director = source('src/pcp/director.ts');
    expect(director).not.toMatch(/[<>]=?\s*MAX_ASKS_PER_FIELD/);
    expect((director.match(/askBudgetFor\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the credentials are asked after the ticket exists, not in front of it', () => {
  it('asks nothing more once the request is complete, so the model files', () => {
    const d = director();
    d.update('filable', requestComplete);
    expect(d.askNext('filable').nextQuestion).toBeUndefined();
  });

  it('never speaks the email question before a disposition is recorded', () => {
    const d = director();
    d.update('filable', requestComplete);
    const asked: string[] = [];
    for (let turn = 0; turn < 8; turn++) {
      const q = d.askNext('filable').nextQuestion;
      if (q) asked.push(String(q.field));
    }
    expect(asked).toEqual([]);
    // And the question itself is unchanged — this moves WHEN it is asked, not
    // what it says.
    expect(PROMPTS.callerEmail).toMatch(/email address/i);
  });

  it('asks them the moment the request is durable', () => {
    const d = director();
    d.update('filable', requestComplete);
    d.recordDisposition('filable', 'CREATE_TASK');
    expect(d.askNext('filable').nextQuestion?.field).toBe('callerRole');
  });

  it('holds back the title and the email, and NOT the callback number', () => {
    // "THE NUMBER COMES BEFORE THE TICKET, ALWAYS" (standing instruction 12):
    // confirming a callback number after filing is not confirming it, because
    // the ticket is already a record somebody will act on.
    expect(ENRICHMENT_AFTER_FILING).toEqual(['callerRole', 'callerEmail']);
    expect(ENRICHMENT_AFTER_FILING).not.toContain('callbackNumber');
    expect(PROFESSIONAL_ENRICHMENT).toContain('callbackNumber');

    const d = director();
    d.update('noani', { ...requestComplete, callbackNumber: undefined });
    expect(d.askNext('noani').nextQuestion?.field).toBe('callbackNumber');
  });
});

describe('the filing tool hands the question over, because nothing else will', () => {
  /**
   * CODEX P1 ON #318, AND IT WAS RIGHT.
   *
   * Unlocking the two fields is not enough on its own: only
   * `record_pcp_intake` names a question, and the model has no reason to call
   * it again once it is holding a ticket number to read out. So the fields
   * would have unlocked into a conversation that had already moved on, and
   * `pcp_caller_email` would have gone to zero rather than merely down.
   *
   * WIRING, READ FROM THE SOURCE — failure mode 10, the device
   * `directorAskBudget.test.ts` already uses for the charge. A director-level
   * assertion cannot see whether the agent asks, which is the whole defect.
   */
  const agent = source('src/agents/pcpAgent.ts');

  it('create_pcp_task asks the director for the next question after a successful file', () => {
    const filed = agent.indexOf("pcpDirector.recordDisposition(callId, disposition);");
    // FROM `filed`, not from 0 — `record_pcp_intake` opens with the same
    // line, and searching from the top finds THAT one and reports the
    // hand-over as missing.
    const asks = agent.indexOf('const decision = pcpDirector.askNext(callId);', filed);
    expect(filed).toBeGreaterThan(-1);
    expect(asks).toBeGreaterThan(filed);
    /**
     * AND NOTHING RETURNS BETWEEN THEM. An ordering assertion alone is
     * decoration here: an early `return response;` above the block leaves the
     * block sitting in the source, in the right order, and stone dead —
     * mutation-checked, and the first version of this test passed under
     * exactly that mutation. The only early return on this path is the
     * `!response.success` guard, which sits ABOVE `filed`.
     */
    expect(agent.slice(filed, asks)).not.toMatch(/\breturn\b/);
    // The question and the instruction both reach the model.
    expect(agent).toContain('say: enrich.prompt,');
    expect(agent).toContain('record the answer with record_pcp_intake');
  });

  it('charges through askNext, so the one-ask email budget survives the second call site', () => {
    // `next()` here instead would hand the question over WITHOUT charging, and
    // `record_pcp_intake` would then offer `callerEmail` again — the operator's
    // one ask restored to two through the back door.
    expect(agent).not.toMatch(/const decision = pcpDirector\.next\(/);
    // And the budget holds across BOTH call sites, because both go through the
    // same charging entry point.
    const d = director();
    d.update('both', requestComplete);
    d.recordDisposition('both', 'CREATE_TASK');
    const asked: string[] = [];
    for (let turn = 0; turn < 10; turn++) {
      const q = d.askNext('both').nextQuestion;
      if (q) asked.push(String(q.field));
    }
    expect(asked.filter((f) => f === 'callerEmail').length).toBe(1);
  });

  it('carries the spent budget out with the question, so a hang-up is still counted', () => {
    // Codex P2 on #318 — the #315 lesson at a second call site. A caller who
    // volunteered their role gets `callerEmail` HERE as their one ask; if they
    // go, no later record_pcp_intake carries the signal, and the instrument
    // misses exactly the call it was built for.
    expect(agent).toContain('const decision = pcpDirector.askNext(callId);');
    expect(agent).toMatch(/askBudgetSpent: decision\.askBudgetSpent/);
    // toolTimeline gates the whole outcome read on nextQuestion, so
    // askBudgetSpent alone would never reach the table.
    expect(agent).toContain('nextQuestion: enrich,');
    const timeline = source('src/services/toolTimeline.ts');
    expect(timeline).toContain('parsed?.nextQuestion || parsed?.mayTerminate !== undefined');
    expect(timeline).toContain("'askBudgetSpent'");
  });

  it('does not name MAX_ASKS_PER_FIELD in the budget log, because it is no longer every field\'s budget', () => {
    // `ASKS_FOR_FIELD` gives callerEmail one ask, so a line naming ANY single
    // count misreports the one field this PR exists to cap.
    //
    // BANNING ONE SPELLING IS NOT A GUARD: the first version of this forbade
    // only `${MAX_ASKS_PER_FIELD}` and a hardcoded `${2}` sailed through it,
    // which mutation testing caught. Both budget logs must say what happened
    // rather than how many times it took.
    expect(agent).not.toMatch(/attempts each/);
    expect((agent.match(/— budget spent`\);/g) ?? []).length).toBe(2);
  });

  it('says the ticket is filed rather than implying something went wrong', () => {
    // The v18 shape: a branch speaking the sentence that belongs to the other
    // one. This branch is reached only AFTER a successful POST.
    expect(agent).toContain('The ticket is FILED');
    expect(agent).toContain('do not apologise');
  });
});

describe('what this must NOT move: who we dial', () => {
  /**
   * THE v33 DECOUPLING, REUSED. `intakeIncomplete` is computed from
   * `stillUnset` — the FULL required list, enrichment included — while
   * `missing` is computed from `askableNow`. `handoffEligible`'s second arm
   * reads `intakeIncomplete`, and that arm is the AUTO-transfer the operator
   * withdrew on 2026-09-04. Shortening the missing list without shortening
   * the incomplete one is what keeps a caller from being dialled into the PCP
   * queue two questions sooner because we stopped asking them something.
   *
   * BELT AND BRACES, AND SAID SO RATHER THAN OVERCLAIMED: the enrichment block
   * is only appended when the purpose does NOT allow HAND_OFF, so that arm
   * cannot be reached today with these fields in the list. The separation
   * still holds the moment either of those two facts changes.
   */
  it('computes intakeIncomplete from the full list and missing from the askable one', () => {
    const director = source('src/pcp/director.ts');
    expect(director).toContain('const intakeIncomplete = stillUnset.length > 0;');
    expect(director).toContain('const missing = askableNow.find(');
    expect(director).toMatch(/const askableNow = stillUnset\.filter\(/);
  });

  it('does not grant a transfer to a professional whose request merely became filable', () => {
    const d = director();
    d.update('nodial', requestComplete);
    const decision = d.next('nodial');
    expect(decision.nextQuestion).toBeUndefined();
    expect(decision.handoffEligible, 'giving up on a question must never become a dial').toBe(false);
  });

  it('still grants it to a professional who ASKS, which is the operator rule', () => {
    const d = director();
    d.update('asked', requestComplete);
    d.markCallerRequestedHuman('asked');
    expect(d.next('asked').handoffEligible).toBe(true);
  });
});
