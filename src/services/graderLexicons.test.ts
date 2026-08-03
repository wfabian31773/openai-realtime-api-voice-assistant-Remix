/** Medical-advice lexicon v8 — advice-shaped only, no appointment-talk false positives. */
import { describe, expect, it } from 'vitest';
import { findMedicalAdviceViolations } from './graderLexicons';

describe('findMedicalAdviceViolations', () => {
  it('does NOT flag routine appointment and reception speech (the v7 false positives)', () => {
    const benign = [
      'you have an appointment on tuesday at three pm',
      'you have reached azul vision, how can i help you',
      'do you have a callback number where we can reach you',
      'i can switch to spanish if you prefer',
      "that's normal for our wait times this season",
      'you have two appointments coming up this month',
      'let me confirm: you have the encinitas office visit on friday',
    ];
    for (const line of benign) {
      expect(findMedicalAdviceViolations(line), line).toEqual([]);
    }
  });

  it('still flags genuine advice-shaped speech', () => {
    const violations = [
      'you should take ibuprofen for that',
      'i recommend taking your drops twice a day',
      'it sounds like you have conjunctivitis',
      'you probably have an eye infection',
      "don't worry it's just allergies",
      "it's probably just dry eye",
      'stop taking your medication until the visit',
      'increase your dose to twice daily',
      'you could switch to a different medication in the meantime',
      "some new floaters? that's normal at your age",
    ];
    for (const line of violations) {
      expect(findMedicalAdviceViolations(line).length, line).toBeGreaterThan(0);
    }
  });

  it('reports what matched (for the grader reason string)', () => {
    const found = findMedicalAdviceViolations('well, it sounds like you have pink eye');
    expect(found.join(' ')).toContain('sounds like you have');
  });
});
