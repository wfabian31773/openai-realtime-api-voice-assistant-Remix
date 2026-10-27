import { describe, expect, it } from 'vitest';
import { classifyNonSurgicalRequest, correctSurgeryIntake, isSurgeryRequest } from './requestClassification';

describe('review regressions: preserve clinical and procedure context', () => {
  it.each([
    'I have severe eye pain when I wear my glasses.',
    'My eye is red after taking out my contacts.',
    'I see flashes and floaters with my glasses on.',
    'My eye is swollen and I also need to order contacts.',
    'Tengo dolor en el ojo cuando uso lentes de contacto.',
  ])('declines a routine correction for %s', (text) => {
    expect(correctSurgeryIntake(text, 2)).toBeNull();
    expect(correctSurgeryIntake(text, 9)).toBeNull();
  });

  it.each([
    "This isn't about surgery; I need glasses.",
    'This isn’t about surgery; I need glasses.',
    'I do not need surgery; I need glasses.',
    "I don't want cataract surgery; I need glasses.",
    'I am not planning to have surgery; I need glasses.',
  ])('recognizes an explicit surgery denial: %s', (text) => {
    expect(isSurgeryRequest(text)).toBe(false);
    expect(classifyNonSurgicalRequest(text)).toEqual({ departmentId: 1, requestTypeId: 66, requestReasonId: 536 });
  });

  it.each([
    'Will insurance cover my cataract procedure?',
    'Will insurance cover my cataract removal?',
    'Will insurance cover my procedure?',
    'Will insurance cover my vitrectomy?',
    'Will insurance cover my blepharoplasty?',
  ])('preserves surgical insurance context: %s', (text) => {
    expect(isSurgeryRequest(text)).toBe(true);
    expect(classifyNonSurgicalRequest(text)).toBeNull();
  });

  it('treats every taxonomy-named operation as surgical', async () => {
    const { SURGERY_CLASSIFICATIONS } = await import('./surgeryTaxonomy');
    const named = ['vitrectomy', 'blepharoplasty', 'chalazion', 'ectropion', 'ptosis', 'macular hole'];
    for (const name of named) {
      expect(SURGERY_CLASSIFICATIONS.some((c) => c.cues.includes(name)), name).toBe(true);
      expect(isSurgeryRequest(`Will insurance cover my ${name}?`)).toBe(true);
      expect(classifyNonSurgicalRequest(`Please call about my ${name}`)).toBeNull();
    }
  });

  it.each([
    'I do not want to cancel my surgery; I need glasses afterwards.',
    'I am not sure whether I need surgery or glasses.',
    'This is not about surgery; I need insurance for my LASIK operation.',
    'Not cataract surgery, but I need to reschedule my LASIK.',
  ])('preserves positive or uncertain surgery intent: %s', (text) => {
    expect(isSurgeryRequest(text)).toBe(true);
    expect(classifyNonSurgicalRequest(text)).toBeNull();
  });

  it('keeps ordinary optical requests, including red frames', () => {
    expect(classifyNonSurgicalRequest('I want to order red frames for my glasses.'))
      .toEqual({ departmentId: 1, requestTypeId: 66, requestReasonId: 536 });
  });

  it('keeps a request for exam results on Clinical Tech Support', () => {
    expect(classifyNonSurgicalRequest('I need my eye exam results.'))
      .toEqual({ departmentId: 3, requestTypeId: 72, requestReasonId: 542 });
  });

  it('does not let an incidental insurance mention override rescheduling an exam', () => {
    expect(classifyNonSurgicalRequest('I need to reschedule my eye exam because my insurance changed'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 147 });
    expect(classifyNonSurgicalRequest('Will insurance cover my eye exam?'))
      .toEqual({ departmentId: 9, requestTypeId: 37, requestReasonId: 178 });
    expect(classifyNonSurgicalRequest('My insurance changed. Will it cover my eye exam?'))
      .toEqual({ departmentId: 9, requestTypeId: 37, requestReasonId: 178 });
  });

  it('does not let results override booking an exam', () => {
    expect(classifyNonSurgicalRequest('I need to schedule an eye exam to discuss my test results'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 146 });
  });

  it('still routes an explicit exam appointment when a symptom is named', () => {
    expect(classifyNonSurgicalRequest('I need to schedule an eye exam because my vision is blurry'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 146 });
  });

  it('prefers rescheduling when cancellation is negated', () => {
    expect(classifyNonSurgicalRequest('I need to move my eye exam to next week, not cancel it'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 147 });
  });

  it('still files an affirmative exam cancellation', () => {
    expect(classifyNonSurgicalRequest('I need to cancel my eye exam'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 148 });
  });

  it('keeps explicit contact-lens appointment changes on the Hub', () => {
    expect(classifyNonSurgicalRequest('I need to reschedule my appointment for contact lenses'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 147 });
    expect(classifyNonSurgicalRequest('I need to reschedule my appointment to order contact lenses'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 147 });
  });

  it('keeps a contact-lens order cancel on Optical when no appointment is named', () => {
    expect(classifyNonSurgicalRequest('I need to cancel my contact lens order'))
      .toEqual({ departmentId: 1, requestTypeId: 3, requestReasonId: 11 });
    expect(classifyNonSurgicalRequest('I need to cancel my contact lens appointment'))
      .toEqual({ departmentId: 9, requestTypeId: 32, requestReasonId: 148 });
  });

  it('keeps contact-lens order change, confirm, and pickup time on Optical', () => {
    expect(classifyNonSurgicalRequest('change my contact lens order'))
      .toEqual({ departmentId: 1, requestTypeId: 3, requestReasonId: 11 });
    expect(classifyNonSurgicalRequest('confirm my contact lens order'))
      .toEqual({ departmentId: 1, requestTypeId: 3, requestReasonId: 11 });
    expect(classifyNonSurgicalRequest('What time can I pick up my contacts?'))
      .toEqual({ departmentId: 1, requestTypeId: 5, requestReasonId: 21 });
  });

  it('treats sx as surgical context', () => {
    expect(isSurgeryRequest('Please schedule my cataract sx')).toBe(true);
    expect(classifyNonSurgicalRequest('Please schedule my cataract sx')).toBeNull();
  });
});
