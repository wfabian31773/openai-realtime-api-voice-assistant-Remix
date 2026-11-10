/**
 * A birthday on a ticket is how staff find the right chart. Getting it wrong is
 * worse than not having it, so this parser refuses rather than guesses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeDobParts, dobShape, numberWordsToDigits } from './dobParts';

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
 * READ THE DATE HOWEVER THE CALLER SAID IT.
 *
 * Operator, 2026-09-03, after the first attempt at this cost two more
 * patients: *"if you are asking for a dob, you should treat whatever they give
 * you as a dob, not a phone number. Who will give you a phone number when you
 * ask for a dob? We should parse the date no matter how they give it to us."*
 *
 * Every string below is a real caller's words from that afternoon, and every
 * one of them was refused by the parser while the agent told the caller their
 * request had been filed.
 */
describe('a date of birth however it was said', () => {
  const cases: Array<[string, string, string]> = [
    ['tech 22:10, a year in two halves', 'Date of birth is 7 26, 19 29', '1929-07-26'],
    ['surgery 22:12, name then a split year', 'Stanley Morrell, 5 31, 19 44', '1944-05-31'],
    ['tech 22:06, a specialty pharmacy', 'October 22nd, 1950', '1950-10-22'],
    ['optical 21:40, a whole sentence', 'My name is Crystal. My date of birth is June 17th, 1984', '1984-06-17'],
    ['optical 21:51, a lead-in', 'our date of birth is August 10, 1962', '1962-08-10'],
    ['surgery 21:50', 'date of birth April 17, 1951', '1951-04-17'],
    ['optical 21:07', 'birthdate 5 13 45', '1945-05-13'],
    ['tech 20:55, after a spelled-out surname', 'T O C C O 10 7 63', '1963-10-07'],
    ['a named month with a split year', 'July 26 19 29', '1929-07-26'],
    ['a trailing full stop', 'March 17, 1973.', '1973-03-17'],
    ['day before month', '17 March 1973', '1973-03-17'],
    ['an abbreviated month', 'Sept 2 1948', '1948-09-02'],
  ];
  for (const [why, spoken, iso] of cases) {
    it(`${why}: "${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }
});

/**
 * WHAT STILL REFUSES — and note what is NOT on this list.
 *
 * The first version of this defended itself with a rule that no digits could
 * be left over once the date was removed, so a spoken phone number could never
 * become a birthday. That rule threw away "7 26, 19 29" over the stray "29"
 * and cost two patients inside an hour. It is gone, and the operator's
 * reasoning is why: this function only ever sees the `date_of_birth` ARGUMENT,
 * which the model fills after asking for a birthday. Nobody answers that with
 * a phone number.
 *
 * What refuses now protects the PATIENT rather than the parser: a date that is
 * not real, a year nobody living was born in, and a set of numbers that is not
 * one date. A phone number is refused by the shape rule as a side effect,
 * which is the honest reason rather than a special case.
 */
describe('what it still refuses', () => {
  it('rejects impossible dates rather than filing them', () => {
    expect(normalizeDobParts('13/45/1973')).toBeNull();
    expect(normalizeDobParts('02/30/1973')).toBeNull();
    expect(normalizeDobParts('date of birth 13/45/1973')).toBeNull();
  });

  it('rejects a birth year nobody living was born in', () => {
    expect(normalizeDobParts('03/17/1823')).toBeNull();
    expect(normalizeDobParts(`03/17/${new Date().getFullYear() + 1}`)).toBeNull();
    expect(normalizeDobParts(`date of birth 03/17/${new Date().getFullYear() + 1}`)).toBeNull();
  });

  it('rejects a split year that is not a century a patient was born in', () => {
    // "19" and "20" only. Without that, any stray pair becomes a year.
    expect(normalizeDobParts('7 26, 45 29')).toBeNull();
  });

  it('refuses numbers that do not form one date', () => {
    // A phone number is six numeric groups and assembles into nothing. That is
    // the shape rule doing its job, not a phone-number special case.
    expect(normalizeDobParts('909 608 1832')).toBeNull();
    expect(normalizeDobParts('7 60 3 18 57 75')).toBeNull();
    expect(normalizeDobParts('call the pharmacy at 909 608 1832')).toBeNull();
  });

  it('still needs a day — a month and a year is not a birthday', () => {
    expect(normalizeDobParts('March 1973')).toBeNull();
    expect(normalizeDobParts('born March 1973')).toBeNull();
  });

  it('refuses what carries no date at all', () => {
    expect(normalizeDobParts('')).toBeNull();
    expect(normalizeDobParts('sometime in the seventies')).toBeNull();
    expect(normalizeDobParts('nineteen seventy three')).toBeNull();
  });

  it('does not mistake a name that merely starts like a month', () => {
    // "Marcus" begins "mar". Reading it as March would put a wrong birthday on
    // a real ticket, which is the one outcome worse than no birthday.
    expect(normalizeDobParts('Marcus 17 1973')).toBeNull();
  });

  it('still will not read a date out of the TAIL of an ISO date', () => {
    // The bug this file was written for: an unanchored m/d/y pattern matched
    // the tail of "2017-03-17" and put 73/03/2017 on a real ticket.
    expect(normalizeDobParts('2017-03-17')).toEqual({ year: '2017', month: '03', day: '17' });
  });
});

/**
 * SPANISH, because the practice takes Spanish calls every day.
 *
 * Bought on 2026-09-03 at 22:23: a patient rang tech, gave her whole request
 * in Spanish, and it was refused. Her insurance had stopped covering her eye
 * drops and she needed the prescription changed. Nothing was filed. The month
 * table was English-only and I had rewritten this parser an hour earlier
 * without once asking what language the month would be in.
 */
describe('a date of birth in Spanish', () => {
  const cases: Array<[string, string]> = [
    ['Mi fecha de nacimiento es 17 de febrero 1958', '1958-02-17'],
    ['17 de febrero 1958', '1958-02-17'],
    ['3 de enero 1960', '1960-01-03'],
    ['15 de marzo 1971', '1971-03-15'],
    ['1 de abril 1955', '1955-04-01'],
    ['20 de mayo 1962', '1962-05-20'],
    ['9 de agosto 1948', '1948-08-09'],
    ['30 de septiembre 1970', '1970-09-30'],
    ['25 de diciembre 1980', '1980-12-25'],
    ['17 dic 1958', '1958-12-17'],
    ['5 ene 1960', '1960-01-05'],
  ];
  for (const [spoken, iso] of cases) {
    it(`"${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }

  it('the stray "de" costs nothing', () => {
    // The reader takes month words and numbers and ignores everything else, so
    // a preposition in the middle of the date is not a special case.
    expect(normalizeDobParts('17 de febrero 1958')).toEqual(
      normalizeDobParts('17 febrero 1958'),
    );
  });

  it('still will not read a Spanish month out of a longer word', () => {
    // The "Marcus is March" bug, in the other language.
    expect(normalizeDobParts('marzoso 17 1973')).toBeNull();
  });

  it('leaves English exactly as it was', () => {
    expect(normalizeDobParts('March 17, 1973')).toEqual({ year: '1973', month: '03', day: '17' });
    expect(normalizeDobParts('Date of birth is 7 26, 19 29')).toEqual({ year: '1929', month: '07', day: '26' });
  });
});

/**
 * A MONTH WORD LOOSE IN A SENTENCE IS NOT A MONTH.
 *
 * Codex, reviewing the Spanish months on PR #267, and both examples reproduced
 * exactly as reported. Adding `ago` (agosto) and `set` (setiembre) made English
 * utterances parse as dates:
 *
 *   "birthdate 5 13 45 a long time ago"  ->  nothing, a real date thrown away
 *   "he was born 10 years ago in 2016"   ->  2016-08-10, a birthday INVENTED
 *
 * The second is the outcome this whole file exists to prevent.
 *
 * Deleting those two abbreviations would have closed those two examples and
 * left the class open, because "may" is an English word too. The rule is
 * structural instead: a day has to sit beside its month. Both locks are in —
 * the rule, and the abbreviations dropped as well — so a mutation that removes
 * either is still caught.
 */
describe('a month word loose in an English sentence', () => {
  it('does not invent a birthday from "10 years ago in 2016"', () => {
    expect(normalizeDobParts('he was born 10 years ago in 2016')).toBeNull();
    expect(normalizeDobParts('10 years ago in 2016')).toBeNull();
  });

  it('still reads the real date when a stray month word follows it', () => {
    expect(normalizeDobParts('birthdate 5 13 45 a long time ago')).toEqual(
      { year: '1945', month: '05', day: '13' },
    );
    expect(normalizeDobParts('set the date 5 13 45')).toEqual(
      { year: '1945', month: '05', day: '13' },
    );
  });

  it('does not invent one from "may" either — the same class, in English', () => {
    // The reason the fix is adjacency and not a blocklist of two words.
    expect(normalizeDobParts('he may have been born 10 years ago in 2016')).toBeNull();
  });

  it('keeps every real form, where the day sits beside its month', () => {
    for (const [spoken, iso] of [
      ['August 10, 1962', '1962-08-10'],
      ['17 March 1973', '1973-03-17'],
      ['17 de febrero 1958', '1958-02-17'],
      ['our date of birth is August 10, 1962', '1962-08-10'],
      ['born 17 March 1973', '1973-03-17'],
    ] as const) {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`, spoken).toBe(iso);
    }
  });

  it('a linking word between the day and its month is still a date', () => {
    // "17 DE febrero", "17 OF March" — one preposition, not a sentence.
    expect(normalizeDobParts('17 of March 1973')).toEqual({ year: '1973', month: '03', day: '17' });
  });
});

/**
 * A TWO-DIGIT YEAR THAT LANDS IN THE FUTURE IS THE OTHER CENTURY.
 *
 * 2026-09-03, tech line, CA039096dc14b47e22b81724bad7c06823: a caller rang
 * about prescriptions for a relative in a care centre and gave her birthday as
 * "11 24 26". She was born in November 1926 — ninety-nine years old. The pivot
 * ("over 30 means 19xx") read 26 as 2026, eleven weeks from now, and the year
 * check let it through because 2026 is this year.
 *
 * A wrong date of birth silently matches the wrong patient, and this one was
 * wrong by a century on exactly the patients least able to ring back and
 * correct it.
 *
 * Time is pinned for the literal case, because whether "11 24 26" is in the
 * future depends on what day it is — the point of the fix is that the calendar
 * decides, so the test has to say which calendar.
 */
describe('a two-digit year the pivot puts in the future', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads "11 24 26" as 1926, not eleven weeks from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T22:34:55Z'));
    expect(normalizeDobParts('11 24 26')).toEqual({ year: '1926', month: '11', day: '24' });
  });

  it('leaves a two-digit year that is already past alone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T22:34:55Z'));
    // Both sides of the pivot, both in the past, both unchanged by this fix.
    expect(normalizeDobParts('5 8 39')).toEqual({ year: '1939', month: '05', day: '08' });
    expect(normalizeDobParts('3-17-73')).toEqual({ year: '1973', month: '03', day: '17' });
    expect(normalizeDobParts('9/2/48')).toEqual({ year: '1948', month: '09', day: '02' });
    // A baby born this year is a real patient — 2020 is past, so it stays 2020.
    expect(normalizeDobParts('1 1 20')).toEqual({ year: '2020', month: '01', day: '01' });
  });

  it('holds whatever day it is — a month from now is always the last century', () => {
    // No fake timers: the same rule, expressed against the real clock, so this
    // keeps testing the fix long after 2026-11-24 has gone past.
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const spoken = `${soon.getMonth() + 1} ${soon.getDate()} ${String(soon.getFullYear()).slice(2)}`;
    const p = normalizeDobParts(spoken);
    expect(p?.year, spoken).toBe(String(soon.getFullYear() - 100));
  });

  it('still refuses a FOUR-digit year in the future — the pivot is not a way in', () => {
    expect(normalizeDobParts(`11/24/${new Date().getFullYear() + 1}`)).toBeNull();
    expect(normalizeDobParts(`${new Date().getFullYear() + 1}-11-24`)).toBeNull();
  });
});

/**
 * THE SHAPE OF WHAT ARRIVED, AND NOTHING ELSE.
 *
 * A refusal that says `missingFields: ["date_of_birth"]` is two different
 * failures under one name — the model sent nothing, or it sent something the
 * parser would not take — and they need opposite fixes. dobShape is what tells
 * them apart on 2026-09-03's surgery call (CAf9b262f33921dee7df6274a16d90d001,
 * refused four times for a date the caller had just confirmed back to the
 * agent), and it goes into tool_timeline, so the test that matters most is the
 * one proving it carries no birthday.
 */
describe('the shape a date of birth arrived in', () => {
  it('keeps the shape and drops every digit and letter', () => {
    expect(dobShape('5 8 39')).toBe('# # ##');
    expect(dobShape('May 8th, 1939')).toBe('aaa #aa, ####');
    expect(dobShape('03/17/1973')).toBe('##/##/####');
    expect(dobShape('17 de febrero 1958')).toBe('## aa aaaaaaa ####');
  });

  it('says which refusal it was', () => {
    // The model sent no date at all — a prompt problem, not a parser one.
    expect(dobShape('')).toBe('(none)');
    expect(dobShape('   ')).toBe('(none)');
    expect(dobShape(null)).toBe('(none)');
    expect(dobShape(undefined)).toBe('(none)');
    // The model sent a structured object where a string was described.
    expect(dobShape({ month: 5, day: 8, year: 1939 })).toBe('(not a string)');
    expect(dobShape(19390508)).toBe('(not a string)');
  });

  it('cannot carry a birthday out — no digit and no letter survives', () => {
    for (const spoken of [
      '5 8 39',
      'May 8th, 1939',
      'my date of birth is June 17th, 1984',
      'Jackie Bott, 5 8 39',
      '17 de febrero 1958',
      'nineteen twenty-nine',
    ]) {
      const shaped = dobShape(spoken);
      expect(shaped, spoken).not.toMatch(/\p{Nd}/u);
      expect(shaped, spoken).not.toMatch(/[b-z]/i);
    }
  });

  it('is bounded — a whole sentence does not become a database column', () => {
    const long = dobShape('x'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
  });
});

/**
 * A DATE OF BIRTH SAID ONE DIGIT AT A TIME.
 *
 * Probed against two real calls that were refused on 2026-09-08:
 *
 *   "0 1 0 4 58"                         CA4475d6f1b265c4c6824ff0f241d159f9 — said
 *                                        four times, refused four times
 *   "Cero tres veintidos del cincuenta"  CAdc9f9667694dd95382985ad5f86f57b4 — the
 *                                        same habit, in Spanish
 *
 * "01 04 58" and "January 4th, 1958" both parse. The digit-at-a-time form does
 * not, and the reason is arithmetic rather than intent: the reader assembles a
 * date from THREE numeric groups or FOUR, and a caller reading their birthday
 * out digit by digit produces FIVE. Five is neither, so it fell through to the
 * branch whose job is refusing phone numbers.
 *
 * The Spanish line above is closed since v199, by the number-word reader
 * (`numberWordsToDigits`), which runs only after the digits have been refused.
 * See "a date of birth said in words" below.
 */
describe('a date of birth said one digit at a time', () => {
  const cases: Array<[string, string, string]> = [
    ['the real call, a two-digit year', '0 1 0 4 58', '1958-01-04'],
    ['the same caller, saying the year in full', '0 1 0 4 1 9 5 8', '1958-01-04'],
    ['a transcript that punctuated every digit', '0-1-0-4-58', '1958-01-04'],
    ['five groups, a December birthday', '1 2 2 5 47', '1947-12-25'],
  ];
  for (const [why, spoken, iso] of cases) {
    it(`${why}: "${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }

  it('the two-digit year is still decided by the calendar, not by the pivot', () => {
    // Same rule as every other path: "20" is 2020 because 2020 is in the past.
    // Without expandTwoDigitYear here this reads 1920 and matches nobody.
    expect(normalizeDobParts('0 1 0 1 2 0')).toEqual({ year: '2020', month: '01', day: '01' });
  });

  it('still refuses a phone number said the same way', () => {
    expect(normalizeDobParts('9 0 9 6 0 8 1 8 3 2')).toBeNull();
    expect(normalizeDobParts('1 9 0 9 6 0 8 1 8 3 2')).toBeNull();
  });

  it('still refuses digits that are not a real date', () => {
    expect(normalizeDobParts('9 9 9 9 9 9')).toBeNull();
    expect(normalizeDobParts('0 0 0 0 0 0')).toBeNull();
  });

  /**
   * THE GUARD THIS TEST EXISTS FOR: every token has to be a digit.
   *
   * A sentence whose digits happen to total six proves nothing about what the
   * caller meant, and joining the digits out of one fabricates a birthday —
   * "he was born 10 years ago in 2016" is 102016, which assembles into a date
   * that is real, in range, and wrong. Drop the every-token rule and this
   * assertion is the one that changes colour first.
   */
  it('will not sweep the digits out of a sentence', () => {
    expect(normalizeDobParts('my number is 0 1 0 4 58')).toBeNull();
  });
});

/**
 * A DATE OF BIRTH SAID IN WORDS — v199.
 *
 * On grok-voice-3.0 the transcriber writes a year the way it was spoken, and
 * the agent reads dates back in words. `numberWordsToDigits` turns the words
 * into digits and the same parser reads them, ONLY after the digits were
 * refused. Synthetic dates; the shapes are the 2026-11-07..10 corpus's
 * (`aSpokenDateOfBirthReachesTheTicket.test.ts`).
 */
describe('a date of birth said in words', () => {
  const reads: Array<[string, string]> = [
    ['July seventh, nineteen fifty-one.', '1951-07-07'],
    ['nacida el tres de marzo de mil novecientos cuarenta y ocho', '1948-03-03'],
    ['Noviembre nueve de mil novecientos treinta y nueve.', '1939-11-09'],
    ['Cero tres veintidos del cincuenta', '1950-03-22'],
    ['0 6 zero 2 19 47.', '1947-06-02'],
    ['zero one zero four five eight', '1958-01-04'],
    ['the second of may nineteen fifty five', '1955-05-02'],
    ['veintidos de febrero de dos mil once', '2011-02-22'],
    ['march seventeenth nineteen seventy three', '1973-03-17'],
  ];
  for (const [spoken, iso] of reads) {
    it(`reads "${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }

  it('still refuses a worded date that is not a date', () => {
    expect(normalizeDobParts('zero three thirty two of fifty')).toBeNull();
    expect(normalizeDobParts('nineteen seventy three')).toBeNull();
  });

  it('reads an ordinary word as a word: "oh", "one", "second" count only beside a number or a month', () => {
    expect(numberWordsToDigits('just a second')).toBeNull();
    expect(numberWordsToDigits('oh it is march')).toBeNull();
    expect(numberWordsToDigits('I have one question')).toBeNull();
    expect(numberWordsToDigits('the second of may')).toBe('the 2 of may');
  });

  it('a teen then a tens is two numbers, the halves of a year', () => {
    expect(numberWordsToDigits('nineteen fifty-one')).toBe('19 51');
    expect(numberWordsToDigits('mil novecientos cincuenta y seis')).toBe('1956');
    expect(numberWordsToDigits('two thousand eleven')).toBe('2011');
    expect(numberWordsToDigits('nineteen hundred and five')).toBe('1905');
  });

  it('changes no answer the digits already gave', () => {
    // The word reader runs only after the digits were refused. "May 5, 19
    // fifty" reads from its digits alone as May 5th 2019, and that answer
    // stands, as it did before v199, even though the words would read 1950:
    // widening what the word reader may override is its own change.
    const p = normalizeDobParts('May 5, 19 fifty');
    expect(p && `${p.year}-${p.month}-${p.day}`).toBe('2019-05-05');
    const q = normalizeDobParts("Yes, that's the one, March 3rd 1955");
    expect(q && `${q.year}-${q.month}-${q.day}`).toBe('1955-03-03');
  });
});

describe('a worded answer that negates, denies or corrects reads nothing (Codex P1 on #447)', () => {
  const iso = (spoken: string) => {
    const p = normalizeDobParts(spoken);
    return p ? `${p.year}-${p.month}-${p.day}` : null;
  };

  it('a rejection after a worded date: no date', () => {
    expect(iso('June third nineteen forty-four. That is wrong.')).toBeNull();
    expect(iso('June third nineteen forty-four, no, sorry.')).toBeNull();
    expect(iso("March seventeenth nineteen seventy three. That's not right.")).toBeNull();
    expect(iso('tres de junio de mil novecientos cuarenta y cuatro. Está equivocado.')).toBeNull();
    expect(iso('tres de junio de mil novecientos cuarenta y cuatro, perdón')).toBeNull();
  });

  it('a negation anywhere: no date', () => {
    expect(iso('It is not June third nineteen forty-four.')).toBeNull();
    expect(iso("I don't think it's June third nineteen forty-four.")).toBeNull();
    expect(iso('It was never June third nineteen forty-four.')).toBeNull();
    expect(iso('No es el tres de junio de mil novecientos cuarenta y cuatro.')).toBeNull();
    expect(iso('No June third nineteen forty-four.')).toBeNull();
  });

  it('a correction word inside a worded answer: no date (spokenDob reads what follows the correction)', () => {
    expect(iso('June third, wait, nineteen forty-four.')).toBeNull();
  });

  it('a leading "No," set off by punctuation corrects what came before: the date stands', () => {
    expect(iso('No, June fourth nineteen forty-four.')).toBe('1944-06-04');
    expect(iso('Nope. June fourth nineteen forty-four.')).toBe('1944-06-04');
    expect(iso('No, junio cuatro de mil novecientos cuarenta y cuatro.')).toBe('1944-06-04');
  });

  it('the digit form reads as it does on main', () => {
    expect(iso('June 3, 1944. That is wrong.')).toBe('1944-06-03');
  });
});

describe('digit forms read since v199', () => {
  const reads: Array<[string, string]> = [
    ['0 3 14, 1949.', '1949-03-14'],
    ['10, 10, 19, 1961.', '1961-10-10'],
    ['10 21 del 4 7.', '1947-10-21'],
  ];
  for (const [spoken, iso] of reads) {
    it(`reads "${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }
  it('still refuses a phone number with commas in it', () => {
    expect(normalizeDobParts('909, 555, 0100')).toBeNull();
  });
});
