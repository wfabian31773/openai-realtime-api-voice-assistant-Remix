/**
 * A DATE OF BIRTH THE CALLER GAVE REACHES THE TICKET (v231).
 *
 * The 2026-11-14 ticket-quality pass: on 2026-11-12/13, 20 queue-lane tickets
 * (optical, surgery, tech) went out with no date of birth, or a wrong one, on a
 * call whose caller had said it. Each was read against its transcript and its
 * tool timeline; the failure, ticket by ticket:
 *
 * RESCUED BY THIS CHANGE (10)
 *   The teardown sweep filed the request and carried a date of birth only from
 *   a certain lookup, so the date the caller said in answer to the ask was
 *   dropped, though the reader already read it (6):
 *     VA-84472  CA0a0f4707669d09852a48b0c62f3b8214  tech     digits, then a comma and the year
 *     VA-84514  CA82b14ab39eb7122bf204eaed753fb61b  tech     the same shape, for "her" date of birth
 *     VA-85094  CA76ac3f4ac1246f91129f74c031c1c93d  surgery  Spanish month and "de" year, asked twice
 *     VA-85244  CA9712d588018b434f15fbc05c68bebaf4  tech     month and day, then the whole date
 *     VA-85245  CAfbf212203b932a5e914673348d7c3b0e  tech     month, ordinal day, year
 *     VA-84530  CAc9a3cca2379bfb98fd73df6542a38cff  surgery  the same date twice (the in-call filing
 *                                                             carried it and was refused for the surgeon)
 *   The caller said "date of birth <date>" before anyone asked, so no ask window
 *   opened and the reader read nothing (3 by the sweep, 1 in the call):
 *     VA-84249  CA0ae7b0b0184c3dbdc4ca7867d91897e0  surgery  a one-breath message, the label at the end
 *     VA-84692  CA1f32004624cf617a49e117ab488e3cdb  optical  the label after the patient's name, digits
 *     VA-84628  CAee0c403d87b3404aa046f70543d4625d  tech     a refill request, label then the drug
 *     VA-84757  CAf3c1bbe78c4f427364507b3cac0dd3d1  surgery  in the call: the filing tool found no date
 *
 * STILL FAILS (4, pinned below so a fix shows up here)
 *     VA-84754  CAd9904b304f6d4c65d8a1d140a48ad199  surgery  the month said twice: "<Month>, <Month> <day>, <year>"
 *     VA-84940  CA812fa0d52f3422896f15f9f59eb831ad  tech     the same stutter
 *     VA-85064  CAd49ac5f736f80a367cffd991a90074e6  surgery  "Cero. Adelante." closed the window before the date
 *     VA-84505  CA892e7cab4059e0eab19feaacf1fc1739  optical  a Spanish restart, "7 21, 7 21 5 8"
 *
 * CORRECTLY REFUSED (5): the date is ambiguous or was corrected into a tangle
 *     VA-84416  CAa7cfbc6ec0a172aaab0c3edc2ba399f5  tech     "<m> <d> 19", a year that is not a year
 *     VA-85076  CA8c7d0b4d0d4fd3c1c9d72dfe7b875067  tech     the month said three times, then "del <yy>"
 *     VA-84440  CAcfbf4cb372706386e7a3313fabfb2c17  surgery  "<Month> <d>, 19, <year>"
 *     VA-84638  CAe5375a718ac89042446aea03031de618  optical  three corrections, none clean
 *     VA-84263  CAaec8ba53ab37f2419a65c2db7771c445  optical  month and day in one turn, the year two turns later
 *
 * NOT THIS MECHANISM (1): VA-84834 (CAc7a24aeff2ec7f71932c8bbd1cf54971), the
 * model sent its own reading of a run of digits as the date of birth.
 *
 * Every name and date below is synthetic, in the shape of the real one; the
 * real transcripts stay in call_logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { runRequestSweep, type SweepFiler, type NumberLookup } from './sweepRunner';
import { CALLER_DOB_NOTE } from './requestSweep';
import type { NameAsker } from './nameFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';
import { noteStatedNameFromArgs, resetStatedNames } from '../tools/statedName';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { dobFromCallerAnswer, noteSpokenDob, resetSpokenDobs } from '../tools/spokenDob';
import { prepareTicketIdentity } from '../tools/ticketIdentity';

const A = (s: string) => `AGENT: ${s}`;
const C = (s: string) => `CALLER: ${s}`;
const GREETING = A('Thank you for calling Azul Vision. I can take a message and they will follow up with you. How can I help you today?');
const ASK = A('And may I please have your date of birth, starting with the month, then the day, then the year?');

function record(callSid: string, slug: string, lines: string[], toolEvents: VoiceCallRecord['toolEvents'] = []): VoiceCallRecord {
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: lines.join('\n'),
    toolEvents,
    agentTurns: 4,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 91_000,
  };
}

function filer(): SweepFiler & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn = (async (ticket: unknown) => {
    calls.push(ticket as Record<string, unknown>);
    return { success: true, ticketNumber: 'VA-SWEEP-1' };
  }) as SweepFiler & { calls: Record<string, unknown>[] };
  fn.calls = calls;
  return fn;
}

const heardAs = (firstName: string, lastName: string): NameAsker => async () => ({ firstName, lastName });
const noName: NameAsker = async () => null;

/** The name a name-taking tool received on the call, as `runTool` notes it. */
function stated(callSid: string, firstName: string, lastName: string): void {
  noteStatedNameFromArgs('lookup_patient', { call_sid: callSid, first_name: firstName, last_name: lastName });
}

const birth = (t: Record<string, unknown>) =>
  t.patientBirthYear ? `${t.patientBirthYear}-${t.patientBirthMonth}-${t.patientBirthDay}` : undefined;

beforeEach(() => {
  resetStatedNames();
  resetVerifiedIdentities();
  resetSpokenDobs();
});

interface Swept {
  ticket: string;
  sid: string;
  slug: 'optical' | 'surgery' | 'tech';
  name: [string, string];
  /** `stated`: a lookup or filing tool received the name. `heard`: read from the recording. */
  source: 'stated' | 'heard';
  lines: string[];
  dob: string;
}

const ANSWERED_THE_ASK: Swept[] = [
  { ticket: 'VA-84472', sid: 'CA0a0f4707669d09852a48b0c62f3b8214', slug: 'tech', name: ['Testa', 'Lake'], source: 'stated', dob: '1948-07-14',
    lines: [GREETING, C('I am calling about refills on her eye drops, please.'), A("Sure. And may I please have Testa's date of birth, starting with the month, then the day, then the year?"), C('7 14, 1948.'), A('Could you spell your last name for me, letter by letter?')] },
  { ticket: 'VA-84514', sid: 'CA82b14ab39eb7122bf204eaed753fb61b', slug: 'tech', name: ['Testa', 'Lake'], source: 'stated', dob: '1946-03-18',
    lines: [GREETING, C('Calling back about the eye drops for my mother, she ran out.'), A("That's fine. May I please have her date of birth, starting with the month, then the day, then the year?"), C('3 18, 1946.'), A('Checking that now.')] },
  { ticket: 'VA-85094', sid: 'CA76ac3f4ac1246f91129f74c031c1c93d', slug: 'surgery', name: ['Ana', 'Ruiz'], source: 'stated', dob: '1950-07-12',
    lines: [GREETING, C('Quiero saber la fecha de mi cirugía, por favor.'), A('Ana Ruiz. ¿Y me puede dar su fecha de nacimiento, empezando por el mes, luego el día y luego el año?'), C('Julio 12 de 1950.'), A('No la encuentro con esos datos. ¿Podría repetírmela, por favor?'), C('Julio 12, 1950.')] },
  { ticket: 'VA-85244', sid: 'CA9712d588018b434f15fbc05c68bebaf4', slug: 'tech', name: ['Petra', 'Vale'], source: 'stated', dob: '1970-10-14',
    lines: [GREETING, C('I have a question about my eye drops, they burn.'), A('Petra. And may I please have your date of birth, starting with the month, then the day, then the year?'), C('October 14'), C('October 14, 1970.'), A('Checking that for you.')] },
  { ticket: 'VA-85245', sid: 'CAfbf212203b932a5e914673348d7c3b0e', slug: 'tech', name: ['Dina', 'Fern'], source: 'stated', dob: '1972-06-21',
    lines: [GREETING, C('My eye has been red since yesterday and I need someone to call me.'), A('Dina Fern. And may I please have your date of birth, starting with the month, then the day, then the year?'), C('June 21st, 1972.'), A('Looking that up.')] },
  { ticket: 'VA-84530', sid: 'CAc9a3cca2379bfb98fd73df6542a38cff', slug: 'surgery', name: ['Mara', 'Tamm'], source: 'stated', dob: '1986-03-26',
    lines: [GREETING, C('I need to know when my surgery is scheduled.'), ASK, C('March 26, 1986.'), A("I still can't lock that down. Could you say your date of birth one more time for me?"), C('March 26, 1986.'), A("I'm not able to match that to one record. How can I help you today?")] },
];

const SAID_UNASKED: Swept[] = [
  { ticket: 'VA-84249', sid: 'CA0ae7b0b0184c3dbdc4ca7867d91897e0', slug: 'surgery', name: ['Lucy', 'Arden'], source: 'heard', dob: '1945-03-21',
    lines: [GREETING, C('Uh, yes, this is for Lucy Arden. She had surgery on Tuesday and we are confused about when to start the eye drops. Please give me a call at 5 5 5 5 5 5 0 1 0 0, and this is for Lucy Arden, date of birth March 21, 1945. Thank you.')] },
  { ticket: 'VA-84692', sid: 'CA1f32004624cf617a49e117ab488e3cdb', slug: 'optical', name: ['Mia', 'Gale'], source: 'heard', dob: '2011-07-04',
    lines: [GREETING, C('Hi, I would like to decline the special glasses for Mia Gale, date of birth 7 4 11. She just wants her regular glasses, so maybe you can put in the order as is.')] },
  { ticket: 'VA-84628', sid: 'CAee0c403d87b3404aa046f70543d4625d', slug: 'tech', name: ['Carla', 'Dorn'], source: 'stated', dob: '1943-02-18',
    lines: [GREETING, C('Prescription refill request for Carla Dorn, date of birth February 18, 1943, for latanoprost eye drops. We are requesting a 90-day supply. Please follow up. Thank you so much.')] },
];

describe('the corpus: a date of birth the caller gave reaches the swept ticket', () => {
  for (const row of [...ANSWERED_THE_ASK, ...SAID_UNASKED]) {
    it(`${row.ticket} (${row.sid}, ${row.slug}) files with the date the caller said`, async () => {
      if (row.source === 'stated') stated(row.sid, row.name[0], row.name[1]);
      const file = filer();
      const out = await runRequestSweep(
        record(row.sid, row.slug, row.lines),
        file,
        row.source === 'heard' ? heardAs(row.name[0], row.name[1]) : noName,
      );
      expect(out.filed).toBe(true);
      expect(file.calls).toHaveLength(1);
      expect(birth(file.calls[0])).toBe(row.dob);
      expect(String(file.calls[0].staffNote)).toContain(CALLER_DOB_NOTE);
    });
  }

  it('VA-84757 (CAf3c1bbe78c4f427364507b3cac0dd3d1, surgery): in the call, the filing tools find the date the caller labelled', () => {
    const sid = 'CAf3c1bbe78c4f427364507b3cac0dd3d1';
    noteSpokenDob(sid, [
      GREETING,
      C('Patient, Hal Stone, date of birth 10/25/1941, says that his drops irritate his eyes. He would like an alternative medication for dry eyes.'),
    ]);
    const out = prepareTicketIdentity({ call_sid: sid, first_name: 'Hal', last_name: 'Stone' });
    expect(out.missing).toBeUndefined();
    expect(out.input.date_of_birth).toBe('1941-10-25');
  });
});

describe('the corpus: still fails, and correctly refused (the reader reads no date)', () => {
  const unread: Array<[string, string, string[]]> = [
    ['still fails: VA-84754 / VA-84940, the month said twice', 'CAd9904b304f6d4c65d8a1d140a48ad199',
      [A('Thanks. And may I please have your date of birth, starting with the month, then the day, then the year? [interrupted]'), C('April'), C('April, April 12th, 1950.'), A('Checking that now.')]],
    ['still fails: VA-85064, "Adelante." closed the window', 'CAd49ac5f736f80a367cffd991a90074e6',
      [A('Ana Ruiz. ¿Y me da su fecha de nacimiento, empezando por el mes, luego el día y luego el año? [interrupted]'), C('Se'), A('No la capté. ¿Podría repetirla, por favor? [interrupted]'), C('Cero'), A('Cero. Adelante.'), C('0 2 14 1952.')]],
    ['still fails: VA-84505, a Spanish restart', 'CA892e7cab4059e0eab19feaacf1fc1739',
      [A('Ana Ruiz. ¿Y su fecha de nacimiento, empezando por el mes, luego el día y luego el año? [interrupted]'), C('Sí.'), A('luego el día, y luego el año. [interrupted]'), C('7 21, 7 21 5 8.'), A('Siete, veintiuno, cinco ocho. ¿Es correcto? [interrupted]'), C('Sí. Sí.')]],
    ['correctly refused: VA-84416, a year that is not a year', 'CAa7cfbc6ec0a172aaab0c3edc2ba399f5',
      [A('Hal Stone. And may I please have his date of birth, starting with the month, then the day, then the year? [interrupted]'), C('Yes.'), A('I still need the date itself. For example, March seventeenth, nineteen seventy-three. [interrupted]'), C('8 17 19'), A('That came through as just the digits. Is that August seventeenth, nineteen nineteen? [interrupted]')]],
    ['correctly refused: VA-85076, the month three times then "del"', 'CA8c7d0b4d0d4fd3c1c9d72dfe7b875067',
      [A('Ana Ruiz. ¿Y su fecha de nacimiento, empezando por el mes, luego el día y luego el año? [interrupted]'), C('Sí.'), A('Después el día, y al final el año. [interrupted]'), C('Once'), C('11, 11, 11 del 54.'), A('Once, once, mil novecientos cincuenta y cuatro.')]],
  ];
  for (const [title, sid, lines] of unread) {
    it(`${title} (${sid})`, () => {
      expect(dobFromCallerAnswer(lines)).toBeUndefined();
    });
  }
});

describe('a date the caller calls the date of birth: what it is not', () => {
  it('a label followed by another date reads nothing', () => {
    expect(dobFromCallerAnswer([GREETING, C('This is for Testa Lake, date of birth, and her surgery is March 3, 2026. Please call.')])).toBeUndefined();
  });

  it('a label whose sentence names another date reads nothing', () => {
    expect(dobFromCallerAnswer([GREETING, C('For Testa Lake, date of birth April 9, 2026 for the surgery, please confirm it.')])).toBeUndefined();
  });

  it('a label whose date is then taken back reads nothing', () => {
    expect(dobFromCallerAnswer([GREETING, C('Refill for Testa Lake, date of birth March 3, 1950, no, that is wrong, let me check.')])).toBeUndefined();
  });

  it('a label not followed by a date reads nothing, whatever date comes later in the sentence', () => {
    expect(dobFromCallerAnswer([GREETING, C('I do not know her date of birth, but my son has his birthday March 3, 1980, and he needs drops.')])).toBeUndefined();
  });

  it('"DOB" alone is a label', () => {
    expect(dobFromCallerAnswer([GREETING, C('Refill request for Testa Lake, DOB 3/3/1950, for her drops.')])).toBe('1950-03-03');
  });

  it('a label followed by a denial reads nothing', () => {
    expect(dobFromCallerAnswer([GREETING, C('Her date of birth is not March 3, 1950, the chart is wrong. Please call me.')])).toBeUndefined();
  });

  it('two different dates labelled on one call read as neither', () => {
    expect(
      dobFromCallerAnswer([
        GREETING,
        C('Refills for Testa Lake, date of birth March 3, 1950.'),
        C('And for Hal Lake, date of birth April 9, 1948. Thank you.'),
      ]),
    ).toBeUndefined();
  });

  it('a birth with no label, said before any ask, stays unread', () => {
    expect(dobFromCallerAnswer([GREETING, C('My name is Testa Lake and I was born March 17th, 1973.')])).toBeUndefined();
  });

  it('the same date labelled twice still reads', () => {
    expect(
      dobFromCallerAnswer([GREETING, C('For Testa Lake, date of birth March 3, 1950.'), C('Again, Testa Lake, DOB March 3, 1950.')]),
    ).toBe('1950-03-03');
  });

  it('Spanish: "fecha de nacimiento" reads', () => {
    expect(dobFromCallerAnswer([GREETING, C('Es para Ana Ruiz, fecha de nacimiento 3 de marzo de 1950. Gracias.')])).toBe('1950-03-03');
  });

  it('a later answer to the ask decides, over a labelled date', () => {
    expect(
      dobFromCallerAnswer([GREETING, C('This is for Testa Lake, date of birth March 3, 1950.'), ASK, C('April 9, 1951.')]),
    ).toBe('1951-04-09');
  });

  it('a labelled date that disagrees with the answer already given clears it', () => {
    expect(
      dobFromCallerAnswer([GREETING, ASK, C('April 9, 1951.'), A('Thank you. What can I help with?'), C('Refills for Testa Lake, date of birth March 3, 1950.')]),
    ).toBeUndefined();
  });

  it('a rejection after a labelled date clears it, and a later unrelated line does not bring it back', () => {
    expect(
      dobFromCallerAnswer([
        GREETING,
        C('This is for Testa Lake, date of birth March 3, 1950.'),
        A('I have March third, nineteen fifty. Is that right?'),
        C('No, it is not March 3rd.'),
        A('Thank you. What can I help with?'),
        C('She needs a refill on her drops.'),
      ]),
    ).toBeUndefined();
  });
});

describe('the sweep carries it only under a name the caller gave', () => {
  const sid = 'CA0ae7b0b0184c3dbdc4ca7867d91897e0';
  const message = [GREETING, C('This is for Lucy Arden. She had surgery on Tuesday and we are confused about the drops. Date of birth March 21, 1945. Please call back.')];

  it('not under the calling number\'s owner, when nobody said a patient name', async () => {
    const lines = [GREETING, C('Calling about my mother, she had surgery Tuesday and the drops are confusing. Date of birth March 21, 1945. Please call back.')];
    const owner: NumberLookup = async () => ({ firstName: 'Owen', lastName: 'Arden' });
    const file = filer();
    const out = await runRequestSweep(record(sid, 'surgery', lines), file, noName, owner);
    expect(out.filed).toBe(true);
    expect(file.calls[0].patientFirstName).toBe('Owen');
    expect(birth(file.calls[0])).toBeUndefined();
    expect(String(file.calls[0].staffNote)).not.toContain(CALLER_DOB_NOTE);
  });

  it('a certain identity files the chart date, never the spoken one', async () => {
    rememberVerifiedIdentity(sid, { firstName: 'Lucy', lastName: 'Arden', dateOfBirth: '1945-03-12', certain: true });
    const file = filer();
    await runRequestSweep(record(sid, 'surgery', message), file, noName);
    expect(birth(file.calls[0])).toBe('1945-03-12');
    expect(String(file.calls[0].staffNote)).not.toContain(CALLER_DOB_NOTE);
  });

  it('a name the caller said on the number\'s record (spoken) carries it', async () => {
    rememberVerifiedIdentity(sid, { firstName: 'Lucy', lastName: 'Arden', dateOfBirth: '1945-03-12', certain: false });
    const lines = [GREETING, C('Hi, my name is Lucy Arden. I had surgery on Tuesday and the drops are confusing. Date of birth March 21, 1945. Please call back.')];
    const file = filer();
    await runRequestSweep(record(sid, 'surgery', lines), file, noName);
    expect(file.calls[0].patientLastName).toBe('Arden');
    expect(birth(file.calls[0])).toBe('1945-03-21');
  });

  it('a nameless records request carries no date of birth', async () => {
    const lines = [GREETING, C('I need copies of my mother\'s records sent to her new doctor. Date of birth March 21, 1945. Please call back.')];
    const file = filer();
    const out = await runRequestSweep(record('CA1f32004624cf617a49e117ab488e3cdb', 'records', lines), file, noName);
    expect(out.filed).toBe(true);
    expect(file.calls[0].patientFirstName).toBeUndefined();
    expect(birth(file.calls[0])).toBeUndefined();
  });

  it('no date said, no date filed, no note', async () => {
    stated(sid, 'Lucy', 'Arden');
    const lines = [GREETING, C('This is for Lucy Arden, she had surgery Tuesday and the drops are confusing. Please call back.')];
    const file = filer();
    await runRequestSweep(record(sid, 'surgery', lines), file, noName);
    expect(birth(file.calls[0])).toBeUndefined();
    expect(String(file.calls[0].staffNote)).not.toContain(CALLER_DOB_NOTE);
  });
});

describe('the wiring', () => {
  it('the filer sends the birth fields the ticket carries', () => {
    const src = readFileSync(join(__dirname, 'sweepRunner.ts'), 'utf8');
    expect(src).toMatch(/ticket\.patientBirthYear \? \{ patientBirthYear: ticket\.patientBirthYear/);
  });
});
