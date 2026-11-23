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

  it('a chosen contact method is a callback when the model did not say otherwise', () => {
    expect(callbackNeeded({ modelSays: undefined, categoryDefault: false, preferredContact: 'text' })).toEqual({
      required: true,
      overridden: true,
    });
    expect(callbackNeeded({ modelSays: true, categoryDefault: false, preferredContact: 'email' })).toEqual({
      required: true,
      overridden: false,
    });
  });

  it("v269: a chosen contact method does not outrank the model's explicit FALSE", () => {
    // The prompt asks the method question on every call, so the field is
    // filled when the caller declined ("You don't need to call back.").
    for (const preferredContact of ['phone', 'text', 'email']) {
      expect(callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact }), preferredContact).toEqual({
        required: false,
        overridden: false,
      });
    }
    expect(
      callbackNeeded({
        modelSays: false,
        categoryDefault: true,
        preferredContact: 'phone',
        callerWords: "You don't need to call back.",
      }).required,
    ).toBe(false);
    expect(
      callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact: 'phone', callerWords: "Um, I'll call back." })
        .required,
    ).toBe(false);
  });

  it("v269: a spoken ask still outranks the model's FALSE beside a chosen method", () => {
    expect(
      callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact: 'email', callerWords: 'Just email me.' }),
    ).toEqual({ required: true, overridden: true });
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
    // The model said nothing about a callback: a fully answered question still
    // does not turn a chosen method into one, and the category default stands.
    expect(
      callbackNeeded({ modelSays: undefined, categoryDefault: false, preferredContact: 'phone', fullyAnswered: true }),
    ).toEqual({ required: false, overridden: false });
  });

  it('with no caller signal, the model answer, else the category default, stands', () => {
    expect(callbackNeeded({ modelSays: false, categoryDefault: true })).toEqual({ required: false, overridden: false });
    expect(callbackNeeded({ modelSays: undefined, categoryDefault: false })).toEqual({ required: false, overridden: false });
    expect(callbackNeeded({ modelSays: undefined, categoryDefault: true }).required).toBe(true);
  });
});
