// Item #8: synthetic failure shapes, indexed by the reported ticket ids; not transcripts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { resetGateAttempts } from './gateAttempts';
import { recordCallerSpeech, releaseCallerSpeech } from '../services/symptomCorroboration';
const api = vi.hoisted(() => ({ createTicket: vi.fn(), lookupProviderAndLocation: vi.fn() }));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: api, lookupWasUnavailable: () => false }));
const BASE = { first_name: 'Taylor', last_name: 'Example', date_of_birth: '01/02/1980', callback_number: '2025550142', requester: 'I am the patient' };
beforeEach(() => { vi.clearAllMocks(); resetGateAttempts(); api.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' }); });
const CASES = [
  ['VA-73593', 'I need to change the date of my appointment', 9],
  ['73510', 'Please cancel the visit tomorrow', 9],
  ['73485', 'What time should I arrive for surgery?', 2],
  ['73880', 'I need help with a referral for an appointment', 9],
  ['75992', 'Our payer vendor needs to check insurance eligibility', 18],
  ['67520', 'Please move my appointment to Friday', 9],
  ['67482', 'I have a question about my surgery', 2],
  ['67461', 'Has my referral been authorized?', 18],
  ['67473', 'Our health plan vendor is calling about a claim', 18],
  ['67533', 'I called the records line but need an appointment', 9],
  ['VA-76695', 'Please reschedule my appointment', 9],
  ['76349', 'Confirm my appointment time please', 9]
] as const;

describe('item #8: a non-records call never becomes records work', () => {
  it.each(CASES)('%s files to the correct queue without CAP fields or a form ask', async (_id, description, departmentId) => {
    const result = await runTool('file_records_ticket', { ...BASE, request_description: description, request_reason_id: '547', form_channel: 'sms' });
    expect(result.success).toBe(true);
    expect(result).toMatchObject({ cap_clock_applies: false });
    const payload = api.createTicket.mock.calls[0]?.[0];
    expect(payload.departmentId).toBe(departmentId);
    for (const field of ['requestorType', 'requestorName', 'requestPathway', 'capClockApplies', 'formChannel']) expect(payload).not.toHaveProperty(field);
    expect(payload.description).not.toMatch(/CAP|records clock|Send to:|Dates needed:/i);
  });
  it('does not ask a scheduling caller for records requester or delivery fields', async () => {
    const result = await runTool('file_records_ticket', { ...BASE, requester: undefined,
      request_description: 'Please reschedule my appointment' });
    expect(result.success).toBe(true);
    expect(api.createTicket.mock.calls[0]?.[0].departmentId).toBe(9);
  });
  it('uses the ordinary callback queue when no records request is stated', async () => {
    await runTool('file_records_ticket', { ...BASE, request_description: 'Something else entirely' });
    expect(api.createTicket.mock.calls[0]?.[0]).toMatchObject({ departmentId: 9, requestTypeId: 69, requestReasonId: 539 });
  });
  it('classifies a scheduling call before a records form can be offered', async () => {
    const result = await runTool('classify_records_request', { request_description: 'Please reschedule my appointment' });
    expect(result).toMatchObject({ department_id: 9 });
    expect(result).toMatchObject({ is_records_request: false });
  });
  it('uses captured caller speech when the model supplies a records template', async () => {
    const sid = 'CA' + '8'.repeat(32);
    recordCallerSpeech(sid, 'Please move my appointment to Friday');
    try {
      const result = await runTool('file_records_ticket', { ...BASE, call_sid: sid, request_description: 'Patient requests medical records', form_channel: 'sms' });
      expect(result.success).toBe(true);
      expect(api.createTicket.mock.calls[0]?.[0]).toMatchObject({ departmentId: 9 });
      expect(api.createTicket.mock.calls[0]?.[0].description).not.toMatch(/medical records/i);
    } finally { releaseCallerSpeech(sid); }
  });
  it.each(['a provider office', 'a health plan', 'an attorney'])('keeps a real records request from %s in Medical Records', async requester => {
    const result = await runTool('file_records_ticket', { ...BASE, requester, request_description: 'Please fax the surgery notes before the appointment', form_channel: 'sms' });
    expect(result.success).toBe(true);
    expect(api.createTicket.mock.calls[0]?.[0]).toMatchObject({ departmentId: 16, capClockApplies: false });
  });
});
