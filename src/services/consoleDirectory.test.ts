/**
 * The directory key has one job: make two spellings of the same person compare
 * equal. The directoryKey examples below are roster forms; provider fuzzy-match
 * coverage uses synthetic names so no case data enters the test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  directoryKey,
  isDirectoryConfigured,
  LOCATION_ALIASES,
  matchProviderFromRoster,
  __resetDirectory,
  type DirectoryProvider,
} from './consoleDirectory';
import { currentClinicName, RETIRED_CLINIC_NAMES } from '../config/azulVisionKnowledge';
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

describe('provider roster matching', () => {
  const roster: DirectoryProvider[] = [
    { canonical: 'Mira Example, O.D.', key: 'mira example', volume90d: 0 },
    { canonical: 'Jonas Sample, M.D.', key: 'jonas sample', volume90d: 0 },
  ];

  it('corrects a unique, small transcription error to the roster spelling', () => {
    expect(matchProviderFromRoster('Dr. Mira Exampl', roster)?.canonical)
      .toBe('Mira Example, O.D.');
  });

  it('leaves equally close provider names unresolved', () => {
    const ambiguous: DirectoryProvider[] = [
      { canonical: 'Mira Examplex, O.D.', key: 'mira examplex', volume90d: 0 },
      { canonical: 'Mira Exampleq, O.D.', key: 'mira exampleq', volume90d: 0 },
    ];
    expect(matchProviderFromRoster('Mira Example', ambiguous)).toBeNull();
  });

  it('does not turn an unrelated name into a roster hit', () => {
    expect(matchProviderFromRoster('Rina Fictional', roster)).toBeNull();
  });

  it('checks the margin against a runner-up below the minimum hit score', () => {
    const close: DirectoryProvider[] = [
      { canonical: 'Mira Exampletonxy', key: 'mira exampletonxy', volume90d: 0 },
      { canonical: 'Mira Exompletonq', key: 'mira exompletonq', volume90d: 0 },
    ];
    // 88.24% and 86.67%: the best meets 88%, but is not five points ahead.
    expect(matchProviderFromRoster('Mira Exampleton', close)).toBeNull();
  });

  it('refuses a normalized exact match shared by two roster spellings', () => {
    const colliding: DirectoryProvider[] = [
      roster[0],
      { canonical: 'Míra Example, O.D.', key: 'míra example', volume90d: 0 },
    ];
    expect(matchProviderFromRoster('Mira-Example', colliding)).toBeNull();
    expect(matchProviderFromRoster('Mira-Example', [...colliding].reverse())).toBeNull();
    // An original exact spelling remains authoritative, in either order.
    expect(matchProviderFromRoster('Mira Example', [...colliding].reverse())).toBe(roster[0]);
  });

  it('sends the roster spelling from the simplified ticket path too', async () => {
    vi.stubEnv('OBS_CONSOLE_DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:5432/unused');
    __resetDirectory({
      providers: new Map(roster.map((p) => [p.key, p])),
      locations: new Map(),
      loadedAt: Date.now(),
    });
    try {
      const out = await resolveTicketLookupFields({ lastProviderSeen: 'Mira Exampl' });
      expect(out.lastProviderSeen).toBe('Mira Example');
    } finally {
      __resetDirectory();
      vi.unstubAllEnvs();
    }
  });
});

describe('retired clinic names resolve through the current location directory', () => {
  // Historical schedule labels and caller wording both resolve through the
  // current-name map while the directory continues to use active mirror rows.
  it('points the retired "North Valley Eye" name at the live Mission Hills entry', () => {
    const missionHills = LOCATION_ALIASES.find((a) => a.fileAs === 'Mission Hills');
    expect(missionHills?.mirror).toBe('azul vision mission hlls');
    expect(RETIRED_CLINIC_NAMES['north valley eye']).toBe('Mission Hills');
    expect(currentClinicName('Our North Valley Eye office')).toBe('Mission Hills');
    // The mirror itself must be a name that exists in the live directory;
    // retired spellings stay in the separate map, never in `mirror`.
    expect(directoryKey('Azul Vision Mission Hlls')).toBe(missionHills?.mirror);
  });

  it('points the retired "Magan" name at the live Covina entry', () => {
    const covina = LOCATION_ALIASES.find((a) => a.fileAs === 'Covina');
    expect(covina?.mirror).toBe('azul vision covina');
    expect(RETIRED_CLINIC_NAMES.magan).toBe('Covina');
    expect(currentClinicName('Magan')).toBe('Covina');
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
