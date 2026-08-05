/**
 * Surname extraction off the live schedule.
 *
 * Every format below is a real value from the Schedule table on 2026-08-05.
 * The column is free text and no two entries agree on where the credentials
 * go, which is why this is parsed rather than assumed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../server/db', () => ({ db: { execute: async () => ({ rows: [] }) } }));

const { surnameOf } = await import('./providerRoster');

describe('surnameOf — real schedule formats', () => {
  it('handles every layout the column actually contains', () => {
    expect(surnameOf('Logan, Dwayne K')).toBe('Logan');
    expect(surnameOf('Amini M.D,Payam')).toBe('Amini');
    expect(surnameOf('Mahdavi M.D., Paymohn')).toBe('Mahdavi');
    expect(surnameOf('Sugiyama, Dennis O.D.')).toBe('Sugiyama');
    expect(surnameOf('Rocha.O.D.Guadalupe')).toBe('Rocha');
    expect(surnameOf('Khachatoor Sarkissian O.D., Talin')).toBe('Khachatoor');
    expect(surnameOf('Grant-Acquah, Kweku')).toBe('Grant-Acquah');
    expect(surnameOf('Tran O.D., Kevin H')).toBe('Tran');
  });

  it('rejects the resource rows that share the provider column', () => {
    // "OCT/VF" has 12,423 appointments — more than any human on the schedule.
    for (const junk of ['OCT/VF', 'Screening', 'OCT', 'VF', '', '   ', 'A']) {
      expect(surnameOf(junk), junk).toBeNull();
    }
  });

  it('is the answer to the Amani/Amini mistake', () => {
    // The hand-written list said 'Amani' because that is what the transcriber
    // heard. The schedule says Amini. Hinting a mis-transcription teaches the
    // transcriber to keep making it.
    expect(surnameOf('Amini M.D,Payam')).toBe('Amini');
    expect(surnameOf('Amini M.D,Payam')).not.toBe('Amani');
  });
});
