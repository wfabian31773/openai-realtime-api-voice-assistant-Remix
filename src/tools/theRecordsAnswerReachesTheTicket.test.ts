/**
 * THE CALLER'S ANSWER REACHES THE RECORDS TICKET — v232.
 *
 * `file_records_ticket` asks how the requester wants the records (v188), then
 * where, each once, and files with the gap written when the answer does not
 * come back. The answer comes back only if the model puts it in
 * `delivery_method` / `deliver_to`, and on the records line it mostly does
 * not: it calls the tool again with its first arguments, word for word, while
 * the caller has just said "By fax." and read out a fax number the agent read
 * back and the caller confirmed. The spent ask then filed "Delivery: NOT
 * CAPTURED" and "Send to: NOT CAPTURED".
 *
 * THE CORPUS: the twelve records-lane tickets of the 2026-11-12/13 quality
 * pass whose verdict was "no delivery (caller gave it)", each by its real call
 * SID and ticket number. Every name, number and address below is a synthetic
 * stand-in in the shape of that call's delivery exchange (RULE THREE: the real
 * lines stay on disk). In every one of them the model's filing calls carried
 * neither `delivery_method` nor `deliver_to` (`tool_timeline` `supplied`), so
 * each case re-sends the same arguments, as the model did.
 *
 * The result, per ticket: the method now reaches the ticket on 11 of 12 (the
 * twelfth answered "Via portal", which is not a method, and still files NOT
 * CAPTURED). On 7 the destination was said before the model filed: a fax
 * number the agent read back and the caller confirmed lands on 5, and on 2
 * (a garbled readback, an email address) the ticket points the clerk at the
 * call transcript instead of saying NOT CAPTURED. On 4 the model filed before
 * the destination was said, so the tool now asks for it once; on 3 of those
 * the caller gave it later in the same call, modelled here after the ask, and
 * on 1 never.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { resetGateAttempts } from './gateAttempts';
import { resetVerifiedIdentities } from './verifiedIdentity';
import { DELIVERY_METHOD_QUESTION, DELIVERY_DESTINATION_QUESTION } from './recordsDeliveryMethod';
import {
  noteRecordsDelivery,
  readRecordsDelivery,
  recordsDeliveryHeard,
  resetRecordsDeliveries,
} from './spokenRecordsDelivery';

/** A provider's office asking for a mutual patient's records: off the clock, no form. */
const PROVIDER = {
  requester: "calling from Dr. Example's office",
  requester_type: 'provider',
  first_name: 'Testpatient',
  last_name: 'Example',
  date_of_birth: '01/02/1950',
  callback_number: '202-555-0142',
  request_description: 'Requesting the patient medical records for their upcoming visit',
};
/** The patient, declining the signing link: on the clock, the phone collects it. */
const PATIENT_NO_LINK = {
  requester: 'I am the patient',
  first_name: 'Testpatient',
  last_name: 'Example',
  date_of_birth: '01/02/1950',
  location: 'Synthetic Clinic',
  callback_number: '202-555-0142',
  request_description: 'I need a copy of my medical records',
  form_channel: 'declined',
};

type Out = Record<string, unknown>;
const filed = (n: string) => ({ success: true, ticketNumber: n }) as never;
async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

let clock = 1_800_000_000_000;
const laterTurn = () => {
  clock += 5_000;
};

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
  resetRecordsDeliveries();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

const METHOD_Q = `AGENT: ${DELIVERY_METHOD_QUESTION}`;

/**
 * One call: the model files with the same arguments every time, and between
 * filings the call's transcript grows by the lines given. Returns every tool
 * answer and the one payload that reached the ticketing app.
 */
async function replay(
  sid: string,
  ticket: string,
  steps: Array<string[] | 'file'>,
  args: Record<string, unknown> = PROVIDER,
): Promise<{ answers: Out[]; payload: Record<string, unknown> | undefined }> {
  const create = vi.spyOn(await client(), 'createTicket').mockResolvedValue(filed(ticket));
  const transcript: string[] = [
    'AGENT: Thank you for calling Azul Vision medical records.',
    'CALLER: I am calling to request records for a patient.',
  ];
  const answers: Out[] = [];
  for (const step of steps) {
    laterTurn();
    if (step === 'file') {
      answers.push((await runTool('file_records_ticket', { ...args, call_sid: sid })) as Out);
    } else {
      transcript.push(...step);
      noteRecordsDelivery(sid, transcript);
    }
  }
  const payload = create.mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined;
  return { answers, payload };
}

const description = (p: Record<string, unknown> | undefined) => String(p?.description ?? '');

describe('the corpus: twelve records tickets whose caller said how, 2026-11-12/13', () => {
  it('VA-84258 (CA28c8fd1a64c9d0d32c1e6a200f06da08): the method and the fax number in one answer, read back and confirmed', async () => {
    const { answers, payload } = await replay('CA28c8fd1a64c9d0d32c1e6a200f06da08', 'VA-84258', [
      'file',
      [METHOD_Q, 'CALLER: Hello? Are you still there?', `AGENT: Yes, I'm still here. ${DELIVERY_METHOD_QUESTION}`,
        'CALLER: We need them faxed to 2 0 2 5 5 5 oh 1 6 1.',
        'AGENT: Two zero two, five five five, zero one six one. Did I get that right?',
        "CALLER: Yes, that's correct."],
      'file',
    ]);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
    expect(answers[1].success, JSON.stringify(answers[1])).toBe(true);
    expect(payload?.deliveryMethodRequested).toBe('fax');
    expect(description(payload)).toContain('Delivery: by fax');
    expect(description(payload)).toContain('Send to: fax 202-555-0161 (read back to the caller and confirmed on the call)');
    expect(answers[1]).toMatchObject({ method_heard: true, send_to_heard: 'fax' });
    expect(answers[1].note_destination).toBeUndefined();
  });

  it('VA-84311 (CAc51a2529ba3af879d0d5096b3adfafcb): a fax number given, the readback garbled — the clerk is pointed at the transcript', async () => {
    const { answers, payload } = await replay('CAc51a2529ba3af879d0d5096b3adfafcb', 'VA-84311', [
      'file',
      [METHOD_Q, 'CALLER: By fax.', "AGENT: By fax. What's the fax number?", 'CALLER: 2', 'CALLER: 0 2 5 5 5 zero 1 6 2.',
        'AGENT: Two zero two five five five zero one six two two. Did I get that right? [interrupted]', 'CALLER: Not working.'],
      'file',
    ]);
    expect(answers[1].success, JSON.stringify(answers[1])).toBe(true);
    expect(description(payload)).toContain('Delivery: by fax');
    expect(description(payload)).toContain('Send to: given by the caller on the call, in the call transcript on this ticket');
    expect(description(payload)).not.toContain('Send to: NOT CAPTURED');
    expect(answers[1]).toMatchObject({ method_heard: true, send_to_heard: 'stated' });
    // The model is not told to ask where again: the caller already said.
    expect(answers[1].note_destination).toBeUndefined();
  });

  it('VA-84499 (CAe82269913472022d8aa00edc85f0c87f): fax, the number, read back, yes', async () => {
    const { answers, payload } = await replay('CAe82269913472022d8aa00edc85f0c87f', 'VA-84499', [
      'file',
      [METHOD_Q, 'CALLER: Fax.', "AGENT: Fax it is. What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 6 3.',
        'AGENT: Two zero two, five five five, zero one six three. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Send to: fax 202-555-0163 (read back to the caller and confirmed on the call)');
  });

  it('VA-84599 (CAeaec9cf1b705afc2b630a35d011d30bf): an email address spelled and confirmed earlier, then "Oh, by email."', async () => {
    const { answers, payload } = await replay('CAeaec9cf1b705afc2b630a35d011d30bf', 'VA-84599', [
      ["AGENT: What's the email address? Please spell it out for me, letter by letter.",
        'CALLER: T E S T at example dot com.', "AGENT: That's T E S T at example dot com. Did I get that right?", 'CALLER: Yes.'],
      'file',
      [METHOD_Q, 'CALLER: Oh, by email.'],
      'file',
    ]);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
    expect(answers[1].success, JSON.stringify(answers[1])).toBe(true);
    expect(payload?.deliveryMethodRequested).toBe('secure_email');
    expect(description(payload)).toContain('Delivery: by email');
    expect(description(payload)).toContain('Send to: given by the caller on the call');
  });

  it('VA-84605 (CAcc6d04536ce98393eecf3b94130a2516): "Via portal." is not a method, and still files NOT CAPTURED — correctly', async () => {
    const { answers, payload } = await replay('CAcc6d04536ce98393eecf3b94130a2516', 'VA-84605', [
      'file',
      [METHOD_Q, 'CALLER: Via portal.', "AGENT: Portal isn't one of the options I can set."],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Delivery: NOT CAPTURED');
    expect(payload?.deliveryMethodRequested).toBeUndefined();
    expect(answers[1].method_heard).toBeUndefined();
  });

  it('VA-84698 (CA120b727e81d18f82cbe8374f841991b3): "By fax." — the tool now asks the number; the caller disputes the readback, so it is not written as confirmed', async () => {
    const { answers, payload } = await replay('CA120b727e81d18f82cbe8374f841991b3', 'VA-84698', [
      'file',
      [METHOD_Q, 'CALLER: By fax.', 'CALLER: Fax.'],
      'file',
      [`AGENT: ${DELIVERY_DESTINATION_QUESTION.fax}`, 'CALLER: 2 0 2 5 5 5 zero 1 6 4.',
        'AGENT: Two zero two, five five five, zero one six four. Is that the one?', 'CALLER: No. 2 0 2 5 5 5 zero 1 6 4.'],
      'file',
    ]);
    expect(answers[1].success).toBe(false);
    expect(answers[1].missingFields).toEqual(['deliver_to']);
    expect(answers[1].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
    expect(answers[2].success, JSON.stringify(answers[2])).toBe(true);
    expect(description(payload)).toContain('Delivery: by fax');
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(description(payload)).not.toContain('202-555-0164');
  });

  it('VA-84715 (CAa974773f87a9643247a7dbbb0ac7c417): fax, the number in digits, read back in digits, yes', async () => {
    const { answers, payload } = await replay('CAa974773f87a9643247a7dbbb0ac7c417', 'VA-84715', [
      'file',
      [METHOD_Q, 'CALLER: By fax.', "AGENT: Fax is fine. What's the fax number?", 'CALLER: 2 0 2 5 5 5 oh 1 6 5.',
        "AGENT: That's 2 0 2 5 5 5 0 1 6 5. Did I get that right?", 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Send to: fax 202-555-0165 (read back to the caller and confirmed on the call)');
  });

  it('VA-84721 (CA1e8801491c999837badfcbbae8fc7993): "Fax" — the tool asks the number, the caller confirms it', async () => {
    const { answers, payload } = await replay('CA1e8801491c999837badfcbbae8fc7993', 'VA-84721', [
      'file',
      [`${METHOD_Q} [interrupted]`, 'CALLER: Fax'],
      'file',
      [`AGENT: ${DELIVERY_DESTINATION_QUESTION.fax}`, 'CALLER: 2 0 2 5 5 5 0 1 6 6.',
        'AGENT: You mentioned fax number 2 0 2 5 5 5 0 1 6 6 — is that where they should go?', 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[1].missingFields).toEqual(['deliver_to']);
    expect(answers[2].success, JSON.stringify(answers[2])).toBe(true);
    expect(description(payload)).toContain('Send to: fax 202-555-0166 (read back to the caller and confirmed on the call)');
  });

  it('VA-84999 (CA1d0b53c198254b1a7d989ab5d3a14e5a): a fax number given in pieces with a correction, then read back and confirmed', async () => {
    const { answers, payload } = await replay('CA1d0b53c198254b1a7d989ab5d3a14e5a', 'VA-84999', [
      'file',
      [METHOD_Q, 'CALLER: By fax.', "AGENT: Fax is good. What's the fax number?", 'CALLER: 2 0 2.', 'CALLER: 2 0 2 5 5 4.',
        "AGENT: Two zero two, five five four. That's six digits so far. What are the last four?",
        'CALLER: Uh, correction.', 'AGENT: Go ahead.', 'CALLER: 2 0 2 5 5 5.', 'CALLER: 2 0 2 5 5 5 0 1 6 7.',
        'AGENT: Two zero two, five five five, zero one six seven. Did I get that right?', 'CALLER: Correct, yes.'],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Send to: fax 202-555-0167 (read back to the caller and confirmed on the call)');
  });

  it('VA-85051 (CA9e9a07435f452151aae1560ac5cb736a): "By, via fax." and nothing more — the method reaches the ticket, the number is asked once', async () => {
    const { answers, payload } = await replay('CA9e9a07435f452151aae1560ac5cb736a', 'VA-85051', [
      'file',
      [METHOD_Q, 'CALLER: By, via fax.', 'AGENT: Fax it is.'],
      'file',
      [`AGENT: ${DELIVERY_DESTINATION_QUESTION.fax}`, 'CALLER: Um, can you repeat the ticket number?'],
      'file',
    ]);
    expect(answers[1].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
    expect(answers[2].success, JSON.stringify(answers[2])).toBe(true);
    expect(description(payload)).toContain('Delivery: by fax');
    expect(description(payload)).toContain('Send to: NOT CAPTURED');
  });

  it('VA-85175 (CA39d5c02e4266a28f9f29a530d361603b): "Through our portal or through fax." is fax', async () => {
    const { answers, payload } = await replay('CA39d5c02e4266a28f9f29a530d361603b', 'VA-85175', [
      'file',
      [METHOD_Q, 'CALLER: Through our portal or through fax.',
        "AGENT: Portal isn't one of the options I can enter. Does fax work?", 'CALLER: Yes.',
        "AGENT: Fax it is. What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 6 8.',
        'AGENT: Two zero two, five five five, zero one six eight. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Delivery: by fax');
    expect(description(payload)).toContain('Send to: fax 202-555-0168 (read back to the caller and confirmed on the call)');
  });

  it('VA-85323 (CAb69247af316295214ea9617c27863649): "Email." — the tool asks the address, the caller gives it and confirms the readback', async () => {
    const { answers, payload } = await replay('CAb69247af316295214ea9617c27863649', 'VA-85323', [
      'file',
      [METHOD_Q, 'CALLER: Email.'],
      'file',
      [`AGENT: ${DELIVERY_DESTINATION_QUESTION.email}`, 'CALLER: Records at example clinic dot com.',
        "AGENT: That's R E C O R D S at E X A M P L E C L I N I C dot com. Did I get that right?", 'CALLER: Correct.'],
      'file',
    ]);
    expect(answers[1].message).toBe(DELIVERY_DESTINATION_QUESTION.email);
    expect(answers[2].success, JSON.stringify(answers[2])).toBe(true);
    expect(payload?.deliveryMethodRequested).toBe('secure_email');
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(answers[2]).toMatchObject({ method_heard: true, send_to_heard: 'stated' });
  });
});

describe('what the model sends still wins, and only an answer to the question counts', () => {
  it('a method the model sent beats the transcript', async () => {
    const { payload } = await replay('CA' + 'a1'.repeat(16), 'VA-232-1', [
      [METHOD_Q, 'CALLER: Fax.'],
      'file',
    ], { ...PROVIDER, delivery_method: 'mail', deliver_to: '1 Example Way, Testville' });
    expect(payload?.deliveryMethodRequested).toBe('mail');
    expect(description(payload)).toContain('Send to: 1 Example Way, Testville');
  });

  it('a destination the model sent beats a confirmed fax readback', async () => {
    const { answers, payload } = await replay('CA' + 'a2'.repeat(16), 'VA-232-2', [
      [METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 7 0.',
        'AGENT: Two zero two, five five five, zero one seven zero. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ], { ...PROVIDER, deliver_to: '202-555-0171' });
    expect(description(payload)).toContain('Send to: 202-555-0171');
    expect(answers[0].send_to_heard).toBeUndefined();
  });

  it('a callback number read back is not a fax number: the tool still asks for the fax', async () => {
    const { answers } = await replay('CA' + 'a3'.repeat(16), 'VA-232-3', [
      [METHOD_Q, 'CALLER: Fax.', "AGENT: And what's the best number to reach you?", 'CALLER: 2 0 2 5 5 5 0 1 7 2.',
        'AGENT: Two zero two, five five five, zero one seven two. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[0].success).toBe(false);
    expect(answers[0].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
  });

  it('an email address given as a contact never stands in for the fax number', async () => {
    const { answers } = await replay('CA' + 'a4'.repeat(16), 'VA-232-4', [
      ["AGENT: What's the email address? Please spell it out.", 'CALLER: T E S T at example dot com.'],
      [METHOD_Q, 'CALLER: By fax.'],
      'file',
    ]);
    expect(answers[0].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
  });

  it('two methods, or a negation, read nothing: the one ask is spent and the ticket says NOT CAPTURED', async () => {
    for (const [i, answer] of ['CALLER: Fax or email is fine.', 'CALLER: Not fax, we do not have one.'].entries()) {
      resetGateAttempts();
      const { answers, payload } = await replay('CA' + `b${i}`.repeat(16), `VA-232-5${i}`, [
        'file',
        [METHOD_Q, answer],
        'file',
      ]);
      expect(answers[1].success, answer).toBe(true);
      expect(description(payload), answer).toContain('Delivery: NOT CAPTURED');
    }
  });

  it('a method volunteered before anyone asked is not read: the tool asks the question first', async () => {
    const { answers } = await replay('CA' + 'a6'.repeat(16), 'VA-232-6', [
      ['CALLER: Can you fax them over to our office?'],
      'file',
    ]);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
  });

  it('on the clock, a confirmed fax number satisfies the destination: only the dates are asked', async () => {
    const { answers } = await replay('CA' + 'a7'.repeat(16), 'VA-232-7', [
      [METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 7 3.',
        'AGENT: Two zero two, five five five, zero one seven three. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ], PATIENT_NO_LINK);
    expect(answers[0].success).toBe(false);
    expect(answers[0].missingFields).toEqual(['date_range']);
  });

  it('on the clock, a destination given but not read whole is not asked again either: only the dates are', async () => {
    const { answers } = await replay('CA' + 'a9'.repeat(16), 'VA-232-9', [
      [METHOD_Q, 'CALLER: By email.', `AGENT: ${DELIVERY_DESTINATION_QUESTION.email}`, 'CALLER: Test at example dot com.'],
      'file',
    ], PATIENT_NO_LINK);
    expect(answers[0].success).toBe(false);
    expect(answers[0].missingFields).toEqual(['date_range']);
  });

  it('a readback that names the callback is not the fax, however the agent got there', async () => {
    const { answers } = await replay('CA' + 'aa'.repeat(16), 'VA-232-10', [
      [METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: Hold on.',
        'AGENT: I have your callback as 2 0 2 5 5 5 0 1 7 5. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[0].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
  });

  it('a fax number given in the same breath as the method is not asked for again', async () => {
    const { answers, payload } = await replay('CA' + 'ab'.repeat(16), 'VA-232-11', [
      [METHOD_Q, 'CALLER: Fax, to 2 0 2 5 5 5 0 1 7 7.', 'AGENT: Thank you.'],
      'file',
    ]);
    expect(answers[0].success, JSON.stringify(answers[0])).toBe(true);
    expect(description(payload)).toContain('Send to: given by the caller on the call');
  });

  it('a number given to the email question is not a fax destination', async () => {
    const { answers } = await replay('CA' + 'ac'.repeat(16), 'VA-232-12', [
      [`AGENT: ${DELIVERY_DESTINATION_QUESTION.email}`, 'CALLER: 2 0 2 5 5 5 0 1 7 8.'],
      [METHOD_Q, 'CALLER: Fax.'],
      'file',
    ]);
    expect(answers[0].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
  });

  it('when the signing form collects delivery, a fax read back on the call does not replace it', async () => {
    const sid = 'CA' + 'ad'.repeat(16);
    noteRecordsDelivery(sid, [METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 7 9.',
      'AGENT: Two zero two, five five five, zero one seven nine. Did I get that right?', 'CALLER: Yes.']);
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValue(filed('VA-232-13'));
    const r = (await runTool('file_records_ticket', {
      ...PATIENT_NO_LINK, form_channel: 'sms', delivery_method: 'fax', call_sid: sid,
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(description(p)).toContain('Send to: on the signed form');
    expect(description(p)).not.toContain('202-555-0179');
  });

  it('a request whose signing link collects delivery never reads the transcript', async () => {
    const sid = 'CA' + 'a8'.repeat(16);
    noteRecordsDelivery(sid, [METHOD_Q, 'CALLER: Fax.']);
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValue(filed('VA-232-8'));
    vi.spyOn(await client(), 'sendRecordsIntakeLink').mockResolvedValue({ success: true } as never);
    const r = (await runTool('file_records_ticket', {
      ...PATIENT_NO_LINK, form_channel: 'sms', call_sid: sid,
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.method_heard).toBeUndefined();
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.deliveryMethodRequested).toBeUndefined();
  });
});

/**
 * A CONFIRMED FAX IS ONLY GOOD UNTIL THE CALLER REPLACES IT (Codex P2 on #482,
 * head d776a6d). A confirmed number written onto a records ticket as
 * "confirmed" after the caller gave another one sends a chart to the wrong
 * place. Anything later that puts the fax in question clears it, and the
 * ticket falls back to the transcript pointer until a new number is read back
 * and confirmed.
 */
describe('a later destination replaces a confirmed fax', () => {
  const CONFIRMED_OLD = [
    METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 8 1.',
    'AGENT: Two zero two, five five five, zero one eight one. Did I get that right?', 'CALLER: Yes.',
  ];

  it('a new fax number given after the confirmation is never filed as the old one', async () => {
    const { answers, payload } = await replay('CA' + 'd1'.repeat(16), 'VA-232-20', [
      [...CONFIRMED_OLD, 'AGENT: Is there anything else?',
        'CALLER: Actually, can you send it to a different fax? 2 0 2 5 5 5 0 1 9 9.', 'AGENT: Sure.'],
      'file',
    ]);
    expect(answers[0].success, JSON.stringify(answers[0])).toBe(true);
    expect(description(payload)).not.toContain('202-555-0181');
    expect(description(payload)).toContain('Send to: given by the caller on the call');
  });

  it('the new number, once read back and confirmed, is the one on the ticket', async () => {
    const { payload } = await replay('CA' + 'd2'.repeat(16), 'VA-232-21', [
      [...CONFIRMED_OLD, 'CALLER: Wait, that is the old fax. Use 2 0 2 5 5 5 0 1 9 8.',
        'AGENT: Two zero two, five five five, zero one nine eight. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ]);
    expect(description(payload)).toContain('Send to: fax 202-555-0198 (read back to the caller and confirmed on the call)');
    expect(description(payload)).not.toContain('202-555-0181');
  });

  it('a different number read back and not confirmed clears the old one', () => {
    const h = readRecordsDelivery([
      ...CONFIRMED_OLD, "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 9 7.',
      'AGENT: Two zero two, five five five, zero one nine seven. Did I get that right?', 'CALLER: Hold on.',
    ]);
    expect(h.fax).toBeUndefined();
    expect(h.given).toContain('fax');
  });

  it('a correction with no number clears it too', () => {
    expect(readRecordsDelivery([...CONFIRMED_OLD, 'CALLER: Sorry, that fax number is wrong.']).fax).toBeUndefined();
  });

  it('what does not put the fax in question leaves it: the same number again, a date of birth, a callback number', () => {
    expect(readRecordsDelivery([...CONFIRMED_OLD, 'CALLER: Yes, 2 0 2 5 5 5 0 1 8 1.']).fax).toBe('2025550181');
    expect(readRecordsDelivery([...CONFIRMED_OLD,
      'AGENT: May I please have the date of birth, starting with the month, then the day, then the year?',
      'CALLER: 0 1 0 2 1 9 5 0.']).fax).toBe('2025550181');
    expect(readRecordsDelivery([...CONFIRMED_OLD,
      "AGENT: And what's the best number to reach you?", 'CALLER: 2 0 2 5 5 5 0 1 4 2.']).fax).toBe('2025550181');
  });
});

describe('a caller who switches method after confirming a fax', () => {
  const CONFIRMED = [
    METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 8 2.',
    'AGENT: Two zero two, five five five, zero one eight two. Did I get that right?', 'CALLER: Yes.',
  ];

  it('answering the method question again with email: the fax is not used, even if the model still sends fax', async () => {
    for (const [i, method] of [undefined, 'fax'].entries()) {
      resetGateAttempts();
      const { payload } = await replay('CA' + `e${i}`.repeat(16), `VA-232-3${i}`, [
        [...CONFIRMED, METHOD_Q, 'CALLER: Email, please.'],
        'file',
      ], method ? { ...PROVIDER, delivery_method: method } : PROVIDER);
      expect(description(payload), String(method)).not.toContain('202-555-0182');
    }
  });

  it('"Actually, email it instead." with no question: the fax is not used, and the store no longer says fax', async () => {
    const lines = [...CONFIRMED, 'AGENT: Is there anything else?', 'CALLER: Actually, can you email it instead?'];
    const h = readRecordsDelivery(lines);
    expect(h.fax).toBeUndefined();
    expect(h.method).toBeUndefined();
    for (const [i, method] of [undefined, 'fax', 'email'].entries()) {
      resetGateAttempts();
      const { answers, payload } = await replay('CA' + `f${i}`.repeat(16), `VA-232-4${i}`, [
        lines,
        'file',
      ], method ? { ...PROVIDER, delivery_method: method } : PROVIDER);
      expect(JSON.stringify(answers[0]) + description(payload), String(method)).not.toContain('202-555-0182');
    }
  });
});

describe('the store', () => {
  it('a sentinel CallSid stores nothing', () => {
    noteRecordsDelivery('unknown', [METHOD_Q, 'CALLER: Fax.']);
    expect(recordsDeliveryHeard('unknown')).toBeUndefined();
  });

  it('is recomputed from the whole record: a later unreadable answer clears the method', () => {
    const sid = 'CA' + 'c1'.repeat(16);
    noteRecordsDelivery(sid, [METHOD_Q, 'CALLER: Fax.']);
    expect(recordsDeliveryHeard(sid)?.method).toBe('fax');
    noteRecordsDelivery(sid, [METHOD_Q, 'CALLER: Fax.', METHOD_Q, 'CALLER: Fax or email, either.']);
    expect(recordsDeliveryHeard(sid)).toBeUndefined();
  });

  it('a denied fax readback clears a fax confirmed before it', () => {
    const h = readRecordsDelivery([
      METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 7 4.',
      'AGENT: Two zero two, five five five, zero one seven four. Did I get that right?', 'CALLER: Yes.',
      'AGENT: Two zero two, five five five, zero one seven four. Is that the one?', 'CALLER: No, that is wrong.',
    ]);
    expect(h.fax).toBeUndefined();
    expect(h.given).toContain('fax');
  });

  it('a number read back after the caller chose email is not a fax number', () => {
    const h = readRecordsDelivery([
      METHOD_Q, 'CALLER: Email.', 'CALLER: 2 0 2 5 5 5 0 1 7 6.',
      'AGENT: Two zero two, five five five, zero one seven six. Did I get that right?', 'CALLER: Yes.',
    ]);
    expect(h.method).toBe('email');
    expect(h.fax).toBeUndefined();
    expect(h.given).not.toContain('fax');
  });

  it('a readback of eleven digits is a fax number only when the first is the country code', () => {
    const lines = (spoken: string) => [
      METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: Here it is.',
      `AGENT: ${spoken}. Did I get that right?`, 'CALLER: Yes.',
    ];
    expect(readRecordsDelivery(lines('One, two zero two, five five five, zero one eight zero')).fax).toBe('2025550180');
    expect(readRecordsDelivery(lines('Two zero two, five five five, zero one eight zero one')).fax).toBeUndefined();
  });

  it('expires with the call', () => {
    const sid = 'CA' + 'c2'.repeat(16);
    noteRecordsDelivery(sid, [METHOD_Q, 'CALLER: Fax.']);
    clock += 31 * 60_000;
    expect(recordsDeliveryHeard(sid)).toBeUndefined();
  });
});

describe('the wiring', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

  it('the bridge posts the whole record on every caller turn, beside the date of birth', () => {
    const bridge = src('../runtime/mediaStreamBridge.ts');
    expect(bridge).toMatch(/^import \{ noteRecordsDelivery \} from "\.\.\/tools\/spokenRecordsDelivery";$/m);
    expect(bridge).toContain('noteRecordsDelivery(this.deps.context.callSid, this.transcriptLog.lines);');
  });

  it('the records tool reads it through a static import (the Node 20 rule)', () => {
    const tool = src('./medicalRecordsTools.ts');
    expect(tool).toMatch(/^import \{ recordsDeliveryHeard, formatFax \} from '\.\/spokenRecordsDelivery';$/m);
    expect(tool).not.toMatch(/import\(['"]\.\/spokenRecordsDelivery['"]\)/);
  });
});
