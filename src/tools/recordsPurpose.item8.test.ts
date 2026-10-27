// Item #8: synthetic failure shapes, indexed by the reported ticket ids; not transcripts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { resetGateAttempts } from './gateAttempts';
import { recordCallerSpeech, releaseCallerSpeech, noteCallerTranscript } from '../services/symptomCorroboration';
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


describe('self-review: request-scoped caller evidence', () => {
  it('does not read caller identity or employer as a contradictory request', async () => {
    const sid = 'CA' + '9'.repeat(32);
    noteCallerTranscript(sid, ["CALLER: I am Taylor from Example Surgery Center"]);
    try {
      const result = await runTool('file_records_ticket', { ...BASE, requester: 'provider', call_sid: sid,
        request_description: 'Please fax my chart to the new doctor' });
      expect(result.success).toBe(true);
      expect(api.createTicket.mock.calls[0]?.[0]).toMatchObject({ departmentId: 16 });
    } finally { releaseCallerSpeech(sid); }
  });

  it('uses the same captured request in classification and filing, excluding identity turns', async () => {
    const sid = 'CA' + 'a'.repeat(32);
    noteCallerTranscript(sid, [
      'CALLER: Please move my appointment to Friday',
      'CALLER: My name is Taylor Example',
      'CALLER: January second nineteen eighty',
    ]);
    try {
      const input = { ...BASE, call_sid: sid, request_description: 'Patient requests medical records', form_channel: 'sms' };
      expect(await runTool('classify_records_request', input)).toMatchObject({ is_records_request: false, department_id: 9 });
      expect((await runTool('file_records_ticket', input)).success).toBe(true);
      const payload = api.createTicket.mock.calls[0]?.[0];
      expect(payload).toMatchObject({ departmentId: 9, requestTypeId: 32, requestReasonId: 147 });
      expect(payload.description).toContain('please move my appointment to friday');
      expect(payload.description).not.toMatch(/name is|nineteen eighty|records clock/);
    } finally { releaseCallerSpeech(sid); }
  });

  it.each(['Please fax my OCT images to my doctor', 'ROI request', 'I want to inspect my file', 'Please complete my DMV form'])(
    'files supported records work without redirecting it: %s', async request_description => {
      expect(await runTool('classify_records_request', { request_description })).toMatchObject({ is_records_request: true, department_id: 16 });
      expect((await runTool('file_records_ticket', { ...BASE, request_description, form_channel: 'sms' })).success).toBe(true);
      expect(api.createTicket.mock.calls[0]?.[0]).toMatchObject({ departmentId: 16, requestPathway: 'pending_authorization', capClockApplies: false, formChannel: 'sms' });
    },
  );
});
