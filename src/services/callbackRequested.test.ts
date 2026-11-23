/**
 * v166, ticket 70202: a caller who chose "Call, please" and later asked to be
 * called when the office opened was filed `[NO CALLBACK NEEDED]`. Synthetic
 * words only.
 */
import { describe, it, expect } from 'vitest';
import { callbackNeeded, callerAskedToBeContacted, callerDeclinedContact, declinedChannels } from './callbackRequested';

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

describe('callerDeclinedContact', () => {
  it('reads a decline in English and Spanish', () => {
    for (const line of [
      "You don't need to call back.",
      'You don’t have to call me.',
      'Um, I\'ll call back.',
      'I will call you tomorrow.',
      "Don't call me.",
      'Please do not text me.',
      'There is no need to email me.',
      'No callback, thanks.',
      'No me llamen.',
      'No es necesario que me llamen.',
      'Yo les llamo mañana.',
      'Vuelvo a llamar después.',
    ]) {
      expect(callerDeclinedContact(line), line).toBe(true);
    }
  });

  it('a method answer, an ask or a name is not a decline', () => {
    for (const line of ['Text.', 'Phone.', 'Email.', 'Call, please.', 'Text is fine.', 'You can call me Mary.', "I'll call my pharmacy.", undefined]) {
      expect(callerDeclinedContact(line), String(line)).toBe(false);
    }
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

  it("v269: the model's FALSE outranks a chosen contact method only when the caller declined", () => {
    // The prompt asks the method question on every call, so the field is
    // filled when the caller declined ("You don't need to call back.").
    for (const callerWords of ["You don't need to call back.", "Um, I'll call back.", 'No me llamen, gracias.']) {
      expect(
        callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact: 'phone', callerWords }),
        callerWords,
      ).toEqual({ required: false, overridden: false });
    }
  });

  it("#517 review: a decline covers only the channel it names, so a choice of another channel is a follow-up", () => {
    for (const [preferredContact, callerWords] of [
      ['text', "Don't call me. Text."],
      ['email', "Don't call me, email is fine."],
      ['text', "I'll call back if I can. Actually, text me later... no, just text."],
      ['text', 'No me llamen. Texto.'],
      ['phone', "Don't text me. Phone."],
      ['call', "Don't email me. Call."],
    ] as const) {
      expect(
        callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact, callerWords }).required,
        `${preferredContact}: ${callerWords}`,
      ).toBe(true);
    }
  });

  it('#517 review: a decline of the chosen channel, of contact, or with no channel chosen still stands', () => {
    for (const [preferredContact, callerWords] of [
      ['phone', "You don't need to call back."],
      ['phone', "I'll call back."],
      ['text', "Don't text me."],
      ['email', 'No need to email.'],
      ['text', "Please don't contact me."],
      ['email', 'Do not contact me, thanks.'],
      [undefined, "Don't call me."],
      ['fax', "Don't call me."],
    ] as const) {
      expect(
        callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact, callerWords }),
        `${preferredContact}: ${callerWords}`,
      ).toEqual({ required: false, overridden: false });
    }
  });

  it('declinedChannels names the channel each decline covers', () => {
    expect([...declinedChannels("Don't call me.")]).toEqual(['call']);
    expect([...declinedChannels('No need to text.')]).toEqual(['text']);
    expect([...declinedChannels("Don't email me.")]).toEqual(['email']);
    expect([...declinedChannels("Don't contact me.")].sort()).toEqual(['call', 'email', 'text']);
    expect([...declinedChannels("I'll call back.")]).toEqual(['call']);
    expect([...declinedChannels('No me llamen.')]).toEqual(['call']);
    expect([...declinedChannels("Don't text me, and don't email me either.")].sort()).toEqual(['email', 'text']);
    expect(declinedChannels('Text.').size).toBe(0);
    expect(declinedChannels(undefined).size).toBe(0);
  });

  it('a decline never turns a callback off by itself: it only lets the model\'s FALSE stand', () => {
    for (const modelSays of [undefined, true] as const) {
      expect(
        callbackNeeded({
          modelSays,
          categoryDefault: true,
          preferredContact: 'phone',
          callerWords: "You don't need to call back.",
        }).required,
        String(modelSays),
      ).toBe(true);
    }
  });

  it("Codex P1 on #517: a bare method answer is a callback even when the model sent FALSE", () => {
    for (const [preferredContact, callerWords] of [
      ['text', 'Text.'],
      ['phone', 'Phone.'],
      ['email', 'Email.'],
      ['text', 'Text is fine.'],
      ['phone', undefined],
    ] as const) {
      expect(
        callbackNeeded({ modelSays: false, categoryDefault: true, preferredContact, callerWords }),
        String(callerWords),
      ).toEqual({ required: true, overridden: true });
    }
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
