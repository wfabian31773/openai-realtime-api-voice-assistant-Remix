/**
 * THE "INTAKE INCOMPLETE" NOTE IS THE DIRECTOR'S OWN LIST.
 *
 * Support Desk intake, Oct 30 2026 (tickets 69644, 69593, 69579, 69578, 69577,
 * 69557, 69549, 69544, 69540): nearly every PCP ticket carried
 * "[Intake incomplete ...]" naming role, organization type, relationship to
 * the patient and DOB, fields the director deliberately stopped asking (v34).
 * pcpAgent's `ticketState()` checked a static nine-field list instead of what
 * `next()` requires for the call reason. It now reads `intakeMissing`.
 *
 * The wiring half (the note on a filed ticket) is pinned in
 * pcpIntakeDegradation.test.ts, which goes red if `ticketState()` reverts to a
 * static list.
 */
import { describe, expect, it } from 'vitest';
import { PcpDirector } from './director';

const NEVER_ASKED = ['callerFacilityType', 'statedRelationship', 'patientDob'];
const fresh = () => new PcpDirector({ lunchClosure: () => false });

describe('intakeMissing comes from the director, per call reason', () => {
  it('a professional handoff-capable purpose with name and organization is complete', () => {
    const d = fresh();
    d.update('a', { callPurpose: 'schedule_appointment', callerName: 'Alex', callerOrganization: 'Clinic' });
    expect(d.next('a').intakeMissing).toEqual([]);
  });

  it('never reports a field the director no longer asks', () => {
    for (const purpose of ['schedule_appointment', 'service_inquiry', 'patient_medical_records_request', 'outside_referral_status', 'patient_caller'] as const) {
      const d = fresh();
      d.update('b', { callPurpose: purpose });
      const missing = d.next('b').intakeMissing;
      for (const field of NEVER_ASKED) expect(missing, `${purpose} -> ${field}`).not.toContain(field);
    }
  });

  it('a patient caller is never reported missing a role or an organization', () => {
    const d = fresh();
    d.update('c', { callPurpose: 'patient_caller' });
    const missing = d.next('c').intakeMissing;
    expect(missing).toContain('callerName');
    expect(missing).not.toContain('callerRole');
    expect(missing).not.toContain('callerOrganization');
  });

  it('still reports the patient name on a purpose that requires patient context', () => {
    const d = fresh();
    d.update('d', { callPurpose: 'outside_referral_status', callerName: 'Alex', callerOrganization: 'Clinic' });
    const missing = d.next('d').intakeMissing;
    expect(missing).toContain('patientFirstName');
    expect(missing).toContain('patientLastName');
  });

  it('drops a field once it is answered, including via SATISFIED_BY', () => {
    const d = fresh();
    d.update('e', { callPurpose: 'outside_referral_status', callerName: 'Alex', callerOrganization: 'Clinic', patientFirstName: 'Pat', patientLastName: 'Lee' });
    expect(d.next('e').intakeMissing).not.toContain('patientFirstName');
    d.update('e', { deliveryPreference: 'email' } as never);
    expect(d.next('e').intakeMissing).not.toContain('callerEmail');
  });

  it('is the same list that decides whether the intake is incomplete (no second copy)', () => {
    const d = fresh();
    d.update('f', { callPurpose: 'service_inquiry', callerName: 'Alex' });
    const decision = d.next('f');
    expect(decision.intakeMissing.length > 0).toBe(true);
    if (decision.nextQuestion) expect(decision.intakeMissing).toContain(decision.nextQuestion.field);
  });
});
