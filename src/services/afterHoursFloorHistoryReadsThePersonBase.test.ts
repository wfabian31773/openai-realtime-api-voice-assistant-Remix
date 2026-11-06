/**
 * Codex review of v182: the floor's caller-ID history read used
 * `lookupByPhone`, which searches only appointment-row phone columns, so a
 * patient whose number lives only in `patients_master` gave no office. It now
 * reads through the REAL `lookupPatient` (person base first, PersonID join).
 * Only the appointment-book rungs, the join and `patientVerification` are
 * stubbed. Synthetic numbers and ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

const h = vi.hoisted(() => ({ verifyPatient: vi.fn(), findByPhone: vi.fn() }));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: vi.fn() } }));
vi.mock('./patientVerification', () => ({ verifyPatient: h.verifyPatient, findByPhone: h.findByPhone }));

const { scheduleLookupService } = await import('./scheduleLookupService');
const floor = await import('./afterHoursTeardownFloor');

const PERSON = {
  personId: '00000000-0000-4000-8000-0000000000bb', personNbr: null,
  firstName: 'Synthetic', lastName: 'Example', dob: '1970-01-01', hasMedicalRecord: true, language: null,
};
const EMPTY = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };
const svc = scheduleLookupService as unknown as Record<string, any>;

beforeEach(() => {
  process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://fake/console';
  h.verifyPatient.mockReset();
  h.findByPhone.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // The appointment book has no row carrying this number.
  for (const rung of ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName']) {
    vi.spyOn(svc, rung).mockResolvedValue(EMPTY);
  }
  vi.spyOn(svc, 'lookupByPersonId').mockImplementation(async (_id: unknown, matchedBy: unknown) => ({
    ...EMPTY, patientFound: true, matchedBy, totalAppointmentsFound: 1,
    identity: { unique: true, candidateCount: 1, candidates: [] }, lastLocationSeen: 'Redlands',
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OBS_CONSOLE_DATABASE_URL;
});

describe('caller-ID history on the after-hours floor', () => {
  it('finds the office for a number that is only in the patient master', async () => {
    h.findByPhone.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });
    const office = await floor.officeFromCallerHistory('+12025550100', 'CA-synthetic');
    expect(office).toBe('Redlands');
    expect(h.findByPhone).toHaveBeenCalledWith('+12025550100', undefined);
    expect(svc.lookupByPersonId).toHaveBeenCalledWith(PERSON.personId, 'phone', expect.any(Number));
    expect(svc.lookupByPhone).not.toHaveBeenCalled();
  });

  it('several people on the number in the patient master give no office', async () => {
    h.findByPhone.mockResolvedValue({ verified: false, reason: 'ambiguous', candidates: 3 });
    expect(await floor.officeFromCallerHistory('+12025550100', 'CA-synthetic')).toBeUndefined();
    expect(svc.lookupByPersonId).not.toHaveBeenCalled();
  });

  it('a patient-master failure is swallowed', async () => {
    h.findByPhone.mockRejectedValue(new Error('synthetic outage'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await floor.officeFromCallerHistory('+12025550100', 'CA-synthetic')).toBeUndefined();
  });
});
