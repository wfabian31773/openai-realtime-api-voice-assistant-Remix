/**
 * THE PATIENT'S NAME, TAKEN FROM THE RECORDING — v180.
 *
 * Operator ruling, 2026-10-29: "we should not be filing nameless tickets but
 * we also need to make sure that we did not get the name in transcripts nor
 * did we match the phone number to a patient on lookup." And 2026-11-05:
 * "remind me why we dont take the name from the transcripts, thought we had
 * agreed to do that".
 *
 * THE CORPUS: every queue-lane call of 2026-10-22..11-04 (13 days, 3,838
 * substantive calls) where the caller left one long message, the calling
 * number matched no record, and no ticket of any provenance exists — checked
 * by SID in the Support Center. 17 calls. Read by hand:
 *
 *   10 say the patient's first AND last name (6 of them a pharmacy, a clinic
 *      or a relative calling about somebody else) -> filed under it
 *    4 say one name word only                       -> still nothing filed
 *    3 say no name                                  -> still nothing filed
 *
 * Re-read 2026-11-05 with every capitalised word masked (Codex P1 on #431):
 * all 10 say the name as one name — first and last together, once with a
 * middle initial between. CA00483637f3eb17a94a4ac57a3c04a468 was first
 * counted among them and is not: its transcript has one name word after "the
 * patient name is".
 *
 * The model is faked here with the answer a correct reading gives; what this
 * pins is the CODE around it: a both-halves name the caller said files, with
 * the staff note saying where it came from, and anything else — a first name
 * alone, a name the caller never said, the agent's name, a placeholder, a
 * model that fails — files nothing, exactly as before. How often the real
 * model reads these right is the after-number, measured in production.
 * The SIDs are real; every name and number below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { runRequestSweep, type SweepFiler } from './sweepRunner';
import { nameFromTheRecording, nameWasSaidByTheCaller, NAME_INSTRUCTIONS, type NameAsker } from './nameFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';
import { readFileSync } from 'node:fs';

const GREETING: Record<string, string> = {
  surgery: 'AGENT: Thank you for calling Azul Vision surgery coordination. I can take a message and they will follow up with you. How can I help you today?',
  tech: 'AGENT: Thank you for calling Azul Vision clinical support. I can take a message and they will follow up with you. How can I help you today?',
  optical: 'AGENT: Thank you for calling Azul Vision optical. I can take a message and they will follow up with you. How can I help you today?',
};

function record(callSid: string, slug: string, callerSays: string): VoiceCallRecord {
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: `${GREETING[slug]}\nCALLER: ${callerSays}`,
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

const answers = (firstName: string | null, lastName: string | null): NameAsker => async () => ({ firstName, lastName });

interface Call { sid: string; slug: 'surgery' | 'tech' | 'optical'; says: string; model: [string | null, string | null] }

const NAMED: Call[] = [
  { sid: 'CA14a1aa67d7e411c287b23f626fd54143', slug: 'surgery', model: ['Testa', 'Ruiz'],
    says: 'Hola, quiero saber si la cirugía de Testa Ruiz es para el día veinte de octubre. Que me devuelvas la llamada, por favor. Gracias.' },
  { sid: 'CA27d8459380d334bb66c37fdf6b81485a', slug: 'optical', model: ['Testa', 'Lake'],
    says: "Hi, I'm Testa. My last name is spelled L A K E. You gave me new glasses three months ago and the arm broke off. Let me know if I can bring them in to get them fixed. Thank you." },
  { sid: 'CA2b956fd8f7a39bd6ac1de84a2635e213', slug: 'surgery', model: ['Testa', 'Vale'],
    says: "I need to speak with the doctor's office. My name is Testa D. Vale. I would like to speak with her about the procedure she requested for my eyes. Please have her call me. Bye-bye." },
  { sid: 'CA3c4b75ecfef4ed0a45c4435a523834fb', slug: 'surgery', model: ['Testa', 'Mendo'],
    says: "Hi, I'm calling for Testa Mendo. Your office sent her a surgery logistics ticket. Could you please call back at this number? This is our second call today. Thank you." },
  { sid: 'CA3d9442bd1ce325133a16a8c35ec4f3d9', slug: 'tech', model: ['Testo', 'de la Torre'],
    says: 'Hi, my name is Testa Nieto. My grandfather, Testo de la Torre, is coming in today, and I wanted to find out about eye drops for the discomfort after his shots. If you can give me a call back on my direct line.' },
  { sid: 'CA6db2967834bf4ed4e2fe277ccd65aba0', slug: 'tech', model: ['Testa', 'Quill'],
    says: 'Hi, I am calling from a clinic for patient Testa Quill. Date of birth 1 02 1950. We need a refill. Please call back. Thank you.' },
  { sid: 'CAb072fe66653e2d41cc20d13826c31c30', slug: 'tech', model: ['Testa', 'Brook'],
    says: 'Hi, calling from a pharmacy for the patient refills for the patient name Testa Brook, for ketorolac drops. Give us a callback. Thank you.' },
  { sid: 'CAe4f9a0980993c44f32dbf57ceea0a4ae', slug: 'tech', model: ['Testa', 'Fern'],
    says: "My name is Testa Fern. I'm calling to follow up on my prescription order that was supposed to be submitted to the pharmacy yesterday." },
  { sid: 'CA7fc9110d7a1ac76c107acfa0781de73a', slug: 'surgery', model: ['Testa', 'Cole'],
    says: "Hi, my name's Testa Cole. I'm looking at getting a clearance for my surgery, but I'm not sure if I'm supposed to get a chest X-ray. Can you give me a call back? Thank you." },
  { sid: 'CA78702382ce8e85cdd26c656b46f76277', slug: 'surgery', model: ['Testa', 'Ruiz'],
    says: 'Hola, Testa Ruiz tiene una cirugía mañana, pero no sabemos dónde va a ser ni a qué hora. Por favor, que me informen. Gracias.' },
];

const FIRST_NAME_ONLY: Call[] = [
  { sid: 'CA00483637f3eb17a94a4ac57a3c04a468', slug: 'tech', model: [null, 'Pharmon'],
    says: "Hi, I'm calling from a pharmacy for a refill for the patient, date of birth 1/02/1950, and the patient name is Pharmon, for timolol drops. Could you look into it and give me a callback? Thank you." },
  { sid: 'CA01b6ab7178b7e73c2782b1cd53af7eec', slug: 'surgery', model: ['Testa', null],
    says: 'Hi, yeah. My name is Testa. I have a cataract surgery appointment on the tenth and need to move it.' },
  { sid: 'CA6de7de53eb0cae521c7450a458cb16b6', slug: 'tech', model: ['Testa', null],
    says: "I'm calling from a pharmacy for a refill. The patient's name is Testa, date of birth 1 2 1950. The medication is cyclosporine. Thank you." },
  { sid: 'CA903a81b579a74c0a010e386b4f3d48a2', slug: 'surgery', model: ['Testa', null],
    says: "Hi, yeah, my name is Testa. I have surgery scheduled on the third, but I'm going to reschedule again. Can you call me? Thank you." },
];

const NO_NAME: Call[] = [
  { sid: 'CA2a8326566e64ef2e8dcb8333c295b244', slug: 'tech', model: [null, null],
    says: "I'm calling from a pharmacy in regards to a refill request for a patient." },
  { sid: 'CA2c39111f3c3e527bd63c3425f82c8347', slug: 'tech', model: [null, null],
    says: 'Hi, um, I want to see how much it is to get a contacts prescription. Can you give me a callback? Thank you.' },
  { sid: 'CA9ffbade0ae87bb6c79fa7a55efb449ad', slug: 'optical', model: [null, null],
    says: 'Hi, yes, um, I just wanted to know if my glasses were ready. My name' },
];

beforeEach(() => {
  resetVerifiedIdentities();
  resetStatedNames();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the corpus: 17 messages from numbers that match no record, 2026-10-22..11-04', () => {
  it.each(NAMED)('$sid — files under the patient name the caller said', async ({ sid, slug, says, model }) => {
    const f = filer();
    const out = await runRequestSweep(record(sid, slug, says), f, answers(...model));
    expect(out.filed).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].patientFirstName).toBe(model[0]);
    expect(f.calls[0].patientLastName).toBe(model[1]);
    expect(String(f.calls[0].staffNote)).toContain('NAME TAKEN FROM THE RECORDING');
    expect(String(f.calls[0].staffNote)).not.toContain('PATIENT NAME NOT CAPTURED');
  });

  it.each(FIRST_NAME_ONLY)('$sid — one name word alone files nothing', async ({ sid, slug, says, model }) => {
    const f = filer();
    const out = await runRequestSweep(record(sid, slug, says), f, answers(...model));
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(f.calls).toHaveLength(0);
  });

  it.each(NO_NAME)('$sid — no name files nothing', async ({ sid, slug, says, model }) => {
    const f = filer();
    const out = await runRequestSweep(record(sid, slug, says), f, answers(...model));
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(f.calls).toHaveLength(0);
  });

  it('without the model, every one of the 17 is skipped as no-name, as before v180', async () => {
    for (const c of [...NAMED, ...FIRST_NAME_ONLY, ...NO_NAME]) {
      const f = filer();
      expect(await runRequestSweep(record(c.sid, c.slug, c.says), f)).toEqual({ filed: false, reason: 'no-name' });
      expect(f.calls).toHaveLength(0);
    }
  });
});

describe('a name the caller did not say never reaches a ticket', () => {
  const sid = 'CA00000000000000000000000000000180';
  it('a name the model made up', async () => {
    const f = filer();
    const out = await runRequestSweep(record(sid, 'tech', 'Hi, I need a refill on my drops. Please call me back.'), f, answers('Testa', 'Invented'));
    expect(out.filed).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it('a surname only the AGENT said', async () => {
    const r = record(sid, 'tech', 'Yes. I need a refill on my drops, please call me back.');
    r.transcript = `AGENT: Am I speaking with Testa Agentsaid?\nCALLER: Yes. I need a refill on my drops, please call me back.`;
    const f = filer();
    expect((await runRequestSweep(r, f, answers('Testa', 'Agentsaid'))).filed).toBe(false);
  });
  it('one half said, the other not', () => {
    const t = 'CALLER: My name is Testa and I need a refill.';
    expect(nameWasSaidByTheCaller(t, { firstName: 'Testa', lastName: 'Nowhere' })).toBe(false);
  });
  it('a placeholder the ticketing app refuses', async () => {
    expect(await nameFromTheRecording('CALLER: This is the patient caller speaking.', answers('Patient', 'Caller'))).toBeNull();
  });
  it('a one-letter half', async () => {
    expect(await nameFromTheRecording('CALLER: This is Testa B speaking.', answers('Testa', 'B'))).toBeNull();
  });
  it('a model that throws or times out', async () => {
    const throws: NameAsker = async () => { throw new Error('timeout'); };
    expect(await nameFromTheRecording('CALLER: My name is Testa Cole.', throws)).toBeNull();
  });
  it('a spelled last name at the very end of the message still counts', () => {
    const t = 'CALLER: Please call me back, this is Testa, last name L A K E';
    expect(nameWasSaidByTheCaller(t, { firstName: 'Testa', lastName: 'Lake' })).toBe(true);
  });
  it('a digit in a name is not a name', async () => {
    expect(await nameFromTheRecording('CALLER: My name is Testa Cole, call me.', answers('Testa', 'Cole1'))).toBeNull();
  });
  it('accents and case do not matter; whole words do', () => {
    const t = 'CALLER: Habla Testa Núñez, por favor llámeme.';
    expect(nameWasSaidByTheCaller(t, { firstName: 'TESTA', lastName: 'Nunez' })).toBe(true);
    expect(nameWasSaidByTheCaller(t, { firstName: 'Test', lastName: 'Nunez' })).toBe(false);
  });
});

describe('said as ONE name, not two names crossed (Codex P1 on #431)', () => {
  const said = (t: string, firstName: string, lastName: string) => nameWasSaidByTheCaller(t, { firstName, lastName });

  it('CA3d9442bd1ce325133a16a8c35ec4f3d9 — the caller\'s first name with the patient\'s surname is refused, and nothing files', async () => {
    const c = NAMED.find((x) => x.sid === 'CA3d9442bd1ce325133a16a8c35ec4f3d9')!;
    expect(said(`CALLER: ${c.says}`, 'Testa', 'de la Torre')).toBe(false);
    const f = filer();
    expect((await runRequestSweep(record(c.sid, c.slug, c.says), f, answers('Testa', 'de la Torre'))).filed).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it('a clinic caller who gives her name and the patient\'s: either name passes, the two crossed do not', () => {
    const t = 'CALLER: This is Testa Smithy calling about my patient Restu Jonas, please call back.';
    expect(said(t, 'Restu', 'Jonas')).toBe(true);
    expect(said(t, 'Testa', 'Smithy')).toBe(true);
    expect(said(t, 'Testa', 'Jonas')).toBe(false);
    expect(said(t, 'Restu', 'Smithy')).toBe(false);
  });
  it('surname first counts ("Jonas, Restu")', () => {
    expect(said('CALLER: The patient is Jonas, Restu, date of birth 1 2 1950.', 'Restu', 'Jonas')).toBe(true);
  });
  it('the halves may be labelled', () => {
    expect(said('CALLER: First name Restu, last name Jonas.', 'Restu', 'Jonas')).toBe(true);
    expect(said('CALLER: My name is Restu and my last name is Jonas.', 'Restu', 'Jonas')).toBe(true);
    expect(said('CALLER: Mi nombre es Restu, mi apellido es Jonas.', 'Restu', 'Jonas')).toBe(true);
  });
  it('a middle initial may sit between; a middle name may not (nothing files, as before)', () => {
    expect(said('CALLER: My name is Restu D. Jonas, call me.', 'Restu', 'Jonas')).toBe(true);
    expect(said('CALLER: My name is Restu Marie Jonas, call me.', 'Restu', 'Jonas')).toBe(false);
  });
  it('a spelling of the first half may sit between', () => {
    expect(said('CALLER: This is Restu, R E S T U, Jonas.', 'Restu', 'Jonas')).toBe(true);
  });
  it('so may a spelling the transcriber misheard, which spells neither half', () => {
    expect(said('CALLER: This is Restu, R E Z D U, Jonas.', 'Restu', 'Jonas')).toBe(true);
  });
  it('a two-word half spelled as one run counts', () => {
    expect(said('CALLER: The patient is T E S T A R A E Jonas.', 'Testa Rae', 'Jonas')).toBe(true);
  });
  it('a name given across two of the caller\'s turns does not count', () => {
    const t = 'CALLER: My name is Restu.\nAGENT: And your last name?\nCALLER: Jonas. I need a refill.';
    expect(said(t, 'Restu', 'Jonas')).toBe(false);
  });
});

describe('a spelled name ends at a full stop (Codex P2 on #431)', () => {
  const said = (t: string, firstName: string, lastName: string) => nameWasSaidByTheCaller(t, { firstName, lastName });
  it('"L A K E. I need a refill" reads "lake", not only "lakei"', () => {
    expect(said('CALLER: My name is Jane, last name L A K E. I need a refill.', 'Jane', 'Lake')).toBe(true);
  });
  it('letters written with full stops still join ("L. A. K. E.")', () => {
    expect(said('CALLER: My name is Jane, last name L. A. K. E. Call me back.', 'Jane', 'Lake')).toBe(true);
  });
});

describe('the sweep still decides', () => {
  it('a caller who said nothing but their name is still identity-only', async () => {
    const f = filer();
    const out = await runRequestSweep(record('CA00000000000000000000000000000181', 'surgery', 'Testa Cole.'), f, answers('Testa', 'Cole'));
    expect(out).toEqual({ filed: false, reason: 'identity-only' });
    expect(f.calls).toHaveLength(0);
  });
  it('a bare introduction with "last name" and a spelling is still identity-only (Codex P2 on #431)', async () => {
    const f = filer();
    const out = await runRequestSweep(record('CA00000000000000000000000000000184', 'surgery', 'My name is Jane, last name L A K E.'), f, answers('Jane', 'Lake'));
    expect(out).toEqual({ filed: false, reason: 'identity-only' });
    expect(f.calls).toHaveLength(0);
  });
  it('the same in Spanish', async () => {
    const f = filer();
    const out = await runRequestSweep(record('CA00000000000000000000000000000185', 'surgery', 'Mi nombre es Testa, mi apellido es Cole.'), f, answers('Testa', 'Cole'));
    expect(out).toEqual({ filed: false, reason: 'identity-only' });
  });
  it('the same introduction with a request after it still files', async () => {
    const f = filer();
    const out = await runRequestSweep(record('CA00000000000000000000000000000186', 'surgery', 'My name is Jane, last name L A K E. I need my surgery moved to next week.'), f, answers('Jane', 'Lake'));
    expect(out.filed).toBe(true);
    expect(f.calls[0].patientLastName).toBe('Lake');
  });
  it('the model is asked only when the sweep would drop the request for having no name', async () => {
    const ask = vi.fn(answers('Testa', 'Cole'));
    const silent = record('CA00000000000000000000000000000182', 'surgery', '');
    silent.transcript = GREETING.surgery;
    await runRequestSweep(silent, filer(), ask);
    await runRequestSweep(record('CA00000000000000000000000000000183', 'pcp', 'My name is Testa Cole, call me.'), filer(), ask);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('the production wiring', () => {
  it('the runtime runs the production sweep, which passes the model', () => {
    const runtime = readFileSync(new URL('./voiceRuntime.ts', import.meta.url), 'utf8');
    expect(runtime).toMatch(/options\.sweepCall \?\? runProductionSweep/);
    const runner = readFileSync(new URL('./sweepRunner.ts', import.meta.url), 'utf8');
    expect(runner).toMatch(/runRequestSweep\(record, defaultFiler, askModelForThePatientName, lookUpTheCallingNumber\)/);
  });
  it('the model is told to take the patient, from the caller, and not to guess', () => {
    expect(NAME_INSTRUCTIONS).toMatch(/PATIENT/);
    expect(NAME_INSTRUCTIONS).toMatch(/not the caller's/);
    expect(NAME_INSTRUCTIONS).toMatch(/Never use a name only the AGENT said/);
    expect(NAME_INSTRUCTIONS).toMatch(/Do not guess/);
  });
});
