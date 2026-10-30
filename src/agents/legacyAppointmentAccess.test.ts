import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db', () => ({ db: {}, pool: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: vi.fn(async () => {}) } }));
vi.mock('../services/callerMemoryService', () => ({
  CallerMemoryService: class { static getInstance() { return { getCallerMemory: async () => null }; } },
  callerMemoryService: {},
}));
vi.mock('../services/toolDirection', () => ({ withToolDirection: (_a: unknown, _c: unknown, _n: unknown, fn: unknown) => fn }));
vi.mock('../services/toolTimeline', () => ({ recordingExecute: (_c: unknown, _n: unknown, fn: unknown) => fn }));
const { lookupByNameAndDOB, lookupByPhone } = vi.hoisted(() => ({ lookupByNameAndDOB: vi.fn(), lookupByPhone: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: { lookupByNameAndDOB, lookupByPhone } }));
import { createNoIvrAgent, buildNoIvrSystemPrompt } from './noIvrAgent';
import { createAnsweringServiceAgent } from './answeringServiceAgent';
import { buildPcpPrompt } from './pcpAgent';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';

const record = {
  patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true },
  scheduleReadStatus: 'available', pastAppointments: [], totalAppointmentsFound: 1,
  upcomingAppointments: [{ isoDate: '2099-11-04', startTime: '9:30 AM', location: 'Example North', provider: 'Morgan Example, MD' }],
};
const patient = { first_name: 'Synthetic', last_name: 'Example', date_of_birth: '1980-01-02' };
const factories = [createNoIvrAgent, createAnsweringServiceAgent] as const;
const decode = (raw: unknown): any => typeof raw === 'string' ? JSON.parse(raw) : raw;
async function callLookup(factory: typeof factories[number], args = patient) {
  const agent = await factory(async () => {}, { callId: 'synthetic-item15' });
  const tool = agent.tools.find((t) => t.name === 'lookup_schedule')!;
  const raw = await (tool as any).invoke({}, JSON.stringify(args));
  return decode(raw);
}
beforeEach(() => {
  vi.clearAllMocks();
  resetVerifiedIdentities();
  lookupByNameAndDOB.mockResolvedValue(record);
  lookupByPhone.mockResolvedValue(record);
});
afterEach(() => vi.useRealTimers());

describe('item #15 existing appointment tools keep the same read-only policy', () => {
  it.each([undefined, 'runtime'] as const)('VA-75007: after-hours policy on pipeline %s reviews bookings first', (pipeline) => {
    const prompt = buildNoIvrSystemPrompt({ callId: 'synthetic-item15', pipeline });
    expect(prompt).toContain('Before an appointment request, use lookup_schedule');
    expect(prompt).toMatch(/same booking/i);
    expect(prompt).not.toContain('if the caller corrects you, trust the caller');
    expect(prompt).not.toMatch(/trust the caller over your data|accept caller's info as correct/i);
    expect(prompt).toContain('clarify the difference against the record');
  });
  it.each(factories)('withholds BOTH appointment result formats on an ambiguous name and DOB', async (factory) => {
    lookupByNameAndDOB.mockResolvedValue({ ...record, identity: { unique: false, candidateCount: 2 } });
    const result = await callLookup(factory);
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(JSON.stringify(result)).not.toMatch(/Example North|Morgan Example|2099-11-04/);
    expect(result).not.toHaveProperty('upcomingAppointments');
    expect(result).not.toHaveProperty('pastAppointments');
  });
  it.each(factories)('preserves appointment times, every booking, status and claim checks when reusing a validated schedule', async (factory) => {
    for (const state of [
      { scheduleReadStatus: 'available', scheduleTruncated: false, access: 'available', bookings: true },
      { scheduleReadStatus: 'available', scheduleTruncated: true, access: 'partial', bookings: true },
      { scheduleReadStatus: 'available', scheduleTruncated: true, access: 'partial', bookings: false },
      { scheduleReadStatus: 'unavailable', scheduleTruncated: false, access: 'unavailable', bookings: false },
    ]) {
      resetVerifiedIdentities();
      lookupByNameAndDOB.mockResolvedValue({
        ...record, ...state,
        patientData: { firstName: patient.first_name, lastName: patient.last_name, dateOfBirth: patient.date_of_birth, personId: 'synthetic-person' },
        upcomingAppointments: state.bookings ? [record.upcomingAppointments[0], {
          ...record.upcomingAppointments[0], isoDate: '2099-12-04', startTime: '2:00 PM',
        }] : [],
      });
      const agent = await factory(async () => {}, { callId: 'synthetic-repeat', callSid: `CA${'38'.repeat(16)}` });
      const tool = agent.tools.find((t) => t.name === 'lookup_schedule')!;
      const invoke = (args: Record<string, unknown>) => (tool as any).invoke({}, JSON.stringify(args));
      const args = { ...patient, office: 'Example South' };
      const fresh = decode(await invoke(args));
      const calls = lookupByNameAndDOB.mock.calls.length;
      // No DOB on the repeat: exercise the held-identity shortcut, including
      // answering service's path below its separate DOB-confirmation shortcut.
      const repeated = decode(await invoke({ office: args.office }));
      const fields = ['appointment_access', 'read_only', 'upcoming_appointments', 'has_upcoming_appointments',
        'provider_check', 'office_check', 'booking_details_match', 'scheduling_action', 'appointment_instruction'];
      for (const field of fields) expect(repeated[field], field).toEqual(fresh[field]);
      expect(repeated.appointment_access).toBe(state.access);
      if (state.bookings) expect(repeated.upcoming_appointments.map((a: any) => a.time)).toEqual(['9:30 AM', '2:00 PM']);
      expect(lookupByNameAndDOB).toHaveBeenCalledTimes(calls);
    }
  });
  it('does not disclose the answering-service phone candidate through its prompt or tool', async () => {
    lookupByPhone.mockResolvedValue({ ...record, matchedBy: 'phone' });
    const agent = await createAnsweringServiceAgent(async () => {}, {
      callId: 'synthetic-phone-item15', callLogId: 'synthetic-log', callerPhone: '+15555550115',
    });
    expect(String(agent.instructions)).not.toMatch(/Example North|Morgan Example/);
    const tool = agent.tools.find((t) => t.name === 'lookup_schedule')!;
    const result = decode(await (tool as any).invoke({}, JSON.stringify({ phone: '+15555550115' })));
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(JSON.stringify(result)).not.toMatch(/Example North|Morgan Example|2099-11-04/);
  });
  it.each([
    { unique: false, candidateCount: 2 },
    { unique: true, candidateCount: 1 },
  ])('does not let the cached DOB shortcut confirm an ambiguous or differently named patient (%j)', async (identity) => {
    lookupByPhone.mockResolvedValue({
      ...record, matchedBy: 'phone', identity,
      patientData: { firstName: 'Another', lastName: 'Example', dateOfBirth: patient.date_of_birth },
    });
    lookupByNameAndDOB.mockResolvedValue({ ...record, identity: { unique: false, candidateCount: 2 } });
    const agent = await createAnsweringServiceAgent(async () => {}, {
      callId: 'synthetic-cached-item15', callLogId: 'synthetic-log', callerPhone: '+15555550115',
    });
    const tool = agent.tools.find((t) => t.name === 'lookup_schedule')!;
    const result = decode(await (tool as any).invoke({}, JSON.stringify(patient)));
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(JSON.stringify(result)).not.toMatch(/Example North|Morgan Example|2099-11-04/);
    expect(lookupByNameAndDOB).toHaveBeenCalled();
  });
  it('keeps the unique cached record accessible after a matching name and DOB', async () => {
    lookupByPhone.mockResolvedValue({
      ...record, matchedBy: 'phone', patientData: { firstName: patient.first_name, lastName: patient.last_name, dateOfBirth: patient.date_of_birth },
    });
    const agent = await createAnsweringServiceAgent(async () => {}, {
      callId: 'synthetic-cached-match-item15', callLogId: 'synthetic-log', callerPhone: '+15555550115',
    });
    const tool = agent.tools.find((t) => t.name === 'lookup_schedule')!;
    const result = decode(await (tool as any).invoke({}, JSON.stringify(patient)));
    expect(result).toMatchObject({ appointment_access: 'available', verified: true });
    expect(lookupByNameAndDOB).not.toHaveBeenCalled();
  });
  it.each(factories)('reports a rejected schedule read as unavailable, with a request-taking exit', async (factory) => {
    lookupByNameAndDOB.mockRejectedValue(new Error('synthetic outage'));
    expect(await callLookup(factory)).toMatchObject({
      found: false, appointment_access: 'unavailable',
      has_upcoming_appointments: null, scheduling_action: 'request_schedule_review',
    });
  });
  it.each(factories)('preserves a failed read returned by the service instead of claiming no patient', async (factory) => {
    lookupByNameAndDOB.mockResolvedValue({
      patientFound: false, upcomingAppointments: [], pastAppointments: [],
      totalAppointmentsFound: 0, scheduleReadStatus: 'unavailable',
    });
    const result = await callLookup(factory);
    expect(result).toMatchObject({ found: false, appointment_access: 'unavailable', has_upcoming_appointments: null });
    expect(result.message ?? '').not.toMatch(/no patient|new patient/i);
  });
  it('prefers the supplied name and DOB over a phone candidate on the answering-service lane', async () => {
    expect(await callLookup(createAnsweringServiceAgent, { ...patient, phone: '+15555550115' } as typeof patient)).toMatchObject({
      appointment_access: 'available',
    });
    expect(lookupByNameAndDOB).toHaveBeenCalled();
    expect(lookupByPhone).not.toHaveBeenCalled();
  });
  it('marks the answering-service timeout unavailable rather than a missing patient', async () => {
    vi.useFakeTimers();
    lookupByNameAndDOB.mockImplementation(() => new Promise(() => {}));
    const result = callLookup(createAnsweringServiceAgent);
    await vi.advanceTimersByTimeAsync(5100);
    expect(await result).toMatchObject({ found: false, appointment_access: 'unavailable', has_upcoming_appointments: null });
  });
  it('VA-75007: PCP appointment policy respects its existing access gate', () => {
    expect(buildPcpPrompt()).toContain('Before an appointment request, use lookup_patient_appointments');
  });
  it.each([
    ['VA-74600', createNoIvrAgent], ['67478', createAnsweringServiceAgent],
  ] as const)('%s: the existing lookup_schedule compares a named office with the booking', async (_ticket, factory) => {
    lookupByNameAndDOB.mockResolvedValue({
      patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true },
      scheduleReadStatus: 'available', pastAppointments: [], totalAppointmentsFound: 1,
      upcomingAppointments: [{ isoDate: '2099-11-04', startTime: '9:30 AM', location: 'Example North', provider: 'Morgan Example, MD' }],
    });
    const agent = await factory(async () => {}, { callId: 'synthetic-item15' });
    expect(String(agent.instructions)).toContain('Before an appointment request, use lookup_schedule');
    const tool = agent.tools.find((t) => t.name === 'lookup_schedule')!;
    const raw = await (tool as any).invoke({}, JSON.stringify({
      first_name: 'Synthetic', last_name: 'Example', date_of_birth: '1980-01-02', office: 'Example South',
    }));
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(result).toMatchObject({ office_check: 'not_matched', scheduling_action: 'clarify_record_difference', read_only: true });
  });
});
