/**
 * WHY THE IDENTITY WRITE DID NOTHING — the W1 instrument, 2026-09-23.
 *
 * `rememberVerifiedIdentity` returns early on three conditions and all three
 * leave the map EMPTY, so `identityStoreProbe` reporting `storeSize: 0` cannot
 * tell a refused write from one that never happened. On 2026-09-22 all 623
 * probed calls read exactly that while 210 of them ran a `lookup_patient`
 * reporting `identity_is_certain: true`, and the fork could not be split from
 * outside (docs/observatory/SPEC-20260923.md).
 *
 * So the writer now names its own verdict and both call sites put it somewhere
 * countable. Driven through the REAL `lookup_patient` via `runTool` — the entry
 * point the model calls — because a probe proven only against a map I filled
 * myself is the mistake v51's own test made (failure mode 10).
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
await import('./sharedPatientTools');
const { identityStoreProbe, rememberVerifiedIdentity, resetVerifiedIdentities } =
  await import('./verifiedIdentity');
const { resetGateAttempts } = await import('./gateAttempts');
const { identityEvent } = await import('../runtime/identityTelemetry');

const SID = 'CA0000000000000000000000000000cd01';
const SENTINEL = 'unknown';
const PHONE = '+15550000199';

const ONE = {
  patientFound: true,
  patientName: 'Wren Oakhollow',
  matchedBy: 'phone' as const,
  identity: { unique: true, candidateCount: 1, candidates: [] },
  patientData: {
    firstName: 'Wren',
    lastName: 'Oakhollow',
    dateOfBirth: '1958-03-03',
    personId: 'p-wren',
  },
  upcomingAppointments: [],
  pastAppointments: [],
  totalAppointmentsFound: 2,
};

beforeEach(() => {
  lookupSpy.mockReset();
  resetVerifiedIdentities();
  resetGateAttempts();
});

describe('the lookup tool says what its identity write did', () => {
  it('reports stored, and the entry is really there', async () => {
    lookupSpy.mockResolvedValue(ONE);
    const res: any = await runTool('lookup_patient', { phone: PHONE, call_sid: SID });
    expect(res.identity_is_certain).toBe(true);
    expect(res.identity_write).toBe('stored');
    expect(identityStoreProbe(SID)).toMatchObject({ size: 1, hasEntry: true, entryCertain: true });
  });

  it('reports merged when the same person is written twice on one call', async () => {
    lookupSpy.mockResolvedValue(ONE);
    await runTool('lookup_patient', { phone: PHONE, call_sid: SID });
    const res: any = await runTool('lookup_patient', { phone: PHONE, call_sid: SID });
    expect(res.identity_write).toBe('merged');
    expect(identityStoreProbe(SID)).toMatchObject({ size: 1, hasEntry: true });
  });

  /**
   * THE FORK THAT COULD NOT BE SPLIT. A sentinel SID is refused at the guard,
   * so NOTHING is stored and the probe is indistinguishable from a call whose
   * write never ran. The verdict is the whole difference.
   */
  it('reports refused_sid on a sentinel call id, and stores nothing', async () => {
    lookupSpy.mockResolvedValue(ONE);
    const res: any = await runTool('lookup_patient', { phone: PHONE, call_sid: SENTINEL });
    expect(res.identity_is_certain).toBe(true);
    expect(res.identity_write).toBe('refused_sid');
    expect(identityStoreProbe(SID)).toMatchObject({ size: 0, hasEntry: false });
  });

  it('reports refused_name when the record gave no surname, and stores nothing', async () => {
    lookupSpy.mockResolvedValue({ ...ONE, patientData: { ...ONE.patientData, lastName: undefined } });
    const res: any = await runTool('lookup_patient', { phone: PHONE, call_sid: SID });
    expect(res.identity_write).toBe('refused_name');
    expect(identityStoreProbe(SID)).toMatchObject({ size: 0, hasEntry: false });
  });

  /**
   * AND AN ABSENT VERDICT IS ALSO AN ANSWER: the branch was never reached.
   * A non-unique match stores nothing by design, and that is not a refusal.
   */
  it('reports no verdict at all when the match was not unique', async () => {
    lookupSpy.mockResolvedValue({
      ...ONE,
      identity: { unique: false, candidateCount: 2, candidates: [] },
    });
    const res: any = await runTool('lookup_patient', { phone: PHONE, call_sid: SID });
    expect(res.identity_write).toBeUndefined();
    expect(identityStoreProbe(SID)).toMatchObject({ size: 0, hasEntry: false });
  });
});

describe('the writer itself', () => {
  it('names each of its three silent returns', () => {
    expect(rememberVerifiedIdentity(SENTINEL, { firstName: 'Wren', lastName: 'Oakhollow' }))
      .toBe('refused_sid');
    expect(rememberVerifiedIdentity(SID, { firstName: 'Wren' })).toBe('refused_name');
    expect(rememberVerifiedIdentity(SID, { lastName: 'Oakhollow' })).toBe('refused_name');
    expect(rememberVerifiedIdentity(SID, { firstName: 'Wren', lastName: 'Oakhollow' }))
      .toBe('stored');
  });

  it('carries no caller data into the refusal it prints', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...a) => { lines.push(a.join(' ')); });
    rememberVerifiedIdentity(SID, { firstName: 'Wren' });
    spy.mockRestore();
    const blob = lines.join('\n');
    expect(blob).toContain('[IDENTITY] remember REFUSED');
    for (const secret of ['Wren', 'Oakhollow', '1958-03-03', PHONE]) {
      expect(blob).not.toContain(secret);
    }
  });
});

describe('the runtime row carries the pre-context verdict', () => {
  it('puts it beside the store fields, and omits it when there was no write', () => {
    const probe = identityStoreProbe(SID);
    expect(identityEvent({}, probe, true, 'refused_name').data)
      .toMatchObject({ precontextWrite: 'refused_name', storeSize: 0 });
    expect(identityEvent({}, probe, true).data).not.toHaveProperty('precontextWrite');
  });

  /**
   * PINNED AT THE RUNTIME, not only in the helper: a helper test proves the
   * helper and not that anything calls it (failure mode 10, and v20 is the
   * worked example where both ends had tests and the links between them did
   * not).
   */
  it('captures the write at the pre-context site and forwards it at teardown', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../runtime/voiceRuntime.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/precontextWrite = rememberVerifiedIdentity\(entry\.callSid/);
    expect(src).toMatch(/logIdentity\([\s\S]{0,400}?precontextWrite,/);
  });
});
