/**
 * THE PERSON BASE ANSWERS FIRST (v85).
 *
 * RULE ZERO: match on `patients_master`, validate, join on `PersonID`. Until
 * v84 the person base was the LAST rung of `lookupPatient`; this pins it as
 * the FIRST when the Console is configured, and pins that nothing moves for
 * the old order when it is not. Driven through the REAL service with the
 * three book rungs and the join stubbed, the pattern `lookupPersonBaseRung`
 * uses, and the Console gate taken from the same env the runtime reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});
const { verifyPatient, findByPhone } = vi.hoisted(() => ({ verifyPatient: vi.fn(), findByPhone: vi.fn() }));
vi.mock('./patientVerification', () => ({ verifyPatient, findByPhone }));

import { ScheduleLookupService } from './scheduleLookupService';

const PERSON = { personId: '00000000-0000-4000-8000-0000000000aa', personNbr: null, firstName: 'Testcaller', lastName: 'Mirror', dob: '1950-01-01', hasMedicalRecord: true, language: null };
const EMPTY = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };
const FROM_BOOK = { ...EMPTY, patientFound: true, patientName: 'Booked Patient', matchedBy: 'phone' as const, totalAppointmentsFound: 3 };
const FROM_JOIN = { ...EMPTY, patientFound: true, patientName: 'Testcaller Mirror', matchedBy: 'phone' as const, totalAppointmentsFound: 2, identity: { unique: true, candidateCount: 1, candidates: [] }, patientData: {} };

function svc(bookAnswers: unknown, joinAnswer: unknown = FROM_JOIN) {
  const s = new ScheduleLookupService() as unknown as Record<string, any>;
  for (const rung of ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName']) s[rung] = vi.fn().mockResolvedValue(bookAnswers);
  // The real join builds its context with the matchedBy it was handed; the stub echoes it.
  s.lookupByPersonId = vi.fn().mockImplementation(async (_id: string, matchedBy: string) => ({ ...(joinAnswer as any), matchedBy }));
  return s as unknown as ScheduleLookupService & Record<string, any>;
}
const bookCalls = (s: any) => ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName'].reduce((n, r) => n + s[r].mock.calls.length, 0);

beforeEach(() => {
  verifyPatient.mockReset();
  findByPhone.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OBS_CONSOLE_DATABASE_URL;
});

describe('with the Console configured, the person base is the first rung', () => {
  beforeEach(() => { process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://fake/console'; });

  it('a phone match in the person base answers, and the appointment book is never searched by string', async () => {
    findByPhone.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });
    const s = svc(FROM_BOOK);
    const ctx = await s.lookupPatient({ phone: '+15555550100' });
    expect(ctx.patientFound).toBe(true);
    expect(ctx.patientName).toBe('Testcaller Mirror');
    expect(ctx.matchedBy).toBe('phone');
    expect(ctx.identityUnconfirmed).toBe(true); // a phone match is a candidate, never an identity
    expect(bookCalls(s)).toBe(0);
    expect(s.lookupByPersonId).toHaveBeenCalledWith(PERSON.personId, 'phone', undefined);
  });

  it('a name and date of birth that verify answer as confirmed, before any string search', async () => {
    verifyPatient.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });
    const s = svc(FROM_BOOK);
    const ctx = await s.lookupPatient({ phone: '+15555550100', firstName: 'Testcaller', lastName: 'Mirror', dateOfBirth: '1950-01-01' });
    expect(ctx.identityUnconfirmed).toBe(false);
    expect(ctx.matchedBy).toBe('name_and_dob');
    expect(bookCalls(s)).toBe(0);
    expect(findByPhone).not.toHaveBeenCalled();
  });

  it('several people on the number is an ANSWER: ambiguity is returned, never traded for a string match', async () => {
    findByPhone.mockResolvedValue({ verified: false, reason: 'ambiguous', candidates: 3 });
    const s = svc(FROM_BOOK);
    const ctx = await s.lookupPatient({ phone: '+15555550100' });
    expect(ctx.patientFound).toBe(false);
    expect(ctx.identity).toEqual({ unique: false, candidateCount: 3, candidates: [] });
    expect(bookCalls(s)).toBe(0);
  });

  it('the affirmed first name is handed to the person base so a shared number can be narrowed there', async () => {
    findByPhone.mockResolvedValue({ verified: true, reason: 'match', candidates: 3, patient: PERSON, source: 'mirror' });
    const s = svc(FROM_BOOK);
    await s.lookupPatient({ phone: '+15555550100', firstName: 'Testcaller' });
    expect(findByPhone).toHaveBeenCalledWith('+15555550100', 'Testcaller');
  });

  it('when the person base finds nobody, the appointment book rungs still run, in their old order', async () => {
    findByPhone.mockResolvedValue({ verified: false, reason: 'no_match', candidates: 0 });
    const s = svc(FROM_BOOK);
    const ctx = await s.lookupPatient({ phone: '+15555550100' });
    expect(ctx.patientName).toBe('Booked Patient');
    expect(s.lookupByPhone).toHaveBeenCalledTimes(1);
    expect(findByPhone).toHaveBeenCalledTimes(1); // once, first — not again at the end
  });

  it('when the person base is unreachable, the book still answers and nobody is unidentified by an outage', async () => {
    findByPhone.mockResolvedValue({ verified: false, reason: 'unavailable', candidates: 0 });
    const s = svc(FROM_BOOK);
    const ctx = await s.lookupPatient({ phone: '+15555550100' });
    expect(ctx.patientName).toBe('Booked Patient');
  });

  it('nobody anywhere is still nobody', async () => {
    findByPhone.mockResolvedValue({ verified: false, reason: 'no_match', candidates: 0 });
    const s = svc(EMPTY);
    const ctx = await s.lookupPatient({ phone: '+15555550100' });
    expect(ctx.patientFound).toBe(false);
    expect(ctx.identity).toBeUndefined();
    // Asked FIRST and not again at the end: a second lookup cannot change the answer.
    expect(findByPhone).toHaveBeenCalledTimes(1);
    expect(bookCalls(s)).toBe(2); // phone and name; no date of birth was given
  });
});

describe('without the Console configured, the old order stands', () => {
  it('the appointment book answers first and the person base is not consulted', async () => {
    findByPhone.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });
    const s = svc(FROM_BOOK);
    const ctx = await s.lookupPatient({ phone: '+15555550100' });
    expect(ctx.patientName).toBe('Booked Patient');
    expect(findByPhone).not.toHaveBeenCalled();
  });
});
