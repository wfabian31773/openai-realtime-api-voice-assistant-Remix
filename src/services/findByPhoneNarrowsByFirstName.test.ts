/**
 * A shared number narrowed by the affirmed first name, inside the person base.
 * The pg pool is faked the way `patientVerification.test.ts` fakes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('pg', () => ({
  default: { Pool: class { query = (...a: unknown[]) => query(...a); on() {} end() { return Promise.resolve(); } } },
}));

import { findByPhone, __resetPoolForTests, __resetMirrorBreakerForTests } from './patientVerification';

const row = (id: string, first: string) => ({
  person_id: id, person_nbr: null, first_name: first, last_name: 'Household', date_of_birth: '1960-01-01',
  has_medical_record: true, language: null, phones: ['5555550100', null, null, null, null],
});
const TWO = [row('00000000-0000-4000-8000-000000000001', 'Alpha'), row('00000000-0000-4000-8000-000000000002', 'Bravo')];

beforeEach(() => {
  query.mockReset();
  __resetPoolForTests();
  __resetMirrorBreakerForTests();
  process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://fake/console';
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.OBS_CONSOLE_DATABASE_URL; });

describe('findByPhone with an affirmed first name', () => {
  it('picks the one person on the number who carries that name', async () => {
    query.mockResolvedValue({ rows: TWO });
    const r = await findByPhone('+15555550100', 'Bravo');
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe('00000000-0000-4000-8000-000000000002');
    expect(r.candidates).toBe(2);
  });
  it('stays ambiguous when the name matches nobody on the number', async () => {
    query.mockResolvedValue({ rows: TWO });
    const r = await findByPhone('+15555550100', 'Zulu');
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('ambiguous');
  });
  it('stays ambiguous when two people share the name as well as the number', async () => {
    query.mockResolvedValue({ rows: [TWO[0], row('00000000-0000-4000-8000-000000000003', 'Alpha')] });
    const r = await findByPhone('+15555550100', 'Alpha');
    expect(r.reason).toBe('ambiguous');
  });
  it('stays ambiguous with no name at all, exactly as before', async () => {
    query.mockResolvedValue({ rows: TWO });
    const r = await findByPhone('+15555550100');
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates).toBe(2);
  });
  it('one person on the number needs no name', async () => {
    query.mockResolvedValue({ rows: [TWO[0]] });
    const r = await findByPhone('+15555550100', 'Nobody');
    expect(r.verified).toBe(true);
  });
});
