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
  /** Why the #421 structural rule now refuses this call (fails safe). */
  structuralFlip?: string;
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
    structuralFlip: 'names another person ("Coordinator Placeholder") besides the caller',
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

      if (call.structuralFlip) {
        // Intentionally flipped by the structural rule: no ticket, as before v168.
        expect(out).toEqual({ filed: false, reason: 'no-name' });
        expect(file.calls).toHaveLength(0);
        return;
      }
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
    // The correction overrides Smith; it cannot be told from a correction of a
    // mention, so it never confirms either name (fails safe).
    expect(said('This is Mary Smith. Sorry, I mean Mary Jones', 'Mary', 'Jones')).toBe(false);
    expect(callerSaidTheName('CALLER: This is Mary Smith.\nCALLER: My name is Ana Ruiz.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am calling about my glasses.', 'Mary', 'Smith')).toBe(true);
  });

  it('Codex round 2 on the P1 fix: punctuation, same-clause conflicts, casing, unrelated "I mean"', () => {
    expect(said('The message said: "This is Mary Smith."', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith and I am John Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith sorry I mean Mary Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith sorry I mean Mary Jones.', 'Mary', 'Jones')).toBe(false);
    expect(said('This is Mary Smith. I am john jones.', 'Mary', 'Smith')).toBe(false);
    // Round 13: any correction cancels (fail-safe; a missed confirmation only falls back).
    expect(said('This is Mary Smith. I mean my appointment is tomorrow.', 'Mary', 'Smith')).toBe(false);
    expect(said('this is mary smith, i am calling about my glasses, it is urgent.', 'Mary', 'Smith')).toBe(true);
  });

  it('Codex round 3: quotes past a period, lowercase conflicts, corrections of a mention', () => {
    expect(said('The message said: "Hello. This is Mary Smith."', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. this is john jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Sorry about the message, I mean Mary Jones.', 'Mary', 'Jones')).toBe(false);
    expect(said('This is John Jones. I am calling about Mary Jones, sorry, I mean Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am completely out of medication.', 'Mary', 'Smith')).toBe(false); // allowlist: flipped ("completely" not a listed continuation; fails safe)
  });

  it('Codex round 4: a correction of a mention never confirms; lowercase names conflict', () => {
    expect(said('I am calling about Mary Jones. Sorry, I mean Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is John Jones calling about Mary Jones, sorry, I mean Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am fred jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Sorry, I mean emily jones.', 'Mary', 'Smith')).toBe(false);
  });

  it('Codex round 5: attribution after a quote or on another turn, particles, a leading "No"', () => {
    expect(said('"This is Mary Smith," the message said.', 'Mary', 'Smith')).toBe(false);
    expect(
      callerSaidTheName('CALLER: The message said:\nAGENT: What did it say?\nCALLER: This is Mary Smith.', 'Mary', 'Smith'),
    ).toBe(false);
    expect(said('This is Mary Smith. Sorry, I mean John de Vries.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. No I am John Jones.', 'Mary', 'Smith')).toBe(false);
  });

  it('Codex round 6: other written sources, -ly names, an agent turn, a later denial', () => {
    expect(said('The email reads: "This is Mary Smith."', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am kimberly jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Sorry, I mean beverly jones.', 'Mary', 'Smith')).toBe(false);
    expect(
      callerSaidTheName(
        'CALLER: My name is John Jones.\nAGENT: Are you calling about Mary Jones?\nCALLER: Sorry, I mean Mary Smith.',
        'Mary',
        'Smith',
      ),
    ).toBe(false);
    expect(said("This is Mary Smith. Actually, I'm not Mary Smith, I'm her daughter.", 'Mary', 'Smith')).toBe(false);
  });

  it('Codex round 7: -ed names, a correction that runs on, single quotes, possessive reporters', () => {
    expect(said('This is Mary Smith. Sorry, I mean mohammed jones.', 'Mary', 'Smith')).toBe(false);
    expect(said("This is John Jones. Sorry, I mean Mary Smith is the patient, I'm her son.", 'Mary', 'Smith')).toBe(false);
    expect(said("The screen shows 'This is Mary Smith'.", 'Mary', 'Smith')).toBe(false);
    expect(said("The voicemail's first words were this is Mary Smith.", 'Mary', 'Smith')).toBe(false);
  });

  it('Codex round 8: an introduction attributed to someone else, comma run-ons, initials', () => {
    expect(said('My mother introduced herself: my name is Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(
      said("This is John Jones. Sorry, I mean Mary Smith, my mother, is the patient. I'm her son.", 'Mary', 'Smith'),
    ).toBe(false);
    expect(said('This is Mary Smith. Sorry, I mean J. Jones.', 'Mary', 'Smith')).toBe(false);
  });

  it('Codex round 9: punctuated corrections, more reporting verbs, initials, a hedged denial', () => {
    expect(said('This is Mary Smith. Sorry, I mean, Mary Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('My mother would say this is Mary Smith when she answered the phone.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Actually, I am J. Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Sorry, I am not actually Mary Smith, I am her daughter.', 'Mary', 'Smith')).toBe(false);
  });

  it('Codex round 10: unlisted reporting verbs, filler inside a correction, initials A and I', () => {
    expect(said('My mother replied: this is Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('My mother always answers the phone with this is Mary Smith.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Sorry, I mean, um, Mary Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Actually, I am A. Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am a patient of Dr. Lee.', 'Mary', 'Smith')).toBe(false); // allowlist: flipped ("a" could be an initial; fails safe)
  });

  it('Codex round 11: a correction finished on the next turn, a quotative after a comma', () => {
    expect(
      callerSaidTheName('CALLER: This is Mary Smith. Sorry, I mean\nAGENT: Go ahead.\nCALLER: Mary Jones.', 'Mary', 'Smith'),
    ).toBe(false);
    expect(said('My mother always goes, this is Mary Smith.', 'Mary', 'Smith')).toBe(false);
  });

  it('Codex round 12: punctuation inside an introduction, half-name corrections, qualifiers, S., agent prompts', () => {
    expect(said('This is Mary Smith. My name is, John Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. Sorry, I mean my last name is Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. I am really John Jones.', 'Mary', 'Smith')).toBe(false);
    expect(said('This is Mary Smith. My name is S. Jones.', 'Mary', 'Smith')).toBe(false);
    expect(
      callerSaidTheName('AGENT: What exactly did the message say?\nCALLER: This is Mary Smith.', 'Mary', 'Smith'),
    ).toBe(false);
    // Structural rule: two introduction phrases => no match (intentional flip).
    expect(said('This is Mary Smith. My last name is Smith.', 'Mary', 'Smith')).toBe(false);
  });
});

describe("Codex round 13: corrections, half-name denials, agent read-aloud", () => {
  const T = (body: string) => body;
  it("any correction cancels", () => {
    expect(callerSaidTheName(T("CALLER: This is Mary Smith. Sorry, I mean the last name is Jones."), "Mary", "Smith")).toBe(false);
    expect(callerSaidTheName(T("CALLER: This is Mary Smith. Sorry, I mean this is her daughter."), "Mary", "Smith")).toBe(false);
  });
  it("a denied surname cancels", () => {
    expect(callerSaidTheName(T("CALLER: This is Mary Smith. My last name is not Smith but Jones."), "Mary", "Smith")).toBe(false);
  });
  it("an agent asking to read a voicemail aloud cancels", () => {
    expect(callerSaidTheName(T("AGENT: Please read the voicemail aloud.\nCALLER: This is Mary Smith."), "Mary", "Smith")).toBe(false);
  });
  it("a plain introduction still confirms", () => {
    expect(callerSaidTheName(T("CALLER: This is Mary Smith."), "Mary", "Smith")).toBe(true);
  });
});


describe("allowlist design (#421): round-13 cases and common-word names", () => {
  const said = (c: string, f: string, l: string) => callerSaidTheName(`AGENT: Hello?\nCALLER: ${c}`, f, l);
  it("the four Codex round-13 cases fail safe", () => {
    expect(callerSaidTheName("AGENT: Can you tell me exactly what she said?\nCALLER: This is Mary Smith.", "Mary", "Smith")).toBe(false);
    expect(said("This is Mary Smith. Sorry, my surname is not Smith but Jones.", "Mary", "Smith")).toBe(false);
    expect(said("This is Mary Smith. Sorry, that should be Mary Jones.", "Mary", "Smith")).toBe(false);
    expect(said("this is mary smith. i am an nguyen.", "Mary", "Smith")).toBe(false);
  });
  it("an adverb before another name is a conflict, not a continuation", () => {
    expect(said("This is Mary Smith. I am just John Jones.", "Mary", "Smith")).toBe(false);
  });
  it("matches case-insensitively and keeps names that are common words", () => {
    // Structural rule: in an all-caps line every word looks like a name (intentional flip).
    expect(said("THIS IS MARY SMITH.", "Mary", "Smith")).toBe(false);
    expect(said("this is mary smith.", "Mary", "Smith")).toBe(true);
    expect(said("hi this is will long, calling about my glasses.", "Will", "Long")).toBe(true);
    expect(said("My name is Rose Bush.", "Rose", "Bush")).toBe(true);
  });
});

describe("allowlist design, Codex round 15: third parties, other corrections", () => {
  it("fails safe", () => {
    const said = (c: string) => callerSaidTheName(`AGENT: Hello?\nCALLER: ${c}`, "Mary", "Smith");
    expect(said("This is Mary Smith, my mother. I am her daughter Ana, calling for my own prescription.")).toBe(false);
    expect(said("This is Mary Smith. Sorry, make that John Jones.")).toBe(false);
    expect(callerSaidTheName("AGENT: How does your mother introduce herself?\nCALLER: This is Mary Smith.", "Mary", "Smith")).toBe(false);
  });
});

describe("allowlist design, Codex round 16", () => {
  it("fails safe", () => {
    const said = (c: string, f = "Mary", l = "Smith") => callerSaidTheName(`AGENT: Hello?\nCALLER: ${c}`, f, l);
    expect(said("Mi nombre es Maria Garcia de la Cruz. Necesito cambiar mi cita.", "Maria", "Garcia")).toBe(false);
    expect(said("This is Mary Smith. Sorry, that was wrong; Jane Jones is my name. Please call me about my surgery.")).toBe(false);
    expect(callerSaidTheName("AGENT: How does the voicemail begin?\nCALLER: This is Mary Smith.", "Mary", "Smith")).toBe(false);
  });
});

describe("allowlist design, Codex round 17", () => {
  it("fails safe", () => {
    const said = (c: string, f = "Mary", l = "Smith") => callerSaidTheName(`AGENT: Hello?\nCALLER: ${c}`, f, l);
    expect(said("This is Mary Smith and I am your patient Jane Jones, calling to refill my eye drops.")).toBe(false);
    expect(callerSaidTheName("AGENT: Is this Mary Smith?\nCALLER: This is Mary Smith? No, Jane Jones here. I need my eye drops refilled.", "Mary", "Smith")).toBe(false);
    expect(said("Mi nombre es María García y López. Necesito cambiar mi cita.", "María", "García")).toBe(false);
    expect(said("This is Mary Smith and I am calling about my glasses.")).toBe(true);
  });
});

describe("allowlist design, Codex round 18", () => {
  it("fails safe", () => {
    expect(callerSaidTheName("AGENT: What do you hear when you dial that number?\nCALLER: This is Mary Smith.", "Mary", "Smith")).toBe(false);
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: This is Mary Smith. Sorry, Jane Jones here. I need to reschedule my appointment.", "Mary", "Smith")).toBe(false);
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: Mary Smith here.", "Mary", "Smith")).toBe(false);
  });
});

describe("allowlist design, Codex round 19", () => {
  it("fails safe", () => {
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: This is Mary Smith. Actually, Jane Jones. I need to reschedule my appointment.", "Mary", "Smith")).toBe(false);
    expect(callerSaidTheName("AGENT: Hello, what do you hear when you dial that number?\nCALLER: This is Mary Smith. I need to reschedule my own appointment.", "Mary", "Smith")).toBe(false);
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: When I dial your number, I hear this. This is Mary Smith. Can you help me book an appointment?", "Mary", "Smith")).toBe(false);
  });
});


describe("structural rule (GitHub Assistant block on #421)", () => {
  const said = (c: string, f: string, l: string) => callerSaidTheName(`AGENT: Hello?\nCALLER: ${c}`, f, l);
  it("the five blocking examples fail safe", () => {
    expect(said("La grabación comienza así. Mi nombre es María García. Necesito renovar mis gotas.", "María", "García")).toBe(false);
    expect(said("My name is Mary Smith. Excuse me, Jane Jones. I need my eye drops refilled.", "Mary", "Smith")).toBe(false);
    expect(said("Mi nombre es María García. Mejor dicho, Ana Ruiz. Necesito renovar mis gotas.", "María", "García")).toBe(false);
    expect(said("Soy María García. En realidad soy la paciente Ana Ruiz. Necesito renovar mis gotas.", "María", "García")).toBe(false);
    expect(said("This is Mary Smith. It is the patient Jane Jones speaking. I need my eye drops refilled.", "Mary", "Smith")).toBe(false);
  });
  it("lowercase second introductions and later-turn introductions fail safe", () => {
    expect(said("soy maría garcía. en realidad soy la paciente ana ruiz.", "María", "García")).toBe(false);
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: I need my eye drops refilled please.\nAGENT: Go ahead.\nCALLER: This is Mary Smith.", "Mary", "Smith")).toBe(false);
    expect(said("This is Mary Smith. Please have Jane call me back.", "Mary", "Smith")).toBe(false);
  });
  it("a plain introduction, said once or repeated, still confirms", () => {
    expect(said("Mi nombre es María García. Necesito renovar mis gotas.", "María", "García")).toBe(true);
    expect(said("My name is Mary Smith. Call me back on Monday. My name is Mary Smith.", "Mary", "Smith")).toBe(true);
  });
});

describe("structural rule, Codex round 1", () => {
  it("fails safe", () => {
    const c = (x: string) => callerSaidTheName(`AGENT: Hello?\n${x}`, "Mary", "Smith");
    expect(c("CALLER: Reading from the patient chart. This is Mary Smith.")).toBe(false);
    expect(c("CALLER: This is Mary Smith. Jane speaking, a nurse calling about this patient.")).toBe(false);
    expect(c('CALLER: "This is Mary Smith."\nCALLER: This is Mary Smith.')).toBe(false);
  });
});

describe("structural rule, Codex round 2", () => {
  it("fails safe", () => {
    const c = (x: string) => callerSaidTheName(`AGENT: Hello?\n${x}`, "Mary", "Smith");
    expect(c("CALLER: This is Mary Smith. Jane, the nurse speaking, calling about this patient.")).toBe(false);
    expect(c("CALLER: Transcribing a patient request. My name is Mary Smith. Please refill my eye drops.")).toBe(false);
  });
});

describe("structural rule, Codex round 3", () => {
  it("fails safe", () => {
    const c = (x: string) => callerSaidTheName(`AGENT: Hello?\n${x}`, "Mary", "Smith");
    expect(c("CALLER: I hear the following when I call. This is Mary Smith. Please leave your number.")).toBe(false);
    expect(c("CALLER: this is mary smith. apologies, jane jones. i need my eye drops refilled.")).toBe(false);
    expect(c("CALLER: This is Mary Smith. Jane is speaking for the patient. Please refill the eye drops.")).toBe(false);
  });
});


/**
 * THE LAST ROUND THIS READER TAKES — 2026-11-03, taken over from the Codex
 * fix loop on the operator's word. Three open findings close here, and the
 * class they belong to (a caller who gives their name and then talks about
 * somebody else) is priced rather than chased further.
 *
 * MEASURED, queue lanes, 2026-10-20..11-02, calls the pre-context recognised
 * and that left no ticket (the only calls this sweep path can touch): 261.
 * 32 carried a self-introduction; 2 of those also mentioned "my <relative>"
 * or "my patient"; 0 of the 11 single-turn message-and-hang-up calls the PR
 * is for did. A relative word anywhere in the caller's words now fails safe,
 * possessive and plural included, and a speaker declaration is read without
 * regard to case. A further phrasing of the same class is declined with that
 * number rather than added as one more cue.
 */
describe("closing round: relatives in any form, and speakers in any case", () => {
  const c = (x: string) => callerSaidTheName(`AGENT: Hello?\nCALLER: ${x}`, "Mary", "Smith");
  it("a grandchild, a possessive relative, or a Spanish relative fails safe", () => {
    expect(c("This is Mary Smith. Calling about my granddaughter's eye drops. Please call me back.")).toBe(false);
    expect(c("This is Mary Smith. Calling for my grandson to refill eye drops.")).toBe(false);
    expect(c("This is Mary Smith. Calling about my mother's appointment.")).toBe(false);
    expect(c("This is Mary Smith. My kids' appointments need to move.")).toBe(false);
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: Soy María García. Llamo por mi nieta, necesita sus gotas.", "María", "García")).toBe(false);
  });
  it("a speaker declared in lower case fails safe", () => {
    expect(c("This is Mary Smith. jane is speaking for the patient. please refill the eye drops.")).toBe(false);
    expect(c("this is mary smith. jane is calling for the patient.")).toBe(false);
  });
  it("the caller's own request still confirms", () => {
    expect(c("This is Mary Smith. I need my eye drops refilled. Please call me back.")).toBe(true);
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: Mi nombre es María García. Necesito renovar mis gotas.", "María", "García")).toBe(true);
  });
});

describe("closing round: the v170 named greeting, and a name that is also a relative word", () => {
  // v170 puts the record's first name in the greeting itself. A caller who
  // answers it and leaves the message must still confirm, and the greeting's
  // name must not read as a third party.
  const NAMED = (first: string) =>
    'AGENT: Thank you for calling Azul Vision surgery coordination. All of our coordinators are currently ' +
    'assisting other patients, but I can take a message and they will follow up with you. All calls are being ' +
    `recorded for quality assurance purposes. Am I speaking with ${first}?`;
  it("a yes and a plain introduction after the named greeting confirms", () => {
    expect(callerSaidTheName(`${NAMED("Mary")}\nCALLER: Yes, this is Mary Smith. I need my eye drops refilled. Please call me back.`, "Mary", "Smith")).toBe(true);
  });
  it("a no after the named greeting does not", () => {
    expect(callerSaidTheName(`${NAMED("Mary")}\nCALLER: No, this is Jane Smith. I need my eye drops refilled.`, "Mary", "Smith")).toBe(false);
  });
  it("a record named Ella or Tia is not a relative of itself", () => {
    expect(callerSaidTheName(`${NAMED("Ella")}\nCALLER: Yes, this is Ella Smith. I need my eye drops refilled.`, "Ella", "Smith")).toBe(true);
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: Soy Tia García. Necesito renovar mis gotas.", "Tia", "García")).toBe(true);
  });
  it("but the same word used for somebody else still fails safe", () => {
    expect(callerSaidTheName("AGENT: Hello?\nCALLER: Soy María García. Llamo por mi tía, necesita sus gotas.", "María", "García")).toBe(false);
  });
});
