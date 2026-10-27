import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchFactsForPerson, hubLimit, findByPhone } = vi.hoisted(() => ({
  fetchFactsForPerson: vi.fn(), hubLimit: vi.fn(), findByPhone: vi.fn(),
}));
vi.mock('./consoleScheduleFacts', () => ({ isConsoleScheduleConfigured: () => true, fetchFactsForPerson }));
vi.mock('./patientVerification', () => ({ findByPhone, verifyPatient: vi.fn() }));
vi.mock('../../server/db', () => {
  const chain: any = {};
  for (const name of ['select', 'from', 'where', 'orderBy']) chain[name] = () => chain;
  chain.limit = hubLimit;
  return { db: chain };
});
import { scheduleLookupService } from './scheduleLookupService';

const personId = '00000000-0000-4000-8000-000000000015';
const row = (overrides = {}) => ({
  personId, patientFirstName: 'Synthetic', patientLastName: 'Example',
  appointmentDate: '2099-11-04', appointmentStart: '0930', appointmentStatus: 'Active',
  renderingPhysician: 'Morgan Example, MD', officeLocation: 'Example North', ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
  hubLimit.mockRejectedValue(new Error('synthetic outage'));
  findByPhone.mockResolvedValue({ verified: true, patient: {
    personId, firstName: 'Synthetic', lastName: 'Example', dob: '1980-01-02',
  } });
});

describe('item #15 real joined schedule reader', () => {
  it('VA-74600: returns the complete upcoming list, with removed bookings excluded', async () => {
    fetchFactsForPerson.mockResolvedValue([
      ...Array.from({ length: 7 }, (_, i) => row({ appointmentDate: `2099-11-${String(i + 4).padStart(2, '0')}` })),
      row({ appointmentStatus: 'Removed' }),
    ]);
    const result = await scheduleLookupService.lookupByPersonId(personId, 'name_and_dob');
    expect(result.upcomingAppointments).toHaveLength(7);
    expect(result).toMatchObject({ scheduleReadStatus: 'available', scheduleTruncated: false });
    expect(result.upcomingAppointments[0]).toMatchObject({ startTime: '9:30 AM', location: 'Example North', provider: 'Morgan Example, MD' });
    expect(hubLimit).not.toHaveBeenCalled();
  });

  it('VA-75007: empty, failed and skipped joins cannot all mean no bookings', async () => {
    fetchFactsForPerson.mockResolvedValue([]);
    expect(await scheduleLookupService.lookupByPersonId(personId, 'phone')).toMatchObject({ scheduleReadStatus: 'available' });
    fetchFactsForPerson.mockRejectedValue(new Error('synthetic outage'));
    expect(await scheduleLookupService.lookupByPersonId(personId, 'phone')).toMatchObject({ scheduleReadStatus: 'unavailable' });
    expect(await scheduleLookupService.lookupByPersonId(personId, 'phone', Date.now() - 1)).toMatchObject({ scheduleReadStatus: 'unavailable' });
  });

  it('keeps the known identity and the failed-read signal together through lookupPatient', async () => {
    fetchFactsForPerson.mockRejectedValue(new Error('synthetic outage'));
    expect(await scheduleLookupService.lookupPatient({ phone: '+15555550115' })).toMatchObject({
      patientFound: true, patientData: { personId }, scheduleReadStatus: 'unavailable',
    });
  });

  it('marks the existing 60-row read limit as partial instead of promising completeness', async () => {
    fetchFactsForPerson.mockResolvedValue(Array.from({ length: 60 }, () => row({ appointmentStatus: 'Removed' })));
    expect(await scheduleLookupService.lookupByPersonId(personId, 'name_and_dob')).toMatchObject({
      scheduleReadStatus: 'available', scheduleTruncated: true, upcomingAppointments: [],
    });
  });

  it('keeps failed legacy name and phone reads distinct from successful misses', async () => {
    for (const read of [
      () => scheduleLookupService.lookupByPhone('+15555550115'),
      () => scheduleLookupService.lookupByName('Synthetic', 'Example'),
      () => scheduleLookupService.lookupByNameAndDOB('Synthetic', 'Example', '1980-01-02'),
    ]) {
      hubLimit.mockRejectedValue(new Error('synthetic outage'));
      expect(await read()).toMatchObject({ patientFound: false, scheduleReadStatus: 'unavailable' });
      hubLimit.mockResolvedValue([]);
      expect(await read()).toMatchObject({ patientFound: false, scheduleReadStatus: 'available' });
    }
  });
});
