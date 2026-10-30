import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupPatient, lookupByPersonId } = vi.hoisted(() => ({
  lookupPatient: vi.fn(), lookupByPersonId: vi.fn(),
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient, lookupByPersonId },
}));
vi.mock('../services/consoleDirectory', () => ({ isDirectoryConfigured: () => false }));
vi.mock('../services/toolTimeline', () => ({
  recordingExecute: (_ctx: unknown, _name: string, fn: unknown) => fn,
}));
import { getTool } from './registry';
import { resetVerifiedIdentities, rememberVerifiedIdentity, verifiedIdentityFor } from './verifiedIdentity';
import { realtimeToolsFor } from './realtimeAdapter';
import './sharedPatientTools';
import type { PatientScheduleContext } from '../services/scheduleLookupService';

const sid = `CA${'15'.repeat(16)}`;
const personId = '00000000-0000-4000-8000-000000000015';
const appointment = {
  isoDate: '2026-11-04', date: 'November 4, 2026', dayOfWeek: 'Wednesday',
  startTime: '9:30 AM', timeOfDay: '9:30 AM', location: 'Example North',
  provider: 'Morgan Example, MD', status: 'Active',
};
const context = {
  patientFound: true, matchedBy: 'name_and_dob',
  patientData: { firstName: 'Synthetic', lastName: 'Example', personId, dateOfBirth: '1980-01-02' },
  identity: { unique: true, candidateCount: 1, candidates: [] },
  upcomingAppointments: [appointment], pastAppointments: [], totalAppointmentsFound: 1,
  scheduleReadStatus: 'available',
} satisfies PatientScheduleContext;
const run = (args: Record<string, unknown> = {}) => {
  const tool = getTool('check_patient_appointments');
  expect(tool, 'item #15: the appointment check must be callable').toBeDefined();
  return tool!.handler({ ...args, call_sid: sid }) as Promise<any>;
};
beforeEach(() => {
  vi.clearAllMocks();
  resetVerifiedIdentities();
  rememberVerifiedIdentity(sid, { ...context.patientData, certain: true });
  lookupPatient.mockResolvedValue(context);
  lookupByPersonId.mockResolvedValue(context);
});

describe('item #15 joined appointment access', () => {
  it('VA-74600: lookup_patient carries provider, office and date/time it already read', async () => {
    // Exercise the initial joined lookup before any identity is held.
    resetVerifiedIdentities();
    const result = await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    expect(result).toMatchObject({
      appointment_access: 'available', upcoming_appointments: [{
        date: '2026-11-04', time: '9:30 AM', time_zone: 'America/Los_Angeles',
        office: 'Example North', provider: 'Morgan Example, MD',
      }],
    });
    expect(lookupByPersonId).not.toHaveBeenCalled();
  });

  it.each([
    ['available', false, 'available', [appointment, { ...appointment, isoDate: '2026-12-04', startTime: '', timeOfDay: 'Afternoon' }]],
    ['available', true, 'partial', [appointment]],
    ['available', true, 'partial', []],
    ['unavailable', false, 'unavailable', []],
    ['available', false, 'available', []],
  ] as const)('repeated lookup preserves the full %s schedule (partial=%s, %s)', async (scheduleReadStatus, scheduleTruncated, access, appointments) => {
    resetVerifiedIdentities();
    lookupPatient.mockResolvedValue({ ...context, scheduleReadStatus, scheduleTruncated, upcomingAppointments: appointments });
    const lookup = async () => await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid }) as Record<string, unknown>;
    const fresh = await lookup();
    const repeated = await lookup();
    // Every appointment-read field returned by the fresh lookup must survive.
    const fields = ['appointment_access', 'read_only', 'upcoming_appointments', 'has_upcoming_appointments',
      'provider_check', 'office_check', 'booking_details_match', 'scheduling_action', 'appointment_instruction'];
    for (const field of fields) expect(repeated[field], field).toEqual(fresh[field]);
    expect(repeated).toMatchObject({ appointment_access: access, identity_is_certain: true, read_only: true });
    if (appointments.length === 2) expect(repeated.upcoming_appointments).toEqual([
      { date: '2026-11-04', time: '9:30 AM', time_zone: 'America/Los_Angeles', office: 'Example North', provider: 'Morgan Example, MD' },
      { date: '2026-12-04', time: 'Afternoon', time_zone: 'America/Los_Angeles', office: 'Example North', provider: 'Morgan Example, MD' },
    ]);
    if (!appointments.length) expect(repeated.has_upcoming_appointments).toBe(access === 'available' ? false : null);
    expect(lookupPatient).toHaveBeenCalledTimes(1);
    expect(lookupByPersonId).not.toHaveBeenCalled();
    expect(verifiedIdentityFor(sid)).not.toHaveProperty('appointmentContext');
  });

  it('reads the held person key when validation did not cache a full schedule', async () => {
    const result = await getTool('lookup_patient')!.handler({ call_sid: sid });
    expect(result).toMatchObject({ appointment_access: 'available', upcoming_appointments: [{ time: '9:30 AM' }] });
    expect(lookupByPersonId).toHaveBeenCalledWith(personId, 'name_and_dob', expect.any(Number));
    expect(lookupPatient).not.toHaveBeenCalled();
  });

  it.each([
    { firstName: 'Another' }, { lastName: 'Different' },
    { dateOfBirth: '1990-02-03' }, { personId: '00000000-0000-4000-8000-000000000016' },
  ])('does not serve a full cache belonging to a different identity (%j)', async (patientData) => {
    rememberVerifiedIdentity(sid, { ...context.patientData, certain: true,
      appointmentContext: { ...context, patientData: { ...context.patientData, ...patientData } },
    });
    lookupByPersonId.mockResolvedValue({ ...context, scheduleReadStatus: 'unavailable', upcomingAppointments: [] });
    const result = await getTool('lookup_patient')!.handler({ call_sid: sid });
    expect(result).toMatchObject({ appointment_access: 'unavailable', has_upcoming_appointments: null });
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(lookupByPersonId).toHaveBeenCalledTimes(1);
  });

  it.each([
    { first_name: 'Another' }, { last_name: 'Different' }, { date_of_birth: '1990-02-03' },
  ])('checks supplied identity before reusing a full schedule (%j)', async (identity) => {
    resetVerifiedIdentities();
    await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    lookupPatient.mockResolvedValue({ ...context, identity: { unique: false, candidateCount: 2, candidates: [] } });
    const result = await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid, ...identity });
    expect(result).toMatchObject({ appointment_access: 'identity_required', identity_is_certain: false });
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(lookupPatient).toHaveBeenCalledTimes(2);
    expect(lookupByPersonId).not.toHaveBeenCalled();
  });

  it('a new call cannot read another call\'s full schedule cache', async () => {
    resetVerifiedIdentities();
    await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    const result = await getTool('lookup_patient')!.handler({ call_sid: `CA${'16'.repeat(16)}` });
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(lookupPatient).toHaveBeenCalledTimes(1);
  });

  it('replacing a same-named identity discards the previous full schedule', async () => {
    resetVerifiedIdentities();
    await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    const otherId = '00000000-0000-4000-8000-000000000016';
    rememberVerifiedIdentity(sid, { ...context.patientData, personId: otherId, certain: true });
    lookupByPersonId.mockResolvedValue({ ...context, scheduleReadStatus: 'unavailable', upcomingAppointments: [] });
    const result = await getTool('lookup_patient')!.handler({ call_sid: sid });
    expect(result).toMatchObject({ appointment_access: 'unavailable', has_upcoming_appointments: null });
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(lookupByPersonId).toHaveBeenCalledWith(otherId, 'name_and_dob', expect.any(Number));
  });

  it('an unconfirmed enrichment cannot replace a validated full schedule', async () => {
    resetVerifiedIdentities();
    await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    rememberVerifiedIdentity(sid, { ...context.patientData, certain: false,
      appointmentContext: { ...context, upcomingAppointments: [], scheduleReadStatus: 'unavailable' },
    });
    expect(await getTool('lookup_patient')!.handler({ call_sid: sid })).toMatchObject({
      appointment_access: 'available', upcoming_appointments: [{ time: '9:30 AM' }],
    });
    expect(lookupByPersonId).not.toHaveBeenCalled();
  });

  it('76186: a named provider that differs from the record is not confirmed', async () => {
    const result = await run({ provider: 'Other Example, MD' });
    expect(result).toMatchObject({ provider_check: 'not_matched', scheduling_action: 'clarify_record_difference' });
    expect(result.upcoming_appointments[0].provider).toBe('Morgan Example, MD');
    expect(lookupByPersonId).toHaveBeenCalledWith(personId, 'name_and_dob', expect.any(Number));
    expect(lookupPatient).not.toHaveBeenCalled();
  });

  it('67478: a named office that differs from the record is not confirmed', async () => {
    const result = await run({ office: 'Example South' });
    expect(result).toMatchObject({ office_check: 'not_matched', scheduling_action: 'clarify_record_difference' });
  });

  it('VA-75007: an existing booking requires review before a new appointment request', async () => {
    expect(await run()).toMatchObject({
      has_upcoming_appointments: true, scheduling_action: 'review_existing_booking', read_only: true,
    });
  });

  it('does not combine the provider from one appointment with the office from another', async () => {
    lookupByPersonId.mockResolvedValue({ ...context, upcomingAppointments: [appointment, {
      ...appointment, location: 'Example South', provider: 'Other Example, MD',
    }] });
    expect(await run({ provider: 'Morgan Example, MD', office: 'Example South' })).toMatchObject({
      provider_check: 'matched', office_check: 'matched', booking_details_match: false,
      scheduling_action: 'clarify_record_difference',
    });
  });

  it('normalizes titles and punctuation without inventing a different provider', async () => {
    expect(await run({ provider: 'Dr. Morgan Example', office: 'Azul Vision Example North' })).toMatchObject({
      provider_check: 'matched', office_check: 'matched', booking_details_match: true,
    });
  });

  it('distinguishes an empty schedule from a failed read', async () => {
    lookupByPersonId.mockResolvedValue({ ...context, upcomingAppointments: [] });
    expect(await run()).toMatchObject({ appointment_access: 'available', has_upcoming_appointments: false });
    lookupByPersonId.mockResolvedValue({ ...context, upcomingAppointments: [], scheduleReadStatus: 'unavailable' });
    const result = await run();
    expect(result).toMatchObject({ appointment_access: 'unavailable', scheduling_action: 'request_schedule_review' });
    expect(result.has_upcoming_appointments).toBeNull();
  });

  it('does not call a capped result a complete empty schedule', async () => {
    lookupByPersonId.mockResolvedValue({ ...context, upcomingAppointments: [], scheduleTruncated: true });
    expect(await run()).toMatchObject({ appointment_access: 'partial', has_upcoming_appointments: null });
  });

  it.each([false, undefined])('withholds appointments without a certain stored match (%s)', async (certain) => {
    resetVerifiedIdentities();
    if (certain === false) rememberVerifiedIdentity(sid, { ...context.patientData, certain });
    const result = await run({ person_id: personId });
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(lookupByPersonId).not.toHaveBeenCalled();
  });

  it('never exposes new appointment fields on an ambiguous lookup', async () => {
    // An initial lookup must reach the service, rather than reuse the held identity.
    resetVerifiedIdentities();
    lookupPatient.mockResolvedValue({ ...context, identity: { unique: false, candidateCount: 2 } });
    const result = await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(lookupPatient).toHaveBeenCalledTimes(1);
    expect(verifiedIdentityFor(sid)).toBeUndefined();
  });

  it('withholds appointments when an explicitly corrected identity lookup is ambiguous', async () => {
    resetVerifiedIdentities();
    await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    lookupPatient.mockResolvedValue({ ...context, identity: { unique: false, candidateCount: 2 } });
    const result = await getTool('lookup_patient')!.handler({
      caller_phone: '+15555550115', call_sid: sid, identity_corrected: true,
    });
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(lookupPatient).toHaveBeenCalledTimes(2);
    expect(verifiedIdentityFor(sid)).toBeUndefined();
  });

  it('does not re-search an identified patient whose record lacks a person key', async () => {
    resetVerifiedIdentities();
    rememberVerifiedIdentity(sid, { firstName: 'Synthetic', lastName: 'Example', certain: true });
    expect(await run()).toMatchObject({ appointment_access: 'unavailable', scheduling_action: 'request_schedule_review' });
    expect(lookupPatient).not.toHaveBeenCalled();
    expect(lookupByPersonId).not.toHaveBeenCalled();
  });

  it('lookup_patient also reports unavailable when a held identity has no full cache or person key', async () => {
    resetVerifiedIdentities();
    rememberVerifiedIdentity(sid, { firstName: 'Synthetic', lastName: 'Example', certain: true });
    expect(await getTool('lookup_patient')!.handler({ call_sid: sid })).toMatchObject({
      found: true, identity_is_certain: true, appointment_access: 'unavailable', has_upcoming_appointments: null,
    });
    expect(lookupPatient).not.toHaveBeenCalled();
    expect(lookupByPersonId).not.toHaveBeenCalled();
  });

  it('withholds a read that completes after the call switched patients', async () => {
    lookupByPersonId.mockImplementation(async () => {
      rememberVerifiedIdentity(sid, { firstName: 'Another', lastName: 'Example', personId: '00000000-0000-4000-8000-000000000016', certain: true });
      return context;
    });
    const result = await run();
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(result).not.toHaveProperty('upcoming_appointments');
  });

  it('lookup_patient withholds a fallback read if the identity changes during it', async () => {
    lookupByPersonId.mockImplementation(async () => {
      rememberVerifiedIdentity(sid, { ...context.patientData, dateOfBirth: '1990-02-03', certain: true });
      return context;
    });
    const result = await getTool('lookup_patient')!.handler({ call_sid: sid });
    expect(result).toMatchObject({ found: false, identity_is_certain: false, appointment_access: 'identity_required' });
    expect(result).not.toHaveProperty('upcoming_appointments');
    expect(result).not.toHaveProperty('patient_name');
  });

  it('takes the call id from the adapter and excludes patient identifiers from the model schema', async () => {
    expect(getTool('check_patient_appointments')).toBeDefined();
    const [tool] = realtimeToolsFor(['check_patient_appointments'], { call_sid: sid });
    expect(tool.parameters.properties).not.toHaveProperty('person_id');
    expect(tool.parameters.properties).not.toHaveProperty('call_sid');
    const result = JSON.parse(await (tool as any).invoke({}, JSON.stringify({ call_sid: `CA${'99'.repeat(16)}`, person_id: 'other' })));
    expect(result.appointment_access).toBe('available');
    expect(lookupByPersonId.mock.calls[0][0]).toBe(personId);
  });
});
