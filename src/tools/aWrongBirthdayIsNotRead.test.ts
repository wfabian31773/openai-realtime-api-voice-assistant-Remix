/**
 * A WRONG BIRTHDAY IS NOT READ FROM THE TRANSCRIPT — v209.
 *
 * The Codex post-merge sweep of #447 (v206), run by the operator on
 * 2026-11-11, found five ways the transcript reader could put a wrong date of
 * birth on a ticket. Each was reproduced against v206 (`main`, 6e96e6fe)
 * before anything changed, and compared with the live v205:
 *
 *   1  "June 3, 1944." then "It is not June third." kept June 3rd. v205
 *      cleared it after a second ask, and kept it in the same turn or after
 *      a line that asks nothing.
 *   2  "One one nineteen fifty-one." read as January 19th, 1951 (v206 only).
 *   3  "June third, I'm seventy years old." read as June 3rd, 1970. v205 did
 *      the same for "June 3, I'm 70 years old."
 *   4  "June 3, 1944. I mean the surgery was December 5, 2025." read the
 *      surgery date (v206 only); "My surgery is December 5, 2025." in answer
 *      to a second ask did it on v205 too.
 *   5  The agent asks for a surgery date, the caller asks it to repeat, the
 *      agent says "Sure." and then "The month, day, and year.": the surgery
 *      date was read as the birthday (v206 only). A line that asks for the
 *      date of birth and the other date in one breath did it on v205 too.
 *
 * Every case now gives either the caller's birthday or no date. Each block
 * keeps controls that must still read, because a missing date of birth is
 * asked for again and a wrong one matches the wrong patient.
 *
 * Measured before choosing the rules, runtime calls of 2026-10-28..11-11 that
 * asked for a date of birth (2,077): 30 caller lines carried a year and the
 * name of another date (a surgery, an appointment, a visit), and every one
 * that answered the question said the birthday in a sentence of its own; 168
 * agent lines asked for or read back the date of birth beside another date,
 * nearly all the after-hours read-back summary. The real lines of v206's
 * corpus read exactly as they did on v206.
 *
 * PHI: every name and date below is SYNTHETIC.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dobFromCallerAnswer, noteSpokenDob, resetSpokenDobs, spokenDobFor } from './spokenDob';
import { negatesADate, numberWordsToDigits, readDobQuietly, statesAnAge } from './dobParts';

const A = (s: string) => `AGENT: ${s}`;
const C = (s: string) => `CALLER: ${s}`;
const ASK = A('And may I please have your date of birth, starting with the month, then the day, then the year?');
const REASK = A('Could you repeat your date of birth for me, starting with the month?');

beforeEach(() => resetSpokenDobs());

describe('1. a date of birth the caller says is not theirs is cleared', () => {
  it('after a second ask', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), REASK, C('It is not June third.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), REASK, C('It is not 6 3.')])).toBeUndefined();
    // The month and the day apart: only the partial answer's own check sees this one.
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), REASK, C("June, it's not the third.")])).toBeUndefined();
  });

  it('in the same turn', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), C('It is not June third.')])).toBeUndefined();
  });

  it('after a line that asks nothing', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C("That's not June third.")])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C('No es el tres de junio.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C("That's not 6 3.")])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C("It's not the third of June.")])).toBeUndefined();
  });

  it('a later date after the rejection is read', () => {
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C('It is not June third.'), REASK, C('June 4, 1944.')]),
    ).toBe('1944-06-04');
  });

  it('controls: a "No." to another question, an agreeing partial, a different date negated', () => {
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Anything else?'), C('No. My birthday is June third, by the way.')]),
    ).toBe('1944-06-03');
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), REASK, C('June third.')])).toBe('1944-06-03');
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C('Not June fourth.')])).toBe('1944-06-03');
    // A negation on the line the date came from is not read against it.
    expect(dobFromCallerAnswer([ASK, C("June 3, 1944, isn't it?")])).toBe('1944-06-03');
  });

  it('a rejection of another date does not clear the birthday (Codex P2 on #454)', () => {
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('And what date is your surgery?'), C('My surgery is not June third.')]),
    ).toBe('1944-06-03');
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C('The appointment is not June third, it is the fifth.')]),
    ).toBe('1944-06-03');
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Gracias.'), C('Mi cirugía no es el tres de junio.')]),
    ).toBe('1944-06-03');
  });

  it('but a sentence that names the birthday, or names no other date, still clears it', () => {
    // Names the birthday beside the surgery: cleared, the safe side.
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C('My birthday is not June third, my surgery is.')]),
    ).toBeUndefined();
    // The surgery in one sentence, the rejection in the next: the rejection stands on its own.
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C('My surgery is next week. It is not June third.')]),
    ).toBeUndefined();
    // After a surgery question with no date named: the caller may mean the birthday, so it clears.
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('And what date is your surgery?'), C("It's not June third.")]),
    ).toBeUndefined();
  });

  it('a negation in another sentence does not reach the date (Codex P2 on #454, round 2)', () => {
    const after = (line: string) => dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Is there anything else?'), C(line)]);
    expect(after('June third is correct. I do not need anything else.')).toBe('1944-06-03');
    expect(after("Yes, June third. No, that's all.")).toBe('1944-06-03');
    expect(after("June third. I don't have my card with me.")).toBe('1944-06-03');
    expect(after('June third. Is that right?')).toBe('1944-06-03');
  });

  it('but a bare denial after the date, or a denial after the date asked back, still clears it', () => {
    const after = (line: string) => dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Thank you.'), C(line)]);
    expect(after("June third. That's wrong.")).toBeUndefined();
    expect(after("June third. That's not my birthday.")).toBeUndefined();
    expect(after('June third. No.')).toBeUndefined();
    expect(after('Tres de junio. No es correcto.')).toBeUndefined();
    expect(after("June third? I don't know where that came from.")).toBeUndefined();
  });

  it('negatesADate: a denial, a "not", but not a leading "No." or a correction word', () => {
    expect(negatesADate('It is not June third.')).toBe(true);
    expect(negatesADate("It isn't June 3")).toBe(true);
    expect(negatesADate("That's wrong.")).toBe(true);
    expect(negatesADate('No, not June third.')).toBe(true);
    expect(negatesADate('No. My birthday is June third.')).toBe(false);
    expect(negatesADate('Sorry, June third, 1944.')).toBe(false);
  });
});

describe('2. a run of "one"s is read as the digits it is', () => {
  it('"One one nineteen fifty-one" is January 1st, 1951', () => {
    expect(numberWordsToDigits('one one nineteen fifty one')).toBe('1 1 19 51');
    expect(dobFromCallerAnswer([ASK, C('One one nineteen fifty-one.')])).toBe('1951-01-01');
    expect(dobFromCallerAnswer([ASK, C('Oh one, one, nineteen fifty-one.')])).toBe('1951-01-01');
  });

  it('controls: one "one" still reads as before, and a lone "one" is not a number', () => {
    expect(dobFromCallerAnswer([ASK, C('One nineteen fifty-one.')])).toBe('1951-01-19');
    expect(dobFromCallerAnswer([ASK, C('Oh, one nineteen fifty-one.')])).toBe('1951-01-19');
    expect(numberWordsToDigits('yes that is the one')).toBeNull();
    expect(numberWordsToDigits('one one')).toBeNull();
  });
});

describe('3. an age is not a year', () => {
  it('a turn that states an age gives no date', () => {
    expect(dobFromCallerAnswer([ASK, C("June third, I'm seventy years old.")])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C("June 3, I'm 70 years old.")])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C("June 3, I'm 70.")])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('El tres de junio, tengo setenta años.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C("June 3, she's ninety-one.")])).toBeUndefined();
  });

  it('and does not clear a date already given when it agrees with it', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), REASK, C("June third, I'm eighty.")])).toBe('1944-06-03');
  });

  it('controls: a number that is not stated as an age', () => {
    expect(statesAnAge("I'm one of your patients, June 3 1944")).toBe(false);
    expect(readDobQuietly("I'm one of your patients, June 3 1944")).toEqual({ year: '1944', month: '06', day: '03' });
    expect(statesAnAge("I'm 30 minutes late")).toBe(false);
    expect(statesAnAge("I'm two weeks out from surgery")).toBe(false);
    expect(statesAnAge('I am nineteen forty four')).toBe(false);
    expect(statesAnAge('Tengo una cita')).toBe(false);
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.')])).toBe('1944-06-03');
  });
});

describe('4. a sentence about another date is not an answer about the birthday', () => {
  it('a correction about the surgery does not replace the birthday', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944. I mean the surgery was December 5, 2025.')])).toBe('1944-06-03');
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), C('Could you repeat that?'), C('Sorry, I meant my surgery, December 5, 2025.')]),
    ).toBe('1944-06-03');
    expect(
      dobFromCallerAnswer([ASK, C('3 de junio de 1944. Perdón, la cirugía es el 5 de diciembre de 2025.')]),
    ).toBe('1944-06-03');
  });

  it('a surgery date given to a second ask does not replace or clear the birthday', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), REASK, C('My surgery is December 5, 2025.')])).toBe('1944-06-03');
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), REASK, C('The appointment is December 5.')])).toBe('1944-06-03');
  });

  it('a sentence that takes the date back as the other date leaves no birthday (Codex P1 on #454, round 3)', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944. Sorry, that is my surgery date.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944. That is my surgery date.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944. Sorry, I meant the surgery.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('3 de junio de 1944. Perdón, la cirugía.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK, C('3 de junio de 1944. Esa es la fecha de mi cirugía.')])).toBeUndefined();
    // In a later turn of the same ask.
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), C('Sorry, that is my surgery date.')])).toBeUndefined();
    // And it does not leave an earlier answer standing either.
    expect(dobFromCallerAnswer([ASK, C('May 1, 1950.'), REASK, C('June 3, 1944. Sorry, that is my surgery date.')])).toBeUndefined();
    // A birthday said after the withdrawal still reads.
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944. Sorry, that is my surgery date. My birthday is May 1, 1950.')]),
    ).toBe('1950-05-01');
  });

  it('controls: a sentence that only mentions the other date takes nothing back', () => {
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944. This is about my surgery.')])).toBe('1944-06-03');
    expect(dobFromCallerAnswer([ASK, C("June 3, 1944. It's for my appointment.")])).toBe('1944-06-03');
    // A bare "sorry" takes back only a date said before it in the same turn, as on v206.
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), C("Sorry, I can't make my appointment.")])).toBe('1944-06-03');
    expect(dobFromCallerAnswer([ASK, C("June 3, 1944. Sorry, I can't make my appointment.")])).toBeUndefined();
    // But a strong cue does, from an earlier turn of the same ask.
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), C('I meant the surgery.')])).toBeUndefined();
    // With no date before it in the ask, a pointer has nothing to take back here.
    expect(dobFromCallerAnswer([ASK, C('That is my surgery date.')])).toBeUndefined();
  });

  it('controls: the birthday in its own sentence still reads (the measured shape)', () => {
    expect(dobFromCallerAnswer([ASK, C('July 22nd, 1960. I want to confirm my appointment on Friday.')])).toBe('1960-07-22');
    expect(
      dobFromCallerAnswer([ASK, C("My date of birth, 6 14, 1950. Yeah, so I'm sorry, but I can't go today to my appointment.")]),
    ).toBe('1950-06-14');
    // A birthday in the same sentence as another date is lost, the safe side.
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944, and my surgery is December 5, 2025.')])).toBeUndefined();
  });
});

describe('5. the format said on its own opens a window only for the date of birth', () => {
  const SURGERY = A('And what date is your surgery?');

  it('a "Sure." between the surgery question and the format does not make it a date-of-birth ask', () => {
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), SURGERY, C('Could you repeat that?'), A('Sure.'), A('The month, day, and year.'), C('December 5, 2025.')]),
    ).toBe('1944-06-03');
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), SURGERY, C('Could you repeat that?'), A('Sorry.'), A('Month, day, year, please.'), C('December 5, 2025.')]),
    ).toBe('1944-06-03');
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), SURGERY, C('Could you repeat that?'), A('What day?'), A('Month, day and year.'), C('December 5, 2025.')]),
    ).toBe('1944-06-03');
  });

  it('a line that asks for both dates cannot replace the birthday with a date the caller does not call it', () => {
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), SURGERY, C('Could you repeat that?'), A('Could you repeat the date of birth and the date of your procedure?'), C('December 5, 2025.')]),
    ).toBeUndefined();
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Is that your date of birth or your surgery date you gave me?'), C('December 5, 2025.')]),
    ).toBeUndefined();
    // The format said after such a line is that line's window, and keeps its rule.
    expect(
      dobFromCallerAnswer([ASK, C('June 3, 1944.'), A('Could you repeat the date of birth and the date of your procedure?'), C('Could you repeat that?'), A('Month, day, year.'), C('December 5, 2025.')]),
    ).toBeUndefined();
  });

  it('controls: the format after a date-of-birth ask still opens, and a mixed ask still reads', () => {
    expect(
      dobFromCallerAnswer([ASK, C('Could you repeat that?'), A('Sure.'), A('With the month, then the day, then the year.'), C('June 3, 1944.')]),
    ).toBe('1944-06-03');
    expect(
      dobFromCallerAnswer([A("To check for that appointment, may I have the patient's date of birth, starting with the month, then the day, then the year?"), C('June 3, 1944.')]),
    ).toBe('1944-06-03');
    // A mixed line agreeing with what is held keeps it; the caller naming the birthday replaces it.
    const MIXED = A('I have your date of birth as June third and your appointment on December fifth, is that right?');
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), MIXED, C('Yes, June 3, 1944.')])).toBe('1944-06-03');
    expect(dobFromCallerAnswer([ASK, C('June 3, 1944.'), MIXED, C('No, my birthday is June 4, 1944.')])).toBe('1944-06-04');
  });
});

describe('the store the filing tools read follows the reader', () => {
  it('a rejected date of birth is deleted from the call', () => {
    const sid = 'CA' + 'a'.repeat(32);
    noteSpokenDob(sid, [ASK, C('June 3, 1944.')]);
    expect(spokenDobFor(sid)).toBe('1944-06-03');
    noteSpokenDob(sid, [ASK, C('June 3, 1944.'), A('Thank you.'), C('It is not June third.')]);
    expect(spokenDobFor(sid)).toBeUndefined();
  });
});
