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

beforeEach(() => lookupSpy.mockReset());

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
