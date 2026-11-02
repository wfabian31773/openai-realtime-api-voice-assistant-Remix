/**
 * v166, ticket 70202: a caller who chose "Call, please" and later asked to be
 * called when the office opened was filed `[NO CALLBACK NEEDED]`. Synthetic
 * words only.
 */
import { describe, it, expect } from 'vitest';
import { callbackNeeded, callerAskedToBeContacted } from './callbackRequested';

const WORDS_70202 = 'call, please. could they call me when they get into the office?';

describe('callerAskedToBeContacted', () => {
  it('reads the 70202 shape both ways it was said', () => {
    expect(callerAskedToBeContacted('Call, please.')).toBe(true);
    expect(callerAskedToBeContacted('Could they call me when they get into the office?')).toBe(true);
    expect(callerAskedToBeContacted(WORDS_70202)).toBe(true);
  });

  it('reads text, email, callback and Spanish asks', () => {
    for (const line of [
      'Can you have someone text me?',
      'Please email me the form.',
      "I'd like a callback.",
      'Give me a call tomorrow.',
      'You can call me back at this number.',
      'Could you call me?',
      '¿Me pueden llamar mañana?',
      'Llámenme por favor.',
    ]) {
      expect(callerAskedToBeContacted(line), line).toBe(true);
    }
  });

  it('a negated ask is not an ask, in either language', () => {
    for (const line of [
      "Don't call me.",
      'Don’t call me back.',
      'There is no need to call me back.',
      'Please do not text me.',
      'Never call me again.',
      'No me llamen.',
    ]) {
      expect(callerAskedToBeContacted(line), line).toBe(false);
    }
  });

  it('the negation governs its own match, not the whole turn', () => {
    expect(callerAskedToBeContacted("Don't text me. Call me back when you open.")).toBe(true);
    expect(callerAskedToBeContacted("No, that's wrong. Please call me back.")).toBe(true);
    expect(callerAskedToBeContacted('No, please call me back.')).toBe(true);
    expect(callerAskedToBeContacted("Don't text me, call me back.")).toBe(true);
  });

  it('being told a name is not an ask', () => {
    expect(callerAskedToBeContacted('You can call me Mary.')).toBe(false);
    expect(callerAskedToBeContacted('Everyone calls me Mary.')).toBe(false);
  });

  it('is false for a caller who asked for nothing, and for no words', () => {
    expect(callerAskedToBeContacted('What time do you open? Thanks, bye.')).toBe(false);
    expect(callerAskedToBeContacted(undefined)).toBe(false);
  });
});

describe('callbackNeeded', () => {
  it("70202: the model's FALSE never outranks a caller who asked", () => {
    expect(
      callbackNeeded({ modelSays: false, categoryDefault: false, preferredContact: 'phone', callerWords: WORDS_70202 }),
    ).toEqual({ required: true, overridden: true });
    expect(callbackNeeded({ modelSays: false, categoryDefault: false, callerWords: WORDS_70202 })).toEqual({
      required: true,
      overridden: true,
    });
  });

  it('a chosen contact method alone is a callback', () => {
    expect(callbackNeeded({ modelSays: false, categoryDefault: false, preferredContact: 'text' }).required).toBe(true);
    expect(callbackNeeded({ modelSays: false, categoryDefault: false, preferredContact: 'email' }).required).toBe(true);
  });

  it('a fully answered question keeps the model answer unless the caller ASKED', () => {
    expect(
      callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact: 'phone', fullyAnswered: true }).required,
    ).toBe(false);
    expect(
      callbackNeeded({
        modelSays: false,
        categoryDefault: true,
        preferredContact: 'phone',
        fullyAnswered: true,
        callerWords: 'Please call me back about it.',
      }).required,
    ).toBe(true);
  });

  it('with no caller signal, the model answer, else the category default, stands', () => {
    expect(callbackNeeded({ modelSays: false, categoryDefault: true })).toEqual({ required: false, overridden: false });
    expect(callbackNeeded({ modelSays: undefined, categoryDefault: false })).toEqual({ required: false, overridden: false });
    expect(callbackNeeded({ modelSays: undefined, categoryDefault: true }).required).toBe(true);
  });
});
