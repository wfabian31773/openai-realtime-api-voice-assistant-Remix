/**
 * A birthday on a ticket is how staff find the right chart. Getting it wrong is
 * worse than not having it, so this parser refuses rather than guesses.
 */
import { describe, it, expect } from 'vitest';
import { normalizeDobParts } from './dobParts';

describe('the formats callers actually use', () => {
  const cases: Array<[string, string]> = [
    ['03/17/1973', '1973-03-17'],
    ['3/17/1973', '1973-03-17'],
    ['3-17-73', '1973-03-17'],
    ['1973-03-17', '1973-03-17'],
    ['March 17, 1973', '1973-03-17'],
    ['March 17th 1973', '1973-03-17'],
    ['Mar 17 1973', '1973-03-17'],
    ['17 March 1973', '1973-03-17'],
    ['December 2, 1980', '1980-12-02'],

    /**
     * SPOKEN, WITH NO SEPARATOR AT ALL — the way a date of birth actually
     * arrives from a voice call. Regression for CA60c32bb3 (tech, 2026-09-03
     * 20:40 UTC): the caller said "9 2 48", the model read it back correctly
     * as September 2nd 1948, and file_tech_ticket was refused five times for a
     * missing date of birth before the call died with no ticket.
     */
    ['9 2 48', '1948-09-02'],
    ['9 2 1948', '1948-09-02'],
    ['09 02 1948', '1948-09-02'],
    ['3 17 73', '1973-03-17'],
    ['12  25  1990', '1990-12-25'],
    ['09 - 02 - 1948', '1948-09-02'],
  ];

  for (const [spoken, iso] of cases) {
    it(`"${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }

  it('keeps two-digit parts padded, because the API wants strings', () => {
    const p = normalizeDobParts('1/2/1990');
    expect(p).toEqual({ year: '1990', month: '01', day: '02' });
  });
});

describe('what it refuses', () => {
  it('will not read a month/day/year out of the tail of an ISO date', () => {
    // The bug this guards: an unanchored m/d/y pattern matched the tail of
    // "2017-03-17" and put 73/03/2017 on a real ticket.
    const p = normalizeDobParts('2017-03-17');
    expect(p).toEqual({ year: '2017', month: '03', day: '17' });
  });

  it('rejects impossible dates rather than filing them', () => {
    expect(normalizeDobParts('13/45/1973')).toBeNull();
    expect(normalizeDobParts('02/30/1973')).toBeNull();
    expect(normalizeDobParts('03/17/1823')).toBeNull();
  });

  it('rejects a birth year in the future', () => {
    expect(normalizeDobParts(`03/17/${new Date().getFullYear() + 1}`)).toBeNull();
  });

  /**
   * The separator widened on 2026-09-03; the YEAR rule did not. These are the
   * things a bare-space date could have started matching and must not.
   */
  it('does not mistake a phone number or a partial date for a birthday', () => {
    expect(normalizeDobParts('555 123 4567')).toBeNull();
    expect(normalizeDobParts('818 624 6197')).toBeNull();
    expect(normalizeDobParts('9 2 4')).toBeNull();    // one-digit year
    expect(normalizeDobParts('9 2')).toBeNull();      // no year at all
    expect(normalizeDobParts('13 45 73')).toBeNull(); // still not a real date
  });

  it('rejects what it cannot read at all', () => {
    expect(normalizeDobParts('')).toBeNull();
    expect(normalizeDobParts('sometime in the seventies')).toBeNull();
    expect(normalizeDobParts('March 1973')).toBeNull(); // no day — do not assume the 1st
  });
});

/**
 * THE CALLER SAID A SENTENCE, NOT A DATE.
 *
 * Five calls on 2026-09-03 ended with the agent telling the caller their
 * request was filed when nothing was, and this was the cause of every one: the
 * parser was anchored, so one word around the date threw the date away. The
 * bare date in each of these parsed perfectly at the time.
 */
describe('a date of birth inside a sentence', () => {
  const cases: Array<[string, string, string]> = [
    ['optical 21:51', 'our date of birth is August 10, 1962', '1962-08-10'],
    ['surgery 21:50', 'date of birth April 17, 1951', '1951-04-17'],
    ['optical 21:07', 'birthdate 5 13 45', '1945-05-13'],
    ['tech 20:55, after a spelled-out surname', 'T O C C O 10 7 63', '1963-10-07'],
    ['a lead-in', 'my date of birth is 03/17/1973', '1973-03-17'],
    ['an abbreviation', 'DOB 03/17/1973', '1973-03-17'],
    ['a filler opening', 'it is March 17, 1973', '1973-03-17'],
    ['a trailing full stop', 'March 17, 1973.', '1973-03-17'],
    ['day-first inside a sentence', 'born 17 March 1973', '1973-03-17'],
  ];
  for (const [why, spoken, iso] of cases) {
    it(`${why}: "${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }
});

/**
 * A WRONG DATE OF BIRTH SILENTLY MATCHES THE WRONG PATIENT, so the search is
 * bounded by two rules and these are what hold them. Deleting either rule
 * fails a test here.
 */
describe('what the sentence search still refuses', () => {
  it('does not read a birthday out of a spoken phone number', () => {
    // "7 60 3 18 57 75" is a real caller's number from 2026-09-03 and it
    // CONTAINS "3 18 57", a perfectly valid date. What refuses it is the
    // leftover-digits rule: "7 60 75" is still there once the date is removed.
    expect(normalizeDobParts('7 60 3 18 57 75')).toBeNull();
    expect(normalizeDobParts('909 608 1832')).toBeNull();
    expect(normalizeDobParts('call the pharmacy at 909 608 1832')).toBeNull();
  });

  it('refuses a date accompanied by any other digits', () => {
    expect(normalizeDobParts('March 17 1973 call me at 3 18 57')).toBeNull();
  });

  it('refuses a good date with a stray number beside it', () => {
    /**
     * THIS IS THE CASE THAT ISOLATES THE LEFTOVER-DIGITS RULE, and it took a
     * mutation to find. Deleting that rule broke none of the tests above,
     * because on each of them something else refuses first: "7 60 3 18 57 75"
     * only ever yields "60 3 18", whose month is 60, and valid() throws it out
     * before any rule runs. Here there is exactly one real date and one
     * innocent stray digit, so the rule is the only thing standing between a
     * half-heard utterance and a ticket. With it deleted, all three of these
     * are accepted.
     */
    expect(normalizeDobParts('March 17, 1973 ext 4')).toBeNull();
    expect(normalizeDobParts('April 17 1951 apt 3')).toBeNull();
    expect(normalizeDobParts('August 10, 1962 room 7')).toBeNull();
  });

  it('refuses two different dates rather than picking one', () => {
    /**
     * The one-date rule and the leftover-digits rule COVER EACH OTHER here:
     * with either deleted the other still refuses this, because the second
     * date's digits are exactly the leftovers. A mutation confirmed that
     * neither can be isolated against today's four patterns, so this asserts
     * the behaviour rather than pretending to pin one rule. The one-date rule
     * is kept as defence in depth — a fifth pattern could break the tie the
     * leftover rule currently wins.
     */
    expect(normalizeDobParts('March 17, 1973 or maybe April 2, 1980')).toBeNull();
  });

  it('accepts the same date read by two patterns — agreement is not ambiguity', () => {
    const p = normalizeDobParts('born on 17 March 1973');
    expect(p && `${p.year}-${p.month}-${p.day}`).toBe('1973-03-17');
  });

  it('still will not read a date out of the TAIL of an ISO date', () => {
    // The bug this file was written for: an unanchored m/d/y pattern matched
    // the tail of "2017-03-17" and put 73/03/2017 on a real ticket. The ISO
    // branch answers first, and word boundaries stop the search reaching in.
    expect(normalizeDobParts('2017-03-17')).toEqual({ year: '2017', month: '03', day: '17' });
  });

  it('still rejects impossible and future dates inside a sentence', () => {
    expect(normalizeDobParts('date of birth 13/45/1973')).toBeNull();
    expect(normalizeDobParts(`date of birth 03/17/${new Date().getFullYear() + 1}`)).toBeNull();
  });

  it('still needs a day — a month and a year is not a birthday', () => {
    expect(normalizeDobParts('born March 1973')).toBeNull();
  });

  it('still refuses what carries no date at all', () => {
    expect(normalizeDobParts('sometime in the seventies')).toBeNull();
    expect(normalizeDobParts('nineteen seventy three')).toBeNull();
  });
});
