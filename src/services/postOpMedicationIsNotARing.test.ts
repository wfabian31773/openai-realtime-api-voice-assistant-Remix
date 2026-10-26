/**
 * A POST-OP MEDICATION PROBLEM WITH NO SYMPTOM DOES NOT RING THE ON-CALL PROVIDER.
 *
 * Operator, 2026-10-02, on whether a patient whose post-op drops never reached
 * the pharmacy is "post-surgical trouble": "no, it should record an urgent
 * ticket in after hours." The gate refuses it with its own code, and the
 * refusal files the urgent ticket (noIvrAfterHoursRouting.test.ts).
 *
 * The carve-out must never swallow a symptom: any symptom word sends the call
 * back to the acute check, which rings as before. And a clinician calling about
 * a post-op patient is case 1, whatever the subject.
 */
import { describe, it, expect } from 'vitest';
import { judgeEscalation } from './afterHoursEscalationGate';

const patient = (reason: string) => judgeEscalation({ callerType: 'patient_urgent_medical', reason });

describe('the post-op medication carve-out', () => {
  it('refuses the corpus shape with its own code', () => {
    const v = patient('Had a surgical procedure today; the steroid eye drop prescription is not at the pharmacy');
    expect(v).toMatchObject({ allowed: false, code: 'post_op_medication' });
  });

  it('refuses "post-op" plus a medication, which the acute list alone would have rung', () => {
    expect(patient('Post-op patient ran out of drops')).toMatchObject({ allowed: false, code: 'post_op_medication' });
  });

  it('steps aside the moment a symptom is named — post-surgical trouble still rings', () => {
    for (const reason of [
      'Post-op patient ran out of drops and has pain in the eye',
      'After surgery, drops not at the pharmacy, and vision is blurry',
      'Post-op patient, prescription missing, eye is red and swollen',
      'Después de la cirugía no tiene las gotas y le duele',
    ]) {
      const v = patient(reason);
      expect(v.allowed, reason).toBe(true);
    }
  });

  it('a post-op complication with no medication in it still rings', () => {
    expect(patient('Post-op complication after cataract surgery yesterday').allowed).toBe(true);
  });

  it('a clinician calling about a post-op patient\'s medication is case 1', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Hospital pharmacist calling about a post-op patient prescription',
    });
    expect(v).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it('a plain refill with no operation is still the administrative refusal, unchanged', () => {
    expect(patient('Caller needs a refill of glaucoma drops sent to the pharmacy')).toMatchObject({
      allowed: false,
      code: 'administrative_request',
    });
  });
});
