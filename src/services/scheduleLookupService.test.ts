import { describe, it, expect, vi } from 'vitest';

// Importing the service opens a database pool at module load. These tests
// never reach it — they exercise the pure sorting step — but the import still
// has to get past the env check.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

import { ScheduleLookupService } from './scheduleLookupService';

/**
 * Real call, 2026-08-10 23:52. The caller asked when their last appointment
 * was. The agent answered "Wednesday, December 30, 2026" and, in the same
 * breath, "you don't have any upcoming appointments scheduled right now".
 *
 * Both sentences came from one row: a REMOVED (cancelled) appointment dated
 * four months in the future. It failed the "Active" test so it was not
 * upcoming, and everything that was not upcoming was filed as past — where,
 * sorted newest-first, it became the patient's last visit.
 */
const DEC_30_REMOVED = {
  appointmentDate: '2026-12-30',
  appointmentStart: '0800',
  appointmentStatus: 'Removed',
  renderingPhysician: 'Dwayne Logan, MD',
  officeLocation: 'Loma Linda Surgery Center LLC',
  patientFirstName: 'Wayne',
  patientLastName: 'Fabian',
};
const JUL_14_NOSHOW = {
  appointmentDate: '2026-07-14',
  appointmentStart: '1120',
  appointmentStatus: 'NoShow',
  renderingPhysician: 'Dwayne Logan, MD',
  officeLocation: 'Redlands',
  patientFirstName: 'Wayne',
  patientLastName: 'Fabian',
};
const JUL_13_ACTIVE = {
  appointmentDate: '2026-07-13',
  appointmentStart: '1530',
  appointmentStatus: 'Active',
  renderingPhysician: 'Dwayne Logan, MD',
  officeLocation: 'Loma Linda Surgery Center LLC',
  patientFirstName: 'Wayne',
  patientLastName: 'Fabian',
};

// buildContext is private, and deliberately so — but it is where the defect
// lived, and reaching it through the database would test the database.
function build(rows: unknown[]) {
  const svc = new ScheduleLookupService();
  return (svc as unknown as {
    buildContext: (r: unknown[], m: string) => ReturnType<ScheduleLookupService['lookupByPhone']> extends Promise<infer T> ? T : never;
  }).buildContext(rows, 'name_and_dob');
}

/** Dates far enough out that these tests do not expire. */
function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('what counts as the last appointment', () => {
  it('never reports a cancelled future appointment as a past visit', () => {
    const ctx = build([DEC_30_REMOVED, JUL_14_NOSHOW, JUL_13_ACTIVE]);
    expect(ctx.pastAppointments.map((a) => a.isoDate)).not.toContain('2026-12-30');
    expect(ctx.lastVisitDate).not.toMatch(/December 30/);
  });

  it('reports the last Active visit before today, not the last row on file', () => {
    const ctx = build([DEC_30_REMOVED, JUL_14_NOSHOW, JUL_13_ACTIVE]);
    expect(ctx.pastAppointments[0].isoDate).toBe('2026-07-13');
    expect(ctx.lastProviderSeen).toBe('Dwayne Logan, MD');
    expect(ctx.lastLocationSeen).toBe('Loma Linda Surgery Center LLC');
  });

  it('does not report a no-show as an appointment the patient attended', () => {
    const ctx = build([JUL_14_NOSHOW, JUL_13_ACTIVE]);
    expect(ctx.pastAppointments.map((a) => a.isoDate)).not.toContain('2026-07-14');
  });

  it('still counts every row on file, including the ones it will not report', () => {
    const ctx = build([DEC_30_REMOVED, JUL_14_NOSHOW, JUL_13_ACTIVE]);
    expect(ctx.totalAppointmentsFound).toBe(3);
    expect(ctx.patientFound).toBe(true);
  });

  it('still surfaces a genuine upcoming appointment', () => {
    const upcoming = { ...JUL_13_ACTIVE, appointmentDate: isoDaysFromToday(14) };
    const ctx = build([upcoming, JUL_13_ACTIVE]);
    expect(ctx.upcomingAppointments.map((a) => a.isoDate)).toEqual([isoDaysFromToday(14)]);
  });

  it('does not offer a cancelled future appointment as upcoming', () => {
    const cancelledSoon = { ...DEC_30_REMOVED, appointmentDate: isoDaysFromToday(14) };
    const ctx = build([cancelledSoon, JUL_13_ACTIVE]);
    expect(ctx.upcomingAppointments).toHaveLength(0);
  });
});
