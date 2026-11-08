/**
 * HOW THEY WANT THE RECORDS — v188.
 *
 * Operator, 2026-11-08: *"for medical records, we are never asking, how would
 * you like to receive the records and that is never being passed back to the
 * request."* Measured 2026-10-25..11-07, calls of 30 s or more that ran a
 * records tool: the records line asked the method on 0 of 152; PCP asked it on
 * 103 of 108. `mr_cases.delivery_method_requested` is written by no voice
 * path: only a staffer on the case screen sets it.
 *
 * Driven through `runTool`, the entry point the model calls, with the ticketing
 * client mocked at `createTicket`. What is pinned: the question (in PCP's own
 * words), one field per question, each asked once, the destination in the
 * words of the method, the ticket's Delivery line, and `recordsDeliveryMethod`
 * on the payload — never on a redirected request, and never asked when the
 * signing form asks it. Synthetic callers throughout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { resetGateAttempts } from './gateAttempts';
import { resetVerifiedIdentities } from './verifiedIdentity';
import {
  DELIVERY_METHOD_QUESTION,
  DELIVERY_DESTINATION_QUESTION,
  normalizeDeliveryMethod,
  caseDeliveryMethod,
} from './recordsDeliveryMethod';
import { PROMPTS as DIRECTOR_PROMPTS } from '../pcp/director';

let sidCounter = 0x188000;
const freshSid = () => `CA${(++sidCounter).toString(16).padStart(32, '0')}`;

/** A provider's office asking for a mutual patient's records: off the clock, no form. */
const PROVIDER = {
  requester: "calling from Dr. Example's office",
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
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

describe('the method is asked, in the words PCP already uses', () => {
  it('is the same sentence on both lines', () => {
    expect(DELIVERY_METHOD_QUESTION).toBe(DIRECTOR_PROMPTS.recordsDeliveryMethod);
  });

  it('a provider with no method is asked how they want the records, before anything files', async () => {
    const create = vi.spyOn(await client(), 'createTicket');
    const r = (await runTool('file_records_ticket', { ...PROVIDER, call_sid: freshSid() })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['delivery_method']);
    expect(r.message).toBe(DELIVERY_METHOD_QUESTION);
    expect(String(r.fix)).toMatch(/ONCE/);
    expect(create).not.toHaveBeenCalled();
  });

  it('then the destination, in the words of the method, once', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-1'));
    const sid = freshSid();
    await runTool('file_records_ticket', { ...PROVIDER, call_sid: sid });
    laterTurn();
    const second = (await runTool('file_records_ticket', { ...PROVIDER, delivery_method: 'fax', call_sid: sid })) as Out;
    expect(second.success).toBe(false);
    expect(second.missingFields).toEqual(['deliver_to']);
    expect(second.message).toBe(DELIVERY_DESTINATION_QUESTION.fax);
    expect(create).not.toHaveBeenCalled();

    laterTurn();
    const third = (await runTool('file_records_ticket', {
      ...PROVIDER, delivery_method: 'fax', deliver_to: '202-555-0199', call_sid: sid,
    })) as Out;
    expect(third.success, JSON.stringify(third)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.departmentId).toBe(16);
    expect(p.recordsDeliveryMethod).toBe('fax');
    expect(String(p.description)).toContain('Delivery: by fax');
    expect(String(p.description)).toContain('Send to: 202-555-0199');
  });

  it('a caller who never answers still files — the gap is written on the ticket, never a refusal', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-2'));
    const sid = freshSid();
    await runTool('file_records_ticket', { ...PROVIDER, call_sid: sid });
    laterTurn();
    const r = (await runTool('file_records_ticket', { ...PROVIDER, call_sid: sid })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.recordsDeliveryMethod).toBeUndefined();
    expect(String(p.description)).toContain('Delivery: NOT CAPTURED');
  });

  it('a batched sibling gets the same question and spends nothing', async () => {
    const create = vi.spyOn(await client(), 'createTicket');
    const sid = freshSid();
    const a = (await runTool('file_records_ticket', { ...PROVIDER, call_sid: sid })) as Out;
    clock += 40; // the second call of one response
    const b = (await runTool('file_records_ticket', { ...PROVIDER, call_sid: sid })) as Out;
    expect(a.missingFields).toEqual(['delivery_method']);
    expect(b.missingFields).toEqual(['delivery_method']);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('each method reaches the case in the ticketing app’s own vocabulary', () => {
  it('email is secure_email, and the address the caller spelled is the destination', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-3'));
    const r = (await runTool('file_records_ticket', {
      ...PROVIDER, delivery_method: 'email', email: 'office@example.test', call_sid: freshSid(),
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.recordsDeliveryMethod).toBe('secure_email');
    expect(String(p.description)).toContain('Delivery: by email');
    expect(String(p.description)).toContain('Send to: office@example.test');
  });

  it('pickup asks no destination', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-4'));
    const r = (await runTool('file_records_ticket', { ...PROVIDER, delivery_method: 'pick up', call_sid: freshSid() })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.recordsDeliveryMethod).toBe('pickup');
    expect(String(p.description)).toContain('Send to: pick up at the office');
  });

  it('mail', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-5'));
    await runTool('file_records_ticket', {
      ...PROVIDER, delivery_method: 'mail', deliver_to: '1 Example Way, Testville', call_sid: freshSid(),
    });
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.recordsDeliveryMethod).toBe('mail');
    expect(String(p.description)).toContain('Delivery: by mail');
  });

  it('reads the words a model sends', () => {
    expect(normalizeDeliveryMethod('Fax')).toBe('fax');
    // The question invites "by …" for every method (Codex P2, #438).
    expect(normalizeDeliveryMethod('by fax')).toBe('fax');
    expect(normalizeDeliveryMethod('By email')).toBe('email');
    expect(normalizeDeliveryMethod('by mail')).toBe('mail');
    expect(normalizeDeliveryMethod('via e-mail')).toBe('email');
    expect(normalizeDeliveryMethod('e-mail')).toBe('email');
    expect(normalizeDeliveryMethod('secure email')).toBe('email');
    expect(normalizeDeliveryMethod('US mail')).toBe('mail');
    expect(normalizeDeliveryMethod('pick up')).toBe('pickup');
    expect(normalizeDeliveryMethod('in person')).toBe('pickup');
    expect(normalizeDeliveryMethod("don't know")).toBe('unspecified');
    expect(normalizeDeliveryMethod('')).toBeNull();
    expect(normalizeDeliveryMethod(undefined)).toBeNull();
    expect(normalizeDeliveryMethod('carrier pigeon')).toBeNull();
    expect(caseDeliveryMethod('email')).toBe('secure_email');
    expect(caseDeliveryMethod('unspecified')).toBeUndefined();
  });
});

describe('on the clock', () => {
  it('a patient who declined the link is asked the method first, then the existing destination-and-dates gate', async () => {
    const create = vi.spyOn(await client(), 'createTicket');
    const sid = freshSid();
    const first = (await runTool('file_records_ticket', { ...PATIENT_NO_LINK, call_sid: sid })) as Out;
    expect(first.missingFields).toEqual(['delivery_method']);
    laterTurn();
    const second = (await runTool('file_records_ticket', { ...PATIENT_NO_LINK, delivery_method: 'mail', call_sid: sid })) as Out;
    expect(second.missingFields).toEqual(['deliver_to', 'date_range']);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * Codex P2, #438. "I don't know" is an ANSWER to how they want the records,
   * and so is a method ask that went unanswered. Asking where to send them next
   * is a second delivery question to a caller who has just said they cannot
   * say — so only the dates are asked, and the case files with the destination
   * written as not captured.
   */
  it('"unspecified" ends the delivery questions: only the dates are asked, then it files with the destination NOT CAPTURED', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-ONCLOCK-U'));
    const sid = freshSid();
    const first = (await runTool('file_records_ticket', {
      ...PATIENT_NO_LINK, delivery_method: 'unspecified', call_sid: sid,
    })) as Out;
    expect(first.missingFields).toEqual(['date_range']);
    expect(String(first.message)).toMatch(/which dates/i);
    expect(String(first.message)).not.toMatch(/where should these be sent|send them to/i);
    laterTurn();
    const second = (await runTool('file_records_ticket', {
      ...PATIENT_NO_LINK, delivery_method: 'unspecified', date_range: 'everything', call_sid: sid,
    })) as Out;
    expect(second.success, JSON.stringify(second)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.capClockApplies).toBe(true);
    expect(p.recordsDeliveryMethod).toBeUndefined();
    expect(String(p.description)).toContain('Delivery: NOT CAPTURED');
    expect(String(p.description)).toContain('Send to: NOT CAPTURED');
  });

  it('an unanswered method ask counts the same: the destination is not asked after it', async () => {
    vi.spyOn(await client(), 'createTicket');
    const sid = freshSid();
    const first = (await runTool('file_records_ticket', { ...PATIENT_NO_LINK, call_sid: sid })) as Out;
    expect(first.missingFields).toEqual(['delivery_method']);
    laterTurn();
    const second = (await runTool('file_records_ticket', { ...PATIENT_NO_LINK, call_sid: sid })) as Out;
    expect(second.missingFields).toEqual(['date_range']);
  });

  it('with only the destination missing, it is asked in the words of the method', async () => {
    vi.spyOn(await client(), 'createTicket');
    const r = (await runTool('file_records_ticket', {
      ...PATIENT_NO_LINK, delivery_method: 'mail', date_range: 'everything', call_sid: freshSid(),
    })) as Out;
    expect(r.missingFields).toEqual(['deliver_to']);
    expect(r.message).toBe(DELIVERY_DESTINATION_QUESTION.mail);
  });

  it('a patient taking the link is NOT asked — the form asks it', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(
      ({ success: true, ticketNumber: 'VA-188-6', form: { requested: true, sent: true, channel: 'sms' } }) as never,
    );
    const r = (await runTool('file_records_ticket', {
      ...PATIENT_NO_LINK, form_channel: 'sms', call_sid: freshSid(),
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.recordsDeliveryMethod).toBeUndefined();
    expect(String(p.description)).toContain('Delivery: on the signed form.');
    expect(String(p.description)).not.toContain('NOT CAPTURED');
  });
});

describe('never asked where it does not belong', () => {
  it('a request routed out of Medical Records is not asked, and carries no method', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-7'));
    const r = (await runTool('file_records_ticket', {
      ...PATIENT_NO_LINK, request_description: 'I need to confirm my appointment for tomorrow', call_sid: freshSid(),
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.departmentId).not.toBe(16);
    expect(p.recordsDeliveryMethod).toBeUndefined();
    expect(String(p.description)).not.toContain('Delivery:');
  });

  it('a lane that declared it cannot ask (PCP) is not asked, and its own answer reaches the case', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-8'));
    const r = (await runTool('file_records_ticket', {
      ...PROVIDER, on_clock_ask_exhausted: true, delivery_method: 'fax', deliver_to: 'fax to 202-555-0199',
      call_sid: freshSid(),
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.recordsDeliveryMethod).toBe('fax');
  });

  it('…and a PCP filing with no method is not asked either', async () => {
    const create = vi.spyOn(await client(), 'createTicket').mockResolvedValueOnce(filed('VA-188-9'));
    const r = (await runTool('file_records_ticket', {
      ...PROVIDER, on_clock_ask_exhausted: true, call_sid: freshSid(),
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
