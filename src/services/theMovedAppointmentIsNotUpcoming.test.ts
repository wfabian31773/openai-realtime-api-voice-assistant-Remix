/**
 * A MOVED APPOINTMENT IS NOT AN APPOINTMENT, AND A MISSED ONE IS NOT A VISIT.
 *
 * The NextGen Bible's §2 rule (ai-bridge NEXTGEN_BIBLE.md, Wayne's definitive
 * reference, 2026-10-20): kept > rescheduled > cancelled, then a past date
 * never kept is a no-show and anything else is upcoming — today included,
 * until it is marked kept. NextGen does not cancel the appointment it moves;
 * it hides it and books a new row. Until v104 the voice app read every
 * not-cancelled Console fact as live, so a moved appointment was an upcoming
 * appointment the caller did not have, and a moved or missed one could be
 * their "last visit".
 *
 * Driven through the REAL `consoleScheduleFacts` (the SQL row -> the Hub
 * shape), the REAL `scheduleLookupService.buildContext` and the REAL
 * `appointmentsForPerson`, with only the Console pool faked — so a mapping
 * that is right but never reached, or reached and then ignored, goes red
 * (failure mode 10). Synthetic person, offices and providers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('./patientVerification', () => ({
  verifyPatient: vi.fn(),
  findByPhone: vi.fn(),
  getConsolePool: () => ({ query }),
}));
vi.mock('../../server/db', () => ({ db: {}, pool: { query: vi.fn() } }));

const PERSON = '00000000-0000-4000-8000-0000000000bb';
// Noon Pacific, so the Pacific day (buildContext) and the UTC day
// (appointmentAnswers) are the same day.
const NOW = new Date('2041-03-05T20:00:00Z');
const TODAY = '2041-03-05';

const fact = (over: Record<string, unknown> = {}) => ({
  appointment_id: '00000000-0000-4000-8000-000000000001',
  appointment_date: '2041-04-02',
  begin_time: '0930',
  duration: 15,
  event_name: 'Follow Up',
  is_cancelled: false,
  is_rescheduled: false,
  is_kept: false,
  person_id: PERSON,
  equipment_only: false,
  location_name: 'Azul Vision Exampletown',
  facility_kind: 'clinic',
  provider_name: 'Example Surgeon, M.D.',
  provider_type: 'Retina',
  first_name: 'Test',
  last_name: 'Patient',
  date_of_birth: '1970-01-01',
  email: null,
  cell_phone: null,
  home_phone: null,
  language: null,
  ...over,
});

beforeEach(() => {
  process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://example.invalid/console';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  query.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.OBS_CONSOLE_DATABASE_URL;
});

async function contextFor(rows: Record<string, unknown>[]) {
  query.mockResolvedValue({ rows });
  const { scheduleLookupService } = await import('./scheduleLookupService');
  return scheduleLookupService.lookupByPersonId(PERSON, 'phone');
}

describe('the upcoming list', () => {
  it('leaves out the appointment NextGen moved, and keeps the one it moved to', async () => {
    const ctx = await contextFor([
      // The replacement: the appointment the caller actually has.
      fact({ appointment_id: '00000000-0000-4000-8000-000000000002', appointment_date: '2041-04-16', location_name: 'Azul Vision Newtown' }),
      // The moved original: hidden on the NextGen screen, never cancelled.
      fact({ appointment_date: '2041-04-02', is_rescheduled: true }),
    ]);
    expect(ctx.upcomingAppointments.map((a) => a.isoDate)).toEqual(['2041-04-16']);
    expect(ctx.upcomingAppointments[0].location).toBe('Newtown');
  });

  it('a moved appointment is not the next physician either (the surgery lane routes on it)', async () => {
    const ctx = await contextFor([
      fact({ appointment_date: '2041-03-20', is_rescheduled: true, provider_name: 'Moved Away, M.D.' }),
      fact({ appointment_id: '00000000-0000-4000-8000-000000000003', appointment_date: '2041-04-20', provider_name: 'Booked Now, M.D.' }),
    ]);
    expect(ctx.lastPhysicianSeen).toBe('Booked Now, MD');
  });

  it("today counts as upcoming until it is kept, then it is today's visit", async () => {
    const notYet = await contextFor([fact({ appointment_date: TODAY, is_kept: false })]);
    expect(notYet.upcomingAppointments.map((a) => a.isoDate)).toEqual([TODAY]);
    expect(notYet.pastAppointments).toEqual([]);

    const seen = await contextFor([fact({ appointment_date: TODAY, is_kept: true })]);
    expect(seen.upcomingAppointments).toEqual([]);
    expect(seen.pastAppointments.map((a) => a.isoDate)).toEqual([TODAY]);
  });
});

describe('the past list, the last visit and the last office', () => {
  it('counts only visits NextGen says were kept: not a moved appointment, not a no-show', async () => {
    const ctx = await contextFor([
      fact({ appointment_date: '2041-02-26', is_kept: false, location_name: 'Azul Vision Missedville' }), // no-show
      fact({ appointment_id: '00000000-0000-4000-8000-000000000004', appointment_date: '2041-02-19', is_rescheduled: true, location_name: 'Azul Vision Movedtown' }),
      fact({ appointment_id: '00000000-0000-4000-8000-000000000005', appointment_date: '2041-01-08', is_kept: true, location_name: 'Azul Vision Seenville' }),
    ]);
    expect(ctx.pastAppointments.map((a) => a.isoDate)).toEqual(['2041-01-08']);
    expect(ctx.lastLocationSeen).toBe('Seenville');
    expect(ctx.lastVisitDate).toBeDefined();
    expect(ctx.pastAppointments[0].location).toBe('Seenville');
  });

  it('kept wins over rescheduled: the screen shows such a row Kept (Bible §2.1)', async () => {
    const ctx = await contextFor([
      fact({ appointment_date: '2041-02-12', is_rescheduled: true, is_kept: true, location_name: 'Azul Vision Seenville' }),
    ]);
    expect(ctx.pastAppointments.map((a) => a.isoDate)).toEqual(['2041-02-12']);
  });

  it('an unknown kept flag is never a no-show: the row counts, as it did before', async () => {
    const ctx = await contextFor([fact({ appointment_date: '2041-02-12', is_kept: null })]);
    expect(ctx.pastAppointments.map((a) => a.isoDate)).toEqual(['2041-02-12']);
  });
});

describe('appointmentsForPerson (the last and next appointment answer)', () => {
  it('never offers a moved appointment as the next one or the last one', async () => {
    query.mockResolvedValue({
      rows: [
        fact({ appointment_date: '2041-03-12', is_rescheduled: true, location_name: 'Azul Vision Movedtown' }),
        fact({ appointment_id: '00000000-0000-4000-8000-000000000006', appointment_date: '2041-03-26', location_name: 'Azul Vision Newtown' }),
        fact({ appointment_id: '00000000-0000-4000-8000-000000000007', appointment_date: '2041-02-27', is_rescheduled: true, location_name: 'Azul Vision Movedtown' }),
        fact({ appointment_id: '00000000-0000-4000-8000-000000000008', appointment_date: '2041-01-15', is_kept: true, location_name: 'Azul Vision Seenville' }),
      ],
    });
    const { appointmentsForPerson } = await import('./appointmentAnswers');
    const a = await appointmentsForPerson(PERSON);
    expect(a?.next?.date).toBe('2041-03-26');
    expect(a?.next?.office).toBe('Newtown');
    expect(a?.last?.date).toBe('2041-01-15');
  });

  it('an appointment kept this morning is the last one, not the next one', async () => {
    query.mockResolvedValue({
      rows: [
        fact({ appointment_date: TODAY, is_kept: true, location_name: 'Azul Vision Seenville' }),
        fact({ appointment_id: '00000000-0000-4000-8000-000000000009', appointment_date: '2041-05-01', location_name: 'Azul Vision Newtown' }),
      ],
    });
    const { appointmentsForPerson } = await import('./appointmentAnswers');
    const a = await appointmentsForPerson(PERSON);
    expect(a?.last?.date).toBe(TODAY);
    expect(a?.next?.date).toBe('2041-05-01');
  });
});
