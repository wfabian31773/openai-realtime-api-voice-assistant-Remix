import { describe, it, expect } from 'vitest';
import { findNameIn, spokenDigitsToNumber, looksLikeName, looksLikeDob, normalizeSpokenDob } from './parsing';

describe('shared caller-answer parsing', () => {
  it('accepts real names and rejects sentences', () => {
    expect(looksLikeName('Carlos Rivera')).toEqual({ first: 'Carlos', last: 'Rivera' });
    expect(looksLikeName('my name is Ana Ruiz')).toEqual({ first: 'Ana', last: 'Ruiz' });
    // Gate B: these were accepted as patient names and then failed forever.
    expect(looksLikeName('I have seen before')).toBeNull();
    expect(looksLikeName('So this is the')).toBeNull();
  });

  it('reads the spelled-out echo callers give ("Lemaire, L-E-M-A-I-R-E")', () => {
    expect(looksLikeName('Lise Lemaire, L-E-M-A-I-R-E')).toEqual({ first: 'Lise', last: 'Lemaire' });
  });

  it('recognises AND normalizes the date forms callers actually say', () => {
    expect(looksLikeDob('5/10/1983')).toBe(true);
    expect(normalizeSpokenDob('5/10/1983')).toBe('1983-05-10');
    expect(normalizeSpokenDob('May 10 1983')).toBe('1983-05-10');
    expect(normalizeSpokenDob('May 10th, 1983')).toBe('1983-05-10');
    // The SD replay defect: spoken numbers were unrecognised, so verifiable
    // patients were sent to a transfer.
    expect(looksLikeDob('August twenty-seven, forty-five')).toBe(true);
    expect(normalizeSpokenDob('August twenty-seven, forty-five')).toBe('1945-08-27');
    expect(normalizeSpokenDob('June fifth, nineteen fifty-nine')).toBe('1959-06-05');
  });

  it('returns null rather than guessing when the date is unusable', () => {
    expect(normalizeSpokenDob('sometime in August')).toBeNull();
    expect(normalizeSpokenDob('I do not remember')).toBeNull();
  });

  /**
   * Sentences taken verbatim from the live calls of 2026-08-10, where the
   * caller answered correctly, the transcriber heard it correctly, and the
   * agent asked again anyway.
   */
  describe('answers the way callers actually give them', () => {
    it('finds the name inside a full sentence', () => {
      expect(findNameIn("Sure, the patient's first and last name is Wayne Fabian and the date of birth is March 17th, 1973."))
        .toEqual({ first: 'Wayne', last: 'Fabian' });
      expect(findNameIn("Yes, it's Wayne Fabian, date of birth is March 17th, 1973."))
        .toEqual({ first: 'Wayne', last: 'Fabian' });
      expect(findNameIn('my name is Maria Gonzalez')).toEqual({ first: 'Maria', last: 'Gonzalez' });
      expect(findNameIn('Wayne Fabian')).toEqual({ first: 'Wayne', last: 'Fabian' });
    });

    it('never lets the date of birth bleed into the surname', () => {
      const n = findNameIn('the name is Wayne Fabian and the date of birth is March 17th 1973');
      expect(n?.last).toBe('Fabian');
    });

    it('still refuses a sentence that is not a name', () => {
      // The original bug this parser exists for.
      expect(findNameIn('I have seen before')).toBeNull();
      expect(findNameIn('uh let me look it up')).toBeNull();
      expect(findNameIn('sorry can you repeat the question')).toBeNull();
      expect(findNameIn('yes')).toBeNull();
    });

    it('reads a phone or fax number spoken as words', () => {
      expect(spokenDigitsToNumber('Sure seven six zero eight six zero one four three four'))
        .toBe('7608601434');
      expect(spokenDigitsToNumber('five six two, five five five, zero one three four'))
        .toBe('5625550134');
      // "oh" for zero, the way people actually say it.
      expect(spokenDigitsToNumber('seven six oh eight six oh one four three four'))
        .toBe('7608601434');
      // A leading country code is dropped, not stored.
      expect(spokenDigitsToNumber('one seven six zero eight six zero one four three four'))
        .toBe('7608601434');
    });

    it('refuses to guess at anything that is not a full number', () => {
      // Half a number across two turns must NOT be filed as a whole one.
      expect(spokenDigitsToNumber("Sure, it's going to be seven six oh")).toBeNull();
      expect(spokenDigitsToNumber('March seventeenth nineteen seventy three')).toBeNull();
      expect(spokenDigitsToNumber('the first one')).toBeNull();
    });
  });

  /**
   * The live 13:34 scheduling call. Wayne Fabian has 43 appointments in the
   * record and the agent told him "I'm not finding a match on my end", because
   * these two utterances produced "It's Wayne Fabian" and "Wayne Date of".
   */
  describe('the names that failed a real patient lookup', () => {
    it('strips a lead-in that ends in a full stop', () => {
      expect(findNameIn("Sure. It's Wayne Fabian. Date of birth is 03/17/1973."))
        .toEqual({ first: 'Wayne', last: 'Fabian' });
    });

    it('never lets a split "date of" fragment become the surname', () => {
      // The transcriber cut the sentence here mid-phrase.
      expect(findNameIn("It's Wayne Fabian. Date of")).toEqual({ first: 'Wayne', last: 'Fabian' });
      expect(findNameIn('the name is Elena Ruiz, date of')).toEqual({ first: 'Elena', last: 'Ruiz' });
    });

    it('still refuses the things that are not names', () => {
      expect(findNameIn('birth is 03/17/1973.')).toBeNull();
      expect(findNameIn('uh let me look it up')).toBeNull();
      expect(findNameIn('sorry can you repeat the question')).toBeNull();
    });
  });
});

describe('the answers that reached the mirror as nonsense', () => {
  // Live 20:48. "Yeah. It's Wayne Fabian." was stored as first name "It's",
  // surname "Wayne" — so verification searched patients_master for a patient
  // surnamed Wayne and returned no_match, on a record with 43 appointments.
  it("keeps the name and drops the lead-in, straight or curly apostrophe", () => {
    for (const said of [
      "Yeah. It's Wayne Fabian.",
      "Yeah. It’s Wayne Fabian.",
      "Yes. It's Wayne Fabian.",
      "Sure. It’s Wayne Fabian",
    ]) {
      expect(findNameIn(said), said).toEqual({ first: 'Wayne', last: 'Fabian' });
    }
  });

  it('never lets sentence punctuation delete a real name', () => {
    // "Fabian." failed the token test on its full stop while "It's" passed,
    // because names legitimately contain apostrophes.
    expect(findNameIn('Wayne Fabian.')).toEqual({ first: 'Wayne', last: 'Fabian' });
    expect(findNameIn('Maria Gonzalez!')).toEqual({ first: 'Maria', last: 'Gonzalez' });
  });

  it('keeps a compound surname intact', () => {
    expect(findNameIn('Maria de la Cruz')).toEqual({ first: 'Maria', last: 'de la Cruz' });
  });

  it('still refuses everything that is not a name', () => {
    for (const said of [
      'uh let me look it up',
      'I have been seen before',
      'Are you kidding me?',
      "That's not what I asked",
      'Yeah',
    ]) {
      expect(findNameIn(said), said).toBeNull();
    }
  });
});
