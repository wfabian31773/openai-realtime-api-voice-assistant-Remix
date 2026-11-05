/**
 * ONE PERSON CHARTED TWICE IS ONE PATIENT — v179.
 *
 * Operator, 2026-11-05, choosing (a): records that share a first name, a date
 * of birth and a phone are one patient; use the chart with a medical record,
 * or failing that the one with the most recent visit.
 *
 * The corpus is the 9 queue calls of 2026-11-04 where the caller said yes to
 * the greeting and `lookup_patient` still could not tell who it was. Read
 * against `patients_master` (by a hash of the number, never the number):
 * 7 were one person with two charts under two last names, the same date of
 * birth and the same phone; 2 numbers (3 calls) held two people with the same
 * last name and DIFFERENT dates of birth. The SIDs are real; every name,
 * number and date below is synthetic and reproduces only the shape.
 *
 * Part 1 drives the real `findByPhone` / `verifyPatient` over a faked Console
 * pool. Part 2 drives `lookup_patient` through `runTool` and the filing gate
 * (`prepareTicketIdentity`), with only the pool and the PersonID join faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('pg', () => ({
  default: { Pool: class { query = (...a: unknown[]) => query(...a); on() {} end() { return Promise.resolve(); } } },
}));
vi.mock('./consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

import {
  findByPhone,
  verifyPatient,
  oneChartedTwice,
  __resetPoolForTests,
  __resetMirrorBreakerForTests,
} from './patientVerification';
import { scheduleLookupService } from './scheduleLookupService';

const { runTool } = await import('../tools/registry');
await import('../tools/sharedPatientTools');
const { resetVerifiedIdentities, verifiedIdentityFor } = await import('../tools/verifiedIdentity');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { prepareTicketIdentity } = await import('../tools/ticketIdentity');

const PHONE = '555-555-0179';
const DIGITS = '5555550179';
const DOB = '1961-02-03';

type R = {
  person_id: string; person_nbr: string | null; first_name: string; last_name: string; date_of_birth: string;
  has_medical_record: boolean; language: null; phones: (string | null)[]; source_updated_at?: string | null;
};
const chart = (id: string, first: string, last: string, opts: Partial<R> = {}): R => ({
  person_id: `00000000-0000-4000-8000-0000000000${id}`,
  person_nbr: `9${id}`,
  first_name: first,
  last_name: last,
  date_of_birth: DOB,
  has_medical_record: true,
  language: null,
  phones: [DIGITS, null, null, null, null],
  source_updated_at: '2024-01-01T00:00:00',
  ...opts,
});
const pid = (id: string) => `00000000-0000-4000-8000-0000000000${id}`;

/** The Console answers patients_master and the last-visit read separately. */
function console_(people: R[], visits: Record<string, string> = {}, visitsFail = false) {
  query.mockImplementation(async (sql: string) => {
    if (/si_appointment_facts/.test(sql)) {
      if (visitsFail) throw new Error('timeout');
      return { rows: Object.entries(visits).map(([person_id, last_visit]) => ({ person_id, last_visit })) };
    }
    return { rows: people };
  });
}

beforeEach(() => {
  query.mockReset();
  __resetPoolForTests();
  __resetMirrorBreakerForTests();
  process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://fake/console';
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OBS_CONSOLE_DATABASE_URL;
});

/**
 * The 2026-11-04 corpus. `shape` is what `patients_master` holds under the
 * greeted first name on the calling number.
 */
const ONE_PERSON_ONE_RECORD = ['CA612ad3aebb20bd509e88a49e174bf8a0', 'CA83e50bffcb86b5987907c80057de07b3', 'CA8d3101032a799ad2dc081b3ea5833691'];
const ONE_PERSON_BOTH_RECORDS = ['CA13b0309fda263e2ccf1d6fdd89bff804', 'CA6c2a3dc10051de46cf389696e093f780', 'CAd977943b361792b425826d36bc7b6353'];
const ONE_PERSON_FOUR_ON_THE_NUMBER = 'CAa85b7bc04e046e54efd4da0765bcdec7';
const TWO_PEOPLE = ['CA6ce26ff9c5418c2af258f0ea17480e48', 'CA0bf5a3864538462f7f82c493bb9f0633', 'CAe3003875fda61f06532a4767c84e3b88'];

describe('the 2026-11-04 corpus through findByPhone', () => {
  it.each(ONE_PERSON_ONE_RECORD)('%s — two charts, one with a medical record: that chart answers', async () => {
    console_([chart('01', 'Testa', 'Maiden', { has_medical_record: false }), chart('02', 'Testa', 'Married')]);
    const r = await findByPhone(PHONE, 'Testa');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('02'));
    expect(r.chartsOnFile).toBe(2);
    expect(r.alsoKnownAs).toEqual(['Maiden']);
  });

  it.each(ONE_PERSON_BOTH_RECORDS)('%s — two charts, both with a record: the most recent visit answers', async () => {
    console_(
      [chart('01', 'Testa', 'Maiden'), chart('02', 'Testa', 'Married')],
      { [pid('01')]: '2026-06-30', [pid('02')]: '2024-02-11' },
    );
    const r = await findByPhone(PHONE, 'Testa');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('01'));
    expect(r.alsoKnownAs).toEqual(['Married']);
  });

  it(`${ONE_PERSON_FOUR_ON_THE_NUMBER} — four people on the number, two of them one person charted twice`, async () => {
    console_(
      [
        chart('01', 'Testa', 'Maiden'),
        chart('02', 'Testa', 'Married'),
        chart('03', 'Otherone', 'Household', { date_of_birth: '1990-05-06' }),
        chart('04', 'Othertwo', 'Household', { date_of_birth: '1992-07-08' }),
      ],
      { [pid('02')]: '2026-09-01' },
    );
    const r = await findByPhone(PHONE, 'Testa');
    expect(r.verified).toBe(true);
    expect(r.candidates).toBe(4);
    expect(r.patient?.personId).toBe(pid('02'));
    expect(r.chartsOnFile).toBe(2);
  });

  it.each(TWO_PEOPLE)('%s — two people, same first and last name, different dates of birth: still ambiguous', async () => {
    console_([chart('01', 'Testa', 'Household', { date_of_birth: '1950-01-01' }), chart('02', 'Testa', 'Household', { date_of_birth: '1980-01-01' })]);
    const r = await findByPhone(PHONE, 'Testa');
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.chartsOnFile).toBeUndefined();
  });
});

describe('an accent on one chart does not pick that chart before the duplicate rule (Codex P2 on #430)', () => {
  it('"Raul" affirmed, "Raul" without a record and "Raúl" with one: the chart with the record answers, the other surname carried', async () => {
    console_([chart('01', 'Raul', 'Maiden', { has_medical_record: false }), chart('02', 'Raúl', 'Married')]);
    const r = await findByPhone(PHONE, 'Raul');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('02'));
    expect(r.chartsOnFile).toBe(2);
    expect(r.alsoKnownAs).toEqual(['Maiden']);
  });

  it('the same on the name-and-date-of-birth path', async () => {
    console_([chart('01', 'Raul', 'Shared', { has_medical_record: false }), chart('02', 'Raúl', 'Shared')]);
    const r = await verifyPatient({ firstName: 'Raul', lastName: 'Shared', dob: DOB });
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('02'));
  });

  it('an accented first name the caller says still narrows a shared number to the one person', async () => {
    console_([chart('01', 'Raúl', 'Household'), chart('02', 'Otra', 'Household', { date_of_birth: '1990-01-01' })]);
    const r = await findByPhone(PHONE, 'Raul');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('01'));
    expect(r.chartsOnFile).toBeUndefined();
  });

  it('the accent can be on the caller\'s side: "Raúl" sent, "Raul" on the chart', async () => {
    console_([chart('01', 'Raul', 'Household'), chart('02', 'Otra', 'Household', { date_of_birth: '1990-01-01' })]);
    const r = await findByPhone(PHONE, 'Raúl');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('01'));
  });

  it('the shared-opening step folds too: "Raulito" narrows to the one "Raúl" on the number', async () => {
    console_([chart('01', 'Raúl', 'Household'), chart('02', 'Otra', 'Household', { date_of_birth: '1990-01-01' })]);
    const r = await findByPhone(PHONE, 'Raulito');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('01'));
  });
});

describe('names outside the Latin alphabet (Codex P2 on #430)', () => {
  const kBase = { date_of_birth: DOB, phones: [DIGITS] };
  it('an affirmed Korean first name still picks its one person on a shared number', async () => {
    console_([chart('01', '민수', 'Household'), chart('02', '지수', 'Household', { date_of_birth: '1990-01-01' })]);
    const r = await findByPhone(PHONE, '민수');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('01'));
  });
  it('the shared-opening step reads whole syllables: "민수" picks "민수호", not "민지"', async () => {
    console_([chart('01', '민수호', 'Household'), chart('02', '민지', 'Household', { date_of_birth: '1990-01-01' })]);
    const r = await findByPhone(PHONE, '민수');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('01'));
  });
  it('two people with different Korean first names, one birthday and one phone, are two people', () => {
    expect(oneChartedTwice([{ first_name: '민수', ...kBase }, { first_name: '지수', ...kBase }])).toBe(false);
  });
  it('the same Chinese first name twice, one birthday, one phone, is one person charted twice', () => {
    expect(oneChartedTwice([{ first_name: '张伟', ...kBase }, { first_name: '张伟', ...kBase }])).toBe(true);
  });
});

describe('joinedAppointments carries the other charts\' last names into every identity write', () => {
  it('a context with aliases puts them on the record; one without adds nothing', async () => {
    const { joinedAppointments } = await import('../tools/ticketIdentity');
    const base = { patientFound: true, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 } as any;
    expect(joinedAppointments({ ...base, alsoKnownAs: ['Maiden'] }).alsoKnownAs).toEqual(['Maiden']);
    expect('alsoKnownAs' in joinedAppointments(base)).toBe(false);
    expect('alsoKnownAs' in joinedAppointments({ ...base, alsoKnownAs: [] })).toBe(false);
  });
});

describe('what counts as one person charted twice', () => {
  const base = { date_of_birth: DOB, phones: [DIGITS] };
  it('same first name, same date of birth and a shared phone', () => {
    expect(oneChartedTwice([{ first_name: 'Testa', ...base }, { first_name: 'testa ', ...base }])).toBe(true);
  });
  it('an accent or case difference in the first name is the same name', () => {
    // Mid-word, where dropping the mark (not just spacing it out) is what makes them equal.
    expect(oneChartedTwice([{ first_name: 'Raúl', ...base }, { first_name: 'RAUL', ...base }])).toBe(true);
  });
  it('a different first name is a different person', () => {
    expect(oneChartedTwice([{ first_name: 'Testa', ...base }, { first_name: 'Testb', ...base }])).toBe(false);
  });
  it('a different date of birth is a different person (a parent and a child)', () => {
    expect(oneChartedTwice([{ first_name: 'Testa', ...base }, { first_name: 'Testa', ...base, date_of_birth: '1990-01-01' }])).toBe(false);
  });
  it('no phone in common is not enough', () => {
    expect(oneChartedTwice([{ first_name: 'Testa', ...base }, { first_name: 'Testa', ...base, phones: ['5555550199'] }])).toBe(false);
  });
  it('one chart is not two', () => {
    expect(oneChartedTwice([{ first_name: 'Testa', ...base }])).toBe(false);
  });
  it('a missing date of birth decides nothing', () => {
    expect(oneChartedTwice([{ first_name: 'Testa', date_of_birth: '', phones: [DIGITS] }, { first_name: 'Testa', date_of_birth: '', phones: [DIGITS] }])).toBe(false);
  });
});

describe('the tie-break', () => {
  it('neither chart has a record: the most recent visit answers', async () => {
    console_(
      [chart('01', 'Testa', 'Maiden', { has_medical_record: false }), chart('02', 'Testa', 'Married', { has_medical_record: false })],
      { [pid('02')]: '2026-03-03' },
    );
    expect((await findByPhone(PHONE, 'Testa')).patient?.personId).toBe(pid('02'));
  });
  it('no visit on either: the most recently updated chart answers', async () => {
    console_([
      chart('01', 'Testa', 'Maiden', { source_updated_at: '2025-10-01T00:00:00' }),
      chart('02', 'Testa', 'Married', { source_updated_at: '2023-01-01T00:00:00' }),
    ]);
    expect((await findByPhone(PHONE, 'Testa')).patient?.personId).toBe(pid('01'));
  });
  it('the visit read failing still answers with one chart, and does not trip the mirror breaker', async () => {
    console_(
      [chart('01', 'Testa', 'Maiden', { source_updated_at: '2025-10-01T00:00:00' }), chart('02', 'Testa', 'Married')],
      {},
      true,
    );
    const r = await findByPhone(PHONE, 'Testa');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('01'));
    // The next lookup still reaches the mirror.
    console_([chart('05', 'Single', 'Person')]);
    expect((await findByPhone(PHONE)).verified).toBe(true);
  });
  it('one chart with a record answers without reading visits at all (no extra Console read on a live call)', async () => {
    console_(
      [chart('01', 'Testa', 'Maiden', { has_medical_record: false }), chart('02', 'Testa', 'Married')],
      { [pid('01')]: '2026-10-30' },
    );
    expect((await findByPhone(PHONE, 'Testa')).patient?.personId).toBe(pid('02'));
    const visitReads = query.mock.calls.filter(([sql]) => /si_appointment_facts/.test(String(sql)));
    expect(visitReads).toHaveLength(0);
  });
  it('a chart with a record wins over a more recent visit on a chart without one', async () => {
    console_(
      [chart('01', 'Testa', 'Maiden', { has_medical_record: false }), chart('02', 'Testa', 'Married')],
      { [pid('01')]: '2026-10-30', [pid('02')]: '2019-01-01' },
    );
    expect((await findByPhone(PHONE, 'Testa')).patient?.personId).toBe(pid('02'));
  });
});

describe('the name-and-date-of-birth path', () => {
  it('two charts under the same last name, first name and date of birth, sharing a phone, are one patient', async () => {
    console_([chart('01', 'Testa', 'Same', { has_medical_record: false }), chart('02', 'Testa', 'Same')]);
    const r = await verifyPatient({ firstName: 'Testa', lastName: 'Same', dob: DOB });
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(pid('02'));
    expect(r.chartsOnFile).toBe(2);
    expect(r.alsoKnownAs).toBeUndefined();
  });
  it('two people under one last name and date of birth with different first names stay apart', async () => {
    console_([chart('01', 'Testa', 'Same'), chart('02', 'Testb', 'Same')]);
    const r = await verifyPatient({ lastName: 'Same', dob: DOB });
    expect(r.reason).toBe('ambiguous');
  });
});

describe('through lookup_patient and the filing gate', () => {
  const lookup = (args: Record<string, unknown>) => runTool('lookup_patient', args) as Promise<Record<string, unknown>>;
  beforeEach(() => {
    resetVerifiedIdentities();
    resetGateAttempts();
    // The PersonID join echoes an empty history; identity comes from the person base.
    vi.spyOn(scheduleLookupService, 'lookupByPersonId').mockImplementation(async (_id, matchedBy) => ({
      patientFound: false,
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 0,
      scheduleReadStatus: 'available',
      matchedBy,
    }));
    console_([chart('01', 'Testa', 'Maiden', { has_medical_record: false }), chart('02', 'Testa', 'Married')]);
  });

  it(`${ONE_PERSON_ONE_RECORD[0]} — the caller's yes to the greeted first name is certain, and the chart date of birth reaches the ticket`, async () => {
    const sid = ONE_PERSON_ONE_RECORD[0];
    const out = await lookup({ call_sid: sid, phone: PHONE, first_name: 'Testa' });
    expect(out.found).toBe(true);
    expect(out.identity_is_certain).toBe(true);
    expect(out.charts_on_file).toBe(2);
    const ticket = prepareTicketIdentity({ call_sid: sid, first_name: 'Testa', last_name: 'Married' });
    expect(ticket.missing).toBeUndefined();
    expect(ticket.input.date_of_birth).toBe(DOB);
  });

  it(`${ONE_PERSON_ONE_RECORD[1]} — the caller gives the OTHER chart's last name: still the same patient`, async () => {
    const sid = ONE_PERSON_ONE_RECORD[1];
    const out = await lookup({ call_sid: sid, phone: PHONE, first_name: 'Testa', last_name: 'Maiden' });
    expect(out.identity_is_certain).toBe(true);
    expect(verifiedIdentityFor(sid)?.alsoKnownAs).toEqual(['Maiden']);
    const ticket = prepareTicketIdentity({ call_sid: sid, first_name: 'Testa', last_name: 'Maiden' });
    expect(ticket.missing).toBeUndefined();
    expect(ticket.input.date_of_birth).toBe(DOB);
  });

  it(`${ONE_PERSON_ONE_RECORD[2]} — with visit history on the chosen chart, the other surname still validates`, async () => {
    vi.mocked(scheduleLookupService.lookupByPersonId).mockImplementation(async (_id, matchedBy) => ({
      patientFound: true,
      patientName: 'Testa Married',
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 1,
      scheduleReadStatus: 'available',
      matchedBy,
      identity: { unique: true, candidateCount: 1, candidates: [] },
      patientData: {},
    }));
    const sid = ONE_PERSON_ONE_RECORD[2];
    const out = await lookup({ call_sid: sid, phone: PHONE, first_name: 'Testa', last_name: 'Maiden' });
    expect(out.identity_is_certain).toBe(true);
    expect(out.charts_on_file).toBe(2);
  });

  it('a last name that is on neither chart is not this patient', async () => {
    const sid = ONE_PERSON_ONE_RECORD[2];
    const out = await lookup({ call_sid: sid, phone: PHONE, first_name: 'Testa', last_name: 'Stranger' });
    expect(out.identity_is_certain).toBe(false);
    const ticket = prepareTicketIdentity({ call_sid: sid, first_name: 'Testa', last_name: 'Stranger' });
    expect(ticket.missing).toBe('date_of_birth');
  });

  it(`${TWO_PEOPLE[0]} — two people on the number is still "several", and nothing is certain`, async () => {
    console_([chart('01', 'Testa', 'Household', { date_of_birth: '1950-01-01' }), chart('02', 'Testa', 'Household', { date_of_birth: '1980-01-01' })]);
    const out = await lookup({ call_sid: TWO_PEOPLE[0], phone: PHONE, first_name: 'Testa' });
    expect(out.found).toBe(false);
    expect(out.candidate_count).toBe(2);
    expect(out.charts_on_file).toBeUndefined();
  });
});
