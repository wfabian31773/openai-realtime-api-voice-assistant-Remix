/**
 * A DATE OF BIRTH THE CALLER GAVE REACHES THE TICKET — v199.
 *
 * Operator, 2026-11-10, on the tickets that come back to staff with fields
 * missing: "we need to understand why these fields are not being populated
 * correctly." The date of birth is the field most often missing on a queue
 * ticket whose caller gave one.
 *
 * THE CORPUS. Queue-lane calls since about 2026-11-07 whose transcript says
 * the caller was asked for a date of birth and answered, read against the
 * ticket that filed: 161 such calls, 25 took a date-of-birth refusal, 17 of
 * the 25 filed with no date of birth. The 17 were read one by one and their
 * failures named:
 *
 *   A  the agent finished its cut-off ask in a line of its own ("with the
 *      month, then the day, then the year.") and the caller answered THAT
 *      line, which opened no window
 *   B  a year said in words ("nineteen fifty-one", "mil novecientos ...")
 *   C  digits with a comma ("0 4 18, 1946.")
 *   D  a repeated century ("6, 2, 19, 1947."), a two-digit year said one
 *      digit at a time ("10 21 del 4 7.")
 *   E  a date and an age in one turn ("June 3, 1944. 82 years old.")
 *   F  a bare "sorry" correcting a date said a moment before
 *   G  a partial answer that agreed with the date already given cleared it
 *   H  the transcriber wrote nonsense, and the agent read the right date back
 *   I  a certain name-and-date-of-birth match, then a filing under the
 *      caller's spelling of the first name: `carry: name_mismatch`
 *
 * 14 of the 17 opened a question window; this build reads 11 of them and
 * leaves 3 unread, because reading them would be a guess. Of the other 3, one
 * is I and is rescued, and two callers volunteered the date before anyone
 * asked, which nothing here reads. I covers three calls in all: two rescued
 * (one of them also reads from its window) and one not, whose first name has
 * a different opening. So 12 of the 17 now carry a date of birth.
 *
 * PHI: the SIDs are real; every name and date below is SYNTHETIC, chosen to
 * reproduce each real shape. The real lines were run separately, off the
 * repo, through the same reader: 14 of 14 gave the expected result.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const { runTool } = await import('./registry');
await import('./sharedPatientTools');
const { dobFromCallerAnswer, resetSpokenDobs } = await import('./spokenDob');
const { verifiedDobFor, verifiedIdentityFor, dobCarry, resetVerifiedIdentities, rememberVerifiedIdentity } = await import('./verifiedIdentity');
const { resetGateAttempts } = await import('./gateAttempts');
const { prepareTicketIdentity } = await import('./ticketIdentity');

const A = (s: string) => `AGENT: ${s}`;
const C = (s: string) => `CALLER: ${s}`;
const ASK_EN = A('And may I please have your date of birth, starting with the month, then the day, then the year? [interrupted]');
const ASK_ES = A('¿Y me puede dar su fecha de nacimiento, empezando por el mes, luego el día y luego el año? [interrupted]');

beforeEach(() => {
  resetSpokenDobs();
  resetVerifiedIdentities();
  resetGateAttempts();
  lookupSpy.mockReset();
});

interface Case {
  sid: string;
  shape: string;
  lines: string[];
  want: string | undefined;
}

const CORPUS: Case[] = [
  {
    sid: 'CAb6183fa70bab1e1575b9bcf867ad01e5',
    shape: 'A + E: the format finished in its own line; a date and an age in one turn',
    lines: [
      ASK_EN, C('Yes.'),
      A('with the month, then the day, then the year. [interrupted]'),
      C('Their birth?'),
      C("Date of birth? I'm retired, dear. June 3, 1944. 82 years old."),
    ],
    want: '1944-06-03',
  },
  {
    sid: 'CA2c5949f3178f9e88f08a413b1accb606',
    shape: 'A + H: Spanish format line; the transcript is nonsense and the readback is in words',
    lines: [
      ASK_ES, C('Lopez'), ASK_ES, C('Sí.'),
      A('con el mes, luego el día y después el año.'),
      C('3 3 17 del 48.'),
      A('Gracias. Solo para confirmar, usted es Ana Lopez, nacida el tres de marzo de mil novecientos cuarenta y ocho. ¿Es correcto? [interrupted]'),
      C('Sí.'),
    ],
    want: '1948-03-03',
  },
  {
    sid: 'CA855265389fad269027dddc8b4b84e597',
    shape: 'A + B: "then the day, then the year." and a zero said as a word',
    lines: [ASK_EN, C('Yes. Yes.'), A('then the day, then the year.'), C('0 6 zero 2 19 47.'), A('Checking that now.')],
    want: '1947-06-02',
  },
  {
    sid: 'CA489604ea2dd121748a8aa1f119afb134',
    shape: 'A: a format-only line with an example date in it',
    lines: [
      A('Para completar el registro necesito su fecha de nacimiento, empezando por el mes, luego el [interrupted]'),
      C('Y el nombre es Ana.'),
      A('El primer nombre lo tomo como Ana. ¿El mes, el día y el año? [interrupted]'),
      C('Ana, sí. Okay, gracias.'),
      A('Mes, día y año. Por ejemplo, marzo diecisiete de mil novecientos setenta y tres.'),
      C('Noviembre 9 de 1939.'),
      A('Noviembre nueve de mil novecientos treinta y nueve.'),
      C('Correcto.'),
    ],
    want: '1939-11-09',
  },
  {
    sid: 'CAf2e29ef64db1f961d224eab7cdbfcbd6',
    shape: 'A: "Month, day, year again, please." after a spelling question',
    lines: [
      A("Do you have the patient's name and date of birth? [interrupted]"),
      C('Thank'),
      A('Could you spell your last name for me, letter by letter?'),
      C('Sure. L O P E Z.'),
      A('That\'s L-O-P-E-Z. Is that right?'),
      C('Yes.'),
      A('Month, day, year again, please.'),
      C('February 8th, 2003.'),
    ],
    want: '2003-02-08',
  },
  {
    sid: 'CAe89c5fec082bbaf2c9c58da4fdcd6f41',
    shape: 'H: the caller is heard as "4, 1952." and the agent reads the date back in words',
    lines: [
      A('Glaucoma operation. And may I please have your date of birth, starting with the month, then the day, then the year?'),
      C('4'), C('4, 1952.'),
      A('April fourth, nineteen fifty-two.'),
      A('Let me get this logged for you — one moment.'),
    ],
    want: '1952-04-04',
  },
  {
    sid: 'CA5839c1001d626c79524c020609999c16',
    shape: 'C: digits with a comma',
    lines: [ASK_EN, C('0 3 14, 1949.'), A("I'm still seeing more than one match on that.")],
    want: '1949-03-14',
  },
  {
    sid: 'CAa8d85ddac206c530e6a42ffe2957a158',
    shape: 'D: the century said, then the whole year',
    lines: [ASK_EN, C('10, 10, 19, 1961.'), A('Checking that now.')],
    want: '1961-10-10',
  },
  {
    sid: 'CAbeb9401a11b651bbaa7a0a7c5efdfef1',
    shape: 'D: a two-digit year said one digit at a time',
    lines: [A('Solo me dio el nombre. ¿Y su fecha de nacimiento, empezando por el mes, luego el día, y luego el año?'), C('10 21 del 4 7.')],
    want: '1947-10-21',
  },
  {
    sid: 'CA46c62db6bf01da345c74d15b7f28f35d',
    shape: 'F: "sorry" between two dates',
    lines: [A("And may I please have Ana's date of birth, starting with the month, then the day, then the year?"), C('2 12, 2009, sorry, 2 21, 2010.')],
    want: '2010-02-21',
  },
  {
    sid: 'CA8ab4aaa6917b6ca300cb0d4ef2a8fc66',
    shape: 'G: a partial answer that agrees with the date given does not clear it',
    lines: [
      ASK_ES, C('Sí.'), C('Sí. Junio 14, 52.'),
      A('Junio catorce de mil novecientos cincuenta y dos.'),
      A('Lo anoto. ¿Su fecha de nacimiento, mes, día y año?'),
      C('Junio 14.'),
      A('Falta el año. ¿Cuál es?'),
      C('Mil, 1952.'),
    ],
    want: '1952-06-14',
  },
  // ── Correctly left unread.
  {
    sid: 'CAc15f284e621b7299919495ac1027187c',
    shape: 'unread: the caller answered the window with a spelling, not a date',
    lines: [A("That's A-A-N. And may I please have the date of birth, starting with the month, then the day, then the year?"), C('No, no. Last name is A N.')],
    want: undefined,
  },
  {
    sid: 'CAdfb4a3835e52f986d789e28ff2781d1b',
    shape: 'unread: the agent states a date volunteered earlier, nobody asked',
    lines: [A('I have that noted for Ana Lopez, date of birth May 2nd, 1950,'), A('Do you happen to have a phone number on file for her?'), C('9 0 9 5 5 5 0 1 0 0.')],
    want: undefined,
  },
  {
    sid: 'CAff4bd060f8c05e0fc3502eb8cd5d9dfa',
    shape: 'unread: "8, 8, 23 del 61" is more than one date could be',
    lines: [
      A('May I please have the date of birth, starting with the month, then the day, then the year?'),
      C('I'),
      A('No le entendí. ¿Puede repetirlo, por favor?'),
      C('¿Qué quiere que repita?'),
      A('Su fecha de nacimiento. El mes, luego el día, y después el año. [interrupted]'),
      C('8, 8, 23 del 61. Me llamo Ana. Quiero saber si mis lentes están listos.'),
      A('Lo anoto.'),
    ],
    want: undefined,
  },
];

describe('the 2026-11-07..10 corpus: each call reads its date of birth, or is left unread on purpose', () => {
  for (const c of CORPUS) {
    it(`${c.sid}: ${c.shape}`, () => {
      expect(dobFromCallerAnswer(c.lines)).toBe(c.want);
    });
  }
});

describe('the format line opens a window only when it can be nothing else', () => {
  it('not before any date of birth was asked', () => {
    expect(dobFromCallerAnswer([A('Month, day, year, please.'), C('March 3rd, 1960.')])).toBeUndefined();
  });

  it('not right after a question about another date', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('Yes.'), A('When was your surgery?'), C('Last spring.'), A('Month, day, year, please.'), C('March 3rd, 2025.')]),
    ).toBeUndefined();
  });

  it('not when the line asks something besides the format', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('Sure.'), A('And what day and year did you get them?'), C('March 3rd, 2025.')]),
    ).toBeUndefined();
  });

  it('not when the line itself names another date', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('Sure.'), A('When was your last appointment? Month, day, year, please.'), C('March 3rd, 2025.')]),
    ).toBeUndefined();
  });
});

describe('the other rules hold their lines', () => {
  it('a bare "sorry" with no date before it is an apology, and the first date stands', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('January 4th 1958.'), C('Sorry, and my surgery is September 12th, 2025.')]),
    ).toBe('1958-01-04');
  });

  it('two different dates in two sentences of one turn stay unread', () => {
    expect(dobFromCallerAnswer([ASK_EN, C('Hmm. January 4th 1958. September 12th, 2025.')])).toBeUndefined();
  });

  it('a partial answer that DISAGREES still clears the earlier date', () => {
    expect(
      dobFromCallerAnswer([ASK_ES, C('Junio 14, 52.'), A('¿Su fecha de nacimiento, mes, día y año?'), C('Julio 3.')]),
    ).toBeUndefined();
  });

  it('a readback the caller denies is not taken', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('4, 1952.'), A('April fourth, nineteen fifty-two. Is that right?'), C('No.')]),
    ).toBeUndefined();
  });

  it('an example is not a readback', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('4, 1952.'), A('For example, April fourth, nineteen fifty-two.'), C('Okay.')]),
    ).toBeUndefined();
  });

  it('a readback whose year is not the year the caller said is not taken', () => {
    expect(dobFromCallerAnswer([ASK_EN, C('4, 1952.'), A('April fourth, nineteen sixty-two.'), C('Okay.')])).toBeUndefined();
  });

  it('only the FIRST agent line after the refused answer is read as a readback', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('4, 1952.'), A('Let me check.'), A('April fourth, nineteen fifty-two.')]),
    ).toBeUndefined();
  });

  // Codex P1 on #447 (head 7feecac0): a correction the reader cannot read.
  it('a correction that does not read refuses the turn; the date it corrected is not kept', () => {
    expect(dobFromCallerAnswer([ASK_EN, C('June 3, 1944. No, June 4.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK_EN, C('June 3, 1944. Sorry, the 4th.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK_EN, C('June 3, 1944. Actually, June 4.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK_EN, C('June 3, 1944. I meant the fourth.')])).toBeUndefined();
    // No cue at all: a second month, or a second run of numbers, is a second date.
    expect(dobFromCallerAnswer([ASK_EN, C('June 3, 1944. June 4.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK_EN, C('6 3 1944. 6 4.')])).toBeUndefined();
    // Shape E with a correction in it: the whole turn does not read, and the
    // correction carries no month and one number, so only its opening word marks it.
    expect(dobFromCallerAnswer([ASK_EN, C('June 3, 1944. Wait, the fourth. 82 years old.')])).toBeUndefined();
  });

  it('an age or a remark beside the date still stands aside (shape E)', () => {
    expect(dobFromCallerAnswer([ASK_EN, C('Hmm. June 3, 1944. 82 years old.')])).toBe('1944-06-03');
  });

  // Codex P1 on #447 (head 7feecac0): the whole answer to the readback is read.
  it('a "no" that is not the first word denies the readback', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('4, 1952.'), A('April fourth, nineteen fifty-two. Is that right?'), C('Actually, no.')]),
    ).toBeUndefined();
    expect(
      dobFromCallerAnswer([ASK_EN, C('4, 1952.'), A('April fourth, nineteen fifty-two. Is that right?'), C('Hmm, no.')]),
    ).toBeUndefined();
  });

  it('a "no" on the caller\'s second line denies the readback', () => {
    expect(
      dobFromCallerAnswer([
        ASK_EN, C('4, 1952.'), A('April fourth, nineteen fifty-two. Is that right?'), C('Hmm.'), C('No.'),
      ]),
    ).toBeUndefined();
  });

  // Codex P1 on #447 (head d0aefbb5): a denial or a correction that names the held date.
  it('a partial that names the held month and day to deny them clears the date', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('June 3, 1944.'), A('Your date of birth, month, day and year?'), C('No, not June 3.')]),
    ).toBeUndefined();
    expect(
      dobFromCallerAnswer([ASK_EN, C('June 3, 1944.'), A('Your date of birth, month, day and year?'), C('Actually, June 3.')]),
    ).toBeUndefined();
  });

  it('a correction or a different date after a readback is not a yes', () => {
    const RB = A('April fourth, nineteen fifty-two. Is that correct?');
    expect(dobFromCallerAnswer([ASK_EN, C('4, 1952.'), RB, C('Actually, April fifth.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK_EN, C('4, 1952.'), RB, C('April fifth.')])).toBeUndefined();
    expect(dobFromCallerAnswer([ASK_EN, C('4, 1952.'), RB, C('Wait, let me check my card.')])).toBeUndefined();
  });

  it('a caller who repeats the read-back date confirms it', () => {
    const RB = A('April fourth, nineteen fifty-two. Is that correct?');
    expect(dobFromCallerAnswer([ASK_EN, C('4, 1952.'), RB, C('Yes, April fourth.')])).toBe('1952-04-04');
    expect(dobFromCallerAnswer([ASK_EN, C('4, 1952.'), RB, C('Yes, April 4th, 1952.')])).toBe('1952-04-04');
  });

  it('a "no" after the agent\'s next line is an answer to that line, not to the readback', () => {
    expect(
      dobFromCallerAnswer([
        ASK_EN, C('4, 1952.'), A('April fourth, nineteen fifty-two. Is that right?'), C('Yes.'),
        A('Thank you. Is there anything else?'), C('No, that is all.'),
      ]),
    ).toBe('1952-04-04');
  });

  it('a readback after an answer that DID read is not needed and changes nothing', () => {
    expect(
      dobFromCallerAnswer([ASK_EN, C('April 4th, 1952.'), A('April fifth, nineteen fifty-two.')]),
    ).toBe('1952-04-04');
  });
});

// ── I: a spelling of the first name the person base accepted with the date of birth.

const RECORD = { firstName: 'Katherine', lastName: 'Lopez', dateOfBirth: '1951-02-03' };
const nameAndDob = (who = RECORD) => ({
  patientFound: true,
  patientName: `${who.firstName} ${who.lastName}`,
  matchedBy: 'name_and_dob' as const,
  identity: { unique: true, candidateCount: 1, candidates: [{ ...who, appointmentCount: 2 }] },
  patientData: { ...who, personId: 'p-synthetic' },
  upcomingAppointments: [],
  pastAppointments: [],
  totalAppointmentsFound: 2,
});
const lookup = (args: Record<string, unknown>) => runTool('lookup_patient', args) as Promise<Record<string, unknown>>;

describe('I — a certain name-and-date-of-birth match carries the chart date under the caller\'s spelling', () => {
  for (const [sid, queue] of [
    ['CA284c5e9edffb9dcf154798ea609d8e8a', 'surgery'],
    ['CA5839c1001d626c79524c020609999c16', undefined],
  ] as const) {
    it(`${sid}: filed under a spelling that shares the chart name's opening`, async () => {
      lookupSpy.mockImplementation(async () => nameAndDob());
      const out = await lookup({ ...(queue ? { queue } : {}), call_sid: sid, first_name: 'Kathy', last_name: 'Lopez', date_of_birth: '02/03/1951' });
      expect(out.identity_is_certain).toBe(true);
      expect(dobCarry(sid, 'Kathy', 'Lopez')).toBe('fired');
      expect(verifiedDobFor(sid, 'Kathy', 'Lopez')).toBe('1951-02-03');
      expect(prepareTicketIdentity({ call_sid: sid, first_name: 'Kathy', last_name: 'Lopez' }).input.date_of_birth).toBe('1951-02-03');
    });
  }

  it('CAc15f284e621b7299919495ac1027187c: a first name with a different opening is still refused (not rescued)', async () => {
    const sid = 'CAc15f284e621b7299919495ac1027187c';
    lookupSpy.mockImplementation(async () => nameAndDob({ firstName: 'Mei', lastName: 'Ito', dateOfBirth: '1962-05-06' }));
    await lookup({ call_sid: sid, first_name: 'May', last_name: 'Ito', date_of_birth: '05/06/1962' });
    expect(dobCarry(sid, 'May', 'Ito')).toBe('name_mismatch');
    expect(verifiedDobFor(sid, 'May', 'Ito')).toBeUndefined();
  });

  it('a different last name is still refused', async () => {
    const sid = 'CA00000000000000000000000000000199';
    lookupSpy.mockImplementation(async () => nameAndDob());
    await lookup({ call_sid: sid, first_name: 'Kathy', last_name: 'Lopez', date_of_birth: '02/03/1951' });
    expect(verifiedDobFor(sid, 'Kathy', 'Lopes')).toBeUndefined();
  });

  it('an unrelated first name is never kept as a spelling', () => {
    const sid = 'CA00000000000000000000000000000198';
    rememberVerifiedIdentity(sid, { ...RECORD, certain: true, heardAs: ['Maria'] });
    expect(verifiedIdentityFor(sid)?.heardAs).toBeUndefined();
    expect(verifiedDobFor(sid, 'Maria', 'Lopez')).toBeUndefined();
  });

  it('an uncertain write keeps no spelling', () => {
    const sid = 'CA00000000000000000000000000000197';
    rememberVerifiedIdentity(sid, { ...RECORD, certain: false, heardAs: ['Kathy'] });
    expect(verifiedIdentityFor(sid)).toBeUndefined();
    rememberVerifiedIdentity(sid, { ...RECORD, certain: true });
    expect(verifiedDobFor(sid, 'Kathy', 'Lopez')).toBeUndefined();
  });

  it('a later certain write on the same person keeps the spelling it learned', () => {
    const sid = 'CA00000000000000000000000000000196';
    rememberVerifiedIdentity(sid, { ...RECORD, certain: true, heardAs: ['Kathy'] });
    rememberVerifiedIdentity(sid, { ...RECORD, certain: true });
    expect(verifiedDobFor(sid, 'Kathy', 'Lopez')).toBe('1951-02-03');
  });

  it('a phone match the caller said yes to records no spelling', async () => {
    const sid = 'CA00000000000000000000000000000195';
    lookupSpy.mockImplementation(async () => ({
      ...nameAndDob(),
      matchedBy: 'phone' as const,
      identityUnconfirmed: true,
    }));
    await lookup({ call_sid: sid, caller_phone: '555-555-0199', first_name: 'Katherine' });
    expect(verifiedIdentityFor(sid)?.heardAs).toBeUndefined();
  });
});
