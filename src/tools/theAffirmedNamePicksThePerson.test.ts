/**
 * THE AFFIRMED FIRST NAME PICKS ONE PERSON AMONG SEVERAL ON A PHONE — v54.
 *
 * Measured 2026-09-16 on the runtime lanes: 26 recognised callers were
 * refused for a date of birth, all 26 with `carry = no_entry`, their lookups
 * matched by phone with `identity_is_certain: false`, and none had a match
 * followed by a miss. The Schedule phone rung had found SEVERAL people on the
 * number and remembered nobody; the greeting's affirmed name never reached
 * the tool. Driven through `runTool`, the entry point the model calls, with
 * an invented family on an invented number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const { runTool } = await import('./registry');
// Registration is an import side effect — the registry knows the tool only once this module has loaded.
await import('./sharedPatientTools');
const { verifiedIdentityFor, resetVerifiedIdentities } = await import('./verifiedIdentity');
const { resetGateAttempts } = await import('./gateAttempts');
const { recognisedCallerBlock } = await import('../runtime/recognisedCallerBlock');

const SID = 'CA000000000000000000000000000000b4';
const XAVIER = { firstName: 'Xavier', lastName: 'Quixote', dateOfBirth: '1961-03-03', appointmentCount: 4 };
const ZELDA = { firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', appointmentCount: 2 };
const EMPTY = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };

/** The phone rung: two people on the number, the newest-seen (Xavier) as the guess. */
const twoOnThePhone = (candidates = [XAVIER, ZELDA]) => ({
  patientFound: true,
  patientName: `${candidates[0].firstName} ${candidates[0].lastName}`,
  matchedBy: 'phone' as const,
  identity: { unique: candidates.length <= 1, candidateCount: candidates.length, candidates },
  patientData: { firstName: candidates[0].firstName, lastName: candidates[0].lastName, dateOfBirth: candidates[0].dateOfBirth },
  upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 6,
});
/** The name + date-of-birth rung, one person by construction. */
const zeldaAlone = {
  patientFound: true, patientName: 'Zelda Quixote', matchedBy: 'name_and_dob' as const, identityUnconfirmed: false,
  identity: { unique: true, candidateCount: 1, candidates: [ZELDA] },
  patientData: { firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', personId: 'p-zelda' },
  upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 2,
};

type Out = Record<string, unknown>;
const lookup = (args: Record<string, unknown>) => runTool('lookup_patient', args) as Promise<Out>;
const byTrio = (p: Record<string, unknown>) => Boolean(p.firstName && p.lastName && p.dateOfBirth);

beforeEach(() => {
  lookupSpy.mockReset();
  lookupSpy.mockImplementation(async (p: Record<string, unknown>) => (byTrio(p) ? zeldaAlone : twoOnThePhone()));
  resetGateAttempts();
  resetVerifiedIdentities();
});

describe('a phone that carries two people', () => {
  it('with the affirmed first name, locks THAT person — certain, remembered with the chart date', async () => {
    const out = await lookup({ queue: 'surgery', call_sid: SID, caller_phone: '555-555-0147', first_name: 'Zelda' });
    expect(out.found).toBe(true);
    expect(out.identity_is_certain).toBe(true);
    expect(out.matched_by).toBe('phone');
    // The re-resolve asked for Zelda's own trio, not Xavier's.
    const trio = lookupSpy.mock.calls.map((c) => c[0] as Record<string, unknown>).find(byTrio);
    expect(trio).toMatchObject({ firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04' });
    const remembered = verifiedIdentityFor(SID);
    expect(remembered).toMatchObject({ firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', certain: true });
  });

  it('with no first name, the match stays a guess among two and nothing is remembered', async () => {
    const out = await lookup({ queue: 'surgery', call_sid: SID, caller_phone: '555-555-0147' });
    expect(out.found).toBe(true);
    expect(out.identity_is_certain).toBe(false);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('a first name BOTH people share picks nobody — a father and a son stay two candidates', async () => {
    lookupSpy.mockImplementation(async (p: Record<string, unknown>) =>
      byTrio(p) ? zeldaAlone : twoOnThePhone([{ ...XAVIER, firstName: 'Zelda' }, ZELDA]),
    );
    const out = await lookup({ queue: 'surgery', call_sid: SID, caller_phone: '555-555-0147', first_name: 'Zelda' });
    expect(out.identity_is_certain).toBe(false);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('a first name NEITHER person has picks nobody', async () => {
    const out = await lookup({ queue: 'surgery', call_sid: SID, caller_phone: '555-555-0147', first_name: 'Yolanda' });
    expect(out.identity_is_certain).toBe(false);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('when the re-resolve on that person misses, the guess stands and nothing is remembered', async () => {
    lookupSpy.mockImplementation(async (p: Record<string, unknown>) => (byTrio(p) ? EMPTY : twoOnThePhone()));
    const out = await lookup({ queue: 'surgery', call_sid: SID, caller_phone: '555-555-0147', first_name: 'Zelda' });
    expect(out.found).toBe(true);
    expect(out.identity_is_certain).toBe(false);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });
});

describe('the recognised-caller block feeds the tool the affirmed name', () => {
  it('tells the model to call lookup_patient with first_name after a YES', () => {
    const block = recognisedCallerBlock({ matched: true, firstName: 'Zelda' } as never);
    const yes = block.slice(block.indexOf('If they said YES'));
    expect(yes).toMatch(/Call lookup_patient\s+with first_name "Zelda"/);
  });
});
