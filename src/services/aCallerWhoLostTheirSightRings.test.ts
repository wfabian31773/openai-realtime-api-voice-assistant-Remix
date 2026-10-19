/**
 * A CALLER WHO LOST THEIR SIGHT RINGS, IN THEIR OWN WORDS — AND A PROVIDER
 * CLAIM THE CALLER NEVER MADE DOES NOT RING THROUGH THE ACUTE DOOR.
 *
 * Review of #353 at d1f76573:
 *
 *   P1 — v99 feeds the caller's words to the gate on the runtime, which makes
 *   the invented-symptom check live again, and that check runs BEFORE the
 *   acute terms. Its vision evidence held "vision|see|sight|dark…", so "I went
 *   blind", "I lost my eyesight", "everything went black", "a curtain came
 *   down" and "estoy ciego" were read as a symptom the model invented, and a
 *   real vision-loss caller was refused a provider.
 *
 *   P2 — the acute lists read the MODEL's sentence, so "clinician calling
 *   about a post-op patient" for a caller who said "Operator. Page Dr. Hart."
 *   rang as acute_clinical and skipped the unstated-provider refusal.
 *
 * Synthetic caller lines in the shapes the review names. No real words.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { corroborate, recordCallerSpeech, releaseCallerSpeech } from './symptomCorroboration';
import { judgeEscalation } from './afterHoursEscalationGate';

const CALL = 'CA00000000000000000000000000000353';
beforeEach(() => releaseCallerSpeech(CALL));

function heard(spoken: string, claim: string) {
  releaseCallerSpeech(CALL);
  if (spoken) recordCallerSpeech(CALL, spoken);
  return corroborate(CALL, claim);
}

describe('P1 — every way a caller says they lost their sight is the caller saying it', () => {
  const SAID = [
    'I went blind in my right eye.',
    "I'm blind in my eye all of a sudden.",
    'I lost my eyesight this evening.',
    'I lost my vision in the left eye.',
    'My eyesight is just gone.',
    'Everything went black.',
    'It all went dark on that side.',
    "It's like a curtain came down.",
    "There's a shadow over half of it.",
    "It's like a veil over my eye.",
    "I can't see out of my right eye.",
    'I cannot see anything.',
    'I can not see.',
    "It's gone, the whole eye.",
    'Estoy ciego del ojo derecho.',
    'Mi esposa está ciega de un ojo.',
    'No veo nada.',
    'No puedo ver del ojo izquierdo.',
    'Perdí la vista.',
    'Perdi la vista de repente.',
    'Se me nubló todo.',
    'Es como una cortina.',
    'Tengo una sombra en el ojo.',
    'Todo negro.',
    'Todo se puso negro.',
  ];

  for (const said of SAID) {
    it(`"${said}" corroborates the model's "sudden vision loss" and the call rings`, () => {
      const c = heard(said, 'sudden vision loss');
      expect(c.supported, 'the evidence list holds this wording').toContain('vision change');
      const v = judgeEscalation({
        callerType: 'patient_urgent_medical',
        reason: 'Caller reports sudden vision loss',
        symptomsSummary: 'sudden vision loss',
        corroboration: c,
      });
      expect(v.allowed, said).toBe(true);
    });
  }

  it('a symptom in the caller\'s own words counts even when the claim list misses it', () => {
    // "bleeding" is not vision evidence, but the caller described an
    // emergency; the per-claim list must never be the only door.
    const c = heard('My eye is bleeding.', 'sudden vision loss');
    expect(c.unsupported).toContain('vision change');
    expect(c.symptomStated).toBe(true);
    const v = judgeEscalation({ reason: 'sudden vision loss', corroboration: c });
    expect(v.allowed).toBe(true);
  });

  it('an acute phrase in the caller\'s own words counts the same way', () => {
    const c = heard('There is something in my eye.', 'vision loss and pain');
    expect(c.supported).toEqual([]);
    expect(c.acuteStated).toBe(true);
    expect(judgeEscalation({ reason: 'vision loss and pain', corroboration: c })).toEqual({
      allowed: true,
      basis: 'acute_clinical',
    });
  });

  it('a symptom the caller never described at all is still refused', () => {
    const c = heard('Yes, I would like somebody to give me a call. | Yes.', 'red eye with pain and vision changes');
    expect(c.symptomStated).toBe(false);
    expect(c.acuteStated).toBe(false);
    const v = judgeEscalation({ reason: 'red eye with pain and vision changes reported', corroboration: c });
    expect(v).toMatchObject({ allowed: false, code: 'symptoms_not_stated_by_caller' });
  });
});

describe('P2 — an acute word only the model wrote does not ring an unstated provider claim', () => {
  const REASONS = [
    'Clinician calling about a post-op patient',
    'Provider reports patient with flashes and floaters',
    'Clinician says the patient is bleeding from the eye',
    'Doctor calling about eye trauma',
  ];

  for (const reason of REASONS) {
    it(`"${reason}" for a caller who said "Operator. Page Dr. Hart." is refusal 3, not acute`, () => {
      const v = judgeEscalation({
        callerType: 'healthcare_provider',
        reason,
        corroboration: heard('Operator. Page Dr. Hart.', reason),
      });
      expect(v).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
    });

    it(`"${reason}" rings as acute when the caller said it themselves`, () => {
      const v = judgeEscalation({
        callerType: 'healthcare_provider',
        reason,
        corroboration: heard('I had surgery yesterday and now I see flashes.', reason),
      });
      expect(v).toEqual({ allowed: true, basis: 'acute_clinical' });
    });
  }

  it('a caller who said they are a provider still rings, whatever the acute words', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Clinician calling about a post-op patient',
      corroboration: heard("I'm a nurse calling from Pomona Valley Hospital.", 'post-op patient'),
    });
    expect(v).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it('with no record of the caller speaking, nothing changes: a post-op patient rings as acute', () => {
    const v = judgeEscalation({
      callerType: 'patient_urgent_medical',
      reason: 'post-op patient with flashes',
      corroboration: heard('', 'post-op patient with flashes'),
    });
    expect(v).toEqual({ allowed: true, basis: 'acute_clinical' });
    expect(judgeEscalation({ callerType: 'healthcare_provider', reason: 'post-op patient' })).toEqual({
      allowed: true,
      basis: 'provider_or_facility',
    });
  });
});
