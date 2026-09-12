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
import { usualOfficeFor, resetVerifiedIdentities } from './verifiedIdentity';

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
