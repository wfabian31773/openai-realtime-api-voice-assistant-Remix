/**
 * THE PERSONID JOIN READS THE CONSOLE.
 *
 * Driven through the REAL `scheduleLookupService` and the REAL
 * `appointmentsForPerson`, with the Console fetch and the Hub `db` chain both
 * faked, so the assertion is about WHICH source answered and what
 * `buildContext` made of it — not about the mapping (that is
 * `consoleScheduleFacts.test.ts`) and not about a helper nobody calls
 * (failure mode 10).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchFactsForPerson = vi.fn();
let configured = true;
vi.mock('./consoleScheduleFacts', () => ({
  isConsoleScheduleConfigured: () => configured,
  fetchFactsForPerson,
}));

// The Hub chain: every step returns the chain; the terminal `limit` resolves rows.
const hubLimit = vi.fn();
const chain: any = {};
for (const step of ['select', 'from', 'where', 'orderBy']) chain[step] = () => chain;
chain.limit = (...a: any[]) => hubLimit(...a);
vi.mock('../../server/db', () => ({ db: chain, pool: { query: vi.fn() } }));
vi.mock('./patientVerification', () => ({
  verifyPatient: vi.fn(),
  findByPhone: vi.fn(),
  getConsolePool: vi.fn(),
}));

const PERSON = '00000000-0000-4000-8000-0000000000aa';
const consoleRow = (over: Record<string, any> = {}) => ({
  appointmentDate: '2026-10-20',
  appointmentStart: '0900',
  appointmentEnd: '0915',
  sessionPartOfDay: null,
  appointmentStatus: 'Active',
  personId: PERSON,
  officeLocation: 'San Bernardino',
  officeLocationType: 'Clinic',
  renderingPhysician: 'Example Surgeon, MD',
  providerFromAppt: 'Example Surgeon, MD',
  doctorType: 'Retina',
  serviceCategory1: 'Follow Up',
  patientFirstName: 'Test',
  patientLastName: 'Patient',
  patientDateOfBirth: '1970-01-01',
  patientEmailAddress: null,
  patientCellPhone: null,
  patientHomePhone: null,
  patientLanguage: null,
  ...over,
});

beforeEach(() => {
  configured = true;
  fetchFactsForPerson.mockReset();
  hubLimit.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('lookupByPersonId', () => {
  it('reads the Console when the pool is configured, and the Hub copy is never asked', async () => {
    fetchFactsForPerson.mockResolvedValue([
      consoleRow(),
      consoleRow({ appointmentDate: '2026-08-01', renderingPhysician: 'Example Optom, OD', providerFromAppt: 'Example Optom, OD', doctorType: 'OD', officeLocation: 'Pasadena' }),
    ]);
    const { scheduleLookupService } = await import('./scheduleLookupService');
    const ctx = await scheduleLookupService.lookupByPersonId(PERSON, 'phone');
    expect(fetchFactsForPerson).toHaveBeenCalledWith(PERSON, expect.any(Number));
    expect(hubLimit).not.toHaveBeenCalled();
    expect(ctx.patientFound).toBe(true);
    expect(ctx.upcomingAppointments[0]?.location).toBe('San Bernardino');
    expect(ctx.lastPhysicianSeen).toBe('Example Surgeon, MD'); // Retina counts; the OD does not
    expect(ctx.lastLocationSeen).toBe('Pasadena');
    expect(ctx.patientData?.personId).toBe(PERSON);
    expect(ctx.identity?.unique).toBe(true);
  });

  it('reads the Hub copy when the Console pool is not configured', async () => {
    configured = false;
    hubLimit.mockResolvedValue([consoleRow({ officeLocation: 'Redlands' })]);
    const { scheduleLookupService } = await import('./scheduleLookupService');
    const ctx = await scheduleLookupService.lookupByPersonId(PERSON, 'name_and_dob');
    expect(fetchFactsForPerson).not.toHaveBeenCalled();
    expect(hubLimit).toHaveBeenCalled();
    expect(ctx.upcomingAppointments[0]?.location).toBe('Redlands');
  });

  it('falls back to the Hub copy, loudly, when the Console does not answer', async () => {
    fetchFactsForPerson.mockRejectedValue(new Error('console unreachable'));
    hubLimit.mockResolvedValue([consoleRow({ officeLocation: 'Upland' })]);
    const { scheduleLookupService } = await import('./scheduleLookupService');
    const ctx = await scheduleLookupService.lookupByPersonId(PERSON, 'phone');
    expect(ctx.upcomingAppointments[0]?.location).toBe('Upland');
    const warned = (console.warn as any).mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(warned).toMatch(/CONSOLE did not answer, falling back to the Hub copy/);
  });

  it('a Console that STALLS still gets the Hub fallback inside the join budget (Codex P2, #342)', async () => {
    // The Console pool allows 2.5 s statements; the join budget is shorter. A
    // stall must not eat the whole budget and leave the fallback unattempted.
    process.env.PERSON_JOIN_TIMEOUT_MS = '400';
    try {
      fetchFactsForPerson.mockImplementation(() => new Promise(() => {})); // never settles
      hubLimit.mockResolvedValue([consoleRow({ officeLocation: 'Monrovia' })]);
      const { scheduleLookupService } = await import('./scheduleLookupService');
      const started = Date.now();
      const ctx = await scheduleLookupService.lookupByPersonId(PERSON, 'phone');
      expect(ctx.patientFound).toBe(true);
      expect(ctx.upcomingAppointments[0]?.location).toBe('Monrovia');
      expect(Date.now() - started).toBeLessThan(400);
      const warned = (console.warn as any).mock.calls.map((c: any[]) => c.join(' ')).join('\n');
      expect(warned).toMatch(/Console join deadline/);
    } finally {
      delete process.env.PERSON_JOIN_TIMEOUT_MS;
    }
  });

  it('an identified person with no facts is still identified — empty is not failure', async () => {
    fetchFactsForPerson.mockResolvedValue([]);
    const { scheduleLookupService } = await import('./scheduleLookupService');
    const ctx = await scheduleLookupService.lookupByPersonId(PERSON, 'phone');
    expect(ctx.patientFound).toBe(false);
    expect(hubLimit).not.toHaveBeenCalled();
    const logged = (console.log as any).mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(logged).toMatch(/PersonID join \(console\): identified, and genuinely no appointments on file/);
  });
});

describe('appointmentsForPerson', () => {
  it('answers last and next from the Console rows, excluding Removed, when configured', async () => {
    const today = new Date().toISOString().slice(0, 10);
    fetchFactsForPerson.mockResolvedValue([
      consoleRow({ appointmentDate: '2099-01-10', appointmentStart: '1330', officeLocation: 'Indio' }),
      consoleRow({ appointmentDate: '2099-01-05', appointmentStatus: 'Removed', officeLocation: 'Nowhere' }),
      consoleRow({ appointmentDate: '2001-03-03', appointmentStart: '0800', officeLocation: 'Glendale' }),
    ]);
    const { appointmentsForPerson } = await import('./appointmentAnswers');
    const a = await appointmentsForPerson(PERSON);
    expect(a?.next).toEqual({ date: '2099-01-10', time: '1:30 PM', provider: 'Example Surgeon, MD', office: 'Indio' });
    expect(a?.last).toEqual({ date: '2001-03-03', time: '8:00 AM', provider: 'Example Surgeon, MD', office: 'Glendale' });
    expect(hubLimit).not.toHaveBeenCalled();
    expect(today < '2099-01-10').toBe(true);
  });

  it('reads the Hub copy when the Console is not configured', async () => {
    configured = false;
    hubLimit.mockResolvedValue([]);
    const { appointmentsForPerson } = await import('./appointmentAnswers');
    const a = await appointmentsForPerson(PERSON);
    expect(fetchFactsForPerson).not.toHaveBeenCalled();
    expect(hubLimit).toHaveBeenCalled();
    expect(a).toEqual({ last: null, next: null });
  });
});
