/**
 * THE STORE PROBE — task #148.
 *
 * `verifiedIdentityFor` answers with a name or with `undefined`, and that one
 * `undefined` is four different facts. This pins each of the four apart, and
 * pins the probe against the REAL writer — `lookup_patient` through `runTool`,
 * the entry point the model calls — rather than a hand-seeded map, because a
 * probe proven only against a map I filled myself is the mistake v51's own
 * test made (failure mode 10).
 *
 * Invented family, invented number, invented SIDs. No real patient anywhere.
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
// Registration is an import side effect.
await import('./sharedPatientTools');
const { identityStoreProbe, rememberVerifiedIdentity, verifiedIdentityFor, resetVerifiedIdentities } =
  await import('./verifiedIdentity');
const { resetGateAttempts } = await import('./gateAttempts');
const { identityForRow } = await import('../runtime/runtimeIdentity');

const SID = 'CA0000000000000000000000000000ab01';
const OTHER_SID = 'CA0000000000000000000000000000ab02';
const SENTINEL = 'unknown';

const QUILL = { firstName: 'Quill', lastName: 'Everard', dateOfBirth: '1959-07-07', appointmentCount: 3 };
const RUE = { firstName: 'Rue', lastName: 'Everard', dateOfBirth: '1962-02-02', appointmentCount: 1 };

/** ONE person on the number: the production shape behind 187 of 09-17's 209 certain lookups. */
const oneOnThePhone = {
  patientFound: true,
  patientName: 'Quill Everard',
  matchedBy: 'phone' as const,
  identity: { unique: true, candidateCount: 1, candidates: [QUILL] },
  patientData: { firstName: 'Quill', lastName: 'Everard', dateOfBirth: '1959-07-07', personId: 'p-quill' },
  upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 3,
};
/**
 * TWO people on the number — unique false.
 *
 * NOTE, and it corrected this file's first draft: a non-unique match stores
 * NOTHING, because `rememberVerifiedIdentity` sits under `if (uniqueMatch)`.
 * So this shape produces an EMPTY store, not an uncertain entry — which is
 * why v54's finding that 26 of 26 recognised callers read `carry = no_entry`
 * is internally consistent rather than surprising.
 */
const twoOnThePhone = {
  ...oneOnThePhone,
  identity: { unique: false, candidateCount: 2, candidates: [QUILL, RUE] },
};
/**
 * A UNIQUE hit on a NAME ALONE: stored, and deliberately not certain.
 * `certain` is unique AND matchedBy neither 'name' nor 'dob', so this is the
 * shape that actually puts an uncertain entry in the store.
 */
const oneByNameAlone = {
  ...oneOnThePhone,
  matchedBy: 'name' as const,
  identity: { unique: true, candidateCount: 1, candidates: [QUILL] },
};
const NOBODY = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };

beforeEach(() => {
  lookupSpy.mockReset();
  resetGateAttempts();
  resetVerifiedIdentities();
});

describe('the four facts behind one undefined', () => {
  it('A CERTAIN MATCH: entry, certain, with a date — and it reaches the row', async () => {
    lookupSpy.mockImplementation(async () => oneOnThePhone);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: SID, caller_phone: '555-555-0199' });

    const probe = identityStoreProbe(SID);
    expect(probe).toMatchObject({
      size: 1, certainEntries: 1, sidCanonical: true,
      hasEntry: true, entryCertain: true, entryHasDob: true,
    });
    // The whole point: the probe agrees with what v51 actually gets.
    expect(identityForRow(SID).patientFound).toBe(true);
  });

  it('NO ENTRY: the lookup found nobody, so an empty store is the honest answer', async () => {
    lookupSpy.mockImplementation(async () => NOBODY);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: SID, caller_phone: '555-555-0199' });

    expect(identityStoreProbe(SID)).toMatchObject({
      size: 0, certainEntries: 0, sidCanonical: true, hasEntry: false, entryCertain: false,
    });
    expect(identityForRow(SID)).toEqual({});
  });

  it('ENTRY NOT CERTAIN: a unique NAME-only hit is remembered, and is not an identity', async () => {
    lookupSpy.mockImplementation(async () => oneByNameAlone);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: SID, caller_phone: '555-555-0199', last_name: 'Everard' });

    const probe = identityStoreProbe(SID);
    // The split that matters: something IS here, and it is not an identity.
    expect(probe).toMatchObject({ hasEntry: true, entryCertain: false });
    expect(probe.size).toBe(1);
    expect(probe.certainEntries).toBe(0);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
    expect(identityForRow(SID)).toEqual({});
  });

  /**
   * The non-unique phone match, pinned as its own fact because it is the
   * production shape behind v54's 26-of-26 `no_entry` and because assuming it
   * stored an uncertain entry is what this file got wrong first.
   */
  it('TWO ON THE NUMBER: nothing is stored at all, so the store reads empty', async () => {
    lookupSpy.mockImplementation(async () => twoOnThePhone);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: SID, caller_phone: '555-555-0199' });

    expect(identityStoreProbe(SID)).toMatchObject({ size: 0, hasEntry: false, entryCertain: false });
    expect(identityForRow(SID)).toEqual({});
  });

  it('KEY MISMATCH: the store holds a certain entry under ANOTHER call, and none under this one', async () => {
    lookupSpy.mockImplementation(async () => oneOnThePhone);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: OTHER_SID, caller_phone: '555-555-0199' });

    const probe = identityStoreProbe(SID);
    // size > 0 with hasEntry false is the hypothesis the 2026-09-17 data could
    // not test: the write and the read disagreeing about this call's SID.
    expect(probe.size).toBe(1);
    expect(probe.certainEntries).toBe(1);
    expect(probe.hasEntry).toBe(false);
    expect(probe.sidCanonical).toBe(true);
  });

  /**
   * ONE MUTATION SURVIVES THIS, BY DESIGN, AND IT IS RECORDED RATHER THAN
   * FAKED: removing the `sidCanonical ?` guard from the probe's own READ fails
   * nothing, because `rememberVerifiedIdentity` refuses a non-canonical key on
   * the WRITE, so the map can never hold one for the read to find.
   *
   * The guard stays anyway, for the reason `verifiedDobFor` states about its
   * own: *"Validated on the READ as well as the write, not because a sentinel
   * could be in the map (the write refuses it) but so the guard survives
   * someone later relaxing the write. Both ends state the same rule."*
   */
  it('SID NOT CANONICAL: a sentinel can never have an entry, and says so', () => {
    rememberVerifiedIdentity(SENTINEL, { ...QUILL, certain: true });
    const probe = identityStoreProbe(SENTINEL);
    expect(probe.sidCanonical).toBe(false);
    expect(probe.hasEntry).toBe(false);
    // The WRITE refused it, which is what makes the read guard unreachable.
    expect(probe.size).toBe(0);
  });
});

describe('what the probe must not do', () => {
  it('carries no patient data at all — counts, booleans and nothing else', async () => {
    lookupSpy.mockImplementation(async () => oneOnThePhone);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: SID, caller_phone: '555-555-0199' });

    const before = Date.now();
    const probe = identityStoreProbe(SID);
    const after = Date.now();

    /**
     * `at` is excluded from the substring scan and pinned as a CLOCK READING
     * instead. A 13-digit epoch can contain any four digits by coincidence, so
     * scanning it for a birth year is a test that fails on a Tuesday; asserting
     * it is the moment of the read is both stronger and stable.
     */
    const { at, ...rest } = probe;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);

    const serialised = JSON.stringify(rest);
    for (const leak of ['Quill', 'Everard', '1959', '0199', 'p-quill', SID]) {
      expect(serialised).not.toContain(leak);
    }
    // Only these keys, so a later field cannot smuggle a name in unnoticed.
    expect(Object.keys(probe).sort()).toEqual(
      ['at', 'certainEntries', 'entryCertain', 'entryHasDob', 'hasEntry', 'sidCanonical', 'size'],
    );
    for (const v of Object.values(probe)) expect(['number', 'boolean']).toContain(typeof v);
  });

  /**
   * The read moment is what bounds the mismatch JOIN in `identityTelemetry.ts`
   * to lookups the probe could have SEEN — a `lookup_patient` settling after
   * hangup writes a certain result to `tool_timeline` regardless, and without
   * this the join files that call as a SID disagreement (Codex P2, #322 round
   * 5). It must be the instant of THIS read, not of the process or the entry.
   */
  it('reports the instant it read the store, not the entry it found', async () => {
    lookupSpy.mockImplementation(async () => oneOnThePhone);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: SID, caller_phone: '555-555-0199' });

    const first = identityStoreProbe(SID).at;
    await new Promise((r) => setTimeout(r, 5));
    const second = identityStoreProbe(SID).at;
    expect(second).toBeGreaterThan(first);
  });

  it('is a PURE READ — probing does not evict the entry it just reported', async () => {
    lookupSpy.mockImplementation(async () => oneOnThePhone);
    await runTool('lookup_patient', { queue: 'surgery', call_sid: SID, caller_phone: '555-555-0199' });

    expect(identityStoreProbe(SID).hasEntry).toBe(true);
    expect(identityStoreProbe(SID).hasEntry).toBe(true);
    // A diagnostic that sweeps changes the thing it measures.
    expect(identityForRow(SID).patientFound).toBe(true);
  });
});
