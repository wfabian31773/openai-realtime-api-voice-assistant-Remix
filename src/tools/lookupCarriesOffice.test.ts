/**
 * DOES `lookup_patient` ACTUALLY PUT THE OFFICE IN THE STORE?
 *
 * This file exists because the first version of the optical suite could not
 * answer that. Those tests seed `verifiedIdentity` by calling
 * `rememberVerifiedIdentity` themselves, so they prove the filing tool READS
 * the office — and mutation testing showed that deleting the write inside
 * `lookup_patient` left all five of them green. The feature would have been
 * dead in production with a passing suite, which is CLAUDE.md failure mode 10
 * in its most expensive form: the SOURCE untested, the sink well covered.
 *
 * So this drives the real tool against a mocked schedule service and reads
 * the store through the same public function the filing path calls.
 *
 * Fixtures are invented. No production caller appears here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

import { runTool } from './registry';
import './sharedPatientTools';
import { usualOfficeFor, verifiedDobFor, resetVerifiedIdentities } from './verifiedIdentity';

// Mocked rather than spied, for the reason lookupFallback.test.ts gives:
// importing the real service pulls in the database.
const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const SID = 'CA00000000000000000000000000000043';

const FOUND = {
  patientFound: true,
  patientName: 'Testcaller Optical',
  matchedBy: 'name_dob',
  patientData: {
    firstName: 'Testcaller',
    lastName: 'Optical',
    dateOfBirth: '01/01/1950',
  },
  pastAppointments: [{ location: 'Glendora', provider: 'A. Clinician, OD' }],
  lastLocationSeen: 'Glendora',
  lastProviderSeen: 'A. Clinician, OD',
  lastVisitDate: '2026-07-09',
  totalAppointmentsFound: 12,
  identity: { unique: true, candidateCount: 1, candidates: [] },
};

const ARGS = {
  first_name: 'Testcaller',
  last_name: 'Optical',
  date_of_birth: '01/01/1950',
  queue: 'optical',
  call_sid: SID,
};

beforeEach(() => {
  lookupSpy.mockReset();
  resetVerifiedIdentities();
});

describe('the office the lookup picked survives the lookup', () => {
  it('is readable by the filing path afterwards, not only spoken to the model', async () => {
    lookupSpy.mockResolvedValue(FOUND as never);

    const out = (await runTool('lookup_patient', ARGS)) as Record<string, unknown>;

    // What the model is told, and what the ticket path can now read. Both,
    // from one lookup — the point of the change is that these agree.
    expect(out.usual_office).toBe('Glendora');
    expect(usualOfficeFor(SID, 'Testcaller', 'Optical')).toBe('Glendora');
  });

  it('hands the filing path NOTHING for an ambiguous match', async () => {
    /**
     * Named for what it proves. Mutation testing showed that removing the
     * write-side `if (uniqueMatch)` guard does NOT fail this test, because the
     * READER refuses anything not marked certain and the flag is stored
     * faithfully either way. So this pins the guard the office actually
     * depends on — `usualOfficeFor` — and not the outer one, which is
     * pre-existing defence in depth for a different reader.
     *
     * Calling it "stores nothing" would have been a claim the assertion
     * cannot make: it reads the store through the public function, which is
     * the right sink, and that function is exactly what stands between an
     * ambiguous match and a wrongly-routed ticket.
     */
    lookupSpy.mockResolvedValue({
      ...FOUND,
      matchedBy: 'phone',
      identity: { unique: false, candidateCount: 3, candidates: [] },
    } as never);

    await runTool('lookup_patient', { ...ARGS, phone: '555-555-0147' });

    expect(usualOfficeFor(SID, 'Testcaller', 'Optical')).toBeUndefined();
  });

  it('stores nothing when the history holds no office this queue can use', async () => {
    lookupSpy.mockResolvedValue({
      ...FOUND,
      pastAppointments: [],
      lastLocationSeen: undefined,
    } as never);

    await runTool('lookup_patient', ARGS);

    expect(usualOfficeFor(SID, 'Testcaller', 'Optical')).toBeUndefined();
  });
});

/**
 * CODEX P1 ON PR #291 — a confident answer must not outlive itself.
 *
 * `rememberVerifiedIdentity` is only reached under `if (uniqueMatch)`, so
 * before this there was no path at all that could unset an entry. A call that
 * matched uniquely and then went ambiguous kept the first result, `certain`
 * and all, and `usualOfficeFor` routed the LATER patient's ticket to the
 * EARLIER patient's office — on the one queue that assigns by office.
 *
 * Both tests drive the real tool twice, because a single-lookup test cannot
 * see this: the defect only exists in the second call's effect on the first.
 */
describe('an ambiguous second lookup on the same call', () => {
  it('drops the earlier certain match when it is about the same name', async () => {
    lookupSpy.mockResolvedValue(FOUND as never);
    await runTool('lookup_patient', ARGS);
    // Established first, so the assertions below are about the SECOND call.
    expect(usualOfficeFor(SID, 'Testcaller', 'Optical')).toBe('Glendora');

    lookupSpy.mockResolvedValue({
      ...FOUND,
      matchedBy: 'phone',
      identity: { unique: false, candidateCount: 2, candidates: [] },
    } as never);
    await runTool('lookup_patient', { ...ARGS, phone: '555-555-0147' });

    // The office is the field that cannot be checked against the ticket.
    expect(usualOfficeFor(SID, 'Testcaller', 'Optical')).toBeUndefined();
    // And the date of birth goes with it: the name guard cannot separate two
    // people who share a name, which is exactly the case that got here.
    expect(verifiedDobFor(SID, 'Testcaller', 'Optical')).toBeUndefined();
  });

  it('leaves a match about SOMEBODY ELSE alone', async () => {
    /**
     * The narrowness is load-bearing, not incidental. Clearing on every
     * ambiguous lookup would throw the identification away whenever the model
     * ran a second, vaguer search for a different person — and that entry is
     * what carries the date of birth past the gate that ended 53 of 75 calls
     * with no ticket. Mutating `forgetIfSameName` to clear unconditionally
     * must fail HERE.
     */
    lookupSpy.mockResolvedValue(FOUND as never);
    await runTool('lookup_patient', ARGS);

    lookupSpy.mockResolvedValue({
      ...FOUND,
      patientName: 'Someone Else',
      matchedBy: 'name',
      patientData: {
        firstName: 'Someone',
        lastName: 'Else',
        dateOfBirth: '02/02/1960',
      },
      identity: { unique: false, candidateCount: 4, candidates: [] },
    } as never);
    await runTool('lookup_patient', {
      ...ARGS,
      first_name: 'Someone',
      last_name: 'Else',
    });

    expect(usualOfficeFor(SID, 'Testcaller', 'Optical')).toBe('Glendora');
    expect(verifiedDobFor(SID, 'Testcaller', 'Optical')).toBe('01/01/1950');
  });
});
