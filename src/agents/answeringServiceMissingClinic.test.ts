import { beforeEach, expect, it, vi } from 'vitest';

// Exercise the actual handler and Zod inputs without starting the voice SDK.
// SDK schema conversion remains covered by contactCaptureWire.test.ts.
vi.mock('@openai/agents/realtime', () => ({
  RealtimeAgent: class {
    constructor(options: object) { Object.assign(this, options); }
  },
  tool: (definition: {
    parameters: { parse(input: unknown): unknown };
    execute(input: unknown): unknown;
  }) => ({
    ...definition,
    invoke: (_context: unknown, raw: string) => definition.execute(definition.parameters.parse(JSON.parse(raw))),
  }),
}));

const h = vi.hoisted(() => ({ lookup: vi.fn(), phone: vi.fn(), submit: vi.fn() }));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {
  updateCallLog: async () => {},
  claimTicketCreation: async () => ({ claimed: true }),
  releaseTicketCreationLock: async () => {},
} }));
vi.mock('../services/toolTimeline', () => ({ recordingExecute: (_ctx: unknown, _name: string, execute: unknown) => execute }));
vi.mock('../services/callerMemoryService', () => ({ CallerMemoryService: {
  getInstance: () => ({ getCallerMemory: async () => null }),
} }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupByNameAndDOB: h.lookup, lookupByPhone: h.phone },
}));
vi.mock('../services/syncAgentService', () => ({ SyncAgentService: { submitSimplifiedTicket: h.submit } }));
import { createAnsweringServiceAgent } from './answeringServiceAgent';
import { rememberConfirmedClinic, rememberVerifiedIdentity, resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { validatedPatientFor } from '../tools/ticketIdentity';
import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import * as directory from '../services/consoleDirectory';

const sid = 'CA' + 'e'.repeat(32);
const args = { first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '1970-01-02' };
const record = { patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true },
  patientData: { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02' },
  upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Synthetic Clinic' }],
  pastAppointments: [], totalAppointmentsFound: 1 };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(directory, 'isDirectoryConfigured').mockReturnValue(true);
  vi.spyOn(directory, 'lookupProvider').mockImplementation(async (name) => ({ canonical: name, key: name.toLowerCase(), volume90d: 1 }));
  vi.spyOn(directory, 'lookupLocation').mockImplementation(async (name) => ({
    canonical: name, key: name.toLowerCase(), volume90d: 1,
    facilityKind: name === 'Synthetic Surgery Center' ? 'surgery_center'
      : name === 'Synthetic Virtual Visits' ? 'virtual' : 'clinic',
  }));
  resetVerifiedIdentities();
  h.lookup.mockResolvedValue(record);
  h.phone.mockResolvedValue({ ...record, matchedBy: 'phone', identityUnconfirmed: true });
  h.submit.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
});
async function invoke(agent: any, name: string, input: Record<string, unknown>) {
  const raw = await agent.tools.find((t: any) => t.name === name).invoke({}, JSON.stringify(input));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function captureHttpSubmission() {
  const { SyncAgentService } = await vi.importActual<typeof import('../services/syncAgentService')>('../services/syncAgentService');
  h.submit.mockImplementation((params) => SyncAgentService.submitSimplifiedTicket(params));
  vi.spyOn(ticketingApiClient as any, 'warmUpIfStale').mockResolvedValue(true);
  return vi.spyOn(ticketingApiClient as any, 'makeRequest')
    .mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
}

const opticalRequest = {
  ...args, department_id: 1, request_type_id: 1, request_reason_id: 1,
  callback_number: '5555550100', subject: 'Optical callback requested',
  description: 'Synthetic glasses question',
};

it.each([false, true])('Optical resolves an ID-only clinic from classify_request (held history: %s)', async (held) => {
  if (!held) h.lookup.mockResolvedValue({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  if (held) await invoke(agent, 'lookup_schedule', args);
  const classification = await invoke(agent, 'classify_request', { request_description: 'Glasses pickup in Eastvale' });
  expect(classification).toMatchObject({ locationId: 5, detectedLocation: 'Eastvale' });

  expect(await invoke(agent, 'create_ticket', { ...opticalRequest, location_id: classification.locationId }))
    .toMatchObject({ success: true });
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({
    locationOfLastVisit: 'Eastvale', reasonForCalling: expect.stringContaining('Location: Eastvale'),
  }));
  expect(h.lookup).toHaveBeenCalledTimes(1);
});

it('Optical falls back to held clinic history when the location ID is unknown', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);

  expect(await invoke(agent, 'create_ticket', { ...opticalRequest, location_id: 999999 }))
    .toMatchObject({ success: true });
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ locationOfLastVisit: 'Synthetic Clinic' }));
  expect(h.lookup).toHaveBeenCalledTimes(1);
});

it.each([
  { location: 'Synthetic Surgery Center', location_name: undefined },
  { location: 'Synthetic Virtual Visits', location_name: undefined },
  { location: 'Synthetic Surgery Center', location_name: '   ' },
])(
  'Optical skips an ineligible next appointment and routes to the last clinic (%j)', async ({ location, location_name }) => {
    h.lookup.mockResolvedValue({ ...record,
      upcomingAppointments: [{ isoDate: '2099-01-01', location }],
      pastAppointments: [{ isoDate: '2020-01-01', location: 'Synthetic Clinic' }],
    });
    const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
    await invoke(agent, 'lookup_schedule', args);
    const { first_name, last_name, date_of_birth, ...request } = opticalRequest;

    expect(await invoke(agent, 'create_ticket', { ...request, location_name })).toMatchObject({ success: true });
    expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({
      patientFullName: 'Alex Synthetic', patientDOB: '1970-01-02',
      locationOfLastVisit: 'Synthetic Clinic',
    }));
    expect(h.lookup).toHaveBeenCalledTimes(1);
  },
);

it('Optical asks when all held facilities are ineligible, then files without a location for human review', async () => {
  h.lookup.mockResolvedValue({ ...record,
    upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Synthetic Surgery Center' }],
    pastAppointments: [{ isoDate: '2020-01-01', location: 'Synthetic Virtual Visits' }],
  });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);

  expect(await invoke(agent, 'create_ticket', opticalRequest))
    .toMatchObject({ success: false, missingFields: ['office location'] });
  expect(h.submit).not.toHaveBeenCalled();

  expect(await invoke(agent, 'create_ticket', {
    ...opticalRequest, unresolved_info: 'Asked; caller does not know an optical office',
  })).toMatchObject({ success: true });
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ locationOfLastVisit: undefined }));
  expect(h.lookup).toHaveBeenCalledTimes(1);
});

it.each([
  { department_id: 1, location_name: 'Synthetic Caller Clinic', expected: 'Synthetic Caller Clinic' },
  { department_id: 1, location_id: 5, expected: 'Eastvale' },
  { department_id: 3, expected: 'Synthetic Surgery Center' },
])('preserves explicit clinics and non-Optical history (%j)', async ({ expected, ...route }) => {
  h.lookup.mockResolvedValue({ ...record,
    upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Synthetic Surgery Center' }],
  });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);

  expect(await invoke(agent, 'create_ticket', { ...opticalRequest, ...route })).toMatchObject({ success: true });
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ locationOfLastVisit: expected }));
});

it('Optical preserves an explicit clinic name over the location ID and held history', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);

  expect(await invoke(agent, 'create_ticket', {
    ...opticalRequest, location_id: 5, location_name: 'Synthetic Caller Clinic',
  })).toMatchObject({ success: true });
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ locationOfLastVisit: 'Synthetic Caller Clinic' }));
});

it('Optical preserves a caller-confirmed clinic when the held identity has no office history', async () => {
  h.lookup.mockResolvedValue({ ...record, upcomingAppointments: [], totalAppointmentsFound: 0 });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);
  rememberConfirmedClinic(sid, 'Synthetic Caller Clinic');
  const send = await captureHttpSubmission();

  expect(await invoke(agent, 'create_ticket', opticalRequest)).toMatchObject({ success: true });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][2]).toMatchObject({ locationOfLastVisit: 'Synthetic Caller Clinic',
    validatedPatient: { status: 'validated', callSid: sid } });
});

it.each([false, true])('Optical files a missing-clinic request for human review after asking (held identity: %s)', async (held) => {
  h.lookup.mockResolvedValue({ ...record, upcomingAppointments: [], totalAppointmentsFound: 0 });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  if (held) await invoke(agent, 'lookup_schedule', args);
  const request = held ? { ...opticalRequest, first_name: '', last_name: '', date_of_birth: '' } : opticalRequest;

  expect(await invoke(agent, 'create_ticket', request)).toMatchObject({ success: false });
  expect(h.submit).not.toHaveBeenCalled();

  const unresolved_info = 'Asked for the office; caller does not know which clinic they visit';
  expect(await invoke(agent, 'create_ticket', { ...request, unresolved_info }))
    .toMatchObject({ success: true, department: 'Optical Support' });
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({
    patientFullName: 'Alex Synthetic', patientDOB: '1970-01-02',
    locationOfLastVisit: undefined, callSid: sid,
    reasonForCalling: expect.stringContaining(`NEEDS HUMAN REVIEW — could not complete on the call. Missing: ${unresolved_info}`),
  }));
});

it.each([undefined, '', '   '])('Optical still asks for a missing clinic without a cannot-provide note (%j)', async (unresolved_info) => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  const result = await invoke(agent, 'create_ticket', { ...opticalRequest, unresolved_info });
  expect(result).toMatchObject({ success: false });
  expect(result.missingFields).toHaveLength(1);
  expect(result.missingFields[0]).toMatch(/location/);
  expect(h.submit).not.toHaveBeenCalled();
});

it('a cannot-provide clinic note does not bypass the DOB gate', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  expect(await invoke(agent, 'create_ticket', {
    ...opticalRequest, date_of_birth: '', unresolved_info: 'Caller cannot provide their clinic',
  })).toMatchObject({ success: false, missingFields: ['date_of_birth'] });
  expect(h.submit).not.toHaveBeenCalled();
});

it.each([2, 3])('department %s files without a clinic', async (department_id) => {
  h.lookup.mockResolvedValue({ ...record, upcomingAppointments: [], totalAppointmentsFound: 0 });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  expect(await invoke(agent, 'create_ticket', { ...opticalRequest, department_id, provider_name: 'Synthetic Surgeon' }))
    .toMatchObject({ success: true });
  expect(h.submit).toHaveBeenCalledTimes(1);
});

it.each([
  [{ first_name: '', last_name: '' }, 'first_name'],
  [{ first_name: 'Alex', last_name: '' }, 'last_name'],
])('asks for missing names before filing (%j)', async (names, field) => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  expect(await invoke(agent, 'create_ticket', { ...opticalRequest, ...names, location_name: 'Synthetic Clinic' }))
    .toMatchObject({ success: false, missingFields: [field] });
  expect(h.submit).not.toHaveBeenCalled();
});

it.each([true, false])('persists a unique secondary name+DOB match before submission (demographics returned: %s)', async (demographics) => {
  h.lookup.mockResolvedValue({ ...record, patientData: { ...(demographics ? record.patientData : {}), personId: 'synthetic-person' } });
  h.submit.mockImplementation(async () => {
    expect(validatedPatientFor(sid, args.first_name, args.last_name, args.date_of_birth)).toMatchObject({
      status: 'validated', personId: 'synthetic-person', dateOfBirth: '1970-01-02',
      nextAppointment: { date: '2099-01-01', location: 'Synthetic Clinic' },
    });
    return { success: true, ticketNumber: 'VA-SYNTHETIC' };
  });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  expect(await invoke(agent, 'create_ticket', { ...opticalRequest, location_name: 'Synthetic Clinic' }))
    .toMatchObject({ success: true });
  expect(h.lookup).toHaveBeenCalledTimes(1);
});

it.each([
  { identity: { unique: false } },
  { identityUnconfirmed: true },
  { matchedBy: 'phone' },
])('does not validate uncertain secondary results (%j)', async (uncertain) => {
  h.lookup.mockResolvedValue({ ...record, ...uncertain });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'create_ticket', { ...opticalRequest, location_name: 'Synthetic Clinic' });
  expect(validatedPatientFor(sid)).toBeUndefined();
});

// Drive the real simplified service and HTTP client, intercepting only their
// final request. A handler-only spy misses automatic held-identity attachment.
it.each([
  ['Synthetic Surgery Center', 'Synthetic Last Clinic', 'Synthetic Usual Clinic', undefined],
  ['Synthetic Next Clinic', 'Synthetic Surgery Center', 'Synthetic Usual Clinic', undefined],
  ['Synthetic Surgery Center', 'Synthetic Virtual Visits', 'Synthetic Usual Clinic', undefined],
  ['Synthetic Surgery Center', 'Synthetic Surgery Center', 'Synthetic Virtual Visits', undefined],
  [undefined, undefined, 'Synthetic Surgery Center', undefined],
  [undefined, undefined, 'Synthetic Usual Clinic', undefined],
  ['Synthetic Surgery Center', 'Synthetic Surgery Center', 'Synthetic Surgery Center', 'Synthetic Caller Clinic'],
  ['Synthetic Surgery Center', 'Synthetic Last Clinic', 'Synthetic Surgery Center', 'id-only'],
  ['Synthetic Next Clinic', 'Synthetic Last Clinic', 'Synthetic Usual Clinic', undefined],
])('filters held Optical history through the HTTP boundary: %s / %s / %s / %s', async (nextOffice, lastOffice, usualOffice, explicit) => {
  const nextAppointment = nextOffice ? { date: '2099-01-01', location: nextOffice } : undefined;
  const lastVisit = lastOffice ? { date: '2020-01-01', location: lastOffice } : undefined;
  h.lookup.mockResolvedValue({ ...record,
    upcomingAppointments: nextOffice ? [{ isoDate: '2099-01-01', location: nextOffice }] : [],
    pastAppointments: lastOffice ? [{ isoDate: '2020-01-01', location: lastOffice }] : [],
    lastLocationSeen: usualOffice,
  });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);
  rememberVerifiedIdentity(sid, { ...record.patientData, certain: true, personId: 'synthetic-person',
    nextAppointment, lastVisit, usualOffice });
  const held = validatedPatientFor(sid);
  const send = await captureHttpSubmission();

  expect(await invoke(agent, 'create_ticket', { ...opticalRequest,
    ...(explicit === 'id-only' ? { location_id: 5 } : { location_name: explicit }),
    unresolved_info: 'Asked; caller cannot provide another clinic',
  })).toMatchObject({ success: true });

  expect(send).toHaveBeenCalledOnce();
  const payload = send.mock.calls[0][2] as any;
  const acceptable = (office?: string) => office && !['Synthetic Surgery Center', 'Synthetic Virtual Visits'].includes(office) ? office : undefined;
  expect(payload.validatedPatient).toMatchObject({ status: 'validated', callSid: sid,
    personId: 'synthetic-person', firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02' });
  expect(payload.validatedPatient.nextAppointment).toEqual(acceptable(nextOffice) ? nextAppointment : undefined);
  expect(payload.validatedPatient.lastVisit).toEqual(acceptable(lastOffice) ? lastVisit : undefined);
  expect(payload.validatedPatient.confirmedClinic).toBe(acceptable(usualOffice));
  expect(payload.locationOfLastVisit).toBe(explicit === 'id-only' ? 'Eastvale' : explicit ||
    acceptable(nextOffice) || acceptable(lastOffice) || acceptable(usualOffice));
  expect(JSON.stringify(payload)).not.toMatch(/Synthetic Surgery Center|Synthetic Virtual Visits/);
  expect(validatedPatientFor(sid)).toEqual(held);
  expect(h.lookup).toHaveBeenCalledTimes(1);
});

it.each([
  [false, 'Synthetic Virtual Visits'],
  [true, 'Synthetic Virtual Visits'],
  [false, 'Synthetic Last Clinic'],
  [true, 'Synthetic Last Clinic'],
])('filters a newly verified secondary Optical identity through the HTTP boundary (clinic known: %s, last visit: %s)', async (clinicKnown, lastOffice) => {
  h.lookup.mockResolvedValue({ ...record,
    upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Synthetic Surgery Center' }],
    pastAppointments: [{ isoDate: '2020-01-01', location: lastOffice }],
    lastLocationSeen: 'Synthetic Surgery Center',
  });
  const send = await captureHttpSubmission();
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  expect(await invoke(agent, 'create_ticket', { ...opticalRequest,
    ...(clinicKnown ? { location_name: 'Synthetic Caller Clinic' }
      : { unresolved_info: 'Asked; caller cannot provide a clinic' }),
  })).toMatchObject({ success: true });

  expect(send).toHaveBeenCalledOnce();
  const payload = send.mock.calls[0][2] as any;
  expect(payload.validatedPatient).toMatchObject({ status: 'validated', callSid: sid,
    firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02' });
  expect(payload.validatedPatient.nextAppointment).toBeUndefined();
  expect(payload.validatedPatient.lastVisit).toEqual(lastOffice === 'Synthetic Last Clinic'
    ? { date: '2020-01-01', location: lastOffice } : undefined);
  expect(payload.validatedPatient.confirmedClinic).toBeUndefined();
  expect(payload.locationOfLastVisit).toBe(clinicKnown ? 'Synthetic Caller Clinic'
    : lastOffice === 'Synthetic Last Clinic' ? lastOffice : undefined);
  expect(JSON.stringify(payload)).not.toMatch(/Synthetic Surgery Center|Synthetic Virtual Visits/);
  expect(h.lookup).toHaveBeenCalledTimes(1);
});

it.each([false, true])('Surgery files without asking for an unknown clinic through the HTTP boundary (held identity: %s)', async (held) => {
  h.lookup.mockResolvedValue({ ...record, upcomingAppointments: [], totalAppointmentsFound: 0 });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  if (held) await invoke(agent, 'lookup_schedule', args);
  const send = await captureHttpSubmission();

  expect(await invoke(agent, 'create_ticket', { ...opticalRequest,
    department_id: 2, provider_name: 'Synthetic Surgeon',
  })).toMatchObject({ success: true });
  expect(send).toHaveBeenCalledOnce();
  const payload = send.mock.calls[0][2] as any;
  expect(payload.locationOfLastVisit).toBeUndefined();
  expect(payload.validatedPatient).toMatchObject({ status: 'validated', callSid: sid });
  expect(h.lookup).toHaveBeenCalledTimes(1);
});
