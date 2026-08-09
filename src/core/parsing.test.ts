import { describe, it, expect } from 'vitest';
import { looksLikeName, looksLikeDob, normalizeSpokenDob } from './parsing';

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
});
