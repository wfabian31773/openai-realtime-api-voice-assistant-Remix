/**
 * A CALLER WHO SAYS THE NAME THE CALLING NUMBER BELONGS TO IS NOT NAMELESS — v168.
 *
 * Operator ruling, 2026-10-29: "we should not be filing nameless tickets but
 * we also need to make sure that we did not get the name in transcripts nor
 * did we match the phone number to a patient on lookup."
 *
 * THE CORPUS, 2026-11-02, by real CallSid. Every one is the same shape: the
 * caller heard the greeting ("…I can take a message and they will follow up
 * with you…"), left a whole message in one breath — name, request, often a
 * callback number — and hung up. The model never got a turn, or got one only
 * as the caller was leaving, so no tool ever received the name and the
 * teardown sweep skipped every one as "no-name". The calling number was on
 * file as exactly one person (the pre-context match, held `certain: false`
 * since #384), and in each the caller said BOTH halves of that person's name.
 * Seven calls, six of them the day's ten lost requests (D1):
 *
 *   surgery  CA05286af5667d706e5e892ae1fc0892f7  wants a coordinator; a month waiting
 *   surgery  CAc053cc03bcdb94e2a42793e713cc1ff5  Spanish; insurance referral for cataract surgery
 *   surgery  CA940cad77a53b398258bfaa174c056e9c  texts about things never ordered; clear the record
 *   surgery  CA7c323ecc102568a418638b8ed307da8b  surgeon's phone and fax for a release form
 *   surgery  CA82885cc3e29c834e1d5d874b4c16f78e  asks a named coordinator to call back
 *   surgery  CA6d8692e2a1dfc3172142de9cd9f6311c  call back about this week's appointment
 *   tech     CA8019e3f55b7a3c7ea50ac953c44067c0  fourth request for a prescription to the pharmacy
 *
 * THE CORRECT REFUSALS from the same day, which must still file nothing:
 *
 *   tech     CA1e9d6914e00df3220970fc83329e196b  surname transcribed differently from the record
 *   tech     CA486d3e40706ba61ddea8fdf9391426e6  never said the candidate's name
 *   optical  CA687ad8d4b61af8ebf3cf61c0d4005fe1  (10-30) first name only
 *
 * Names below are synthetic; the real ones stay in call_logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { noteStatedNameFromArgs, resetStatedNames } from '../tools/statedName';
import {
  rememberVerifiedIdentity,
  resetVerifiedIdentities,
  unconfirmedCandidateFor,
  verifiedIdentityFor,
} from '../tools/verifiedIdentity';
import { callerSaidTheName } from './callerSaidTheName';
import { runRequestSweep, type SweepFiler } from './sweepRunner';
import type { VoiceCallRecord } from './mediaStreamBridge';

const SURGERY_GREETING =
  'AGENT: Thank you for calling Azul Vision surgery coordination. All of our coordinators are currently ' +
  'assisting other patients, but I can take a message and they will follow up with you. All calls are being ' +
  'recorded for quality assurance purposes. How can I help you today?';
const TECH_GREETING =
  'AGENT: Thank you for calling Azul Vision clinical support. All of our technicians are currently ' +
  'assisting other patients, but I can take a message and they will follow up with you. All calls are being ' +
  'recorded for quality assurance purposes. How can I help you today?';
const OPTICAL_GREETING =
  'AGENT: Thank you for calling Azul Vision optical. All of our opticians are currently assisting other ' +
  'patients, but I can take a message and they will follow up with you. All calls are being recorded for ' +
  'quality assurance purposes. How can I help you today?';

function record(callSid: string, slug: string, transcript: string): VoiceCallRecord {
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript,
    toolEvents: [],
    agentTurns: 1,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 56_000,
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

/** The pre-context write, as voiceRuntime makes it: the record, certain: false. */
function onFileAs(callSid: string, firstName: string, lastName: string): void {
  rememberVerifiedIdentity(callSid, {
    firstName,
    lastName,
    dateOfBirth: '1950-03-04',
    certain: false,
  });
}

interface CorpusCall {
  sid: string;
  slug: 'surgery' | 'tech' | 'optical';
  record: [string, string];
  transcript: string;
}

const RESCUED: CorpusCall[] = [
  {
    sid: 'CA05286af5667d706e5e892ae1fc0892f7',
    slug: 'surgery',
    record: ['Rosa', 'Benchmark'],
    transcript:
      `${SURGERY_GREETING}\n` +
      "CALLER: I need to speak with my coordinator. It's been over a month and we have not been able to speak. " +
      "I can't get on the surgery schedule until we speak. Please get a coordinator back to me. This is Rosa " +
      'Benchmark, five five five, five five five, zero one zero zero. Thank you.',
  },
  {
    sid: 'CAc053cc03bcdb94e2a42793e713cc1ff5',
    slug: 'surgery',
    record: ['Teodoro', 'Cárdeno'],
    transcript:
      `${SURGERY_GREETING}\n` +
      'CALLER: Mi nombre es Teodoro Cárdeno, estoy llamando desde el viernes pasado, le pidieron referencias a ' +
      'mi aseguranza para mi cirugía de las cataratas. Por favor, llámenme. Quiero saber.',
  },
  {
    sid: 'CA940cad77a53b398258bfaa174c056e9c',
    slug: 'surgery',
    record: ['Walter', 'Ficticio'],
    transcript:
      `${SURGERY_GREETING}\n` +
      'CALLER: Yes, hello. This is Walter Ficticio, and I have received several texts from you folks about ' +
      "prescriptions and surgeries that I don't recall being involved with, and I want to clear up my record.\n" +
      'CALLER: Yes, hello. This is Walter Ficticio, and I have received several texts from you folks about ' +
      "prescriptions and surgeries that I don't recall being involved with, and I want to clear up my record. " +
      'Look forward to hearing from you. Thank you.\n' +
      'AGENT: Let me look into that for you right now. [interrupted]',
  },
  {
    sid: 'CA7c323ecc102568a418638b8ed307da8b',
    slug: 'surgery',
    // The record carries a middle initial nobody says.
    record: ['Vance Q', 'Ejemplo'],
    transcript:
      `${SURGERY_GREETING}\n` +
      "CALLER: Yes, my name is Vance Ejemplo. I'm scheduled for surgery and my doctor needs the surgeon's " +
      'phone number and fax number so they can send the release form. Call me back. My name is Vance Ejemplo. ' +
      'Thank you.\n' +
      'AGENT: Let me look up Vance Ejemplo. [interrupted]',
  },
  {
    sid: 'CA82885cc3e29c834e1d5d874b4c16f78e',
    slug: 'surgery',
    record: ['Jay', 'Muestra'],
    transcript:
      `${SURGERY_GREETING}\n` +
      'CALLER: Hi, this call is for Coordinator Placeholder. This is Jay Muestra. My phone number is five five ' +
      'five, five five five, zero one zero zero. Thank you.\n' +
      'AGENT: Nice to meet you, Jay. [interrupted]',
  },
  {
    sid: 'CA6d8692e2a1dfc3172142de9cd9f6311c',
    slug: 'surgery',
    record: ['Fred', 'Probeta'],
    transcript:
      `${SURGERY_GREETING}\n` +
      'CALLER: I wanted to speak to someone about my appointment on Wednesday.\n' +
      "CALLER: I wanted to speak to someone about my appointment on Wednesday, or Thursday, I'm sorry. Can you " +
      'please call me back? My name is Fred Probeta. Thank you.\n' +
      'AGENT: May I please have your date of birth, starting with the month, then the day, then the year? [interrupted]',
  },
  {
    sid: 'CA8019e3f55b7a3c7ea50ac953c44067c0',
    slug: 'tech',
    record: ['Susan', 'Testigo'],
    transcript:
      `${TECH_GREETING}\n` +
      "CALLER: My name is Susan Testigo. I've been requesting that you send a prescription for my eye drops to " +
      "the pharmacy so I can pick it up. This is my fourth request and I haven't heard anything from your " +
      'office either. Thank you.',
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
  resetStatedNames();
  resetVerifiedIdentities();
});

describe('the 2026-11-02 corpus: a whole message left in one breath, on the patient\'s own number', () => {
  for (const call of RESCUED) {
    it(`${call.sid} (${call.slug}) files under the record's name and says how it was matched`, async () => {
      onFileAs(call.sid, call.record[0], call.record[1]);
      // Precondition, the reason it was lost: the candidate is not an identity.
      expect(verifiedIdentityFor(call.sid)).toBeUndefined();

      const file = filer();
      const out = await runRequestSweep(record(call.sid, call.slug, call.transcript), file);

      expect(out).toEqual({ filed: true, ticketNumber: 'VA-SWEEP-1' });
      expect(file.calls).toHaveLength(1);
      expect(file.calls[0].patientFirstName).toBe(call.record[0]);
      expect(file.calls[0].patientLastName).toBe(call.record[1]);
      const note = String(file.calls[0].staffNote);
      expect(note).toMatch(/NAME FROM THE CALLING NUMBER'S PATIENT RECORD/);
      expect(note).toMatch(/no date of birth was confirmed/);
      expect(note).not.toMatch(/PATIENT NAME NOT CAPTURED/);
      // A candidate supplies the name and nothing else: no chart date of
      // birth, no validated patient, no office from history.
      expect(file.calls[0]).not.toHaveProperty('patientBirthYear');
      expect(file.calls[0]).not.toHaveProperty('patientBirthMonth');
      expect(file.calls[0]).not.toHaveProperty('validatedPatient');
      expect(file.calls[0]).not.toHaveProperty('locationOfLastVisit');
    });
  }
});

describe('the same day\'s correct refusals still file nothing', () => {
  it('CA1e9d6914e00df3220970fc83329e196b: the surname was transcribed differently from the record', async () => {
    const sid = 'CA1e9d6914e00df3220970fc83329e196b';
    onFileAs(sid, 'Nadia', 'Shimooka');
    const transcript =
      `${TECH_GREETING}\n` +
      'CALLER: My doctor recommended an eye drop and it is too expensive. Is there something cheaper he could ' +
      'prescribe? My name is Nadia Shimalka. Thank you so much. Bye-bye.';
    const file = filer();
    const out = await runRequestSweep(record(sid, 'tech', transcript), file);
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(file.calls).toHaveLength(0);
  });

  it('CA486d3e40706ba61ddea8fdf9391426e6: the caller never said the candidate\'s name', async () => {
    const sid = 'CA486d3e40706ba61ddea8fdf9391426e6';
    onFileAs(sid, 'Sandra', 'Ensayo');
    const transcript =
      `${TECH_GREETING}\n` +
      'CALLER: Hi, I am calling about my eye drops refill, the pharmacy says they never got it. Please call me back.';
    const file = filer();
    expect(await runRequestSweep(record(sid, 'tech', transcript), file)).toEqual({ filed: false, reason: 'no-name' });
    expect(file.calls).toHaveLength(0);
  });

  it('CA687ad8d4b61af8ebf3cf61c0d4005fe1: a first name alone is not the record', async () => {
    const sid = 'CA687ad8d4b61af8ebf3cf61c0d4005fe1';
    onFileAs(sid, 'Veronica', 'Simulada');
    const transcript =
      `${OPTICAL_GREETING}\n` +
      "CALLER: Hi, this is Veronica, I'm calling to see if my glasses are ready. Please call me back.";
    const file = filer();
    expect(await runRequestSweep(record(sid, 'optical', transcript), file)).toEqual({ filed: false, reason: 'no-name' });
    expect(file.calls).toHaveLength(0);
  });

  it('a caller who denies being the record is not filed under it (Codex P2, #421 round 3)', async () => {
    const sid = 'CA0000000000000000000000000000a008';
    onFileAs(sid, 'Mary', 'Smith');
    const transcript =
      `${SURGERY_GREETING}\n` +
      'CALLER: I am not Mary Smith, she is my mother. I need to reschedule my own surgery, please call me back.';
    const file = filer();
    expect(await runRequestSweep(record(sid, 'surgery', transcript), file)).toEqual({ filed: false, reason: 'no-name' });
  });

  it('a name split by a full stop is not the record (Codex P2, #421 round 2)', async () => {
    const sid = 'CA0000000000000000000000000000a007';
    onFileAs(sid, 'Mary', 'Smith');
    const transcript =
      `${SURGERY_GREETING}\n` +
      'CALLER: This is Mary Jones. Smith is my surgeon; please call me about my surgery. Thank you.';
    const file = filer();
    expect(await runRequestSweep(record(sid, 'surgery', transcript), file)).toEqual({ filed: false, reason: 'no-name' });
  });

  it('two people in one message do not add up to the record (Codex P2, #421)', async () => {
    const sid = 'CA0000000000000000000000000000a006';
    onFileAs(sid, 'Mary', 'Smith');
    const transcript =
      `${SURGERY_GREETING}\n` +
      'CALLER: This is John Smith. Please call Mary Jones about her surgery date. Thank you.';
    const file = filer();
    expect(await runRequestSweep(record(sid, 'surgery', transcript), file)).toEqual({ filed: false, reason: 'no-name' });
    expect(file.calls).toHaveLength(0);
  });

  it('a household member: the same surname and a different first name is not the record', async () => {
    const sid = 'CA0000000000000000000000000000a001';
    onFileAs(sid, 'Maria', 'Plantilla');
    const transcript =
      `${SURGERY_GREETING}\n` +
      'CALLER: This is Jorge Plantilla calling about my surgery date. Please call me back.';
    const file = filer();
    expect(await runRequestSweep(record(sid, 'surgery', transcript), file)).toEqual({ filed: false, reason: 'no-name' });
  });

  it('the AGENT saying the name is not the caller saying it', async () => {
    const sid = 'CA0000000000000000000000000000a002';
    onFileAs(sid, 'Rosa', 'Benchmark');
    const transcript =
      `${SURGERY_GREETING}\n` +
      'CALLER: I need to move my surgery date, please call me back.\n' +
      'AGENT: Am I speaking with Rosa Benchmark? [interrupted]';
    const file = filer();
    expect(await runRequestSweep(record(sid, 'surgery', transcript), file)).toEqual({ filed: false, reason: 'no-name' });
  });
});

describe('the sources that already outranked it still do', () => {
  it('a name a tool received wins over the calling number\'s record', async () => {
    const sid = 'CA0000000000000000000000000000a003';
    onFileAs(sid, 'Rosa', 'Benchmark');
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Lena', last_name: 'Prueba' });
    const transcript =
      `${SURGERY_GREETING}\nCALLER: This is Rosa Benchmark, I need to move my surgery date, please call me back.`;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const file = filer();
    await runRequestSweep(record(sid, 'surgery', transcript), file);
    expect(file.calls[0].patientFirstName).toBe('Lena');
    expect(String(file.calls[0].staffNote)).toMatch(/NAME AS THE CALLER GAVE IT/);
    // The candidate is not even consulted, so the log never claims it was used.
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/calling number belongs to/);
  });

  it('a certain match files as it always did, with no unconfirmed note', async () => {
    const sid = 'CA0000000000000000000000000000a004';
    rememberVerifiedIdentity(sid, { firstName: 'Rosa', lastName: 'Benchmark', certain: true });
    const transcript = `${SURGERY_GREETING}\nCALLER: I need to move my surgery date, please call me back.`;
    const file = filer();
    await runRequestSweep(record(sid, 'surgery', transcript), file);
    expect(file.calls[0].patientFirstName).toBe('Rosa');
    expect(String(file.calls[0].staffNote)).not.toMatch(/CALLING NUMBER'S PATIENT RECORD|AS THE CALLER GAVE IT/);
  });

  it('the candidate reader answers only for an unconfirmed entry', () => {
    const sid = 'CA0000000000000000000000000000a005';
    expect(unconfirmedCandidateFor(sid)).toBeUndefined();
    onFileAs(sid, 'Rosa', 'Benchmark');
    expect(unconfirmedCandidateFor(sid)).toEqual({ firstName: 'Rosa', lastName: 'Benchmark' });
    rememberVerifiedIdentity(sid, { firstName: 'Rosa', lastName: 'Benchmark', certain: true });
    expect(unconfirmedCandidateFor(sid)).toBeUndefined();
    expect(unconfirmedCandidateFor('unknown')).toBeUndefined();
  });
});

describe('callerSaidTheName', () => {
  const said = (caller: string, first: string, last: string) =>
    callerSaidTheName(`AGENT: Hello?\nCALLER: ${caller}`, first, last);

  it('reads whole words, folded the store\'s way', () => {
    expect(said('Mi nombre es teodoro CARDENO.', 'Teodoro', 'Cárdeno')).toBe(true);
    expect(said('This is Ana Garcia-Lopez.', 'Ana', 'Garcia Lopez')).toBe(true);
    expect(said("This is Ana O'Brien.", 'Ana', 'OBrien')).toBe(false);
    expect(said('This is Annabel Benchmarking.', 'Anna', 'Benchmark')).toBe(false);
  });

  it('the two halves must be ONE name, not two people (Codex P2, #421)', () => {
    expect(said('This is John Smith. Please call Mary Jones about her surgery.', 'Mary', 'Smith')).toBe(false);
    expect(said('Smith here, calling about Mary.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary, um, about Smith.', 'Mary', 'Smith')).toBe(false);
  });

  it('a sentence or turn boundary between the halves breaks the name (Codex P2, #421 round 2)', () => {
    expect(said('This is Mary Jones. Smith is my surgeon; please call me about my surgery.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary. Smith is my surgeon.', 'Mary', 'Smith')).toBe(false);
    expect(said('My name is Mary; Smith did my surgery.', 'Mary', 'Smith')).toBe(false);
    expect(
      callerSaidTheName('AGENT: Your first name?\nCALLER: Mary.\nAGENT: And your surgeon?\nCALLER: Smith is my surgeon.', 'Mary', 'Smith'),
    ).toBe(false);
    expect(
      callerSaidTheName('AGENT: Your name?\nCALLER: Mary\nCALLER: Smith is my surgeon', 'Mary', 'Smith'),
    ).toBe(false);
  });

  it('the surname must be a whole token, not a prefix of a longer surname (Codex P2, #421 round 4)', () => {
    // Smith on file, Smith-Jones said: a different surname.
    expect(said('This is Mary Smith-Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith - Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith\u2010Jones calling.', 'Mary', 'Smith')).toBe(false);
    expect(said("This is Mary Smith'son.", 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smithson.', 'Mary', 'Smith')).toBe(false);
    // Multi-word surname on file, said only in part.
    expect(said('This is Ana Garcia, calling about my surgery.', 'Ana', 'Garcia Lopez')).toBe(false);
    expect(said('This is Ana Garcia-Lo.', 'Ana', 'Garcia Lopez')).toBe(false);
    // Positive: an exact match, and a hyphenated surname said in full.
    expect(said('This is Mary Smith.', 'Mary', 'Smith')).toBe(true);
    expect(said('This is Mary Smith calling about my surgery.', 'Mary', 'Smith')).toBe(true);
    expect(said('This is Mary Smith-Jones.', 'Mary', 'Smith-Jones')).toBe(true);
    expect(said('My name is Mary Smith Jones.', 'Mary', 'Smith-Jones')).toBe(true);
    expect(said("This is Ana O'Brien.", 'Ana', "O'Brien")).toBe(true);
    // Review round 4: possessives the joiner misses, and hyphenated first names.
    expect(said("This is Mary Smith 's daughter.", 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith\u02BCs daughter.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Anne Smith.', 'Anne-Marie', 'Smith')).toBe(true);
    expect(said('This is Anne-Marie Smith.', 'Anne-Marie', 'Smith')).toBe(true);
    expect(said('This is Annemarie Smith.', 'Anne-Marie', 'Smith')).toBe(false);
    // Review round 4b: a dash is a clause break; a negator joined by a hyphen still negates.
    expect(said('This is Mary Smith \u2014 I need to reschedule.', 'Mary', 'Smith')).toBe(true);
    expect(said('This is Mary Smith\u2013I need to reschedule.', 'Mary', 'Smith')).toBe(true);
    expect(said('No-no soy Mary Smith, soy su hija.', 'Mary', 'Smith')).toBe(false);
  });

  it('a denial, a mention or a possessive is not an introduction (Codex P2, #421 round 3)', () => {
    expect(said('I am not Mary Smith, she is my mother. I need to reschedule my own surgery.', 'Mary', 'Smith')).toBe(false);
    expect(said("I'm not Mary Smith.", 'Mary', 'Smith')).toBe(false);
    expect(said('No soy Mary Smith, soy su hija.', 'Mary', 'Smith')).toBe(false);
    expect(said('This call is for Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said("This is Mary Smith's daughter.", 'Mary', 'Smith')).toBe(false);
    expect(said('Calling about my mother Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('Mary Smith.', 'Mary', 'Smith')).toBe(false);
  });

  it('the introductions callers actually use', () => {
    expect(said('Hi, this is Mary Smith.', 'Mary', 'Smith')).toBe(true);
    expect(said('My name is Mary Smith.', 'Mary', 'Smith')).toBe(true);
    expect(said("Hi, I'm Mary Smith, calling about my glasses.", 'Mary', 'Smith')).toBe(true);
    expect(said("It's Mary Smith.", 'Mary', 'Smith')).toBe(true);
    expect(said('Mi nombre es María Smith.', 'Maria', 'Smith')).toBe(true);
    expect(said('Me llamo María Smith.', 'Maria', 'Smith')).toBe(true);
    expect(said('Soy María Smith.', 'Maria', 'Smith')).toBe(true);
  });

  it('nothing may stand between the halves, so a spoken middle name fails safe', () => {
    expect(said('This is Mary Ann Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary J Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('Hi, this is Mary Smith, calling about my surgery.', 'Mary', 'Smith')).toBe(true);
  });

  it('cuts the first name to its first word and keeps the surname whole', () => {
    expect(said('This is Vance Ejemplo.', 'Vance Q', 'Ejemplo')).toBe(true);
    expect(said('This is Ana Garcia.', 'Ana', 'Garcia Lopez')).toBe(false);
  });

  it('a one-letter half never matches', () => {
    expect(said('This is J Benchmark.', 'J', 'Benchmark')).toBe(false);
  });

  it('reads caller lines only', () => {
    expect(
      callerSaidTheName('AGENT: Is this Rosa Benchmark?\nCALLER: I need my glasses.', 'Rosa', 'Benchmark'),
    ).toBe(false);
  });

  it('a quoted name is not a self-introduction, and conflicting identity fails safe (Codex P1, #421)', () => {
    expect(
      said('The message you left said this is Mary Smith. I am John Jones and need my own prescription refilled.', 'Mary', 'Smith'),
    ).toBe(false);
    expect(said('The message said this is Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am John Jones.', 'Mary', 'Smith')).toBe(false);
  });

  it('a later self-introduction or correction overrides an earlier one (Codex P1, #421)', () => {
    expect(said('This is Mary Smith. Sorry, I mean Mary Jones', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Sorry, I mean Mary Jones', 'Mary', 'Jones')).toBe(true);
    expect(callerSaidTheName('CALLER: This is Mary Smith.\nCALLER: My name is Ana Ruiz.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am calling about my glasses.', 'Mary', 'Smith')).toBe(true);
  });

  it('Codex round 2 on the P1 fix: punctuation, same-clause conflicts, casing, unrelated "I mean"', () => {
    expect(said('The message said: "This is Mary Smith."', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith and I am John Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith sorry I mean Mary Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith sorry I mean Mary Jones.', 'Mary', 'Jones')).toBe(true);
    expect(said('This is Mary Smith. I am john jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I mean my appointment is tomorrow.', 'Mary', 'Smith')).toBe(true);
    expect(said('this is mary smith, i am calling about my glasses, it is urgent.', 'Mary', 'Smith')).toBe(true);
  });
});
