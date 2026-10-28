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
import { resetVerifiedIdentities, rememberVerifiedIdentity } from './verifiedIdentity';
import { realtimeToolsFor } from './realtimeAdapter';
import './sharedPatientTools';

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
  identity: { unique: true, candidateCount: 1 },
  upcomingAppointments: [appointment], pastAppointments: [], totalAppointmentsFound: 1,
  scheduleReadStatus: 'available',
};
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
    // Exercise the initial joined lookup; an established identity is reused
    // without searching again and uses check_patient_appointments for details.
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
    lookupPatient.mockResolvedValue({ ...context, identity: { unique: false, candidateCount: 2 } });
    const result = await getTool('lookup_patient')!.handler({ caller_phone: '+15555550115', call_sid: sid });
    expect(result).toMatchObject({ appointment_access: 'identity_required' });
    expect(result).not.toHaveProperty('upcoming_appointments');
  });

  it('does not re-search an identified patient whose record lacks a person key', async () => {
    resetVerifiedIdentities();
    rememberVerifiedIdentity(sid, { firstName: 'Synthetic', lastName: 'Example', certain: true });
    expect(await run()).toMatchObject({ appointment_access: 'unavailable', scheduling_action: 'request_schedule_review' });
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
