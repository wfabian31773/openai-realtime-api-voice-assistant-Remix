/**
 * A birthday on a ticket is how staff find the right chart. Getting it wrong is
 * worse than not having it, so this parser refuses rather than guesses.
 */
import { describe, it, expect } from 'vitest';
import { normalizeDobParts } from './dobParts';

describe('the formats callers actually use', () => {
  const cases: Array<[string, string]> = [
    ['03/17/1973', '1973-03-17'],
    ['3/17/1973', '1973-03-17'],
    ['3-17-73', '1973-03-17'],
    ['1973-03-17', '1973-03-17'],
    ['March 17, 1973', '1973-03-17'],
    ['March 17th 1973', '1973-03-17'],
    ['Mar 17 1973', '1973-03-17'],
    ['17 March 1973', '1973-03-17'],
    ['December 2, 1980', '1980-12-02'],

    /**
     * SPOKEN, WITH NO SEPARATOR AT ALL — the way a date of birth actually
     * arrives from a voice call. Regression for CA60c32bb3 (tech, 2026-09-03
     * 20:40 UTC): the caller said "9 2 48", the model read it back correctly
     * as September 2nd 1948, and file_tech_ticket was refused five times for a
     * missing date of birth before the call died with no ticket.
     */
    ['9 2 48', '1948-09-02'],
    ['9 2 1948', '1948-09-02'],
    ['09 02 1948', '1948-09-02'],
    ['3 17 73', '1973-03-17'],
    ['12  25  1990', '1990-12-25'],
    ['09 - 02 - 1948', '1948-09-02'],
  ];

  for (const [spoken, iso] of cases) {
    it(`"${spoken}"`, () => {
      const p = normalizeDobParts(spoken);
      expect(p && `${p.year}-${p.month}-${p.day}`).toBe(iso);
    });
  }

  it('keeps two-digit parts padded, because the API wants strings', () => {
    const p = normalizeDobParts('1/2/1990');
    expect(p).toEqual({ year: '1990', month: '01', day: '02' });
  });
});

describe('what it refuses', () => {
  it('will not read a month/day/year out of the tail of an ISO date', () => {
    // The bug this guards: an unanchored m/d/y pattern matched the tail of
    // "2017-03-17" and put 73/03/2017 on a real ticket.
    const p = normalizeDobParts('2017-03-17');
    expect(p).toEqual({ year: '2017', month: '03', day: '17' });
  });

  it('rejects impossible dates rather than filing them', () => {
    expect(normalizeDobParts('13/45/1973')).toBeNull();
    expect(normalizeDobParts('02/30/1973')).toBeNull();
    expect(normalizeDobParts('03/17/1823')).toBeNull();
  });

  it('rejects a birth year in the future', () => {
    expect(normalizeDobParts(`03/17/${new Date().getFullYear() + 1}`)).toBeNull();
  });

  /**
   * The separator widened on 2026-09-03; the YEAR rule did not. These are the
   * things a bare-space date could have started matching and must not.
   */
  it('does not mistake a phone number or a partial date for a birthday', () => {
    expect(normalizeDobParts('555 123 4567')).toBeNull();
    expect(normalizeDobParts('818 624 6197')).toBeNull();
    expect(normalizeDobParts('9 2 4')).toBeNull();    // one-digit year
    expect(normalizeDobParts('9 2')).toBeNull();      // no year at all
    expect(normalizeDobParts('13 45 73')).toBeNull(); // still not a real date
  });

  it('rejects what it cannot read at all', () => {
    expect(normalizeDobParts('')).toBeNull();
    expect(normalizeDobParts('sometime in the seventies')).toBeNull();
    expect(normalizeDobParts('March 1973')).toBeNull(); // no day — do not assume the 1st
  });
});
