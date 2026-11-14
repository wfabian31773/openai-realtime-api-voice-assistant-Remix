/**
 * A DATE OF BIRTH THE CALLER GAVE REACHES THE TICKET (v237).
 *
 * The 2026-11-14 ticket-quality pass: on 2026-11-12/13, 20 queue-lane tickets
 * (optical, surgery, tech) went out with no date of birth, or a wrong one, on a
 * call whose caller had said it. Each was read against its transcript and its
 * tool timeline; the failure, ticket by ticket:
 *
 * RESCUED BY THIS CHANGE (6)
 *   The teardown sweep filed the request and carried a date of birth only from
 *   a certain lookup, so the date the caller said in answer to the ask was
 *   dropped, though the reader already read it:
 *     VA-84472  CA0a0f4707669d09852a48b0c62f3b8214  tech     digits, then a comma and the year
 *     VA-84514  CA82b14ab39eb7122bf204eaed753fb61b  tech     the same shape, for "her" date of birth
 *     VA-85094  CA76ac3f4ac1246f91129f74c031c1c93d  surgery  Spanish month and "de" year, asked twice
 *     VA-85244  CA9712d588018b434f15fbc05c68bebaf4  tech     month and day, then the whole date
 *     VA-85245  CAfbf212203b932a5e914673348d7c3b0e  tech     month, ordinal day, year
 *     VA-84530  CAc9a3cca2379bfb98fd73df6542a38cff  surgery  the same date twice (the in-call filing
 *                                                             carried it and was refused for the surgeon)
 *
 * NOT CARRIED: THE CALLER VOLUNTEERED IT, NOBODY ASKED (4, pinned below)
 *   The caller said "date of birth <date>" before anyone asked, so no ask
 *   window opened. A reader for that shape was built on #480 and withdrawn
 *   after seven review findings in three rounds, one of them a volunteered
 *   date filed under another patient's name; the operator's ruling on #476,
 *   "Shrink the reader", applies: read only what can be bound to the patient.
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

import { callerDobToCarry, runRequestSweep, type SweepFiler, type NumberLookup } from './sweepRunner';
import { CALLER_DOB_NOTE, buildSweptTicket, decideSweep, type SweepInput } from './requestSweep';
import type { NameAsker } from './nameFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';
import { noteStatedNameFromArgs, resetStatedNames } from '../tools/statedName';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { dobFromCallerAnswer, resetSpokenDobs } from '../tools/spokenDob';

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
  { ticket: 'VA-85244', sid: 'CA9712d588018b434f15fbc05c68bebaf4', slug: 'tech', name: ['Lena', 'Vale'], source: 'stated', dob: '1970-10-14',
    lines: [GREETING, C('I have a question about my eye drops, they burn.'), A('Lena. And may I please have your date of birth, starting with the month, then the day, then the year?'), C('October 14'), C('October 14, 1970.'), A('Checking that for you.')] },
  { ticket: 'VA-85245', sid: 'CAfbf212203b932a5e914673348d7c3b0e', slug: 'tech', name: ['Ivy', 'Fern'], source: 'stated', dob: '1972-06-21',
    lines: [GREETING, C('My eye has been red since yesterday and I need someone to call me.'), A('Ivy Fern. And may I please have your date of birth, starting with the month, then the day, then the year?'), C('June 21st, 1972.'), A('Looking that up.')] },
  { ticket: 'VA-84530', sid: 'CAc9a3cca2379bfb98fd73df6542a38cff', slug: 'surgery', name: ['Mara', 'Bell'], source: 'stated', dob: '1986-03-26',
    lines: [GREETING, C('I need to know when my surgery is scheduled.'), ASK, C('March 26, 1986.'), A("I still can't lock that down. Could you say your date of birth one more time for me?"), C('March 26, 1986.'), A("I'm not able to match that to one record. How can I help you today?")] },
];

describe('the corpus: a date of birth the caller gave in answer to the ask reaches the swept ticket', () => {
  for (const row of ANSWERED_THE_ASK) {
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

/**
 * A DATE THE CALLER VOLUNTEERED, WITH NO ASK, IS NOT CARRIED. The labelled
 * reader that read these was withdrawn on #480 (see the header): nothing
 * binds a volunteered "date of birth <date>" to the patient the ticket names,
 * so a caller's own date could reach another patient's ticket.
 */
describe('a date of birth the caller volunteered with no ask is not carried', () => {
  const VOLUNTEERED: Array<[string, string, 'optical' | 'surgery' | 'tech', [string, string], string]> = [
    ['VA-84249', 'CA0ae7b0b0184c3dbdc4ca7867d91897e0', 'surgery', ['Testa', 'Arden'],
      'Uh, yes, this is for Testa Arden. She had surgery on Tuesday and we are confused about when to start the eye drops. Please give me a call at 5 5 5 5 5 5 0 1 0 0, and this is for Testa Arden, date of birth March 21, 1945. Thank you.'],
    ['VA-84692', 'CA1f32004624cf617a49e117ab488e3cdb', 'optical', ['Nora', 'Gale'],
      'Hi, I would like to decline the special glasses for Nora Gale, date of birth 7 4 11. She just wants her regular glasses, so please put in the order as is.'],
    ['VA-84628', 'CAee0c403d87b3404aa046f70543d4625d', 'tech', ['Vera', 'Dorn'],
      'Prescription refill request for Vera Dorn, date of birth February 18, 1943, for latanoprost eye drops. We are requesting a 90-day supply. Please follow up. Thank you so much.'],
    ['VA-84757', 'CAf3c1bbe78c4f427364507b3cac0dd3d1', 'surgery', ['Hal', 'Stone'],
      'Patient, Hal Stone, date of birth 10/25/1941, says that his drops irritate his eyes. He would like an alternative medication for dry eyes.'],
  ];
  for (const [ticket, sid, slug, name, said] of VOLUNTEERED) {
    it(`${ticket} (${sid}, ${slug}): files with no date of birth and no note`, async () => {
      const lines = [GREETING, C(said)];
      expect(dobFromCallerAnswer(lines)).toBeUndefined();
      stated(sid, name[0], name[1]);
      const file = filer();
      const out = await runRequestSweep(record(sid, slug, lines), file, noName);
      expect(out.filed).toBe(true);
      expect(birth(file.calls[0])).toBeUndefined();
      expect(String(file.calls[0].staffNote)).not.toContain(CALLER_DOB_NOTE);
    });
  }
});

/**
 * A DATE THE CALLER TAKES BACK AFTER ANSWERING IS NOT CARRIED (v237;
 * github-actions P2 on #480, head 18c99236). The reader keeps a date the
 * caller rejects with no new one ("That's wrong." after the agent's
 * readback), and the sweep would have filed it where main filed none. Any
 * denial or correction in a caller line after the answering turn now drops
 * it. Every date here is synthetic.
 */
describe('a date the caller takes back after answering is not carried', () => {
  const REQUEST = C('I need a refill on my eye drops, please.');
  const READBACK = A('I have March third, nineteen fifty. Is that right?');
  const THANKS = A('Thank you. What can I help you with?');

  it('"That\'s wrong." after the readback (the review\'s shape)', async () => {
    const lines = [GREETING, REQUEST, ASK, C('March 3, 1950.'), READBACK, C("That's wrong.")];
    expect(dobFromCallerAnswer(lines)).toBe('1950-03-03'); // what the reader alone keeps
    expect(callerDobToCarry(lines)).toBeUndefined();
    const sid = 'CA0a0f4707669d09852a48b0c62f3b8214';
    stated(sid, 'Testa', 'Lake');
    const file = filer();
    await runRequestSweep(record(sid, 'tech', lines), file, noName);
    expect(birth(file.calls[0])).toBeUndefined();
    expect(String(file.calls[0].staffNote)).not.toContain(CALLER_DOB_NOTE);
  });

  it('a denial or a correction in any later caller line', () => {
    const answered = [GREETING, REQUEST, ASK, C('March 3, 1950.')];
    expect(callerDobToCarry([...answered, READBACK, C('No, that is wrong, let me check.')])).toBeUndefined();
    expect(callerDobToCarry([...answered, READBACK, C("That isn't right.")])).toBeUndefined();
    expect(callerDobToCarry([...answered, THANKS, C('Sorry, I meant March 4, 1950.')])).toBeUndefined();
    expect(callerDobToCarry([...answered, C('Wait, let me look at my card.')])).toBeUndefined();
  });

  it('a caller asked again who answers again is judged from the new answer', () => {
    const denied = [GREETING, REQUEST, ASK, C('March 3, 1950.'), READBACK, C("No, that's wrong.")];
    expect(callerDobToCarry([...denied, ASK, C('March 3, 1950.')])).toBe('1950-03-03');
    expect(callerDobToCarry([...denied, ASK, C('March 4, 1950.')])).toBe('1950-03-04');
  });

  it('a correction inside the answering turn is the answer, not a taking back', () => {
    expect(callerDobToCarry([GREETING, REQUEST, ASK, C('March 3, 1950. Sorry, I meant March 4, 1950.')])).toBe('1950-03-04');
    expect(
      callerDobToCarry([GREETING, REQUEST, ASK, C('March 3, 1950.'), A('Could you give me your date of birth once more?'), C('No, it is March 4, 1950.')]),
    ).toBe('1950-03-04');
  });

  it('what is not a taking back: a denial before the answer, and the agent\'s own words', () => {
    expect(callerDobToCarry([GREETING, C("No, I don't have an appointment, I need a refill."), ASK, C('March 3, 1950.')])).toBe('1950-03-03');
    expect(callerDobToCarry([GREETING, REQUEST, ASK, C('March 3, 1950.'), A("I'm not able to match that. How can I help?"), C('A refill, please.')])).toBe('1950-03-03');
  });

  it('all 6 corpus rescues still carry', () => {
    for (const row of ANSWERED_THE_ASK) expect(callerDobToCarry(row.lines), row.ticket).toBe(row.dob);
  });
});

describe('the sweep carries it only under a name the caller gave', () => {
  const sid = 'CA0ae7b0b0184c3dbdc4ca7867d91897e0';
  const message = [GREETING, C('This is for Testa Arden. She had surgery on Tuesday and we are confused about the drops. Please call back.'), ASK, C('March 21, 1945.')];

  it('not under the calling number\'s owner, when nobody said a patient name', async () => {
    const lines = [GREETING, C('Calling about my mother, she had surgery Tuesday and the drops are confusing. Please call back.'), ASK, C('March 21, 1945.')];
    const owner: NumberLookup = async () => ({ firstName: 'Owen', lastName: 'Arden' });
    const file = filer();
    const out = await runRequestSweep(record(sid, 'surgery', lines), file, noName, owner);
    expect(out.filed).toBe(true);
    expect(file.calls[0].patientFirstName).toBe('Owen');
    expect(birth(file.calls[0])).toBeUndefined();
    expect(String(file.calls[0].staffNote)).not.toContain(CALLER_DOB_NOTE);
  });

  it('a certain identity files the chart date, never the spoken one', async () => {
    rememberVerifiedIdentity(sid, { firstName: 'Testa', lastName: 'Arden', dateOfBirth: '1945-03-12', certain: true });
    const file = filer();
    await runRequestSweep(record(sid, 'surgery', message), file, noName);
    expect(birth(file.calls[0])).toBe('1945-03-12');
    expect(String(file.calls[0].staffNote)).not.toContain(CALLER_DOB_NOTE);
  });

  it('carried under every name the caller gave (stated, spoken, heard), and under no other source', () => {
    // A spoken name (v171) is read only from a one-turn message, so it cannot
    // meet an ask answer end to end; the rule is checked on the ticket itself.
    for (const nameSource of ['stated', 'spoken', 'heard', 'verified', 'number', undefined] as const) {
      const input: SweepInput = {
        callSid: sid,
        slug: 'surgery',
        callerPhone: '+15555550100',
        transcript: message.join('\n'),
        toolEvents: [],
        ticketAlreadyFiled: false,
        verifiedName: { firstName: 'Testa', lastName: 'Arden' },
        nameSource,
        callerDob: '1945-03-21',
      };
      const decision = decideSweep(input);
      if (!decision.file) throw new Error('fixture must be fileable');
      const ticket = buildSweptTicket(input, decision) as unknown as Record<string, unknown>;
      const carried = nameSource === 'stated' || nameSource === 'spoken' || nameSource === 'heard';
      expect(birth(ticket)).toBe(carried ? '1945-03-21' : undefined);
      expect(String(ticket.staffNote).includes(CALLER_DOB_NOTE)).toBe(carried);
    }
  });

  it('a nameless records request carries no date of birth', async () => {
    const lines = [GREETING, C('I need copies of my mother\'s records sent to her new doctor. Please call back.'), ASK, C('March 21, 1945.')];
    const file = filer();
    const out = await runRequestSweep(record('CA1f32004624cf617a49e117ab488e3cdb', 'records', lines), file, noName);
    expect(out.filed).toBe(true);
    expect(file.calls[0].patientFirstName).toBeUndefined();
    expect(birth(file.calls[0])).toBeUndefined();
  });

  it('no date said, no date filed, no note', async () => {
    stated(sid, 'Testa', 'Arden');
    const lines = [GREETING, C('This is for Testa Arden, she had surgery Tuesday and the drops are confusing. Please call back.')];
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
