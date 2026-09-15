/**
 * CHART DATE OF BIRTH — STOP THE WIPE, INHERIT ON FILE.
 *
 * Diagnosis is PR #307 / `the-dob-carry.md`. Wayne rejected instrument-only:
 * the professional line cannot keep refusing create-ticket for a date the
 * chart already holds. These pin the two load-bearing halves:
 *
 *   A  wipe cannot return — v11 seed, then a person-base lookup that used
 *      to strip the date, then `file_*_ticket` without `date_of_birth`.
 *      The object handed to `createTicket` carries the chart parts.
 *   B  empty cannot clear — `remember` with a date, then the same person
 *      with no date. `verifiedDobFor` still returns the date.
 *   D  name guard — a ticket under another name does not inherit.
 *   E  already pinned in `verifiedIdentity.test.ts` (caller conflict).
 *
 * Bug B (name guard): `nameKey` treats hyphen / accent / apostrophe as the
 * same person. Nicknames and maiden names stay refused — residual, measured
 * by `carry: name_mismatch` after deploy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const {
  rememberVerifiedIdentity,
  verifiedDobFor,
  dobCarry,
  resetVerifiedIdentities,
} = await import('./verifiedIdentity');
const { runTool } = await import('./registry');
await import('./sharedPatientTools');
await import('./opticalTools');
await import('./surgeryTools');
await import('./techTools');
await import('./medicalRecordsTools');

const SID = 'CA000000000000000000000000000000c1';
const CHART = '1950-01-01';

const RECORD = {
  patientFound: true,
  patientName: 'Testcaller Mirror',
  matchedBy: 'phone',
  identityUnconfirmed: true,
  upcomingAppointments: [],
  pastAppointments: [
    {
      date: 'July 13',
      isoDate: '2026-07-13',
      dayOfWeek: 'Monday',
      timeOfDay: '3:30 PM',
      location: 'Covina',
      provider: 'Testprovider One, MD',
      status: 'Active',
    },
  ],
  totalAppointmentsFound: 4,
  lastLocationSeen: 'Covina',
  lastProviderSeen: 'Testprovider One, MD',
  identity: { unique: true, candidateCount: 1, candidates: [] },
  patientData: {
    firstName: 'Testcaller',
    lastName: 'Mirror',
    dateOfBirth: CHART,
    personId: 'person-chart',
  },
};

const FILING = [
  { tool: 'file_optical_ticket', extra: { location: 'Eastvale' } },
  { tool: 'file_surgery_ticket', extra: {} },
  { tool: 'file_tech_ticket', extra: {} },
  {
    tool: 'file_records_ticket',
    extra: { requester: 'I am the patient', deliver_to: 'to me', date_range: 'everything' },
  },
] as const;

function ticketArgs(first: string, last: string, extra: Record<string, string>) {
  return {
    first_name: first,
    last_name: last,
    callback_number: '5555550100',
    request_description: 'a refill',
    call_sid: SID,
    ...extra,
  };
}

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

async function spyCreate() {
  const api = await client();
  vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
    success: true,
    outcome: 'matched',
    locationId: 12,
    locationMatches: [],
  } as never);
  return vi.spyOn(api, 'createTicket').mockResolvedValue({
    success: true,
    ticketNumber: 'VA-INHERIT',
  } as never);
}

beforeEach(async () => {
  resetVerifiedIdentities();
  lookupSpy.mockReset();
  (await import('./dobEscape')).resetDobHistory();
  (await import('./spokenDob')).resetSpokenDobs();
  (await import('./gateAttempts')).resetGateAttempts();
  vi.restoreAllMocks();
});

describe('Invariant B — empty cannot clear a date already stored for that person', () => {
  it('same names, no personId on either side, incoming empty — date survives', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller',
      lastName: 'Mirror',
      dateOfBirth: CHART,
      certain: false,
    });
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller',
      lastName: 'Mirror',
      certain: false,
    });
    expect(verifiedDobFor(SID, 'Testcaller', 'Mirror')).toBe(CHART);
  });

  it('same personId, incoming empty — date survives and certainty does not drop', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller',
      lastName: 'Mirror',
      dateOfBirth: CHART,
      personId: 'person-chart',
      certain: true,
    });
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller',
      lastName: 'Mirror',
      personId: 'person-chart',
      certain: false,
    });
    expect(verifiedDobFor(SID, 'Testcaller', 'Mirror')).toBe(CHART);
    expect(dobCarry(SID, 'Testcaller', 'Mirror')).toBe('fired');
  });

  it('v11 pre-context then a person-base write with no date — the wipe cannot return', async () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller',
      lastName: 'Mirror',
      dateOfBirth: CHART,
      certain: false,
    });
    lookupSpy.mockResolvedValue({
      ...RECORD,
      patientData: { firstName: 'Testcaller', lastName: 'Mirror', personId: 'person-chart' },
    } as never);

    await runTool('lookup_patient', {
      queue: 'optical',
      call_sid: SID,
      caller_phone: '555-555-0147',
    });

    expect(
      verifiedDobFor(SID, 'Testcaller', 'Mirror'),
      'an empty person-base write must not erase the pre-context chart date',
    ).toBe(CHART);
  });
});

describe('Invariant A — inherit on file after the person-base lookup', () => {
  it('files optical with the chart parts when the model omitted date_of_birth', async () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller',
      lastName: 'Mirror',
      dateOfBirth: CHART,
      certain: false,
    });
    lookupSpy.mockResolvedValue(RECORD as never);
    await runTool('lookup_patient', {
      queue: 'optical',
      call_sid: SID,
      caller_phone: '555-555-0147',
    });

    const create = await spyCreate();
    const out = await runTool(
      'file_optical_ticket',
      ticketArgs('Testcaller', 'Mirror', { location: 'Eastvale' }),
    );

    expect(out.success).toBe(true);
    expect(create).toHaveBeenCalled();
    const filed = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(filed.patientBirthMonth).toBe('01');
    expect(filed.patientBirthDay).toBe('01');
    expect(filed.patientBirthYear).toBe('1950');
  });

  it('each filing tool puts the chart parts on createTicket when names match', async () => {
    for (const { tool, extra } of FILING) {
      resetVerifiedIdentities();
      (await import('./dobEscape')).resetDobHistory();
      (await import('./gateAttempts')).resetGateAttempts();
      rememberVerifiedIdentity(SID, {
        firstName: 'Testcaller',
        lastName: 'Mirror',
        dateOfBirth: CHART,
        certain: false,
      });
      const create = await spyCreate();
      create.mockClear();
      const out = await runTool(tool, ticketArgs('Testcaller', 'Mirror', extra));
      expect(out.success, tool).toBe(true);
      expect(create, tool).toHaveBeenCalled();
      const filed = create.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(filed.patientBirthMonth, tool).toBe('01');
      expect(filed.patientBirthDay, tool).toBe('01');
      expect(filed.patientBirthYear, tool).toBe('1950');
    }
  });
});

describe('Invariant D — do not invent a date for a different name', () => {
  it('a ticket under another name does not take the stored date', async () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller',
      lastName: 'Mirror',
      dateOfBirth: CHART,
      certain: true,
    });
    const create = await spyCreate();
    const out = await runTool(
      'file_optical_ticket',
      ticketArgs('Maria', 'Mirror', { location: 'Eastvale' }),
    );
    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('date_of_birth');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('Bug B — nameKey, not a nickname list', () => {
  it('Garcia-Lopez stored, Garcia Lopez on the ticket — inherit fires', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Ana',
      lastName: 'Garcia-Lopez',
      dateOfBirth: CHART,
      certain: true,
    });
    expect(verifiedDobFor(SID, 'Ana', 'Garcia Lopez')).toBe(CHART);
    expect(dobCarry(SID, 'Ana', 'Garcia Lopez')).toBe('fired');
  });

  it('José stored, Jose on the ticket — inherit fires', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'José',
      lastName: 'Garcia',
      dateOfBirth: CHART,
      certain: true,
    });
    expect(verifiedDobFor(SID, 'Jose', 'Garcia')).toBe(CHART);
  });

  it('O’Brien stored, O\'Brien on the ticket — inherit fires', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Pat',
      lastName: 'O\u2019Brien',
      dateOfBirth: CHART,
      certain: true,
    });
    expect(verifiedDobFor(SID, 'Pat', "O'Brien")).toBe(CHART);
  });

  it('Wayne vs Maria is still a miss — first names are not nicknames', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Wayne',
      lastName: 'Fabian',
      dateOfBirth: '03/17/1973',
      certain: true,
    });
    expect(verifiedDobFor(SID, 'Maria', 'Fabian')).toBeUndefined();
    expect(dobCarry(SID, 'Maria', 'Fabian')).toBe('name_mismatch');
  });
});
