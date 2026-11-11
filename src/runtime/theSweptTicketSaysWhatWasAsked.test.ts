/**
 * THE SWEPT TICKET SAYS WHAT WAS ASKED — v201.
 *
 * Operator, 2026-11-11: tickets that say "reason not captured" leave staff
 * calling back just to find out what the call was about; this must be
 * resolved.
 *
 * THE CORPUS: the 36 agent tickets on optical, surgery, tech and records of
 * the Pacific business day 2026-11-10 whose subject was "Callback needed -
 * reason not captured", read call by call against `call_logs.tool_timeline`,
 * the transcripts and the Support Center's ticket and contact-entry rows.
 *
 *   32  no filing tool ran and nothing was drafted: the teardown sweep filed
 *       the placeholder after the caller hung up. Listed below by SID.
 *    3  a filing tool DID run, with a real request, on a second call — and
 *       the ticketing app consolidated it as a contact entry onto the ticket
 *       the caller's FIRST call had already swept with the placeholder, so the
 *       parent kept the placeholder and the subject. The fix is that first
 *       call's sweep: those three origin SIDs are in the corpus below.
 *    1  CAe8b15a8007b9f480ee33f904c9b2afe8 (records) — a classify tool HAD
 *       drafted a request; the sweep sent it, the app's records classifier
 *       routed it out of Medical Records, refused it for want of a patient
 *       name, and the sweep's own fallback refiled the placeholder. Not this
 *       path (something WAS drafted); recorded as still failing.
 *  (+1  CA955bc442447720ed535872bdf60e7c0b: the reader's list carried it, but
 *       its ticket never had the placeholder — the model wrote a short
 *       request. Not a "reason not captured" ticket.)
 *
 * Of the 35 sweep filings below, a correct reading of the call gives a
 * specific request on 30 and nothing specific on 5 (a returned missed call,
 * two "I want a person", a wrong number, and background noise). The 5 keep the
 * placeholder, which is then the truth.
 *
 * The model is faked here with the answer a correct reading gives. What this
 * pins is the CODE around it: a usable sentence becomes the description, the
 * staff note says where it came from, and anything else — no answer, a
 * vague answer, a phone number, a date of birth, a held name, a model that
 * fails — files exactly what main files. How often the real model reads these
 * right is the after-number, measured in production.
 *
 * The SIDs are real; every word below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities, rememberVerifiedIdentity } from '../tools/verifiedIdentity';
import { resetDraftedRequests, noteDraftedRequestFromArgs } from '../tools/draftedRequest';
import { runRequestSweep, type SweepFiler, type NumberLookup } from './sweepRunner';
import { SWEPT_TICKET_DESCRIPTION, REQUEST_FROM_RECORDING_NOTE } from './requestSweep';
import {
  requestFromTheRecording,
  usableRequest,
  REQUEST_INSTRUCTIONS,
  REQUEST_MAX_CHARS,
  type RequestAsker,
} from './requestFromTheRecording';
import { otherReasonFor } from '../tools/otherReason';
import type { VoiceCallRecord } from './mediaStreamBridge';
import { readFileSync } from 'node:fs';

type Lane = 'optical' | 'surgery' | 'tech' | 'records';

const GREETING: Record<Lane, string> = {
  optical: 'AGENT: Thank you for calling Azul Vision optical. I can take a message and they will follow up with you. Am I speaking with Testa?',
  surgery: 'AGENT: Thank you for calling Azul Vision surgery coordination. I can take a message and they will follow up with you. Am I speaking with Testa?',
  tech: 'AGENT: Thank you for calling Azul Vision clinical support. I can take a message and they will follow up with you. Am I speaking with Testa?',
  records: 'AGENT: Thank you for calling Azul Vision medical records. I can take the details and they will follow up with you. Am I speaking with Testa?',
};

function record(callSid: string, slug: Lane, callerLines: string[], tools: string[]): VoiceCallRecord {
  const lines = [GREETING[slug]];
  for (const said of callerLines) {
    lines.push(`CALLER: ${said}`);
    lines.push('AGENT: Thank you. Let me take a look at that for you. [interrupted]');
  }
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: lines.join('\n'),
    toolEvents: tools.map((name) => ({ name, ok: true, succeeded: true, ...(name === 'check_open_tickets' ? { foundOpenTicket: false } : {}) })),
    agentTurns: callerLines.length + 1,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 76_000,
  } as VoiceCallRecord;
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

const noName = async () => null;
/** Who the calling number belongs to — a synthetic one-person number, so the queue lanes' name gate passes. */
const onePerson: NumberLookup = async () => ({ firstName: 'Testa', lastName: 'Lake' });
const answers = (request: string | null): RequestAsker => async () => ({ request });

interface Row {
  sid: string; lane: Lane; tools: string[]; says: string[]; reads: string | null;
  /** In production this call's own sweep POST carried a taxonomy label, not the placeholder (a consolidated child). */
  mainLabel?: true;
}

const L = ['lookup_patient'];
const LC = ['lookup_patient', 'check_open_tickets'];

/** The 32 calls where nothing was drafted and a request was there to read — or not. */
const SWEPT: Row[] = [
  { sid: 'CAdd8ebea9bd4608b0a9c72754b932e90b', lane: 'records', tools: ['lookup_patient', 'set_spoken_language'],
    says: ['Sí.', 'Cambio de cita, por favor.'], reads: 'Wants to change an upcoming appointment.' },
  { sid: 'CAee30c6ea26b6b73a1af1e6833861bca7', lane: 'surgery', tools: [],
    says: ['Yes.', 'They want me to do one more test before my operation, do I really need that one too?'],
    reads: 'Asking whether another test is needed for pre-surgery clearance.' },
  { sid: 'CAb9c8f2334a0e28fe7814bd2f33b7974c', lane: 'tech', tools: L,
    says: ['Yes.', 'I see you tomorrow, do I have to pay something or is it zero for me?'],
    reads: 'Asking whether there is a copay or deductible for an upcoming visit.' },
  { sid: 'CA072d150d8ab021e01756daeeb79de3d9', lane: 'optical', tools: LC,
    says: ['Yes.', 'Check the status of my eyeglasses.', 'Are the eyeglasses ready?'], reads: 'Asking whether their eyeglasses order is ready.',
    // Its own sweep sent reason 20 with a label; the ticket's placeholder came from an earlier call (2026-11-09) it consolidated onto.
    mainLabel: true },
  { sid: 'CA5af119803153ec47f0aa20d386bf4db7', lane: 'optical', tools: ['set_spoken_language', 'lookup_patient'],
    says: ['Yes.', 'I need to confirm what time my appointment is.'], reads: 'Wants to confirm the time of an upcoming appointment.' },
  { sid: 'CA1930fb3ee6b75f42ae428dfdbd4ab808', lane: 'tech', tools: ['lookup_patient', 'check_patient_appointments'],
    says: ['Yes.', 'I am calling to confirm my appointment for today.'], reads: "Wants to confirm today's appointment." },
  { sid: 'CAd3035530750285743b39aca71bf5e969', lane: 'surgery', tools: ['lookup_patient', 'lookup_patient'],
    says: ['Yes.', 'Which specialist am I seeing at my appointment? I need the doctor I am seeing.'],
    reads: 'Asking which specialist they will see at an existing appointment.' },
  { sid: 'CA606c8b55545768633778dfe2c62d8463', lane: 'tech', tools: LC,
    says: ['Yes.', 'I need a copy of my glasses prescription so I can pick it up.'], reads: 'Wants a copy of their glasses prescription to pick up.' },
  { sid: 'CA2405b626235ca6abd63bdb37385570cf', lane: 'tech', tools: L,
    says: ['Yes.', 'When is my next appointment? I forgot the date.'], reads: 'Asking when their next appointment is.' },
  { sid: 'CAe67fa05526962840d12a5a8026910a78', lane: 'surgery', tools: L,
    says: ['Yes.', 'I want to confirm my appointment coming up and what it is for.'],
    reads: 'Wants to confirm an upcoming appointment and what it is for.' },
  { sid: 'CA47ec5ec32fe6d7e6cdafc18433d04166', lane: 'tech', tools: ['lookup_patient', 'check_patient_appointments'],
    says: ['Yes.', 'I am just confirming my appointment that is coming up.'], reads: 'Wants to confirm an upcoming appointment.' },
  { sid: 'CA9866028a713777fd6870455eeedecb4f', lane: 'records', tools: L,
    says: ['Yes.', 'Is the office going to be open for my appointment, because of the holiday?'],
    reads: 'Asking whether the office will be open for their appointment on the holiday.' },
  { sid: 'CA465fca1ebf4ec23b3f6cf5c6ce5ff66b', lane: 'tech', tools: [],
    says: ['Yes.', 'Can I eat and drink before my visit, or do I have to come in fasting?'],
    reads: 'Asking whether they can eat and drink before their visit.' },
  { sid: 'CA64ca158e932a9fd04dd72b9269ead3bc', lane: 'surgery', tools: L,
    says: ['Yes.', 'Which street is the office on, the one I am seeing them at?'], reads: 'Asking for the address of the office for an upcoming appointment.' },
  { sid: 'CAc0ccf9186530e83bdc466285899a04e1', lane: 'optical', tools: ['lookup_patient', 'resolve_location', 'check_patient_appointments'],
    says: ['Yes.', 'My doctor sent a referral for a diabetic eye screening and I want to know about it.'],
    reads: 'Asking about a referral for a diabetic eye screening.' },
  { sid: 'CA0b6ee5725795927167173326cea5fedc', lane: 'surgery', tools: L,
    says: ['Yes.', 'Nobody has called me yet about the date for my procedure.'], reads: 'Asking when their surgery is scheduled.' },
  { sid: 'CAaf74c556a87e6672ec4996168e7af421', lane: 'surgery', tools: L,
    says: ['Yes.', 'Which of your offices is closest to where I live?'], reads: 'Asking which office is closest to where they live.' },
  { sid: 'CAea44ce12645bc01e97adaea008f25580', lane: 'surgery', tools: L,
    says: ['Yes.', 'I want to make an appointment please.'], reads: 'Wants to book an appointment.' },
  { sid: 'CAc7e03692de805890935841eaceebe36f', lane: 'records', tools: [],
    says: ['His wife.', 'I need his medical records sent to his new eye doctor out of state, we moved, and I already sent a request online.'],
    reads: 'Wants medical records sent to a new eye doctor out of state.' },
  { sid: 'CA9dd7a3026f9428c18641be4345f5d7d7', lane: 'surgery', tools: ['lookup_patient', 'set_spoken_language'],
    says: ['Sí.', '¿Cuál es la dirección de la oficina para mi cita?'], reads: 'Asking for the office address for an upcoming appointment.' },
  { sid: 'CAa47d432991754eb5426210bec47cb879', lane: 'optical', tools: ['lookup_patient', 'set_spoken_language'],
    says: ['Sí.', 'Voy a llegar tarde a mi cita, como quince minutos.'], reads: 'Running late for an appointment today.' },
  { sid: 'CA5dfbd98c9b1bd5a8e9eb3d1ab4cf533c', lane: 'optical', tools: ['lookup_patient', 'set_spoken_language', 'check_open_tickets'],
    says: ['Sí.', '¿Ya están listos mis lentes para recoger?'], reads: 'Asking whether their glasses are ready for pickup.' },
  { sid: 'CA31402e228e12be00052383b695bb4877', lane: 'optical', tools: [],
    says: ['Yes.', 'I want to pay for my glasses order over the phone.'], reads: 'Wants to pay for a glasses order by phone.' },
  { sid: 'CA490c20938db31464e1dbd9aa49c13257', lane: 'surgery', tools: L,
    says: ['Yes.', 'I have a question for the nurse about my appointment coming up.'], reads: 'Has a question for the nurse about an upcoming appointment.' },
  { sid: 'CA3a31908da5aac9b2fe16b243b4ef34c5', lane: 'surgery', tools: L,
    says: ['Yes.', 'Where exactly is the office located?'], reads: 'Asking where the office is located.' },
  { sid: 'CA81f90d2e5e92b180329b281a9332af65', lane: 'optical', tools: L,
    says: ['Yes.', 'I need to make an appointment with the eye doctor, not for glasses.'], reads: 'Wants to book an eye doctor appointment, not an optical one.' },
  { sid: 'CA6751c45405e05c9561f4c5a437b963b3', lane: 'tech', tools: [],
    says: ['This is the pharmacy, we need to verify a prescription the doctor sent over.'],
    reads: 'A pharmacy wants to verify a prescription the doctor sent.' },
  // Five where a correct reading finds nothing specific: the placeholder stays, and is then the truth.
  { sid: 'CAa17c92aa3b89fc0f2f910748cc117d94', lane: 'surgery', tools: LC,
    says: ['Yes.', 'I got a call I could not answer and I am returning it.', 'No, thank you, I will try later.'],
    reads: 'Returning a missed call.' },
  { sid: 'CA932bf0027bca0d61d3d66abe06e56e7a', lane: 'surgery', tools: L,
    says: ['Yes.', 'Uh, I need to talk with somebody else.'], reads: 'Wants to speak with someone.' },
  { sid: 'CA9c17684c2dca1df1fe35bf4ed7927c92', lane: 'optical', tools: [],
    says: ['No.', 'I want to speak with a real person.'], reads: 'Wants to speak with a real person.' },
  { sid: 'CA42b0b849095bf2aef52f4c6a67f05266', lane: 'surgery', tools: L,
    says: ['Yes.', 'No, I made a mistake making the call, I did not recognize the number.'], reads: null },
];

/** The first call behind each of the three consolidated tickets. */
const ORIGINS: Row[] = [
  { sid: 'CA74c0ed734af14cdd0ffc2d67e02ab984', lane: 'surgery', tools: L,
    says: ['Yes.', 'Are they open? Are they open now?', 'Speak to a representative.'],
    reads: 'Asking whether the office is open and wants to speak with a representative.' },
  { sid: 'CAcc6d5e041197e0e11f4aca65c23931c7', lane: 'optical', tools: ['lookup_patient', 'resolve_location'],
    says: ['Yes.', 'I need the number for my clinic.', 'Repeat the number, please.'],
    reads: 'Asking for the phone number of their usual office.' },
  { sid: 'CAa25b4ef80d83f7dba8a47211eda009f4', lane: 'surgery', tools: ['set_spoken_language', 'lookup_patient', 'lookup_patient'],
    says: ['Necesito ayuda en español.', 'Quiero saber acerca de mi cita que tuve ahora en la clínica.'],
    reads: 'Wants to ask about the appointment they just had at the clinic.' },
];

/** Background noise, no request: the sweep filed it in production, and nothing usable is there to read. */
const NOTHING_SAID: Row = {
  sid: 'CAdaaa67e8bd8cc8c2d70103e6b71c7435', lane: 'tech', tools: ['set_spoken_language'],
  says: ['... upside downtown.', 'Huh? Hello?', 'Sí, gracias, de ocho a doce tenemos de todo, dos dólares, dos dólares.'],
  reads: null,
};

const SPECIFIC = [...SWEPT.slice(0, 27), ...ORIGINS];
const VAGUE = SWEPT.slice(27);

beforeEach(() => {
  resetVerifiedIdentities();
  resetStatedNames();
  resetDraftedRequests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function sweep(row: Row, ask: RequestAsker = answers(row.reads)) {
  const f = filer();
  const out = await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), f, noName, onePerson, ask);
  return { out, f };
}

describe('the corpus: the swept "reason not captured" tickets of 2026-11-10', () => {
  it('holds 32 swept calls (31 + the nothing-said control) and 3 consolidation origins', () => {
    expect(SWEPT).toHaveLength(31);
    expect(ORIGINS).toHaveLength(3);
    expect(SPECIFIC).toHaveLength(30);
    expect(VAGUE).toHaveLength(4);
    expect(new Set([...SWEPT, ...ORIGINS, NOTHING_SAID].map((r) => r.sid)).size).toBe(35);
  });

  it.each(SPECIFIC)('$sid ($lane) — the description is what the caller asked for', async (row) => {
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls).toHaveLength(1);
    const t = f.calls[0];
    expect(t.description).toBe(row.reads);
    expect(t.description).not.toBe(SWEPT_TICKET_DESCRIPTION);
    expect(String(t.staffNote)).toContain(REQUEST_FROM_RECORDING_NOTE);
    expect(String(t.staffNote)).toContain(String(row.reads));
  });

  it.each(VAGUE)('$sid ($lane) — nothing specific was asked, so the placeholder stays', async (row) => {
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect(String(f.calls[0].staffNote)).not.toContain(REQUEST_FROM_RECORDING_NOTE);
  });

  it(`${NOTHING_SAID.sid} — background noise: the placeholder stays`, async () => {
    const { out, f } = await sweep(NOTHING_SAID);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });
});

describe('main is unchanged where nothing is read', () => {
  it.each([...SWEPT, ...ORIGINS, NOTHING_SAID].filter((r) => !r.mainLabel))(
    '$sid — reproduces the production defect: main files the placeholder',
    async (row) => {
      const f = filer();
      await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), f, noName, onePerson);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
    },
  );

  it('CA072d150d8ab021e01756daeeb79de3d9 — main files a taxonomy label, as production did; the sentence now beats it', async () => {
    const row = SWEPT.find((r) => r.mainLabel)!;
    const main = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), main, noName, onePerson);
    expect(String(main.calls[0].description)).toMatch(/^Callback request about: /);
    expect((await sweep(row)).f.calls[0].description).toBe(row.reads);
  });

  it('runRequestSweep with no asker reads nothing: the description is what main files', async () => {
    const row = SPECIFIC[0];
    const f = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), f, noName, onePerson);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('a model that throws leaves the placeholder', async () => {
    const { f } = await sweep(SPECIFIC[1], async () => {
      throw new Error('timeout');
    });
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('a model that answers null, or nothing, leaves the placeholder', async () => {
    expect((await sweep(SPECIFIC[2], async () => null)).f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect((await sweep(SPECIFIC[2], async () => ({}))).f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('a refused sentence leaves exactly what main files, label included', async () => {
    const row = SWEPT.find((r) => r.mainLabel)!;
    const main = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), main, noName, onePerson);
    const now = (await sweep(row, answers('Wants a call back at 714 555 0100.'))).f;
    expect(now.calls[0]).toEqual(main.calls[0]);
  });

  it("the model's own drafted request still wins, and the recording is not read", async () => {
    const row = SPECIFIC[3];
    noteDraftedRequestFromArgs('classify_optical_request', { call_sid: row.sid, request_description: 'Glasses order status, drafted on the call.' });
    let asked = 0;
    const { f } = await sweep(row, async () => {
      asked += 1;
      return { request: 'Something else entirely, read later.' };
    });
    expect(asked).toBe(0);
    expect(f.calls[0].description).toBe('Glasses order status, drafted on the call.');
  });

  it('a caller who said nothing at all files nothing, and the recording is never read', async () => {
    let asked = 0;
    const f = filer();
    const r = record('CA00000000000000000000000000000001', 'tech', [], []);
    await runRequestSweep(r, f, noName, onePerson, async () => {
      asked += 1;
      return { request: 'Wants something.' };
    });
    expect(f.calls).toHaveLength(0);
    expect(asked).toBe(0);
  });
});

describe('a sentence that fails a check is dropped, never trimmed into shape', () => {
  const row = SPECIFIC[4];
  it.each([
    ['a phone number', 'Wants a call back at 714 555 0100 about glasses.'],
    ['a phone number with dashes', 'Wants a callback on 714-555-0100 about an order.'],
    ['a phone number read digit by digit', 'Wants a call back at 7 1 4 5 5 5 0 1 0 0 about glasses.'],
    ['a date of birth', 'Wants to confirm the appointment for a patient born 3/14/1958.'],
    ['a numeric date', 'Wants to move the appointment from 11/14 to next week.'],
    ['a year', 'Asking about records from 2019 being sent over.'],
    ['a month and day', 'Wants to reschedule the visit on November 14 to later.'],
    ['a spelled-out year', 'Asking about a patient from nineteen fifty eight records.'],
    ['spelled-out digits', 'Wants a call back at six one eight two about glasses.'],
    ['date-of-birth words', 'Confirming the date of birth on file before the visit.'],
    ['an email address', 'Wants the records emailed to testa at example.com today.'],
    ['an email address with @', 'Wants the records emailed to t@x.co for the new doctor.'],
    ['a street address', 'Asking whether the office at 123 Main Street is open.'],
    ['a titled name', 'Wants to know whether Dr. Quill will do the surgery.'],
    ['the model saying nothing was asked', 'Caller did not state a specific request.'],
    ['a no-topic sentence', 'Requesting a call back from someone.'],
    ['the placeholder itself', 'Callback request taken during your call.'],
    ['too short', 'Needs a fix'],
    ['fewer than three words', 'Prescriptions pending.'],
    ['too long', `Wants ${'help with the order and the frames and the lenses and '.repeat(4)}soon.`],
  ])('%s', async (_what, sentence) => {
    expect(usableRequest(sentence, ['Testa', 'Lake'])).toBeUndefined();
    const { f } = await sweep(row, answers(sentence));
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it("a patient name this call holds is dropped — the number's record, a verified identity, the candidate", async () => {
    // onePerson's name, as the number lookup gives it to the ticket.
    expect((await sweep(row, answers('Lake wants to know if the glasses are ready.'))).f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
    // A verified identity's name.
    resetVerifiedIdentities();
    rememberVerifiedIdentity(row.sid, { firstName: 'Quillon', lastName: 'Marsh', certain: true });
    expect((await sweep(row, answers('Asking whether Quillon can pick the glasses up.'))).f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('a clean sentence is kept, GSM-7 and a closing full stop added', () => {
    expect(usableRequest('Asking whether the contact lenses have arrived', [])).toBe('Asking whether the contact lenses have arrived.');
    expect(usableRequest('Wants the order’s status checked.', [])).toBe("Wants the order's status checked.");
    expect(usableRequest('Wants to move an 8:30 appointment to the afternoon.', [])).toBe('Wants to move an 8:30 appointment to the afternoon.');
  });

  it('the length bound is the constant', () => {
    expect(REQUEST_MAX_CHARS).toBeLessThanOrEqual(160);
    expect(usableRequest(`Wants ${'x'.repeat(REQUEST_MAX_CHARS)}`, [])).toBeUndefined();
  });
});

describe('Medical Records: the sentence never brings a reason with it', () => {
  it('a records description read from the recording travels with the catch-all reason', async () => {
    const row = SWEPT.find((r) => r.sid === 'CAc7e03692de805890935841eaceebe36f')!;
    const { f } = await sweep(row);
    const other = otherReasonFor(16)!;
    expect(f.calls[0].description).toBe(row.reads);
    expect(f.calls[0].requestTypeId).toBe(other.requestTypeId);
    expect(f.calls[0].requestReasonId).toBe(other.requestReasonId);
  });

  it('a records call where nothing is read keeps the reason main sends', async () => {
    const row = SWEPT.find((r) => r.sid === 'CAc7e03692de805890935841eaceebe36f')!;
    const main = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), main, noName, onePerson);
    const now = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), now, noName, onePerson, async () => null);
    expect(now.calls[0].requestReasonId).toBe(main.calls[0].requestReasonId);
    expect(now.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('off records, the reason main classifies is unchanged by the sentence', async () => {
    const row = SPECIFIC.find((r) => r.lane === 'optical')!;
    const main = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), main, noName, onePerson);
    const now = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), now, noName, onePerson, answers(row.reads));
    expect(now.calls[0].requestReasonId).toBe(main.calls[0].requestReasonId);
    expect(now.calls[0].requestTypeId).toBe(main.calls[0].requestTypeId);
  });
});

describe('the records lane gets the heard name (v180) too', () => {
  const sid = 'CAc7e03692de805890935841eaceebe36f';
  const says = ['His wife.', 'I need the medical records for Testa Lake sent to his new eye doctor out of state.'];
  const heard = (firstName: string | null, lastName: string | null) => async () => ({ firstName, lastName });

  it('a nameless records request files under the patient name the caller said, with the v180 note', async () => {
    const f = filer();
    await runRequestSweep(record(sid, 'records', says, []), f, heard('Testa', 'Lake'), onePerson, answers('Wants medical records sent to a new eye doctor out of state.'));
    expect(f.calls[0].patientFirstName).toBe('Testa');
    expect(f.calls[0].patientLastName).toBe('Lake');
    expect(String(f.calls[0].staffNote)).toContain('NAME TAKEN FROM THE RECORDING');
    expect(String(f.calls[0].staffNote)).not.toContain('PATIENT NAME NOT CAPTURED');
    // No date of birth, office or validated patient comes with a heard name.
    expect(f.calls[0]).not.toHaveProperty('patientBirthYear');
    expect(f.calls[0]).not.toHaveProperty('locationOfLastVisit');
    expect(f.calls[0]).not.toHaveProperty('validatedPatient');
    // And the sentence is still the description.
    expect(f.calls[0].description).toBe('Wants medical records sent to a new eye doctor out of state.');
  });

  it('a name the caller did not say files nameless, as main does', async () => {
    const f = filer();
    await runRequestSweep(record(sid, 'records', says, []), f, heard('Quillon', 'Marsh'));
    expect(f.calls[0]).not.toHaveProperty('patientFirstName');
    expect(String(f.calls[0].staffNote)).toContain('PATIENT NAME NOT CAPTURED');
  });

  it('a records call with a certain identity never asks', async () => {
    let asked = 0;
    rememberVerifiedIdentity(sid, { firstName: 'Testa', lastName: 'Lake', certain: true });
    const f = filer();
    await runRequestSweep(record(sid, 'records', says, []), f, async () => { asked += 1; return { firstName: 'Testa', lastName: 'Lake' }; });
    expect(asked).toBe(0);
    expect(f.calls[0].patientFirstName).toBe('Testa');
  });

  it('a name that would leave nothing but the name keeps the nameless filing — a name never costs the ticket', async () => {
    const f = filer();
    await runRequestSweep(record(sid, 'records', ['Testa Lake.', 'Testa Lake.'], []), f, heard('Testa', 'Lake'));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).not.toHaveProperty('patientFirstName');
  });

  it('off records the v180 path is unchanged: a named lane already has its name', async () => {
    let asked = 0;
    const row = SPECIFIC.find((r) => r.lane === 'tech')!;
    const f = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says, row.tools), f, async () => { asked += 1; return null; }, onePerson);
    // tech: no name was held, so v180 asked once (the no-name rung) and the number filed it.
    expect(asked).toBe(1);
    expect(f.calls[0].patientFirstName).toBe('Testa');
  });
});

describe('the reader itself', () => {
  it('never throws, and logs no sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(requestFromTheRecording('CALLER: x', async () => { throw new Error('boom'); })).resolves.toBeNull();
    await expect(requestFromTheRecording('CALLER: x', answers('Wants a call back at 714 555 0100.'))).resolves.toBeNull();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('714');
  });

  it('asks for one sentence with no names, dates of birth, numbers or addresses, and null when nothing was asked', () => {
    expect(REQUEST_INSTRUCTIONS).toMatch(/ONE short plain sentence/);
    expect(REQUEST_INSTRUCTIONS).toMatch(/names of people, dates of birth/);
    expect(REQUEST_INSTRUCTIONS).toMatch(/phone or fax numbers, email addresses, street addresses/);
    expect(REQUEST_INSTRUCTIONS).toMatch(/did not say what they wanted, return null/);
  });

  it('production passes the model; the runtime runs the production sweep', () => {
    const runner = readFileSync(new URL('./sweepRunner.ts', import.meta.url), 'utf8');
    expect(runner).toMatch(/runRequestSweep\(record, defaultFiler, askModelForThePatientName, lookUpTheCallingNumber, askModelForTheRequest\)/);
    const runtime = readFileSync(new URL('./voiceRuntime.ts', import.meta.url), 'utf8');
    expect(runtime).toMatch(/options\.sweepCall \?\? runProductionSweep/);
  });

  it('the off switch answers null without a model call', async () => {
    const prev = process.env.REQUEST_FROM_RECORDING_DISABLED;
    const key = process.env.OPENAI_API_KEY;
    process.env.REQUEST_FROM_RECORDING_DISABLED = '1';
    process.env.OPENAI_API_KEY = 'sk-test-not-used';
    try {
      const { askModelForTheRequest } = await import('./requestFromTheRecording');
      await expect(askModelForTheRequest('CALLER: Are my glasses ready?')).resolves.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.REQUEST_FROM_RECORDING_DISABLED; else process.env.REQUEST_FROM_RECORDING_DISABLED = prev;
      if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    }
  });
});
