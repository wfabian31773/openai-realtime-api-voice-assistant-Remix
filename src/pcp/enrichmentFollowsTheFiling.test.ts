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
