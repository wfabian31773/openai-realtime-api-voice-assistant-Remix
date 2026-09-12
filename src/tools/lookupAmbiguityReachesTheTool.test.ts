/**
 * DOES THE AMBIGUITY ACTUALLY REACH THE MODEL?
 *
 * Codex P2 on PR #292, and the finding was as much about the TEST as the code.
 * `lookupPersonBaseRung.test.ts` asserts at the service, where the ambiguous
 * answer is a context carrying `identity` on an otherwise empty shell. The
 * TOOL then read only `patientFound` and answered "No record found" — so the
 * service test passed while the signal died one layer up, which is CLAUDE.md
 * failure mode 10 in its usual shape: the source proven, the sink assumed.
 *
 * This drives `runTool` — the same entry point the model calls.
 *
 * Fixtures are invented. No production caller appears here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

import { runTool } from './registry';
import './sharedPatientTools';

const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const SID = 'CA00000000000000000000000000000044';
const EMPTY = {
  patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
};

/**
 * BRACES, NOT AN IMPLICIT RETURN. `mockReset()` returns the mock for chaining,
 * and an arrow without braces returns it — which vitest takes as a CLEANUP
 * FUNCTION and calls after every test, invoking the spy with no arguments.
 * Harmless while every test used `mockResolvedValue`; the moment one uses
 * `mockImplementation` and reads its argument, it throws in a teardown hook
 * and fails the test that just passed.
 */
beforeEach(() => {
  lookupSpy.mockReset();
});

describe('an ambiguous person-base hit, as the MODEL receives it', () => {
  it('says several people, not "no record found"', async () => {
    lookupSpy.mockResolvedValue({
      ...EMPTY,
      identity: { unique: false, candidateCount: 3, candidates: [] },
    } as never);

    const out = (await runTool('lookup_patient', {
      queue: 'optical', call_sid: SID, caller_phone: '555-555-0147',
    })) as Record<string, unknown>;

    expect(out.found).toBe(false);
    // The three things the agent needs and did not get before.
    expect(out.identity_is_certain).toBe(false);
    expect(out.candidate_count).toBe(3);
    expect(String(out.message)).toMatch(/3 different people/);
    // And specifically NOT the sentence that sends it down the new-patient path.
    expect(String(out.message)).not.toMatch(/No record found/);
  });

  it('still says "no record found" when the mirror vouched for nobody', async () => {
    // The ordinary miss must keep its wording — this is the control, and it is
    // what stops the branch above swallowing every not-found.
    lookupSpy.mockResolvedValue(EMPTY as never);

    const out = (await runTool('lookup_patient', {
      queue: 'optical', call_sid: SID, caller_phone: '555-555-0147',
    })) as Record<string, unknown>;

    expect(out.found).toBe(false);
    expect(out.candidate_count).toBeUndefined();
    expect(String(out.message)).toMatch(/No record found/);
  });
});

describe('the phone retry may NOT overwrite an explicit ambiguity', () => {
  it('keeps the ambiguous verdict when the caller number matches someone else', async () => {
    /**
     * Codex P1 on PR #292. Name + date of birth came back AMBIGUOUS — several
     * people, which is a stronger claim than a miss and instruction 6 forbids
     * resolving it. The phone-only retry then matched ONE person, and nothing
     * checks that person is among the candidates the NAME matched. Before the
     * fix this answered `found: true, identity_is_certain: true` carrying an
     * unrelated person's PersonID-joined history — a daughter's chart read
     * back to a caller who spoke her mother's name and birthday.
     *
     * Small: last+DOB collides for 2.0% of 400 sampled persons and the full
     * triple for 0. Fixed anyway — reading the wrong patient's record aloud is
     * not the same class of harm as a lost request.
     */
    lookupSpy.mockImplementation(async (p: Record<string, unknown>) => {
      // The name+DOB attempt: several people, nobody chosen.
      if (p.firstName || p.lastName || p.dateOfBirth) {
        return { ...EMPTY, identity: { unique: false, candidateCount: 2, candidates: [] } };
      }
      // The phone-only retry: a confident hit on a DIFFERENT person entirely.
      return {
        ...EMPTY,
        patientFound: true,
        patientName: 'Someone Else',
        matchedBy: 'phone',
        totalAppointmentsFound: 7,
        identity: { unique: true, candidateCount: 1, candidates: [] },
        patientData: { firstName: 'Someone', lastName: 'Else', dateOfBirth: '1970-02-02' },
      };
    });

    const out = (await runTool('lookup_patient', {
      queue: 'optical', call_sid: SID, caller_phone: '555-555-0147',
      first_name: 'Testcaller', last_name: 'Mirror', date_of_birth: '01/01/1950',
    })) as Record<string, unknown>;

    expect(out.found).toBe(false);
    expect(out.identity_is_certain).toBe(false);
    expect(out.candidate_count).toBe(2);
    // The other person must not appear ANYWHERE in what the model receives.
    expect(JSON.stringify(out)).not.toMatch(/Someone Else|1970-02-02/);
  });

  it('still retries on the phone when name+DOB was a genuine MISS', async () => {
    // The guard must not cost the recovery it sits next to: a mis-transcribed
    // name is the common case and the caller's own number is the one field
    // nobody misheard.
    lookupSpy.mockImplementation(async (p: Record<string, unknown>) => {
      if (p.firstName || p.lastName || p.dateOfBirth) return EMPTY; // a plain miss
      return {
        ...EMPTY,
        patientFound: true,
        patientName: 'Testcaller Mirror',
        matchedBy: 'phone',
        totalAppointmentsFound: 4,
        identity: { unique: true, candidateCount: 1, candidates: [] },
        patientData: { firstName: 'Testcaller', lastName: 'Mirror', dateOfBirth: '1950-01-01' },
      };
    });

    const out = (await runTool('lookup_patient', {
      queue: 'optical', call_sid: SID, caller_phone: '555-555-0147',
      first_name: 'Tastcaller', last_name: 'Mirror', date_of_birth: '01/01/1950',
    })) as Record<string, unknown>;

    expect(out.found).toBe(true);
    expect(out.identity_is_certain).toBe(true);
  });
});
