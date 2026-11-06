/**
 * A NAMELESS MESSAGE FILES UNDER THE ONE PATIENT THE NUMBER BELONGS TO — v182.
 *
 * Operator ruling, 2026-10-29: "we should not be filing nameless tickets but
 * we also need to make sure that we did not get the name in transcripts nor
 * did we match the phone number to a patient on lookup." v171 built the half
 * where the caller said the record's name, v180 the half where the name is in
 * the transcript. This is the phone-match half, approved as filed on
 * 2026-11-06 ("going with proposed changes").
 *
 * THE CORPUS: optical, surgery and tech, 2026-10-23..11-05 (14 days). Calls of
 * 30 s or more with a heard caller, no ticket of any provenance (checked by SID
 * in the Support Center: 0 of 185), no open ticket found, and a pre-context
 * candidate stored. 119 of them came from a number that belongs to ONE person
 * in `patients_master` (108 of 168 numbers, matched by hash). The real
 * `decideSweep` run over those 119 transcripts: 80 skip as no-name, 20
 * identity-only, 18 caller-said-nothing, 1 already filed. Of the 80, about a
 * dozen are already filed by v171 or v180 (the caller said a name); the rest
 * file under the number's patient from this build.
 *
 * THE CALL THAT STARTED THIS IS NOT RESCUED, AND THIS FILE SAYS SO.
 * CA9d30160557cbba3a162768d4fc602b13 (a daughter's message about her mother's
 * eye drops) came from a number that belongs to TWO people. Standing
 * instruction 6: several people on a number, and we never pick between them.
 *
 * The SIDs are real; every name, number and word below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));
const findByPhone = vi.hoisted(() => vi.fn());
vi.mock('../services/patientVerification', () => ({ findByPhone }));

import { resetStatedNames } from '../tools/statedName';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from '../tools/verifiedIdentity';
import {
  lookUpTheCallingNumber,
  runRequestSweep,
  type NumberLookup,
  type SweepFiler,
} from './sweepRunner';
import { NUMBER_RECORD_NOTE } from './requestSweep';
import type { NameAsker } from './nameFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';
import { readFileSync } from 'node:fs';

type Slug = 'surgery' | 'tech' | 'optical' | 'records';

const LANE: Record<Slug, string> = {
  surgery: 'surgery coordination',
  tech: 'clinical support',
  optical: 'optical',
  records: 'medical records',
};
/** The named greeting asks the first name (v170); the generic one asks nothing about who it is. */
const greeting = (slug: Slug, named: boolean) =>
  `AGENT: Thank you for calling Azul Vision ${LANE[slug]}. All calls are being recorded for quality assurance purposes. ` +
  (named ? 'Am I speaking with Dana?' : 'How can I help you today?');

function record(callSid: string, slug: Slug, callerLines: string[], named = false): VoiceCallRecord {
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: [greeting(slug, named), ...callerLines.map((l) => `CALLER: ${l}`)].join('\n'),
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

const noName: NameAsker = async () => ({ firstName: null, lastName: null });
const ONE_PERSON = { firstName: 'Dana', lastName: 'Whitfield' };
function owner(answer: { firstName: string; lastName: string } | null): NumberLookup & { asked: number } {
  const fn = Object.assign(
    async () => {
      fn.asked += 1;
      return answer;
    },
    { asked: 0 },
  );
  return fn;
}

/** `named`: the real call's greeting asked "Am I speaking with <first name>?". */
interface Call { sid: string; slug: Slug; lines: string[]; named?: boolean }

/** One-person numbers, no name said, a request made. Each files under the number's patient. */
const RESCUED: Call[] = [
  { sid: 'CA248ca471058a1182bc67511cf9c74344', slug: 'tech',
    lines: ["I need to talk to the doctor's nurse about a prescription for eye drops. The manufacturer needs the doctor to sign a form."] },
  { sid: 'CA45f9ddc966e4c7fff20bff684b6d8187', slug: 'surgery',
    lines: ['Need to reschedule the surgery appointment. I have the ticket number.'] },
  { sid: 'CA486d3e40706ba61ddea8fdf9391426e6', slug: 'tech',
    lines: ['I picked up my serum tears on Saturday. Do I still use my other drops, and do I shake the vial?'] },
  { sid: 'CA07f5b8afa9f4a2f34caf10ec8220b239', slug: 'surgery', named: true,
    lines: ['Can you have her call me back today?', 'I would like to discuss which surgery would be best for me.'] },
  { sid: 'CA6f2efa169f372eb398a7f5287a3344f7', slug: 'tech',
    lines: ["I'm concerned about my eye drops.", 'They prescribed me another drop and I want to know if I can take all three at the same time.'] },
  { sid: 'CAd0258ed3c07bc2ed81581712afc26b7e', slug: 'tech',
    lines: ['Physical procedure.', 'Need eye drops.', "All of 'em."] },
  { sid: 'CA74713a16afdb2e865be3ea5ada8e2689', slug: 'tech', named: true,
    lines: ['I want to speak to a representative.'] },
  // A denial, then a request: the caller is not the person greeted, and the
  // ticket says the name is not confirmed.
  { sid: 'CA643068264f31ff60a0ce1f7ca2256fbc', slug: 'tech', named: true,
    lines: ['No.', 'Can I talk to a live representative?'] },
];

beforeEach(() => {
  resetVerifiedIdentities();
  resetStatedNames();
  findByPhone.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the corpus: no name said, the number belongs to one patient', () => {
  it.each(RESCUED)('$sid — files under the number\'s patient, unconfirmed', async ({ sid, slug, lines, named }) => {
    const f = filer();
    const lookup = owner(ONE_PERSON);
    const out = await runRequestSweep(record(sid, slug, lines, named), f, noName, lookup);
    expect(out.filed).toBe(true);
    expect(lookup.asked).toBe(1);
    expect(f.calls).toHaveLength(1);
    const ticket = f.calls[0];
    expect(ticket.patientFirstName).toBe('Dana');
    expect(ticket.patientLastName).toBe('Whitfield');
    expect(ticket.staffNote).toContain(NUMBER_RECORD_NOTE);
    // A name only. No chart date of birth, no office, no validated patient.
    expect(ticket).not.toHaveProperty('patientBirthYear');
    expect(ticket).not.toHaveProperty('locationOfLastVisit');
    expect(ticket).not.toHaveProperty('validatedPatient');
  });

  it('the same calls file nothing when the number is not looked up (the behaviour before v182)', async () => {
    for (const { sid, slug, lines, named } of RESCUED) {
      const f = filer();
      const out = await runRequestSweep(record(sid, slug, lines, named), f, noName);
      expect(out).toEqual({ filed: false, reason: 'no-name' });
      expect(f.calls).toHaveLength(0);
    }
  });
});

describe('what it leaves alone', () => {
  it('CA9d30160557cbba3a162768d4fc602b13 — a number that belongs to two people files nothing', async () => {
    const f = filer();
    const lookup = owner(null);
    const out = await runRequestSweep(
      record('CA9d30160557cbba3a162768d4fc602b13', 'tech', [
        'No.',
        "This is the daughter. The doctor gave her new eye drops and we'd like to switch from the old ones. She said to call about the change.",
      ], true),
      f, noName, lookup,
    );
    expect(lookup.asked).toBe(1);
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(f.calls).toHaveLength(0);
  });

  it('CA35bccf59df59422897f3e477e620bb7d — a caller who only said "No." is not a request; the number is never looked up', async () => {
    const f = filer();
    const lookup = owner(ONE_PERSON);
    const out = await runRequestSweep(record('CA35bccf59df59422897f3e477e620bb7d', 'optical', ['No.'], true), f, noName, lookup);
    expect(out.filed).toBe(false);
    expect(lookup.asked).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it('CA82885cc3e29c834e1d5d874b4c16f78e — a patient name the caller said wins over the number', async () => {
    const f = filer();
    const lookup = owner(ONE_PERSON);
    const heard: NameAsker = async () => ({ firstName: 'Testa', lastName: 'Ruiz' });
    const out = await runRequestSweep(
      record('CA82885cc3e29c834e1d5d874b4c16f78e', 'surgery', [
        'Hi, this call is for Testa Ruiz about her procedure. Please call me back. Thank you.',
      ]),
      f, heard, lookup,
    );
    expect(out.filed).toBe(true);
    expect(lookup.asked).toBe(0);
    expect(f.calls[0].patientFirstName).toBe('Testa');
    expect(f.calls[0].staffNote).not.toContain(NUMBER_RECORD_NOTE);
  });

  it("CA8019e3f55b7a3c7ea50ac953c44067c0 — the caller saying the record's name (v171) wins over the number", async () => {
    rememberVerifiedIdentity('CA8019e3f55b7a3c7ea50ac953c44067c0', {
      firstName: 'Dana', lastName: 'Whitfield', dateOfBirth: '1950-01-02', certain: false,
    });
    const f = filer();
    const lookup = owner(ONE_PERSON);
    const out = await runRequestSweep(
      record('CA8019e3f55b7a3c7ea50ac953c44067c0', 'tech', [
        "My name is Dana Whitfield. I've been requesting that you send a prescription for my eye drops to the pharmacy so I can pick it up. This is my fourth request. Thank you.",
      ]),
      f, noName, lookup,
    );
    expect(out.filed).toBe(true);
    expect(lookup.asked).toBe(0);
    expect(f.calls[0].staffNote).not.toContain(NUMBER_RECORD_NOTE);
  });

  it('the records lane files nameless as before (v73) and never looks the number up', async () => {
    const f = filer();
    const lookup = owner(ONE_PERSON);
    const out = await runRequestSweep(
      record('CA000000000000000000000000000182aa', 'records', ['I need a copy of my records sent to my new doctor.']),
      f, noName, lookup,
    );
    expect(out.filed).toBe(true);
    expect(lookup.asked).toBe(0);
    expect(f.calls[0]).not.toHaveProperty('patientFirstName');
  });

  it('a lookup that throws files nothing', async () => {
    const f = filer();
    const broken: NumberLookup = async () => {
      throw new Error('mirror down');
    };
    const out = await runRequestSweep(record(RESCUED[0].sid, 'tech', RESCUED[0].lines), f, noName, broken);
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('the production lookup', () => {
  it('names the patient only when the person base says the number is one person', async () => {
    findByPhone.mockResolvedValueOnce({
      verified: true, reason: 'match', candidates: 1, source: 'mirror',
      patient: { personId: 'p', personNbr: '1', firstName: ' Dana ', lastName: 'Whitfield', dob: '1950-01-02', hasMedicalRecord: true, language: null },
    });
    await expect(lookUpTheCallingNumber('+15555550100')).resolves.toEqual(ONE_PERSON);
    expect(findByPhone).toHaveBeenCalledWith('+15555550100');
  });

  it('answers nothing for several people, nobody, or an unreachable person base', async () => {
    findByPhone.mockResolvedValueOnce({ verified: false, reason: 'ambiguous', candidates: 2 });
    await expect(lookUpTheCallingNumber('+15555550100')).resolves.toBeNull();
    findByPhone.mockResolvedValueOnce({ verified: false, reason: 'no_match', candidates: 0 });
    await expect(lookUpTheCallingNumber('+15555550100')).resolves.toBeNull();
    findByPhone.mockResolvedValueOnce({ verified: false, reason: 'unavailable', candidates: 0 });
    await expect(lookUpTheCallingNumber('+15555550100')).resolves.toBeNull();
    // A patient on an unverified answer is still not one person on the number.
    findByPhone.mockResolvedValueOnce({
      verified: false, reason: 'ambiguous', candidates: 2,
      patient: { personId: 'p', personNbr: '1', firstName: 'Dana', lastName: 'Whitfield', dob: '1950-01-02', hasMedicalRecord: true, language: null },
    });
    await expect(lookUpTheCallingNumber('+15555550100')).resolves.toBeNull();
  });

  it('never passes a first name, so it cannot narrow several people down to one', async () => {
    findByPhone.mockResolvedValueOnce({ verified: false, reason: 'ambiguous', candidates: 2 });
    await lookUpTheCallingNumber('+15555550100');
    expect(findByPhone.mock.calls[0]).toHaveLength(1);
  });

  it('the runtime sweep passes it', () => {
    const runner = readFileSync(new URL('./sweepRunner.ts', import.meta.url), 'utf8');
    expect(runner).toMatch(/runRequestSweep\(record, defaultFiler, askModelForThePatientName, lookUpTheCallingNumber\)/);
    const runtime = readFileSync(new URL('./voiceRuntime.ts', import.meta.url), 'utf8');
    expect(runtime).toMatch(/options\.sweepCall \?\? runProductionSweep/);
  });
});
