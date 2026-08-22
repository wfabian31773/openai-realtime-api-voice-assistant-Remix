/**
 * The directory key has one job: make two spellings of the same person compare
 * equal. Every string here is a real `nextgen_name` from `si_providers` /
 * `si_locations` in the Patient Console, read 2026-08-11.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { directoryKey, isDirectoryConfigured, LOCATION_ALIASES } from './consoleDirectory';
import { resolveTicketLookupFields } from './ticketFieldSanitizers';

describe('directoryKey normalises what NextGen actually stores', () => {
  // The mirror is not internally consistent. These are all real.
  it.each([
    ['Payam Amini, M.D.', 'payam amini'],
    ['David Choi, MD', 'david choi'],
    ['Minh Shaw, O.D.', 'minh shaw'],
    ['Todd Mishima, OD', 'todd mishima'],
    ['Sharon Han OD', 'sharon han'],
    ['Brett Tompkins, DO', 'brett tompkins'],
    ['Ashley Szmania, NP', 'ashley szmania'],
    ['Cindy Truong, P.A.', 'cindy truong'],
    ['Dennis Sugiyama', 'dennis sugiyama'],
    ['Marialejandra Diaz Ibarra', 'marialejandra diaz ibarra'],
  ])('%s -> %s', (raw, expected) => {
    expect(directoryKey(raw)).toBe(expected);
  });

  it('handles the two rows where the credential itself is a typo', () => {
    // "O,D." — comma instead of a period. Two providers carry it.
    expect(directoryKey('Theresa Sarno, O,D.')).toBe('theresa sarno');
    expect(directoryKey('Phoebe Chen, O,D.')).toBe('phoebe chen');
  });

  it('makes the caller\'s spoken form match the canonical form', () => {
    // What the schedule sends, vs what NextGen stores.
    expect(directoryKey('Dr. Todd Mishima')).toBe(directoryKey('Todd Mishima, OD'));
    expect(directoryKey('Amir Shama, OD')).toBe(directoryKey('Amir Shama, O.D.'));
    expect(directoryKey('Dr. Laura Syniuta')).toBe(directoryKey('Laura Syniuta, MD'));
  });

  it('does NOT collapse two genuinely different people', () => {
    expect(directoryKey('David Choi, MD')).not.toBe(directoryKey('Daniel Choi, MD'));
    expect(directoryKey('Kevin Tran, O.D.')).not.toBe(directoryKey('Jennie Tran, O.D.'));
    expect(directoryKey('Eugene Chang, M.D.')).not.toBe(directoryKey('Sylvia Chang, M.D.'));
  });

  it('does not truncate a surname that merely ends in a credential-like word', () => {
    // No comma, no trailing-credential shape — must survive whole.
    expect(directoryKey('Dana Le')).toBe('dana le');
    expect(directoryKey('Vi Nguyen')).toBe('vi nguyen');
  });
});

describe('LOCATION_ALIASES carries the two 2026-08-21 renames', () => {
  // Traced from a real call: lookup_patient said "I have you at our North
  // Valley Eye office," the caller confirmed it, and resolve_location still
  // asked "which city is your office in?" — 7 of 19 optical location
  // refusals that day. Confirmed by Wayne, not inferred: North Valley Eye
  // was renamed to Mission Hills, Magan to Covina, both a couple of months
  // before this fix.
  it('points the retired "North Valley Eye" name at the live Mission Hills entry', () => {
    const missionHills = LOCATION_ALIASES.find((a) => a.fileAs === 'Mission Hills');
    expect(missionHills?.mirror).toBe('azul vision mission hlls');
    expect(missionHills?.spoken).toContain('north valley eye');
    // The mirror itself must be a name that exists in the live directory —
    // only `spoken` entries are free to be retired names with nothing behind
    // them. See the file header: a `mirror` with no live entry just warns
    // and does nothing.
    expect(directoryKey('Azul Vision Mission Hlls')).toBe(missionHills?.mirror);
  });

  it('points the retired "Magan" name at the live Covina entry', () => {
    const covina = LOCATION_ALIASES.find((a) => a.fileAs === 'Covina');
    expect(covina?.mirror).toBe('azul vision covina');
    expect(covina?.spoken).toContain('magan');
    expect(directoryKey('Azul Vision Covina')).toBe(covina?.mirror);
  });

  it('never lets a retired name double as a `mirror` — it would silently do nothing', () => {
    // The load() loop only ever looks up `alias.mirror` in the live
    // directory. A retired name that never existed there would hit the
    // "not in the mirror" warning and the alias would resolve to nothing —
    // exactly the mistake caught in review before this shipped.
    const mirrors = LOCATION_ALIASES.map((a) => a.mirror);
    expect(mirrors).not.toContain('north valley eye');
    expect(mirrors).not.toContain('magan');
  });
});

describe('degrading safely when the Console is not reachable', () => {
  const saved = process.env.OBS_CONSOLE_DATABASE_URL;
  beforeEach(() => {
    delete process.env.OBS_CONSOLE_DATABASE_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OBS_CONSOLE_DATABASE_URL;
    else process.env.OBS_CONSOLE_DATABASE_URL = saved;
    vi.restoreAllMocks();
  });

  it('reports itself unconfigured rather than throwing', () => {
    expect(isDirectoryConfigured()).toBe(false);
  });

  it('falls back to the string rules — a call is never blocked on the mirror', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const out = await resolveTicketLookupFields({
      lastProviderSeen: 'Todd Mishima, OD',
      locationOfLastVisit: 'Azul Vision Encinitas',
    });
    // Exactly the pure-string answer.
    expect(out.lastProviderSeen).toBe('Todd Mishima');
    expect(out.locationOfLastVisit).toBe('Encinitas');
  });

  it('still refuses the values that are not people, with no database at all', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const out = await resolveTicketLookupFields({ lastProviderSeen: 'A-Scan' });
    expect(out.lastProviderSeen).toBeUndefined();
  });
});
