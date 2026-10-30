import { beforeEach, expect, it, vi } from 'vitest';

// Run real handlers, service mapping and ticket client; intercept only storage,
// schedule/directory lookups and the final HTTP request. All data is synthetic.
vi.mock('@openai/agents/realtime', () => ({
  RealtimeAgent: class { constructor(options: object) { Object.assign(this, options); } },
  tool: (definition: { parameters: { parse(input: unknown): unknown }; execute(input: unknown): unknown }) => ({
    ...definition,
    invoke: (_context: unknown, raw: string) => definition.execute(definition.parameters.parse(JSON.parse(raw))),
  }),
}));
const h = vi.hoisted(() => ({ phone: vi.fn(), secondary: vi.fn() }));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {
  updateCallLog: async () => {}, claimTicketCreation: async () => ({ claimed: true }),
  releaseTicketCreationLock: async () => {},
} }));
vi.mock('../services/toolTimeline', () => ({ recordingExecute: (_ctx: unknown, _name: string, execute: unknown) => execute }));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: {
  lookupByPhone: h.phone, lookupByNameAndDOB: h.secondary, formatContextForAgent: () => '',
} }));
// Exercise the legacy service's direct fallback; outbox retry transport has its
// own tests, including preservation of both text and ID provenance.
vi.mock('../services/ticketOutboxService', () => ({ TicketOutboxService: {
  writeToOutbox: async () => { throw new Error('synthetic unavailable outbox'); },
} }));

import { createNoIvrAgent } from './noIvrAgent';
import { createNoIvrAgentV2 } from './noIvrAgentV2';
import { createAfterHoursAgent } from './afterHoursAgent';
import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import { rememberConfirmedClinic, rememberVerifiedIdentity, resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { validatedPatientFor } from '../tools/ticketIdentity';
import * as directory from '../services/consoleDirectory';

const sid = 'CA' + 'c'.repeat(32);
const surgery = 'Synthetic Surgery Center';
const virtual = 'Synthetic Virtual Visits';
const clinic = 'Synthetic Optical Clinic';
const empty = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };
const metadata = { callId: 'synthetic-location-call', callSid: sid, callerPhone: '5555550100' };
const demographics = { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02' };
const request = { first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '1970-01-02',
  callback_number: '5555550100', request_category: 'general_question', request_summary: 'When will my glasses be ready?' };

beforeEach(() => {
  vi.restoreAllMocks();
  resetVerifiedIdentities();
  h.phone.mockReset().mockResolvedValue(empty);
  h.secondary.mockReset().mockResolvedValue(empty);
  vi.spyOn(directory, 'isDirectoryConfigured').mockReturnValue(true);
  vi.spyOn(directory, 'lookupLocation').mockImplementation(async (name) => ({
    canonical: name, key: name.toLowerCase(), volume90d: 1,
    facilityKind: name === surgery ? 'surgery_center' : name === virtual ? 'virtual' : 'clinic',
  }));
  vi.spyOn(ticketingApiClient as any, 'warmUpIfStale').mockResolvedValue(true);
  vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValue({ success: true, locationId: 91 });
  vi.spyOn(ticketingApiClient as any, 'makeRequest').mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
});

async function invoke(agent: any, name: string, input: Record<string, unknown>) {
  const raw = await agent.tools.find((t: any) => t.name === name).invoke({}, JSON.stringify(input));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
const payload = () => vi.mocked((ticketingApiClient as any).makeRequest).mock.lastCall?.[2] as any;

it.each(['held', 'secondary'])(
  'no-IVR filters a next-appointment location hydrated from %s identity before HTTP submission', async (mode) => {
    const nextAppointment = { date: '2099-01-01', location: surgery };
    const lastVisit = { date: '2020-01-01', location: clinic };
    if (mode === 'held') rememberVerifiedIdentity(sid, { ...demographics, certain: true, nextAppointment, lastVisit, usualOffice: surgery });
    else h.secondary.mockResolvedValue({ ...empty, patientFound: true, matchedBy: 'name_and_dob',
      identity: { unique: true }, patientData: demographics,
      upcomingAppointments: [{ isoDate: nextAppointment.date, location: surgery }],
      pastAppointments: [{ isoDate: lastVisit.date, location: clinic }], totalAppointmentsFound: 2 });
    const agent = await createNoIvrAgent(async () => {}, metadata);
    expect(await invoke(agent, 'create_ticket', request)).toMatchObject({ success: true });
    expect(payload()).toMatchObject({ locationOfLastVisit: clinic, locationSource: 'history',
      validatedPatient: { nextAppointment: undefined, lastVisit } });
    expect(payload().departmentId).toBeUndefined();
    expect(validatedPatientFor(sid)).toMatchObject({ nextAppointment, lastVisit });
  },
);

it.each([undefined, '', '   '])('no-IVR clears fully ineligible history with no caller office (%j)', async (location) => {
  rememberVerifiedIdentity(sid, { ...demographics, certain: true, usualOffice: surgery,
    nextAppointment: { date: '2099-01-01', location: surgery }, lastVisit: { date: '2020-01-01', location: virtual } });
  const agent = await createNoIvrAgent(async () => {}, metadata);
  expect(await invoke(agent, 'create_ticket', { ...request, location })).toMatchObject({ success: true });
  expect(payload()).toMatchObject({ locationOfLastVisit: undefined,
    validatedPatient: { nextAppointment: undefined, lastVisit: undefined, confirmedClinic: undefined } });
});

it.each([false, true])('no-IVR preserves a caller office even when it is a surgery center (confirmed earlier: %s)', async (earlier) => {
  if (earlier) rememberConfirmedClinic(sid, surgery);
  else rememberVerifiedIdentity(sid, { ...demographics, certain: true,
    nextAppointment: { date: '2099-01-01', location: surgery } });
  const agent = await createNoIvrAgent(async () => {}, metadata);
  expect(await invoke(agent, 'create_ticket', { ...request, ...(earlier ? {} : { location: surgery }) })).toMatchObject({ success: true });
  expect(payload()).toMatchObject({ locationOfLastVisit: surgery, locationSource: 'caller' });
});

it('no-IVR filters a schedule-only location even without a validated identity', async () => {
  h.secondary.mockResolvedValue({ ...empty, patientFound: true, matchedBy: 'phone',
    identityUnconfirmed: true, lastLocationSeen: surgery });
  const agent = await createNoIvrAgent(async () => {}, metadata);
  expect(await invoke(agent, 'create_ticket', request)).toMatchObject({ success: true });
  expect(payload()).toMatchObject({ locationOfLastVisit: undefined, locationSource: 'history' });
  expect(payload().validatedPatient).toBeUndefined();
});

it.each([null, surgery])('after-hours filters held history and preserves a caller location (%j)', async (location_name) => {
  rememberVerifiedIdentity(sid, { ...demographics, certain: true,
    nextAppointment: { date: '2099-01-01', location: surgery }, lastVisit: { date: '2020-01-01', location: clinic } });
  const agent = await createAfterHoursAgent(async () => {}, undefined, metadata);
  expect(await invoke(agent, 'create_after_hours_ticket', {
    patient_first_name: 'Alex', patient_last_name: 'Synthetic', phone_number: '5555550100', triage_outcome: 'general_question',
    description: 'When will my glasses be ready?', patient_birth_month: '01', patient_birth_day: '02', patient_birth_year: '1970',
    patient_email: null, provider_name: null, location_name, pharmacy_name: null, medication_name: null,
  })).toMatchObject({ success: true });
  expect(payload()).toMatchObject({ locationOfLastVisit: location_name || clinic,
    locationSource: location_name ? 'caller' : 'history', validatedPatient: { nextAppointment: undefined } });
});

it.each([undefined, clinic])('no-IVR V2 carries phone pre-context provenance through legacy mapping (%s)', async (location) => {
  h.phone.mockResolvedValue({ ...empty, patientFound: true, lastLocationSeen: surgery });
  const agent = await createNoIvrAgentV2(async () => {}, metadata);
  expect(await invoke(agent, 'create_ticket', { ...request, location })).toMatchObject({ success: true });
  // The legacy taxonomy maps this category to explicit Tech (3), which keeps history.
  expect(payload()).toMatchObject({ departmentId: 3, locationOfLastVisit: location || surgery,
    locationSource: location ? 'caller' : 'history', locationId: 91 });
});
