import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectCrossQueue } from './queueRouting';
const create = vi.fn();
const lookup = vi.fn();
vi.mock('../services/durableTicketFiling', () => ({
  createTicketDurable: (...args: unknown[]) => create(...args),
  postFailureToolResult: (r: unknown) => r,
  repeatFilingFields: () => ({}),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { lookupProviderAndLocation: (...args: unknown[]) => lookup(...args) },
  lookupWasUnavailable: () => false,
}));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: {} }));
import { runTool } from './registry';
import './surgeryTools';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from './verifiedIdentity';
import { resetGateAttempts } from './gateAttempts';
const cases = [
  ['surgery denial contraction', "This isn't about surgery; I need glasses.", 1, 66, 536, 'optical'],
  ['surgery denial need', 'I do not need surgery; I need contacts.', 1, 66, 536, 'optical'],
  [
    "#6 VA-75838",
    "I reached the surgery line but need to order contact lenses.",
    1,
    3,
    11,
    "contact lenses"
  ],
  [
    "#6 75208",
    "Are my contacts ready for pickup?",
    1,
    5,
    21,
    "contact lenses"
  ],
  [
    "#6 74205",
    "I need help with my glasses, not cataract surgery.",
    1,
    66,
    536,
    "optical"
  ],
  [
    "#6 71404",
    "What is the status of my CL order?",
    1,
    5,
    21,
    "contact lenses"
  ],
  [
    "#7 67428",
    "Request Type: Cataract Surgery\nSubject: Schedule an eye exam\nSurgery date: 2026-12-01",
    9,
    32,
    146,
    "appointment"
  ],
  [
    "#7 67429",
    "I need to reschedule my glaucoma test.",
    9,
    32,
    147,
    "appointment"
  ],
  [
    "#7 67486",
    "Do you accept my insurance?",
    9,
    37,
    181,
    "insurance"
  ],
  [
    "#7 67506",
    "I need a glaucoma test.",
    9,
    32,
    146,
    "appointment"
  ],
  [
    "#7 VA-76202",
    "Please verify my insurance coverage for an eye exam.",
    9,
    37,
    178,
    "insurance"
  ],
  [
    "HVA VA-76697",
    "I need an annual eye exam.",
    9,
    32,
    146,
    "appointment"
  ],
  [
    "HVA VA-76341",
    "I have a question for technician support.",
    3,
    72,
    542,
    "technician support"
  ],

  ['different day exam', 'I need a different day for my appointment for an eye exam.', 9, 32, 147, 'appointment'],
  ['contact information', 'I need more information about contact lenses.', 1, 66, 536, 'optical'],
  ['cancelled exam', 'Cancelación de cita para examen de la vista.', 9, 32, 148, 'appointment'],
  ['confirmed exam', 'Confirmación de cita para examen de la vista.', 9, 32, 149, 'appointment'],
  ['confirming exam', 'I am confirming my eye exam appointment.', 9, 32, 149, 'appointment'],
  ['same-day exam', 'Can I get in today for an eye exam?', 9, 32, 151, 'appointment'],
  ['available exam', 'What is the next available eye exam appointment?', 9, 32, 150, 'appointment'],
  ['specialist exam', 'I was referred to a glaucoma specialist for an eye exam.', 9, 32, 152, 'appointment'],
] as const;
beforeEach(() => {
  resetVerifiedIdentities(); resetGateAttempts(); vi.clearAllMocks();
  lookup.mockResolvedValue({ success: true, providerId: 88, locationId: 21 });
  create.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
});
describe('#6/#7 and HVA: actual request wins on the surgery line', () => {
  it.each(cases)('%s routes and files without surgery fields', async (_id, description, departmentId, requestTypeId, requestReasonId) => {
    expect(detectCrossQueue(description, 2)).toMatchObject({ departmentId, requestTypeId, requestReasonId });
    expect(await runTool('classify_surgery_request', { request_description: description })).toMatchObject({
      department_id: departmentId, request_type_id: requestTypeId, request_reason_id: requestReasonId,
    });
    const result = await runTool('file_surgery_ticket', {
      first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
      callback_number: '2025550142', request_description: description,
      surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon', location: 'Testville',
      request_reason_id: '42',
    });
    expect(result).toMatchObject({ success: true });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({ departmentId, requestTypeId, requestReasonId });
    expect(create.mock.calls[0][0].description).not.toMatch(/surgery date|surgeon:/i);
    expect(create.mock.calls[0][0].providerId).toBeUndefined();
  });
  it('keeps an actual surgery date and its surgeon', async () => {
    await runTool('file_surgery_ticket', {
      first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
      callback_number: '2025550142', request_description: 'Reschedule my LASIK surgery.',
      surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon', location: 'Testville',
    });
    expect(create.mock.calls[0][0]).toMatchObject({ departmentId: 2, providerId: 88 });
    expect(create.mock.calls[0][0].description).toContain('Surgery date given by caller: 2026-12-01');
  });
  it('does not change the records-line decision', () => {
    expect(detectCrossQueue('A copy of my cataract surgery notes.', 16)).toBeNull();
  });
});

it('HVA VA-76697: an unexplained date is not evidence of a surgery request', async () => {
  await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '2025550142', request_description: 'Please call me back about my question.',
    surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon', location: 'Testville',
  });
  expect(create.mock.calls[0][0].description).not.toContain('Surgery date');
});

it.each([
  'Will insurance cover my cataract procedure?',
  'Will insurance cover my cataract removal?',
  'Will insurance cover my procedure?',
  'Will insurance cover my vitrectomy?',
  'Will insurance cover my blepharoplasty?',
  'Please schedule my cataract sx',
  'Please schedule my vitrectomy',
])('retains Surgery, surgeon and date for a recognized operation: %s', async (request_description) => {
  expect(detectCrossQueue(request_description, 2)).toBeNull();
  expect(await runTool('classify_surgery_request', { request_description })).toMatchObject({ department_id: 2 });
  expect(await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '2025550142', request_description,
    surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon', location: 'Testville',
  })).toMatchObject({ success: true });
  expect(create.mock.calls[0][0]).toMatchObject({ departmentId: 2, providerId: 88 });
  expect(create.mock.calls[0][0].description).toContain('Surgery date given by caller: 2026-12-01');
});

it.each([
  ['I never got my clearance form.', 530],
  ['What time should I arrive?', 532],
  ['My pre-op drops did not arrive.', 529],
  ['I have a question about the deposit.', 533],
  ['I need to postpone.', 531],
] as const)('carries a validated surgery date for recognized logistics: %s', async (request_description, requestReasonId) => {
  expect(await runTool('classify_surgery_request', { request_description })).toMatchObject({
    department_id: 2, request_reason_id: requestReasonId, logistics: true,
  });
  expect(await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '2025550142', request_description,
    surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon', location: 'Testville',
  })).toMatchObject({ success: true });
  expect(create.mock.calls[0][0]).toMatchObject({ departmentId: 2, requestReasonId });
  expect(create.mock.calls[0][0].description).toContain('Surgery date given by caller: 2026-12-01');
});

it('an unexplained callback cannot acquire a surgery date from a stale logistics reason', async () => {
  await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '2025550142', request_description: 'Please call me back.',
    request_reason_id: '530', surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon', location: 'Testville',
  });
  expect(create.mock.calls[0][0].description).not.toContain('Surgery date');
});

it('still routes an explicit exam appointment when a symptom is named', async () => {
  const request_description = 'I need to schedule an eye exam because my vision is blurry';
  expect(detectCrossQueue(request_description, 2)).toMatchObject({
    departmentId: 9, requestTypeId: 32, requestReasonId: 146,
  });
  const result = await runTool('classify_surgery_request', { request_description });
  expect(result).toMatchObject({ department_id: 9, request_type_id: 32, request_reason_id: 146 });
});

it.each([
  'I have severe eye pain when I wear my glasses.',
  'My eye is red after taking out my contacts.',
  'I see sudden flashes and floaters while wearing glasses.',
])('does not redirect a clinical complaint as routine eyewear: %s', async (request_description) => {
  expect(detectCrossQueue(request_description, 2)).toBeNull();
  expect(detectCrossQueue(request_description, 9)).toBeNull();
  const result = await runTool('classify_surgery_request', { request_description });
  expect(result).toMatchObject({ department_id: 2 });
  await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '2025550142', request_description, urgent: 'true', surgeon: 'Synthetic Surgeon', location: 'Testville',
  });
  expect(create.mock.calls[0][0]).toMatchObject({ departmentId: 2, priority: 'urgent' });
});

it.each([undefined, 'Synthetic Caller Clinic'])('#6 VA-75838: a redirect hydrates an omitted office and preserves a supplied office (%s)', async (location) => {
  const callSid = 'CA' + 'a'.repeat(32);
  rememberVerifiedIdentity(callSid, { firstName: 'Avery', lastName: 'Example',
    dateOfBirth: '1980-01-02', usualOffice: 'Testville', certain: true });
  await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name: 'Example', callback_number: '2025550142',
    request_description: 'I need to order contact lenses.', call_sid: callSid,
    location, surgery_date: '2026-12-01',
  });
  expect(create.mock.calls[0][0]).toMatchObject({ departmentId: 1, locationOfLastVisit: location || 'Testville',
    locationSource: location ? 'caller' : 'history',
    patientBirthYear: '1980', patientBirthMonth: '01', patientBirthDay: '02' });
});
it.each([
  ['uncertain identity', false, 'Example', '01/02/1980'],
  ['different patient', true, 'Different', '01/02/1980'],
  ['conflicting DOB', true, 'Example', '02/03/1981'],
] as const)('does not carry the record office for %s', async (_reason, certain, last_name, date_of_birth) => {
  const callSid = 'CA' + 'd'.repeat(32);
  rememberVerifiedIdentity(callSid, { firstName: 'Avery', lastName: 'Example',
    dateOfBirth: '1980-01-02', usualOffice: 'Record-only office', certain });
  await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name, date_of_birth, callback_number: '2025550142',
    request_description: 'Order contact lenses.', call_sid: callSid, location: 'Caller office',
  });
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][0].locationOfLastVisit).toBe('Caller office');
  expect(lookup).toHaveBeenCalledWith({ locationName: 'Caller office' });
});
it('does not treat the verb contact as eyewear', () => {
  expect(detectCrossQueue('Please contact me about my question.', 2)).toBeNull();
});

describe('Optical redirects keep the bounded office ask', () => {
  const input = { first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '2025550142', request_description: 'I need to order contact lenses.',
    call_sid: 'CA' + 'b'.repeat(32) };

  it.each(['office', 'location'])('a terminal %s refusal enables only this call’s second attempt', async (missingField) => {
    // Make acceptance depend on the actual payload; an unconditional success
    // mock cannot prove the exit is wired.
    create.mockImplementation(async (payload) => payload.routingAskExhausted
      ? { success: true, ticketNumber: 'VA-SYNTHETIC' }
      : { success: false, terminal: true, missingField });
    await runTool('file_surgery_ticket', input);
    expect(create.mock.calls[0][0].routingAskExhausted).toBeUndefined();
    expect(await runTool('file_surgery_ticket', input)).toMatchObject({ success: true });
    expect(create.mock.calls[1][0].routingAskExhausted).toBe(true);
    await runTool('file_surgery_ticket', { ...input, call_sid: 'CA' + 'c'.repeat(32) });
    expect(create.mock.calls[2][0].routingAskExhausted).toBeUndefined();
  });

  it.each(['unknown', ''])('a sentinel SID %s cannot pool office refusals', async (call_sid) => {
    create.mockResolvedValue({ success: false, terminal: true, missingField: 'office' });
    await runTool('file_surgery_ticket', { ...input, call_sid });
    await runTool('file_surgery_ticket', { ...input, call_sid });
    expect(create.mock.calls.every(([p]) => !p.routingAskExhausted)).toBe(true);
  });

  it('an outage does not spend the office ask', async () => {
    create.mockResolvedValueOnce({ success: false, statusCode: 503 });
    await runTool('file_surgery_ticket', input);
    await runTool('file_surgery_ticket', input);
    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();
  });
});
