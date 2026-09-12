/**
 * THE JOIN. Identify in `patients_master`, then pull the record on `PersonID`.
 *
 * Operator, 2026-09-12: *"When you find the patient in the patient master, you
 * automatically join the UID or UUID, whatever, to the schedule to pull up the
 * entire record. Right? Simple. Basic. Right? Can we lock that in
 * definitively?"*
 *
 * WHY IT MATTERS, measured the same day on the 64 callers the appointment book
 * had just reported no record of: **52 (81%) have schedule history on this
 * join** — 49 with past visits, 19 with an appointment still UPCOMING, 51 with
 * an office on file. The book was not missing their appointments. It searches
 * by name and phone STRINGS and it was missing THEM.
 *
 * These tests pin the four things that can quietly undo it: that the join runs
 * at all, that it is keyed with the uuid cast, that one person's rows are not
 * split by how their name is spelled, and that a failed join never unidentifies
 * a caller the person base already vouched for.
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

/**
 * A fake drizzle. It records the `where` it was handed — which is how the uuid
 * cast is asserted — and answers with whatever the test set. Hoisted, because
 * `vi.mock`'s factory runs before the module body.
 */
const { captured, chain, state } = vi.hoisted(() => {
  const captured: { where: unknown; queries: number } = { where: undefined, queries: 0 };
  const state: { answer: { rows: any[] } | { throws: Error } | { hangs: true } } = {
    answer: { rows: [] },
  };
  const chain: Record<string, unknown> = {};
  for (const step of ['select', 'from', 'orderBy']) chain[step] = () => chain;
  chain.where = (w: unknown) => {
    captured.where = w;
    captured.queries += 1;
    return chain;
  };
  chain.limit = () => {
    if ('hangs' in state.answer) return new Promise(() => {}); // never settles
    if ('throws' in state.answer) return Promise.reject(state.answer.throws);
    return Promise.resolve(state.answer.rows);
  };
  return { captured, chain, state };
});
vi.mock('../../server/db', () => ({ db: chain }));

import { ScheduleLookupService } from './scheduleLookupService';
import { byPerson } from './appointmentAnswers';

/**
 * A drizzle clause, flattened to the text it will become. The object graph is
 * circular (a column points back at its table), so it cannot be stringified
 * whole — and the point of the assertion is the CAST, which is a literal.
 */
function render(clause: unknown): string {
  const chunks = (clause as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((c: any) => {
      if (Array.isArray(c?.value)) return c.value.join('');
      if (typeof c?.name === 'string') return `[${c.name}]`;
      if (c && typeof c === 'object' && 'value' in c) return String(c.value);
      return String(c);
    })
    .join('');
}

const PERSON_ID = '11111111-2222-3333-4444-555555555555';
const PERSON = {
  personId: PERSON_ID,
  personNbr: null,
  firstName: 'Testcaller',
  lastName: 'Mirror',
  dob: '1950-01-01',
  hasMedicalRecord: true,
  language: null,
};

/** One appointment row, shaped as the Schedule table returns it. */
const row = (over: Record<string, unknown> = {}) => ({
  appointmentDate: '2026-07-13',
  appointmentStart: '1530',
  appointmentStatus: 'Active',
  officeLocation: 'Covina',
  renderingPhysician: 'Testprovider One, MD',
  doctorType: 'MD',
  patientFirstName: 'Testcaller',
  patientLastName: 'Mirror',
  patientDateOfBirth: '1950-01-01',
  personId: PERSON_ID,
  ...over,
});

/**
 * A service whose three STRING rungs have already come back empty — which is
 * the only state in which the person base is asked at all.
 */
function bookFoundNobody() {
  const s = new ScheduleLookupService() as unknown as Record<string, unknown>;
  const empty = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };
  for (const rung of ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName']) {
    s[rung] = vi.fn().mockResolvedValue(empty);
  }
  return s as unknown as ScheduleLookupService;
}

beforeEach(() => {
  verifyPatient.mockReset();
  findByPhone.mockReset();
  captured.where = undefined;
  captured.queries = 0;
  state.answer = { rows: [] };
  findByPhone.mockResolvedValue({ verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror' });
});

describe('identity in the mirror pulls the whole record from the schedule', () => {
  it('returns the history, the office and the provider — not just a name', async () => {
    state.answer = {
      rows: [
        row({ appointmentDate: '2027-01-04', officeLocation: 'Mission Viejo' }),
        row({ appointmentDate: '2026-07-13' }),
        row({ appointmentDate: '2026-02-02', officeLocation: 'Covina' }),
      ],
    };

    const out = await bookFoundNobody().lookupPatient({ phone: '5555550147' });

    expect(out.patientFound).toBe(true);
    expect(out.totalAppointmentsFound).toBe(3);
    // The upcoming one is what a caller most often rings about, and it is the
    // half a past-only read would lose: 19 of the 52 have one.
    expect(out.upcomingAppointments).toHaveLength(1);
    expect(out.pastAppointments).toHaveLength(2);
    expect(out.lastVisitDate).toBeTruthy();
    // Optical resolves which office a caller means from exactly this.
    expect(out.lastLocationSeen).toBe('Covina');
    expect(out.lastProviderSeen).toBe('Testprovider One, MD');
    // Surgery is assigned BY surgeon, and the surgeon is usually in the future.
    expect(out.lastPhysicianSeen).toBe('Testprovider One, MD');
  });

  it('queries on PersonID with the shared uuid cast, not a bare comparison', async () => {
    // `uuid = text` is not an error the type system can see: Postgres refuses
    // it at runtime, inside a catch, on a live call, and the caller is told
    // they have no history. One helper, one cast, asserted here.
    state.answer = { rows: [row()] };

    await bookFoundNobody().lookupPatient({ phone: '5555550147' });

    expect(captured.queries).toBe(1);
    expect(render(captured.where)).toBe(render(byPerson(PERSON_ID)));
    expect(render(captured.where)).toContain('::uuid');
    expect(render(captured.where)).toContain(PERSON_ID);
  });

  it('does NOT split one person because their own rows spell them differently', async () => {
    /**
     * The 2.4%. Measured 2026-09-12 over 1,372 multi-row person_ids: 33
     * disagree with themselves — 15 by last name, 13 by first name, 8 by date
     * of birth. Maiden names, nicknames, a corrected birthday. Grouping those
     * rows by spelling reports a primary-key join as AMBIGUOUS and drops the
     * smaller group's visits out of that patient's own history.
     */
    state.answer = {
      rows: [
        row({ appointmentDate: '2026-07-13', patientLastName: 'Mirror' }),
        row({ appointmentDate: '2026-05-01', patientLastName: 'Testmaiden' }),
        row({ appointmentDate: '2026-02-02', patientFirstName: 'Test', patientDateOfBirth: '1950-01-02' }),
      ],
    };

    const out = await bookFoundNobody().lookupPatient({ phone: '5555550147' });

    expect(out.totalAppointmentsFound).toBe(3);
    expect(out.pastAppointments).toHaveLength(3);
    expect(out.identity).toMatchObject({ unique: true, candidateCount: 1 });
  });

  it('carries the name the MIRROR verified, not the one the row happens to spell', async () => {
    // Standing instruction 14: the Console is the source of truth for who
    // somebody is, and it is the name on the chart the staffer will open.
    state.answer = { rows: [row({ patientFirstName: 'Testy', patientLastName: 'Testmaiden' })] };

    const out = await bookFoundNobody().lookupPatient({ phone: '5555550147' });

    expect(out.patientName).toBe('Testcaller Mirror');
    expect(out.patientData?.lastName).toBe('Mirror');
    expect(out.patientData?.dateOfBirth).toBe('1950-01-01');
    // …while everything the mirror does not hold still comes from the row.
    expect(out.patientData?.preferredLocation).toBe('Covina');
  });
});

describe('a schedule that cannot answer must not unidentify the caller', () => {
  it('keeps the identity when the join THROWS', async () => {
    state.answer = { throws: new Error('operator does not exist: uuid = text') };

    const out = await bookFoundNobody().lookupPatient({ phone: '5555550147' });

    expect(out.patientFound).toBe(true);
    expect(out.patientName).toBe('Testcaller Mirror');
    expect(out.totalAppointmentsFound).toBe(0);
  });

  it('keeps the identity when the join HANGS — a stall is not a throw', async () => {
    /**
     * Codex P1 on PR #292. `runTool` races `lookup_patient` against a 6s budget
     * and that race RESOLVES rather than cancelling: a query stalled on the
     * pool leaves this await pending forever, so the catch never runs and a
     * caller the mirror had already identified comes back unidentified. Not a
     * hypothetical population — the tool already exceeds its budget on 13-17%
     * of queue calls. The deadline must answer before the tool's race does.
     */
    vi.useFakeTimers();
    state.answer = { hangs: true };
    try {
      const pending = bookFoundNobody().lookupPatient({ phone: '5555550147' });
      await vi.advanceTimersByTimeAsync(1_600); // past the 1.5s join deadline
      const out = await pending;

      expect(out.patientFound).toBe(true);
      expect(out.patientName).toBe('Testcaller Mirror');
      expect(out.totalAppointmentsFound).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers well inside lookup_patient\'s 6s tool budget', async () => {
    // The deadline is worthless if it lands after the race it exists to beat.
    const { joinDeadlineForTests } = await import('./scheduleLookupService');
    expect(joinDeadlineForTests()).toBeLessThan(6_000);
  });

  it('keeps the identity when the patient genuinely has no appointments', async () => {
    // The operator's own distinction, 2026-09-12: separate from the 63% whose
    // number is on file, there is a smaller group we hold a record for who
    // simply have never been booked. Knowing who they are is the win.
    state.answer = { rows: [] };

    const out = await bookFoundNobody().lookupPatient({ phone: '5555550147' });

    expect(out.patientFound).toBe(true);
    expect(out.identity).toMatchObject({ unique: true, candidateCount: 1 });
    expect(out.pastAppointments).toEqual([]);
  });

  it('is never reached at all when the appointment book already found them', async () => {
    const s = new ScheduleLookupService() as unknown as Record<string, unknown>;
    const found = {
      patientFound: true, patientName: 'Booked Patient', matchedBy: 'phone' as const,
      upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 3,
    };
    for (const rung of ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName']) {
      s[rung] = vi.fn().mockResolvedValue(found);
    }

    await (s as unknown as ScheduleLookupService).lookupPatient({ phone: '5555550147' });

    expect(captured.queries).toBe(0);
    expect(findByPhone).not.toHaveBeenCalled();
  });
});
