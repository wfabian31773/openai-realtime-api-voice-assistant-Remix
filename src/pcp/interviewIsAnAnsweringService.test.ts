import { describe, it, expect } from 'vitest';
import {
  PcpDirector, PROFESSIONAL_FIELDS, PATIENT_FIELDS, PATIENT_INTAKE_ORDER, PROMPTS,
} from './director';

/**
 * THE PCP LINE IS AN ANSWERING SERVICE. Operator, 2026-09-16:
 *
 *   "ensure that the PCP line acts as a literal answering service... who is
 *    calling, what are you calling about, where are you calling from, who is
 *    this in regards to, and how would you like to receive the information.
 *    I think that is the crux of any request."
 *
 * Measured over all 369 substantive PCP calls of 2026-09-14/15: 97 died inside
 * the caller-credential block for 17 tickets (17.5%), and only 5 died on a
 * patient question — because almost nobody survived long enough to be asked
 * one. See the comment above PROFESSIONAL_FIELDS for the full attrition table
 * and the transcript that makes the argument.
 */
const director = () => new PcpDirector({ lunchClosure: () => false });

/** Walk the intake, answering nothing, and record what it asks. */
function questionsAsked(d: PcpDirector, callId: string, turns = 12): string[] {
  const asked: string[] = [];
  for (let i = 0; i < turns; i++) {
    const decision = d.askNext(callId);
    if (!decision.nextQuestion) break;
    const field = String(decision.nextQuestion.field);
    if (!asked.includes(field)) asked.push(field);
    // Answer it, so the walk advances rather than spending the ask budget.
    d.update(callId, { [field]: field === 'callerFacilityType' ? 'pcp_office' : 'answer' } as never);
  }
  return asked;
}

describe('what the line no longer spends a turn on', () => {
  it.each([
    ['callerRole', '26 calls died here for 6 tickets'],
    ['callerFacilityType', 'an eight-value enum read to somebody who just named their organisation'],
    ['statedRelationship', 'drew the same answer as the role question'],
    ['patientDob', '20 calls died here for 1 ticket'],
  ])('never asks for %s (%s)', (field) => {
    expect(PROFESSIONAL_FIELDS).not.toContain(field);
    expect(PATIENT_FIELDS).not.toContain(field);
    expect(PATIENT_INTAKE_ORDER).not.toContain(field);
  });

  it('still RECORDS every one of them when the caller volunteers it', () => {
    // Deleted as questions, not as facts. They still travel on the ticket and
    // still feed the records route, which reads callerFacilityType first and
    // falls back to prose.
    const d = director();
    d.update('rec', {
      callerRole: 'Medical receptionist',
      callerFacilityType: 'ipa_medical_group',
      statedRelationship: 'referral coordinator',
      patientDob: '1970-01-01',
    });
    const state = d.get('rec');
    expect(state.callerRole).toBe('Medical receptionist');
    expect(state.callerFacilityType).toBe('ipa_medical_group');
    expect(state.statedRelationship).toBe('referral coordinator');
    expect(state.patientDob).toBe('1970-01-01');
  });
});

describe('the order the operator asked for', () => {
  /**
   * THE OPERATOR'S OWN LIST, 2026-09-16, in his own order — "who's calling,
   * what's your title, what organization are you calling from, who is this
   * request in regards to, and then how would you like to receive this
   * information" — with ONE change I made and am stating rather than hiding.
   *
   * He put the TITLE second. It is asked fifth here, after the patient. The
   * measurement is why: `callerRole` asked second was the single biggest
   * killer on this line (26 calls died on it over 2026-09-14/15 for 6
   * tickets), and a caller who quits on question two takes the whole request
   * with them. Asked after purpose, name, organisation and the patient, the
   * same hang-up costs a job title on a ticket that files anyway.
   *
   * The FIELD is his and is back in. The POSITION is mine, and it is an
   * implementation call under standing instruction 15 — stated here so he can
   * overrule it by moving one entry between two arrays.
   */
  it('asks a professional for his list, patient before credentials', () => {
    const d = director();
    // A purpose with no patient behind it: the whole list is the caller.
    d.update('pro', { callPurpose: 'plan_participation' });
    // BEFORE THE TICKET EXISTS, only what the request needs. The title and the
    // email used to be in this walk; on 2026-09-16 ten calls died on the email
    // question and left no ticket of any provenance, so they moved behind the
    // filing — `ENRICHMENT_AFTER_FILING`.
    expect(questionsAsked(d, 'pro')).toEqual([
      'callerName', 'callerOrganization', 'callbackNumber',
    ]);
    // AND THE FIELDS ARE NOT DROPPED — they are asked once the request is safe.
    d.recordDisposition('pro', 'CREATE_TASK');
    expect(questionsAsked(d, 'pro')).toEqual(['callerRole', 'callerEmail']);
  });

  it('and the patient comes before the title when there is a patient', () => {
    const d = director();
    d.update('ord', { callPurpose: 'outside_referral_status' });
    const asked = questionsAsked(d, 'ord');
    expect(asked).toContain('patientFirstName');
    // The title and the email are not merely later in this walk — they are not
    // in it at all until a disposition is on the record.
    expect(asked).not.toContain('callerRole');
    expect(asked).not.toContain('callerEmail');
    d.recordDisposition('ord', 'CREATE_TASK');
    expect(questionsAsked(d, 'ord')).toEqual(['callerRole', 'callerEmail']);
  });

  it('puts WHO THE CALL IS ABOUT in the intake, not behind five credentials', () => {
    const d = director();
    d.update('pt', { callPurpose: 'outside_referral_status' });
    const asked = questionsAsked(d, 'pt');
    expect(asked).toContain('patientFirstName');
    // It used to sit behind callerRole, callerOrganization, callerFacilityType
    // and statedRelationship. Three of those four are gone.
    expect(asked.indexOf('patientFirstName')).toBeLessThan(4);
  });
});

describe('the questions do the extra work, so the turns do not', () => {
  it('the name question invites the organisation', () => {
    // Measured wording: callers answer "Karina from Optum Medical Clinics".
    expect(PROMPTS.callerName).toMatch(/where are you calling from/i);
    expect(PROMPTS.callerName).toMatch(/\?$/);
  });

  it('a caller who gives both is never asked the organisation', () => {
    const d = director();
    d.update('both', { callPurpose: 'plan_participation' });
    d.askNext('both'); // callerName
    // One utterance, both facts — which is how the transcripts read.
    d.update('both', { callerName: 'Karina', callerOrganization: 'Optum Medical Clinics' });
    const next = d.askNext('both').nextQuestion?.field;
    expect(next, 'the organisation was asked despite being given').not.toBe('callerOrganization');
    expect(next).toBe('callbackNumber');
  });

  it('a caller who gives only a name IS still asked the organisation', () => {
    // The half-answer is why callerOrganization stays its own field rather
    // than being folded into one bundled question.
    const d = director();
    d.update('half', { callPurpose: 'plan_participation', callerName: 'Karina' });
    expect(d.askNext('half').nextQuestion?.field).toBe('callerOrganization');
  });

  it('the patient question invites the whole name, and the half-answer is caught', () => {
    expect(PROMPTS.patientFirstName).toMatch(/who is this in regards to/i);
    const d = director();
    d.update('pn', { callPurpose: 'outside_referral_status', callerName: 'A', callerOrganization: 'B', callbackNumber: '5555550100' });
    d.askNext('pn');
    d.update('pn', { patientFirstName: 'Sam' });   // only a first name
    expect(d.askNext('pn').nextQuestion?.field).toBe('patientLastName');
  });
});

describe('the call a real caller gets', () => {
  it('is three questions when they answer the way the transcripts show', () => {
    const d = director();
    // Caller ID seeded the callback (pcpAgent.ts seeds it whenever the ANI is
    // E.164), and the greeting already asked the purpose.
    d.update('real', { callPurpose: 'outside_referral_status', callbackNumber: '+19095551234' });

    const asked: string[] = [];
    let decision = d.askNext('real');
    asked.push(String(decision.nextQuestion?.field));
    d.update('real', { callerName: 'Karina', callerOrganization: 'Optum Medical Clinics' });

    decision = d.askNext('real');
    asked.push(String(decision.nextQuestion?.field));
    d.update('real', { patientFirstName: 'Sam', patientLastName: 'Rivera' });

    // Two questions in, the REQUEST is complete: who, where from, which
    // patient, and a callback the call itself supplied. What remains is the
    // enrichment block, which cannot cost us the ticket.
    expect(asked).toEqual(['callerName', 'patientFirstName']);
    // AND THE INTERVIEW STOPS THERE so the model files. It used to hand back
    // `callerRole` here, and then the email — which is where ten calls ended
    // on 2026-09-16 with no ticket at all.
    expect(d.askNext('real').nextQuestion).toBeUndefined();
    // Once the request is durable, the credentials are asked and enrich it.
    d.recordDisposition('real', 'CREATE_TASK');
    expect(d.askNext('real').nextQuestion?.field).toBe('callerRole');
  });

  /**
   * AND THE ENRICHMENT CANNOT COST THE REQUEST — which is the whole reason it
   * is at the end rather than at the front.
   *
   * `CAd00fa911`, 2026-09-14, 1,148 seconds, no ticket: the caller opened with
   * her purpose unprompted, answered the name question with name AND
   * organisation, was then asked her role, her facility type and her
   * relationship to the patient, and quit with "Speak to representative." We
   * never once asked which patient. Under this order she is asked the patient
   * second, and hanging up on the title question leaves a workable ticket.
   */
  it('is never asked a credential question before the request is filable', async () => {
    const { ticketReadiness } = await import('./ticketRequirements');
    const d = director();
    d.update('quit', { callPurpose: 'outside_referral_status', callbackNumber: '+19095551234' });
    d.askNext('quit');
    d.update('quit', { callerName: 'Karina', callerOrganization: 'Optum Medical Clinics' });
    d.askNext('quit');
    d.update('quit', { patientFirstName: 'Sam', patientLastName: 'Rivera' });
    // THIS ASSERTION USED TO READ `toBe('callerRole')`, under the heading "a
    // caller who hangs up on the title question still leaves a filable
    // request". The request was filABLE and it did not FILE: the model files
    // when it runs out of questions, and the title and the email were still
    // questions. Ten calls on 2026-09-16 ended on the email ask with no ticket
    // of any provenance.
    expect(d.askNext('quit').nextQuestion).toBeUndefined();

    const readiness = ticketReadiness(d.get('quit') as never);
    expect(readiness.ready).toBe(true);
    expect(readiness.annotate, 'nothing a staffer needs is missing').toEqual([]);
  });
});
