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
 * CAPTURED). On 7 the destination was said before the model filed, and the
 * ticket points the clerk at the recording instead of saying NOT CAPTURED. On
 * 4 the model filed before the destination was said, so the tool now asks for
 * it once; on 3 of those the caller gave it later in the same call, modelled
 * here after the ask, and on 1 never.
 *
 * NO DESTINATION IS READ FROM THE TRANSCRIPT. The first version wrote a fax
 * number the agent read back and the caller confirmed on 6 of these tickets
 * (VA-84258, VA-84499, VA-84715, VA-84721, VA-84999, VA-85175). It drew three
 * review rounds on #482, each a way to file a number the caller had taken
 * back, and was withdrawn on the #476 ruling ("Shrink the reader"). Those 6
 * now carry the pointer, and every case below asserts no number from the
 * transcript reaches the ticket.
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
  it('VA-84258 (CA28c8fd1a64c9d0d32c1e6a200f06da08): the method and the fax number in one answer: the ticket points at the recording', async () => {
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
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(JSON.stringify(payload)).not.toContain('202-555-0161');
    expect(JSON.stringify(payload)).not.toContain('2025550161');
    expect(answers[1]).toMatchObject({ method_heard: true, send_to_heard: 'stated' });
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

  it('VA-84499 (CAe82269913472022d8aa00edc85f0c87f): fax, the number, read back, yes: the method, the pointer, no number', async () => {
    const { answers, payload } = await replay('CAe82269913472022d8aa00edc85f0c87f', 'VA-84499', [
      'file',
      [METHOD_Q, 'CALLER: Fax.', "AGENT: Fax it is. What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 6 3.',
        'AGENT: Two zero two, five five five, zero one six three. Did I get that right?', 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(JSON.stringify(payload)).not.toContain('202-555-0163');
    expect(JSON.stringify(payload)).not.toContain('2025550163');
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

  it('VA-84715 (CAa974773f87a9643247a7dbbb0ac7c417): fax, the number in digits, read back in digits, yes: the pointer, no number', async () => {
    const { answers, payload } = await replay('CAa974773f87a9643247a7dbbb0ac7c417', 'VA-84715', [
      'file',
      [METHOD_Q, 'CALLER: By fax.', "AGENT: Fax is fine. What's the fax number?", 'CALLER: 2 0 2 5 5 5 oh 1 6 5.',
        "AGENT: That's 2 0 2 5 5 5 0 1 6 5. Did I get that right?", 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(JSON.stringify(payload)).not.toContain('202-555-0165');
    expect(JSON.stringify(payload)).not.toContain('2025550165');
  });

  it('VA-84721 (CA1e8801491c999837badfcbbae8fc7993): "Fax" — the tool asks the number once, the caller gives it: the pointer, no number', async () => {
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
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(JSON.stringify(payload)).not.toContain('202-555-0166');
    expect(JSON.stringify(payload)).not.toContain('2025550166');
  });

  it('VA-84999 (CA1d0b53c198254b1a7d989ab5d3a14e5a): a fax number given in pieces with a correction, then read back: the pointer, no number', async () => {
    const { answers, payload } = await replay('CA1d0b53c198254b1a7d989ab5d3a14e5a', 'VA-84999', [
      'file',
      [METHOD_Q, 'CALLER: By fax.', "AGENT: Fax is good. What's the fax number?", 'CALLER: 2 0 2.', 'CALLER: 2 0 2 5 5 4.',
        "AGENT: Two zero two, five five four. That's six digits so far. What are the last four?",
        'CALLER: Uh, correction.', 'AGENT: Go ahead.', 'CALLER: 2 0 2 5 5 5.', 'CALLER: 2 0 2 5 5 5 0 1 6 7.',
        'AGENT: Two zero two, five five five, zero one six seven. Did I get that right?', 'CALLER: Correct, yes.'],
      'file',
    ]);
    expect(answers[1].success).toBe(true);
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(JSON.stringify(payload)).not.toContain('202-555-0167');
    expect(JSON.stringify(payload)).not.toContain('2025550167');
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

  it('VA-85175 (CA39d5c02e4266a28f9f29a530d361603b): "Through our portal or through fax." is fax, and the number is not read', async () => {
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
    expect(description(payload)).toContain('Send to: given by the caller on the call');
    expect(JSON.stringify(payload)).not.toContain('202-555-0168');
    expect(JSON.stringify(payload)).not.toContain('2025550168');
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

  it('a destination the model sent is the one on the ticket, whatever was read back on the call', async () => {
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

  it('only the delivery question opens a window: "Did you send the authorization by fax or email?" answered "Fax." is not a method', async () => {
    const lines = ['AGENT: Did you send the authorization by fax or email?', 'CALLER: Fax.'];
    expect(readRecordsDelivery(lines).method).toBeUndefined();
    const { answers } = await replay('CA' + 'b7'.repeat(16), 'VA-232-16', [lines, 'file']);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
  });

  it('mentioning the records, a request or the form opens none: the github-actions sentence on ab9ff37e', () => {
    for (const q of [
      'Did you send the medical records request by fax or email?',
      'Did you receive the records by fax or email?',
      'Should we send the copies by fax or by email?',
      'Would you like the chart by fax, email, or mail?',
      'Is the form going out by fax or email?',
      'Would you prefer to receive the request form by fax or email?',
      'How did you receive the records, by fax or email?',
      // One sentence decides: a "how" in one question and "would you like to
      // receive" in another do not make a delivery question.
      'How are you today? Do you like the new office? Did you receive the records by fax or email?',
    ]) {
      expect(readRecordsDelivery([`AGENT: ${q}`, 'CALLER: Fax.']).method, q).toBeUndefined();
    }
  });

  it('a line asking how they want to receive the records opens one: the funnel question, received, delivered, sent to them, to get them', () => {
    for (const q of [
      DELIVERY_METHOD_QUESTION,
      'How would you like to receive those, by fax, by email, or by mail?',
      'How would you like them delivered, fax, email, or mail?',
      'How would you like the copies sent to you, by fax or email?',
      'How do you want to get them, by fax or by email?',
      'How would you prefer to have them received, fax or email?',
    ]) {
      expect(readRecordsDelivery([`AGENT: ${q}`, 'CALLER: Fax.']).method, q).toBe('fax');
    }
  });

  it('a method volunteered before anyone asked is not read: the tool asks the question first', async () => {
    const { answers } = await replay('CA' + 'a6'.repeat(16), 'VA-232-6', [
      ['CALLER: Can you fax them over to our office?'],
      'file',
    ]);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
  });

  it('on the clock, a fax number given to the fax question is not asked again: only the dates are', async () => {
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

  it('a readback that names the callback is not a destination given: the tool still asks for the fax', async () => {
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

  it('a callback question that mentions the fax is not a destination question: the tool still asks for the fax', async () => {
    const { answers } = await replay('CA' + 'ae'.repeat(16), 'VA-232-14', [
      [METHOD_Q, 'CALLER: Fax.', 'AGENT: And a callback number, in case the fax does not go through?', 'CALLER: 2 0 2 5 5 5 0 1 4 2.'],
      'file',
    ]);
    expect(answers[0].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
  });

  it('a destination answer that opens with a denial is not a destination given', async () => {
    const { answers } = await replay('CA' + 'af'.repeat(16), 'VA-232-15', [
      [METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: No, not 2 0 2 5 5 5 0 1 9 0, I need to find the right one.'],
      'file',
    ]);
    expect(answers[0].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
  });

  it('a number given to the email question is not a fax destination', async () => {
    const { answers } = await replay('CA' + 'ac'.repeat(16), 'VA-232-12', [
      [`AGENT: ${DELIVERY_DESTINATION_QUESTION.email}`, 'CALLER: 2 0 2 5 5 5 0 1 7 8.'],
      [METHOD_Q, 'CALLER: Fax.'],
      'file',
    ]);
    expect(answers[0].message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
  });

  it('when the signing form collects delivery, nothing read back on the call is used', async () => {
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
 * THE RULE THIS FILE PINS (withdrawn on #482, the #476 ruling): a number the
 * agent read back and the caller confirmed is NOT put on the ticket. The
 * destination on a records ticket is the model's `deliver_to`, as on `main`;
 * when the model omits it and the caller gave one, the ticket points the clerk
 * at the recording. Three review rounds found three ways a transcript-read
 * number could be one the caller had taken back.
 */
describe('a destination is never read from the transcript', () => {
  const READ_BACK = [
    METHOD_Q, 'CALLER: Fax.', "AGENT: What's the fax number?", 'CALLER: 2 0 2 5 5 5 0 1 8 1.',
    'AGENT: Two zero two, five five five, zero one eight one. Did I get that right?',
  ];
  const NUMBER = ['202-555-0181', '2025550181', '555-0181'];

  it('a confirmed readback does not put the number on the ticket, and the pointer does', async () => {
    const { answers, payload } = await replay('CA' + 'd1'.repeat(16), 'VA-232-20', [
      [...READ_BACK, 'CALLER: Yes.'],
      'file',
    ]);
    expect(answers[0].success, JSON.stringify(answers[0])).toBe(true);
    expect(description(payload)).toContain('Send to: given by the caller on the call, in the call transcript on this ticket');
    for (const n of NUMBER) {
      expect(JSON.stringify(payload), n).not.toContain(n);
      expect(JSON.stringify(answers[0]), n).not.toContain(n);
    }
    expect(answers[0].send_to_heard).toBe('stated');
  });

  it('the round-3 shape: "Yes, actually that fax number is wrong" never files a number, and takes the method back too', async () => {
    const { answers, payload } = await replay('CA' + 'd2'.repeat(16), 'VA-232-21', [
      [...READ_BACK, 'CALLER: Yes, actually that fax number is wrong, the last digit is two.'],
      'file',
      'file',
    ]);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
    expect(answers[1].success, JSON.stringify(answers[1])).toBe(true);
    expect(description(payload)).toContain('Delivery: NOT CAPTURED');
    for (const n of NUMBER) {
      expect(JSON.stringify(payload), n).not.toContain(n);
      expect(JSON.stringify(answers), n).not.toContain(n);
    }
  });

  it('the store holds a method and a list of method names, never a destination', () => {
    const h = readRecordsDelivery([...READ_BACK, 'CALLER: Yes.']);
    expect(Object.keys(h).sort()).toEqual(['given', 'method']);
    expect(h).toEqual({ method: 'fax', given: ['fax'] });
  });
});

describe('a method switch outside the question forgets the method', () => {
  it('"Actually, can you email it instead?" leaves no method: the tool asks it, never files fax', async () => {
    const lines = [METHOD_Q, 'CALLER: Fax.', 'AGENT: Okay.', 'CALLER: Actually, can you email it instead?'];
    expect(readRecordsDelivery(lines).method).toBeUndefined();
    const { answers } = await replay('CA' + 'e1'.repeat(16), 'VA-232-30', [lines, 'file']);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
  });

  it('a retraction of the stored method clears it: the method is not filled, and the ticket says NOT CAPTURED, as on main', async () => {
    const lines = [METHOD_Q, 'CALLER: Fax.', 'AGENT: Okay.', 'CALLER: Actually, do not fax the records; we no longer have a fax.'];
    expect(readRecordsDelivery(lines).method).toBeUndefined();
    const { answers, payload } = await replay('CA' + 'e2'.repeat(16), 'VA-232-31', [lines, 'file', 'file']);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
    expect(answers[1].success, JSON.stringify(answers[1])).toBe(true);
    expect(answers[1].method_heard).toBeUndefined();
    expect(description(payload)).toContain('Delivery: NOT CAPTURED');
    // A negation alone clears it, and so does a correction word, whatever it meant: errors land toward clearing.
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', 'AGENT: Okay.', "CALLER: Please don't fax them, we no longer have one."]).method).toBeUndefined();
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', 'AGENT: Okay.', 'CALLER: Actually, fax is fine.']).method).toBeUndefined();
  });

  it('the latest method question the caller answered decides it: "Actually, I don\'t know." leaves no method, and the ticket says NOT CAPTURED', async () => {
    const lines = [METHOD_Q, 'CALLER: Fax.', METHOD_Q, "CALLER: Actually, I don't know."];
    expect(readRecordsDelivery(lines).method).toBeUndefined();
    const { answers, payload } = await replay('CA' + 'e3'.repeat(16), 'VA-232-32', [lines, 'file', 'file']);
    expect(answers[0].missingFields).toEqual(['delivery_method']);
    expect(answers[1].method_heard).toBeUndefined();
    expect(description(payload)).toContain('Delivery: NOT CAPTURED');
    // None, several, or a negated one: no method either way.
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', METHOD_Q, 'CALLER: Hmm, let me check with the doctor.']).method).toBeUndefined();
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', METHOD_Q, 'CALLER: Fax or email, either works.']).method).toBeUndefined();
    // The window is read whole: a negation in a later turn of the same answer takes the method back.
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', 'CALLER: No, wait, let me check.']).method).toBeUndefined();
  });

  it('a single "Fax." fills the method; a second "Fax." to a repeated question does too; a repeat nobody answered changes nothing', () => {
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.']).method).toBe('fax');
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Email.', METHOD_Q, 'CALLER: Fax.']).method).toBe('fax');
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', METHOD_Q, 'AGENT: Are you still there?']).method).toBe('fax');
  });

  it('a plain re-answer of "Fax." keeps the method, and so does preferring the same method', () => {
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', METHOD_Q, 'CALLER: Fax.']).method).toBe('fax');
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', 'AGENT: Okay.', 'CALLER: Fax.']).method).toBe('fax');
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', 'AGENT: Okay.', "CALLER: I'd prefer fax, that's better."]).method).toBe('fax');
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', 'AGENT: Anything else?', "CALLER: No, that's all, thank you."]).method).toBe('fax');
  });

  it('naming the same method again, or answering the question again, is not a switch away', () => {
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', METHOD_Q, 'CALLER: Email, please.']).method).toBe('email');
    expect(readRecordsDelivery([METHOD_Q, 'CALLER: Fax.', 'AGENT: Is there an email we can reach you at?',
      'CALLER: My email is T E S T at example dot com.']).method).toBe('fax');
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
    expect(tool).toMatch(/^import \{ recordsDeliveryHeard \} from '\.\/spokenRecordsDelivery';$/m);
    expect(tool).not.toMatch(/import\(['"]\.\/spokenRecordsDelivery['"]\)/);
  });
});
