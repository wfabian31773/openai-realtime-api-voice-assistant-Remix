/**
 * THE APPOINTMENT BOOK IS NOT THE PERSON BASE.
 *
 * `lookupPatient`'s three rungs all read `schedule` — the Operations Hub's
 * appointment book — so a real patient with no appointment inside its window
 * cannot be found, and from outside that looks random rather than structural.
 * Standing instruction 14 puts identity in the Eye Care Patient Console.
 *
 * MEASURED 2026-09-12, ten days of queue calls, duration >= 30: 627 of 2,511
 * substantive calls (25.0%) ran this and found NOBODY, 235 of those ended with
 * no ticket, and 208 of the 330 distinct caller numbers behind them (63%) ARE
 * in `patients_master`.
 *
 * WHAT THESE PIN IS THE ORDERING, because that is the whole safety argument.
 * The new rung runs ONLY where the method already returned `emptyContext()`,
 * so it can add a match and can never change one the schedule made. The first
 * test is the one to keep if any survive.
 *
 * Every fixture is invented. No production caller appears here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

const { verifyPatient, findByPhone } = vi.hoisted(() => ({
  verifyPatient: vi.fn(),
  findByPhone: vi.fn(),
}));
vi.mock('./patientVerification', () => ({ verifyPatient, findByPhone }));

import { ScheduleLookupService } from './scheduleLookupService';

const PERSON = {
  personId: 'p-1', personNbr: null,
  firstName: 'Testcaller', lastName: 'Mirror',
  dob: '1950-01-01', hasMedicalRecord: true, language: null,
};

const EMPTY = {
  patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
};
const FROM_BOOK = {
  ...EMPTY, patientFound: true, patientName: 'Booked Patient', matchedBy: 'phone' as const,
  totalAppointmentsFound: 3,
};

function svc(scheduleAnswers: unknown) {
  const s = new ScheduleLookupService() as unknown as Record<string, unknown>;
  for (const rung of ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName']) {
    s[rung] = vi.fn().mockResolvedValue(scheduleAnswers);
  }
  return s as unknown as ScheduleLookupService;
}

beforeEach(() => { verifyPatient.mockReset(); findByPhone.mockReset(); });

describe('the person base is asked only after the appointment book gives up', () => {
  it('is NOT consulted when the schedule already found the patient', async () => {
    /**
     * The safety property, and the reason this change is additive. 1,214 calls
     * in ten days currently reach a certain match through the rungs above; not
     * one of them may take a different path because of this.
     */
    const out = await svc(FROM_BOOK).lookupPatient({ phone: '5555550147' });

    expect(out.patientName).toBe('Booked Patient');
    expect(verifyPatient).not.toHaveBeenCalled();
    expect(findByPhone).not.toHaveBeenCalled();
  });

  it('identifies a caller the book has never seen, by phone', async () => {
    findByPhone.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });

    const out = await svc(EMPTY).lookupPatient({ phone: '5555550147' });

    expect(out.patientFound).toBe(true);
    expect(out.matchedBy).toBe('phone');
    expect(out.patientData?.dateOfBirth).toBe('1950-01-01');
    expect(out.identity).toMatchObject({ unique: true, candidateCount: 1 });
    // No history, and that is correct: no appointments is WHY the book missed
    // them. An empty list here is honest; a fabricated one would route on air.
    expect(out.totalAppointmentsFound).toBe(0);
    expect(out.pastAppointments).toEqual([]);
  });

  it('REFUSES to pick when the number belongs to more than one person', async () => {
    // 157,001 of 1,095,736 numbers in the mirror are shared. Instruction 6:
    // verification refuses to guess between two people.
    findByPhone.mockResolvedValue({ verified: false, reason: 'ambiguous', candidates: 3 });

    const out = await svc(EMPTY).lookupPatient({ phone: '5555550147' });

    expect(out.patientFound).toBe(false);
    expect(out.patientData).toBeUndefined();
    // Reported, not swallowed — `identity_is_certain` downstream reads this.
    expect(out.identity).toMatchObject({ unique: false, candidateCount: 3 });
  });

  it('prefers the name and date of birth the caller actually said', async () => {
    verifyPatient.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });
    findByPhone.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });

    const out = await svc(EMPTY).lookupPatient({
      phone: '5555550147', firstName: 'Testcaller', lastName: 'Mirror', dateOfBirth: '01/01/1950',
    });

    expect(out.matchedBy).toBe('name_and_dob');
    expect(findByPhone).not.toHaveBeenCalled();
  });

  it('stays silent when the mirror is unreachable', async () => {
    // An outage must leave the ladder's own answer alone, not manufacture one.
    findByPhone.mockResolvedValue({ verified: false, reason: 'unavailable', candidates: 0 });

    const out = await svc(EMPTY).lookupPatient({ phone: '5555550147' });

    expect(out.patientFound).toBe(false);
    expect(out.identity).toBeUndefined();
  });
});
