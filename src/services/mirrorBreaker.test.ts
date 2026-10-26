/**
 * ONE CALL PAYS THE MIRROR TIMEOUT ONCE.
 *
 * Codex P1 on PR #292. A single `lookup_patient` can reach the Console THREE
 * times when it is slow: `verifyPatient` waits the full budget and falls back,
 * `lookupInPersonBase` then tries `findByPhone`, and `sharedPatientTools`
 * re-enters with `lookupPatient({ phone })` for a third. At the default
 * 2,500ms that is about 7.5 seconds of silence for a live caller, ending in
 * exactly the not-found they would have had at 2.5.
 *
 * `lookup_patient` is the FIRST tool every queue call runs and already times
 * out on 13-17% of them, so this is the call path, not an edge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('pg', () => {
  // `end()` must return a promise: __resetPoolForTests calls .catch() on it.
  class Pool { query = queryMock; on() {} end() { return Promise.resolve(); } }
  return { default: { Pool }, Pool };
});

import {
  verifyPatient,
  findByPhone,
  __resetPoolForTests,
  __resetMirrorBreakerForTests,
} from './patientVerification';

beforeEach(() => {
  process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:5432/unused';
  queryMock.mockReset();
  __resetPoolForTests();
  __resetMirrorBreakerForTests();
});

describe('the mirror breaker', () => {
  it('queries ONCE across the three attempts one call can make', async () => {
    queryMock.mockRejectedValue(new Error('timeout'));

    await verifyPatient({ firstName: 'A', lastName: 'Tester', dob: '01/01/1950', callerPhone: '5555550147' });
    const second = await findByPhone('5555550147');
    const third = await findByPhone('5555550147');

    // The first attempt establishes it. The other two must not touch the wire.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(second.reason).toBe('unavailable');
    expect(third.reason).toBe('unavailable');
  });

  it('does not latch on a clean miss — an empty answer is the mirror WORKING', async () => {
    // The failure this guards against is latching on `no_match` and then going
    // blind for the cooldown on a perfectly healthy Console.
    queryMock.mockResolvedValue({ rows: [] });

    await findByPhone('5555550147');
    await findByPhone('5555550148');

    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('reopens once the cooldown has passed', async () => {
    process.env.PATIENT_VERIFY_COOLDOWN_MS = '0';
    queryMock.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ rows: [] });

    await findByPhone('5555550147');
    await findByPhone('5555550147');

    expect(queryMock).toHaveBeenCalledTimes(2);
    delete process.env.PATIENT_VERIFY_COOLDOWN_MS;
  });
});
