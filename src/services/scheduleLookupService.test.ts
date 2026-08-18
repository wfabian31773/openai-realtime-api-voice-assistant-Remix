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

/**
 * One person per context.
 *
 * A phone number is not an identity. +1 845 531 7471 carries two real records
 * in production — Wayne Fabian (43 rows) and a John Doe test record (1 row) —
 * and buildContext used to pool every row a query returned into a single
 * history. John Doe's 2025-09-16 Anaheim visit was appearing in Wayne's recent
 * visits, and `patientName` came from whichever row happened to sort first.
 *
 * A name-only lookup does the same to every family that shares a surname, which
 * is a much larger population than shared phones.
 */
const JOHN_DOE_ROW = {
  appointmentDate: '2025-09-16',
  appointmentStart: '0900',
  appointmentStatus: 'Active',
  renderingPhysician: 'DRS',
  officeLocation: 'Anaheim',
  patientFirstName: 'John',
  patientLastName: 'Doe',
  patientDateOfBirth: '1980-01-01',
};
const WAYNE_ROWS = [DEC_30_REMOVED, JUL_13_ACTIVE].map((r) => ({
  ...r,
  patientDateOfBirth: '1973-03-17',
}));

describe('two people on one phone number', () => {
  it('builds the history from ONE person, not from both', () => {
    const ctx = build([...WAYNE_ROWS, JOHN_DOE_ROW]);
    // Wayne owns the most recent row, so the context is his.
    expect(ctx.patientData?.lastName).toBe('Fabian');
    // And John Doe's visit is not in it.
    expect(ctx.pastAppointments.map((a) => a.location)).not.toContain('Anaheim');
    expect(ctx.pastAppointments.map((a) => a.isoDate)).toEqual(['2026-07-13']);
  });

  it('counts only that person\'s appointments', () => {
    const ctx = build([...WAYNE_ROWS, JOHN_DOE_ROW]);
    // Two rows are Wayne's; the third belongs to someone else entirely.
    expect(ctx.totalAppointmentsFound).toBe(2);
  });

  it('says the lookup was ambiguous, so nobody asserts a name out loud', () => {
    const ctx = build([...WAYNE_ROWS, JOHN_DOE_ROW]);
    expect(ctx.identity?.unique).toBe(false);
    expect(ctx.identity?.candidateCount).toBe(2);
    expect(ctx.identity?.candidates.map((c) => c.lastName)).toEqual(['Fabian', 'Doe']);
  });

  it('reports a clean single match as unique, so recognition still works', () => {
    const ctx = build(WAYNE_ROWS);
    expect(ctx.identity?.unique).toBe(true);
    expect(ctx.identity?.candidateCount).toBe(1);
  });

  it('treats two people with the same name but different birthdays as two people', () => {
    // The case that makes DOB part of the key: a mother and daughter sharing a
    // name and a household line. Merging them would disclose one's visits to
    // the other.
    const daughter = { ...JUL_13_ACTIVE, patientDateOfBirth: '1998-05-02', appointmentDate: '2026-08-01' };
    const mother = { ...JUL_13_ACTIVE, patientDateOfBirth: '1973-03-17' };
    const ctx = build([daughter, mother]);
    expect(ctx.identity?.unique).toBe(false);
    expect(ctx.totalAppointmentsFound).toBe(1);
  });
});

/**
 * Where the caller's name lives.
 *
 * The demo line's caller recognition read `context.patientFirstName` and
 * `context.patientLastName`. Neither has ever existed on this type — the names
 * are on `patientData` — so both were always undefined, the guard rejected
 * every caller, and the whole function was dead code behind an `as {...}` cast
 * that silenced the compiler. On a live call at 2026-08-11 22:46 the line asked
 * a recognised patient to spell his name, the STT heard "Sabian" instead of
 * "Fabian", and only the phone fallback inside lookupPatient saved the answer.
 *
 * Pinned from both sides: the names ARE on patientData, and they are NOT at the
 * root. A reader that goes back to the root fails here rather than on the air.
 */
describe('where the caller name lives, for anyone reading this context', () => {
  it('carries the first and last name on patientData', () => {
    const ctx = build([JUL_13_ACTIVE]);
    expect(ctx.patientData?.firstName).toBe('Wayne');
    expect(ctx.patientData?.lastName).toBe('Fabian');
  });

  it('does not carry them at the root, whatever a caller might assume', () => {
    const ctx = build([JUL_13_ACTIVE]) as unknown as Record<string, unknown>;
    expect(ctx.patientFirstName).toBeUndefined();
    expect(ctx.patientLastName).toBeUndefined();
    // `patientName` is the one root-level name field, and it is a display
    // string — not the first/last pair a ledger or a ticket needs.
    expect(ctx.patientName).toBe('Wayne Fabian');
  });
});

/**
 * THE SURGEON IS USUALLY IN THE FUTURE.
 *
 * Surgery callers are pre-op: the operation is booked and has not happened, so
 * the operating physician appears only on an UPCOMING appointment. A past-only
 * rule returns nothing for them and the ticket files unrouted — which is what
 * happened to Gail Herrick on 2026-08-17: no past appointments of any kind,
 * one upcoming Laser with Samuel Asanad, MD, and a null provider on the ticket.
 */
describe('lastPhysicianSeen prefers the booked surgeon over the last visit', () => {
  const base = { patientFirstName: 'Gail', patientLastName: 'Herrick', appointmentStart: '0800' };
  const appt = (over: Record<string, unknown>) => ({ ...base, appointmentStatus: 'Active', ...over });

  it('takes the upcoming physician over a more recent optometrist visit', () => {
    const ctx = build([
      appt({ appointmentDate: isoDaysFromToday(14), renderingPhysician: 'Samuel Asanad, MD', doctorType: 'MD' }),
      appt({ appointmentDate: isoDaysFromToday(-3), renderingPhysician: 'Jennie Tran, OD', doctorType: 'OD' }),
    ]);
    expect(ctx.lastPhysicianSeen).toBe('Samuel Asanad, MD');
    // And the OD remains the honest answer to "who did you last see".
    expect(ctx.lastProviderSeen).toBe('Jennie Tran, OD');
  });

  it('a patient whose ONLY appointment is an upcoming surgery still yields a surgeon', () => {
    // Gail Herrick's exact shape: nothing in the past at all.
    const ctx = build([
      appt({ appointmentDate: isoDaysFromToday(3), renderingPhysician: 'Samuel Asanad, MD', doctorType: 'MD' }),
    ]);
    expect(ctx.lastPhysicianSeen).toBe('Samuel Asanad, MD');
  });

  it('falls back to the last physician actually seen when nothing is booked', () => {
    const ctx = build([
      appt({ appointmentDate: isoDaysFromToday(-30), renderingPhysician: 'Dwayne Logan, MD', doctorType: 'MD' }),
    ]);
    expect(ctx.lastPhysicianSeen).toBe('Dwayne Logan, MD');
  });

  it('never returns equipment as a physician OR as the last provider', () => {
    const ctx = build([
      appt({ appointmentDate: isoDaysFromToday(-2), renderingPhysician: 'A-Scan', doctorType: 'Equipment' }),
      appt({ appointmentDate: isoDaysFromToday(-30), renderingPhysician: 'Dwayne Logan, MD', doctorType: 'MD' }),
    ]);
    expect(ctx.lastPhysicianSeen).toBe('Dwayne Logan, MD');
    expect(ctx.lastProviderSeen, 'a machine was reported as the provider').toBe('Dwayne Logan, MD');
  });

  it('a CANCELLED upcoming surgery is not a surgeon', () => {
    const ctx = build([
      appt({ appointmentDate: isoDaysFromToday(10), renderingPhysician: 'Samuel Asanad, MD', doctorType: 'MD', appointmentStatus: 'Removed' }),
      appt({ appointmentDate: isoDaysFromToday(-30), renderingPhysician: 'Dwayne Logan, MD', doctorType: 'MD' }),
    ]);
    expect(ctx.lastPhysicianSeen).toBe('Dwayne Logan, MD');
  });
});
