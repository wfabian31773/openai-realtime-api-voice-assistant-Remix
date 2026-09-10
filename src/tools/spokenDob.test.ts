/**
 * WHAT THE CALLER ACTUALLY SAID, AND WHY THE ADJACENCY RULE IS THE WHOLE TEST.
 *
 * The dangerous failure here is not missing a date — it is filing the WRONG
 * one. `dobParts.ts` says it in every comment and "Marcus 17 1973" parsing as
 * March was a real bug on a real ticket. A caller on these lines says
 * appointment dates and surgery dates out loud, so a reader that swept every
 * date out of a transcript would invent birthdays for a living.
 *
 * The guard is adjacency: a date counts only when the caller said it while
 * ANSWERING a request for a date of birth. Most of what follows is that rule
 * being held to, not the parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dobFromCallerAnswer,
  noteSpokenDob,
  spokenDobFor,
  resetSpokenDobs,
} from './spokenDob';

const SID = 'CA00000000000000000000000000000001';
const OTHER_SID = 'CA00000000000000000000000000000002';

beforeEach(() => {
  resetSpokenDobs();
});

describe('reading the date out of the answer the caller gave', () => {
  it('takes the date from the line answering the question', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: Thanks for calling. How can I help?',
        'CALLER: I need to reschedule my cataract surgery.',
        'AGENT: Of course. May I have your date of birth?',
        'CALLER: March 17th, 1973.',
      ]),
    ).toBe('1973-03-17');
  });

  it('takes it when the answer arrives a line after the acknowledgement', () => {
    // Real transcripts do this constantly: "Sure." lands as its own caller
    // line, then the date. Both are inside the same answering turn.
    expect(
      dobFromCallerAnswer([
        'AGENT: May I have your date of birth?',
        'CALLER: Sure.',
        'CALLER: March 17th, 1973.',
      ]),
    ).toBe('1973-03-17');
  });

  it('reads the digit-at-a-time form, which is what got this call refused', () => {
    // The other half of the same defect — see dobParts.ts.
    expect(
      dobFromCallerAnswer([
        'AGENT: May I please have the date of birth, starting with the month?',
        'CALLER: 0 1 0 4 58',
      ]),
    ).toBe('1958-01-04');
  });

  it('hears the question in Spanish', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: ¿Cuál es su fecha de nacimiento?',
        'CALLER: 17 de febrero 1958',
      ]),
    ).toBe('1958-02-17');
  });

  it('takes the LAST answer, because the last one is the correction', () => {
    // The agent asked again because the first answer did not survive. Taking
    // the first would file the value the caller has just corrected. Both
    // windows here yield a parseable date, so this fails if the first wins.
    expect(
      dobFromCallerAnswer([
        'AGENT: May I have your date of birth?',
        'CALLER: March 17th, 1983.',
        'AGENT: Sorry, could you give me the date of birth once more?',
        'CALLER: March 17th, 1973.',
      ]),
    ).toBe('1973-03-17');
  });

  /**
   * A CALLER WHO KEEPS TALKING AFTER ANSWERING.
   *
   * Codex, PR #275, in the readback form. Reproduced in the form below, which
   * needs no readback at all — the agent asks once, the caller answers, and
   * then says the other thing on their mind. Very often that other thing is a
   * date, and until the reader took the FIRST date in an answer rather than the
   * last, the surgery date won and all four filing tools wrote it to the
   * patient record as the date of birth.
   *
   * `valid()` cannot separate them: a surgery date last autumn is a real date
   * in range. Position inside the answer is the only discriminator there is.
   */
  it('takes the birthday, not the surgery date the caller mentions next', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: May I have your date of birth?',
        'CALLER: January 4th 1958',
        'CALLER: and my surgery is September 12th, 2025',
      ]),
    ).toBe('1958-01-04');
  });

  it('takes the birthday when the caller runs on for several lines', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: May I have your date of birth, starting with the month?',
        'CALLER: March 17th, 1973.',
        'CALLER: I saw the doctor on August 10th, 2024',
        'CALLER: and my follow up is December 2, 2025',
      ]),
    ).toBe('1973-03-17');
  });

  it('a later ask still supersedes an earlier answer — first-within, last-across', () => {
    // Both rules at once: the first date inside each window, and the last
    // window that produced one. Collapsing either direction breaks this.
    expect(
      dobFromCallerAnswer([
        'AGENT: May I have your date of birth?',
        'CALLER: March 17th, 1983.',
        'CALLER: my appointment is September 12th, 2025',
        'AGENT: Sorry, could you give me the date of birth once more?',
        'CALLER: March 17th, 1973.',
        'CALLER: and the surgery was August 10th, 2024',
      ]),
    ).toBe('1973-03-17');
  });

  it('treats a readback as a request, so the correction to it counts', () => {
    // "I have X, is that right?" is the agent putting the subject on the
    // table. The answer that follows is the caller fixing it.
    expect(
      dobFromCallerAnswer([
        'AGENT: I have a date of birth of March 17th, 1983 — is that right?',
        'CALLER: No, it is March 17th, 1973.',
      ]),
    ).toBe('1973-03-17');
  });
});

/**
 * CODEX P1b / P1a ON PR #275 — the four probes that blocked the merge.
 *
 * The discriminator is WHICH AGENT LINE OPENS A WINDOW, not first-vs-last
 * date inside one. An acknowledgement that mentions the date and then
 * changes topic must not treat a later surgery date as a birthday. A
 * confirmation ask still opens a window, so a real correction wins, a
 * refused attempt clears, and "yes that is correct" leaves the date.
 */
describe('which agent lines open a window — Codex P1b / P1a', () => {
  const A = (s: string) => `AGENT: ${s}`;
  const C = (s: string) => `CALLER: ${s}`;
  const ASK = A(
    'May I have your date of birth, starting with the month, then the day, then the year?',
  );

  it('P1b — an acknowledgement does not take a later surgery date as the birthday', () => {
    expect(
      dobFromCallerAnswer([
        ASK,
        C('January 4th 1958'),
        A('I have your date of birth, thank you. Anything else?'),
        C('Yes, my surgery is September 12th, 2025'),
      ]),
    ).toBe('1958-01-04');
  });

  it('P1a — a later unparseable correction clears the earlier date', () => {
    expect(
      dobFromCallerAnswer([
        ASK,
        C('01 04 58'),
        A('I have January 4th 1958 - is that your date of birth?'),
        C('No, zero three twenty two of fifty'),
      ]),
    ).toBeUndefined();
  });

  it('a real correction still wins', () => {
    expect(
      dobFromCallerAnswer([
        ASK,
        C('January 4th 1958'),
        A('I have January 4th 1958 - is that your date of birth?'),
        C('No, it is March 22nd 1950'),
      ]),
    ).toBe('1950-03-22');
  });

  it('a plain confirmation keeps the date', () => {
    expect(
      dobFromCallerAnswer([
        ASK,
        C('January 4th 1958'),
        A('I have January 4th 1958 - is that your date of birth?'),
        C('Yes that is correct'),
      ]),
    ).toBe('1958-01-04');
  });

  it('a same-sentence topic change after acknowledging still does not open a window', () => {
    expect(
      dobFromCallerAnswer([
        ASK,
        C('January 4th 1958'),
        A('I have your date of birth, can I help with anything else?'),
        C('Yes, my surgery is September 12th, 2025'),
      ]),
    ).toBe('1958-01-04');
  });

  it('P1c — a same-turn self-correction replaces the first date', () => {
    expect(
      dobFromCallerAnswer([
        ASK,
        C('January 4th 1958'),
        C('Sorry, I meant January 5th 1958'),
      ]),
    ).toBe('1958-01-05');
  });

  it('P1c — a same-line self-correction replaces the first date', () => {
    expect(
      dobFromCallerAnswer([
        ASK,
        C('January 4th 1958, sorry I meant January 5th 1958'),
      ]),
    ).toBe('1958-01-05');
  });
});

/**
 * THREE LIVE RE-ASKS THAT #280 STOPPED OPENING.
 *
 * Operator measurement after d0021e3: 3 of 13 real re-ask windows refused
 * where they previously parsed. The agent requested the date without
 * "may I" / a question mark, or put "once more" in the next sentence.
 * Widening those cues must not reopen P1b.
 */
describe('genuine re-asks still open a window', () => {
  it('CAe3de7ada — need your date of birth, no question mark', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: I just need your date of birth to get this logged.',
        'CALLER: October 23, 1995.',
      ]),
    ).toBe('1995-10-23');
  });

  it('CA74811ee4 — everything except your date of birth', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: I have everything except your date of birth.',
        'CALLER: April 11th, 1959.',
      ]),
    ).toBe('1959-04-11');
  });

  it('CAa6a32e9c — mis-heard, once more in the next sentence', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: the date of birth may have been mis-heard. Could you give it to me once more?',
        'CALLER: January 29th, 1963',
      ]),
    ).toBe('1963-01-29');
  });
});

/**
 * THE GUARD, STATED AS THE FAILURES IT PREVENTS.
 *
 * Every case below carries a real, parseable date somewhere in the caller's
 * words. A reader without the adjacency rule files every one of them as a
 * birthday.
 */
describe('a date the caller said about something else', () => {
  it('does not take a surgery date the caller volunteered', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: What can I help you with?',
        'CALLER: My surgery is on March 17th, 1973 — sorry, I mean the paperwork is dated that.',
      ]),
    ).toBeUndefined();
  });

  it('does not take a date said after the agent had moved on', () => {
    // The answering turn ENDS at the next agent line. A date after that is an
    // answer to a different question.
    expect(
      dobFromCallerAnswer([
        'AGENT: May I have your date of birth?',
        'CALLER: I do not have it in front of me.',
        'AGENT: No problem. When is your appointment?',
        'CALLER: March 17th, 1973.',
      ]),
    ).toBeUndefined();
  });

  it('takes nothing at all when nobody ever asked', () => {
    expect(
      dobFromCallerAnswer([
        'AGENT: What can I help you with?',
        'CALLER: My name is Wayne Fabian and I was born March 17th, 1973.',
      ]),
    ).toBeUndefined();
  });

  it('takes nothing from an empty or agent-only record', () => {
    expect(dobFromCallerAnswer([])).toBeUndefined();
    expect(dobFromCallerAnswer(['AGENT: May I have your date of birth?'])).toBeUndefined();
  });

  it('refuses a phone number given in answer to the question', () => {
    // The parser's own shape rule does this; the point is that the adjacency
    // rule does not override it.
    expect(
      dobFromCallerAnswer([
        'AGENT: May I have your date of birth?',
        'CALLER: 909 608 1832',
      ]),
    ).toBeUndefined();
  });
});

/**
 * THE LIVE COUNTER MUST NOT MOVE.
 *
 * `[DOB] refused a date of birth in the shape …` is a documented live counter
 * (docs/PULL-CHECK.md) and it is the instrument the whole 2026-09-08 finding
 * rests on: 75 refusals, `dobShape` reading "(none)" on every one. This reader
 * speculatively parses caller lines, and Grok re-emits a caller turn up to
 * five times, so a reader that used the announcing parser would add refusals
 * that no tool ever made — corrupting the measure that says whether any of
 * this worked.
 */
describe('speculative parsing does not touch the instruments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits no [DOB] line, whether it finds a date or refuses one', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    dobFromCallerAnswer([
      'AGENT: May I have your date of birth?',
      'CALLER: I would rather not say.',
      'AGENT: May I have your date of birth?',
      'CALLER: 0 1 0 4 58',
    ]);

    const dobLines = info.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter((l) => l.startsWith('[DOB]'));
    expect(dobLines).toEqual([]);
  });
});

/**
 * THE PER-CALL STORE — same discipline as gateAttempts.ts and
 * verifiedIdentity.ts beside it, and for the same reason. The sentinel rule is
 * the one that matters: `call_sid` is a declared property, so a model with no
 * injected value supplies "unknown", and a truthiness check would hand one
 * caller's date of birth to the next caller who emitted the same sentinel.
 */
describe('the per-call store', () => {
  it('gives a call back the date it heard on that call', () => {
    noteSpokenDob(SID, ['AGENT: May I have your date of birth?', 'CALLER: March 17th, 1973.']);
    expect(spokenDobFor(SID)).toBe('1973-03-17');
  });

  it('never lets one call read another call\'s answer', () => {
    noteSpokenDob(SID, ['AGENT: May I have your date of birth?', 'CALLER: March 17th, 1973.']);
    expect(spokenDobFor(OTHER_SID)).toBeUndefined();
  });

  it('stores nothing under a sentinel, and reads nothing back from one', () => {
    for (const sentinel of ['unknown', 'latest', 'none', 'undefined', '', undefined]) {
      noteSpokenDob(sentinel, [
        'AGENT: May I have your date of birth?',
        'CALLER: March 17th, 1973.',
      ]);
      expect(spokenDobFor(sentinel)).toBeUndefined();
    }
  });

  it('keeps the latest answer as the call goes on', () => {
    // The bridge re-posts the whole record on every caller completion, because
    // a cumulative re-emission REPLACES the open line rather than adding one.
    noteSpokenDob(SID, ['AGENT: May I have your date of birth?', 'CALLER: March 17th, 19']);
    noteSpokenDob(SID, ['AGENT: May I have your date of birth?', 'CALLER: March 17th, 1973.']);
    expect(spokenDobFor(SID)).toBe('1973-03-17');
  });

  it('does not erase an answer it already has when a later post carries none', () => {
    // A caller who answers and then talks about something else must not lose
    // the answer they already gave.
    noteSpokenDob(SID, ['AGENT: May I have your date of birth?', 'CALLER: March 17th, 1973.']);
    noteSpokenDob(SID, [
      'AGENT: May I have your date of birth?',
      'CALLER: March 17th, 1973.',
      'AGENT: Thank you. Anything else?',
      'CALLER: No, that is everything.',
    ]);
    expect(spokenDobFor(SID)).toBe('1973-03-17');
  });

  it('deletes the cached date when the latest ask window is a refused attempt', () => {
    // P1a reaches the store, not only the reader. `if (!iso) return` used to
    // leave 1958-01-04 standing, and the four filing tools would file it.
    noteSpokenDob(SID, [
      'AGENT: May I have your date of birth, starting with the month, then the day, then the year?',
      'CALLER: 01 04 58',
    ]);
    expect(spokenDobFor(SID)).toBe('1958-01-04');
    noteSpokenDob(SID, [
      'AGENT: May I have your date of birth, starting with the month, then the day, then the year?',
      'CALLER: 01 04 58',
      'AGENT: I have January 4th 1958 - is that your date of birth?',
      'CALLER: No, zero three twenty two of fifty',
    ]);
    expect(spokenDobFor(SID)).toBeUndefined();
  });

  it('keeps the cache on a confirmation that yields no date', () => {
    noteSpokenDob(SID, [
      'AGENT: May I have your date of birth?',
      'CALLER: January 4th 1958',
    ]);
    noteSpokenDob(SID, [
      'AGENT: May I have your date of birth?',
      'CALLER: January 4th 1958',
      'AGENT: I have January 4th 1958 - is that your date of birth?',
      'CALLER: Yes that is correct',
    ]);
    expect(spokenDobFor(SID)).toBe('1958-01-04');
  });

  it('forgets everything on reset', () => {
    noteSpokenDob(SID, ['AGENT: May I have your date of birth?', 'CALLER: March 17th, 1973.']);
    resetSpokenDobs();
    expect(spokenDobFor(SID)).toBeUndefined();
  });
});
