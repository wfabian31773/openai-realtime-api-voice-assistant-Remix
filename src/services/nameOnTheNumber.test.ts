/**
 * v264, #512 review round 2: whether somebody on file at the calling number
 * answers to the name a filing carries. The pg pool is faked the way
 * `findByPhoneNarrowsByFirstName.test.ts` fakes it; synthetic people.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('pg', () => ({
  default: { Pool: class { query = (...a: unknown[]) => query(...a); on() {} end() { return Promise.resolve(); } } },
}));

import { nameOnTheNumber, __resetPoolForTests, __resetMirrorBreakerForTests } from './patientVerification';

const row = (id: string, first: string, last: string) => ({
  person_id: id, person_nbr: null, first_name: first, last_name: last, date_of_birth: '1960-01-01',
  has_medical_record: true, language: null, phones: ['5555550100', null, null, null, null],
});
const HELD = '00000000-0000-4000-8000-000000000001';
const SIBLING = '00000000-0000-4000-8000-000000000002';
const HOUSEHOLD = [row(HELD, 'Zelda', 'Quixote'), row(SIBLING, 'Bruno', 'Quixote')];

beforeEach(() => {
  query.mockReset();
  __resetPoolForTests();
  __resetMirrorBreakerForTests();
  process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://fake/console';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.OBS_CONSOLE_DATABASE_URL; });

describe('nameOnTheNumber', () => {
  it('finds a sibling on the number by first and last name, folded', async () => {
    query.mockResolvedValue({ rows: HOUSEHOLD });
    expect(await nameOnTheNumber('+1 (555) 555-0100', ' BRUNO ', 'quixote', HELD)).toBe('yes');
    expect(query.mock.calls[0][1]).toEqual(['5555550100']);
  });

  it('reads the first name by its first three letters, as verifyPatient narrows', async () => {
    query.mockResolvedValue({ rows: [row(SIBLING, 'Bruno', 'Quixote')] });
    expect(await nameOnTheNumber('5555550100', 'Brunito', 'Quixote')).toBe('yes');
    expect(await nameOnTheNumber('5555550100', 'Bianca', 'Quixote')).toBe('no');
  });

  it('folds accents on both names', async () => {
    query.mockResolvedValue({ rows: [row(SIBLING, 'Raúl', 'Peña')] });
    expect(await nameOnTheNumber('5555550100', 'Raul', 'Pena')).toBe('yes');
  });

  it('another last name, or a first name nobody on the number has, is not the name', async () => {
    query.mockResolvedValue({ rows: HOUSEHOLD });
    expect(await nameOnTheNumber('5555550100', 'Bruno', 'Ruiz', HELD)).toBe('no');
    expect(await nameOnTheNumber('5555550100', 'Marta', 'Quixote', HELD)).toBe('no');
  });

  it('leaves out the held patient', async () => {
    query.mockResolvedValue({ rows: HOUSEHOLD });
    expect(await nameOnTheNumber('5555550100', 'Zelda', 'Quixote', HELD)).toBe('no');
    expect(await nameOnTheNumber('5555550100', 'Zelda', 'Quixote')).toBe('yes');
  });

  it('nobody on the number is no', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await nameOnTheNumber('5555550100', 'Marta', 'Ruiz')).toBe('no');
  });

  it('a number that cannot identify a line, or no name to look for, is unknown and reads nothing', async () => {
    expect(await nameOnTheNumber('anonymous', 'Marta', 'Ruiz')).toBe('unknown');
    expect(await nameOnTheNumber(undefined, 'Marta', 'Ruiz')).toBe('unknown');
    expect(await nameOnTheNumber('5555550100', ' ', 'Ruiz')).toBe('unknown');
    expect(await nameOnTheNumber('5555550100', 'Marta', '')).toBe('unknown');
    expect(query).not.toHaveBeenCalled();
  });

  it('an unconfigured person base is unknown', async () => {
    delete process.env.OBS_CONSOLE_DATABASE_URL;
    expect(await nameOnTheNumber('5555550100', 'Marta', 'Ruiz')).toBe('unknown');
    expect(query).not.toHaveBeenCalled();
  });

  it('a read that fails is unknown, and the mirror is then skipped', async () => {
    query.mockRejectedValueOnce(new Error('connection reset'));
    expect(await nameOnTheNumber('5555550100', 'Marta', 'Ruiz')).toBe('unknown');
    query.mockResolvedValue({ rows: [] });
    expect(await nameOnTheNumber('5555550100', 'Marta', 'Ruiz')).toBe('unknown');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
