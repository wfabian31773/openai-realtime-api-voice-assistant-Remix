import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectCrossQueue } from './queueRouting';
const create = vi.fn();
vi.mock('../services/durableTicketFiling', () => ({
  createTicketDurable: (...args: unknown[]) => create(...args),
  postFailureToolResult: (r: unknown) => r,
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { lookupProviderAndLocation: async () => ({ success: true, providerId: 88, locationId: 21 }) },
  lookupWasUnavailable: () => false,
}));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: {} }));
import { runTool } from './registry';
import './surgeryTools';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from './verifiedIdentity';
const cases = [
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
  ]
] as const;
beforeEach(() => { resetVerifiedIdentities(); vi.clearAllMocks(); create.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' }); });
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
      surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon',
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
    surgery_date: '2026-12-01', surgeon: 'Synthetic Surgeon',
  });
  expect(create.mock.calls[0][0].description).not.toContain('Surgery date');
});

it('#6 VA-75838: a redirected request carries the validated record office and DOB', async () => {
  const callSid = 'CA' + 'a'.repeat(32);
  rememberVerifiedIdentity(callSid, { firstName: 'Avery', lastName: 'Example',
    dateOfBirth: '1980-01-02', usualOffice: 'Testville', certain: true });
  await runTool('file_surgery_ticket', {
    first_name: 'Avery', last_name: 'Example', callback_number: '2025550142',
    request_description: 'I need to order contact lenses.', call_sid: callSid,
    location: 'Wrong office from model', surgery_date: '2026-12-01',
  });
  expect(create.mock.calls[0][0]).toMatchObject({ departmentId: 1, locationOfLastVisit: 'Testville',
    patientBirthYear: '1980', patientBirthMonth: '01', patientBirthDay: '02' });
});
it('does not treat the verb contact as eyewear', () => {
  expect(detectCrossQueue('Please contact me about my question.', 2)).toBeNull();
});
