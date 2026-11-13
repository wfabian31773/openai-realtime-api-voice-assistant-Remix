/**
 * v225: A CORRECTION TO THE RECORDS, OR WITHDRAWING A RECORDS REQUEST, IS
 * MEDICAL RECORDS WORK, AND IT IS NOT AN ACCESS REQUEST.
 *
 * The ticketing app has filed both under their own reasons since #406
 * (2026-10-29), with no pathway, no CAP clock and no signing form
 * (`lib/voice-agent/records-intake.ts`). This repo's copy of the classifier
 * did not know either purpose until v225. It read "I need to correct my medical
 * records" as access, so the records tool asked the caller for a signing-link
 * channel, how and where to send the records and which dates, put "PATIENT
 * REQUEST — on the records clock (CAP reportable)" at the top of the ticket,
 * and stated `requestPathway: roa_patient`, `capClockApplies: true`, which is
 * the one combination the app's `decidePathway` takes without a person's
 * review.
 *
 * Synthetic callers only; no transcript, no PHI. Driven through `runTool`,
 * the entry point the model calls, with the ticketing client mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { NOT_ACCESS_HEADER } from './medicalRecordsTools';
import { resetGateAttempts } from './gateAttempts';
import { resetVerifiedIdentities } from './verifiedIdentity';
import { sanitizeForSms } from '../services/gsm7';

const api = vi.hoisted(() => ({
  createTicket: vi.fn(),
  lookupProviderAndLocation: vi.fn(),
  sendRecordsIntakeLink: vi.fn(),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: api, lookupWasUnavailable: () => false }));

let sidCounter = 0xc0e;
const freshSid = () => `CA${(++sidCounter).toString(16).padStart(32, '0')}`;
type Out = Record<string, unknown>;

/** A patient, everything a filing needs, and NO form channel, method, destination or dates. */
const PATIENT = {
  requester: 'I am the patient',
  first_name: 'Testpatient',
  last_name: 'Example',
  date_of_birth: '01/02/1950',
  callback_number: '202-555-0142',
};
const CORRECTION = 'I need to correct my medical records, my allergy list is wrong';
const CANCELLATION = 'Please cancel my records request, I do not need it anymore';
const payload = () => api.createTicket.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
  api.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
  api.sendRecordsIntakeLink.mockResolvedValue({ success: true, channel: 'sms' });
});

describe.each([
  ['amendment', CORRECTION, 'Records Amendment'],
  ['cancellation', CANCELLATION, 'Records Request Cancellation'],
] as const)('%s', (work, request_description, appReason) => {
  it('files on the first invocation, with no signing-link, method, destination or dates question', async () => {
    const r = (await runTool('file_records_ticket', { ...PATIENT, request_description, call_sid: freshSid() })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.missingFields).toBeUndefined();
    expect(api.createTicket).toHaveBeenCalledTimes(1);
  });

  it('stays in Medical Records and states no pathway, no clock, no form and no delivery method', async () => {
    // The model passing a channel and a method anyway changes nothing.
    await runTool('file_records_ticket', {
      ...PATIENT, request_description, form_channel: 'sms', delivery_method: 'fax',
      deliver_to: 'Dr Example, fax 202-555-0100', call_sid: freshSid(),
    });
    const p = payload();
    expect(p.departmentId).toBe(16);
    // Department 16's own "Other - See Description": the app files it under
    // its own reason, and no access reason ("Copies of Records") goes out.
    expect(p.requestReasonId).toBe(547);
    expect(p.requestTypeId).toBe(77);
    for (const field of ['requestPathway', 'capClockApplies', 'formChannel', 'deliveryMethodRequested']) {
      expect(p, field).not.toHaveProperty(field);
    }
    // Who asked is kept, as the app keeps it on these two.
    expect(p.requestorType).toBe('patient');
    expect(p.requestorName).toBe('Testpatient Example');
  });

  it('heads the ticket with the app\'s own reason name and no clock or delivery line', async () => {
    await runTool('file_records_ticket', { ...PATIENT, request_description, call_sid: freshSid() });
    const description = String(payload().description);
    // The description is an SMS body, so it is GSM-7 on the wire (the dash
    // becomes a hyphen, as the clock line's does).
    expect(description.startsWith(`Request Type: ${appReason} - `)).toBe(true);
    expect(description.split('\n')[0]).toBe(sanitizeForSms(NOT_ACCESS_HEADER[work]).value);
    expect(description).not.toMatch(/PATIENT REQUEST|CAP reportable|Send to:|Dates needed:|How to send/);
    expect(description).toContain('Requested by: I am the patient [patient]');
  });

  it('tells the model no form applies, and says nothing about where records go', async () => {
    const r = (await runTool('file_records_ticket', { ...PATIENT, request_description, call_sid: freshSid() })) as Out;
    expect(r.form_applies).toBe(false);
    expect(r.cap_clock_applies).toBe(false);
    expect(r.records_work).toBe(work);
    expect(r.note_destination).toBeUndefined();
    expect(r.form_sent).toBeUndefined();
    expect(String(r.fix)).toMatch(/do not offer a link/i);
    expect(String(r.fix)).toMatch(/send_records_form/);
    expect(String(r.message)).toContain('VA-SYNTHETIC');
  });

  it('the re-send refuses: there is no form to sign for this request', async () => {
    const sid = freshSid();
    await runTool('file_records_ticket', { ...PATIENT, request_description, call_sid: sid });
    const r = (await runTool('send_records_form', { channel: 'sms', call_sid: sid })) as Out;
    expect(r.success).toBe(false);
    expect(String(r.message)).toMatch(/no form to sign/i);
    expect(api.sendRecordsIntakeLink).not.toHaveBeenCalled();
  });

  it('classify_records_request keeps it in Medical Records with no form', async () => {
    const r = (await runTool('classify_records_request', { request_description })) as Out;
    expect(r).toMatchObject({
      success: true, is_records_request: true, records_work: work, form_applies: false,
      department_id: 16, request_reason_id: 547,
    });
    expect(String(r.fix)).toMatch(/not a request for copies/i);
    expect(String(r.fix)).toMatch(/do not ask how or where records should be sent or which dates/i);
  });

  it('still asks who is asking, once, as for any request kept in Medical Records', async () => {
    const r = (await runTool('file_records_ticket', {
      ...PATIENT, requester: undefined, request_description, call_sid: freshSid(),
    })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['requester']);
    expect(api.createTicket).not.toHaveBeenCalled();
  });
});

describe('the controls: access is still access', () => {
  it('a patient\'s own copy request is still asked for the signing-link channel', async () => {
    const r = (await runTool('file_records_ticket', {
      ...PATIENT, request_description: 'I need a copy of my medical records', call_sid: freshSid(),
    })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['form_channel']);
  });

  it('a separate copy request beside a correction is access, as in the app', async () => {
    const r = (await runTool('file_records_ticket', {
      ...PATIENT, request_description: 'I need to correct my medical records and get a copy of my chart',
      call_sid: freshSid(),
    })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['form_channel']);
  });

  it('a patient\'s own copy request still states the pathway and the clock', async () => {
    await runTool('file_records_ticket', {
      ...PATIENT, request_description: 'I need a copy of my medical records', form_channel: 'verbal',
      delivery_method: 'pickup', date_range: 'everything', call_sid: freshSid(),
    });
    const p = payload();
    expect(p.requestPathway).toBe('roa_patient');
    expect(p.capClockApplies).toBe(true);
    expect(String(p.description)).toMatch(/^PATIENT REQUEST - on the records clock/);
  });
});
