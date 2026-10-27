/**
 * The four offices nobody names the same way.
 *
 * Found from a live optical call on 2026-08-13 that looped `resolve_location`
 * ten times because the caller said "Downtown LA". I reported it to the
 * operator as an office we do not have. His reply: *"we do have downtown la
 * that is our main los angeles office."*
 *
 * It was invisible from both ends — the mirror calls it "Azul Vision DTLA" and
 * the ticketing app calls it "Los Angeles", so the caller's own words matched
 * neither system.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LOCATION_ALIASES, directoryKey, lookupLocation, __resetDirectory } from './consoleDirectory';
import { RETIRED_CLINIC_NAMES } from '../config/azulVisionKnowledge';

const database = vi.hoisted(() => ({
  query: vi.fn(),
  rows: [] as Array<{ nextgen_name: string; facility_kind: string; volume_90d: number }>,
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = database.query;
      on = vi.fn();
    },
  },
}));

/** The real mirror rows these aliases point at, with their real volumes. */
const MIRROR = [
  { nextgen_name: 'Azul Vision DTLA', facility_kind: 'clinic', volume_90d: 4810 },
  { nextgen_name: 'Azul Vision Riverside Latham', facility_kind: 'clinic', volume_90d: 11399 },
  { nextgen_name: 'Azul Vision Mission Hlls', facility_kind: 'clinic', volume_90d: 7259 },
  { nextgen_name: 'Azul Vision Willow', facility_kind: 'clinic', volume_90d: 3373 },
  { nextgen_name: 'Azul Vision Covina', facility_kind: 'clinic', volume_90d: 100 },
  // The one that must NOT be stolen by an alias.
  { nextgen_name: 'Atlantis Eyecare Long Beach', facility_kind: 'clinic', volume_90d: 9241 },
  { nextgen_name: 'Azul Vision Encinitas', facility_kind: 'clinic', volume_90d: 2346 },
];

beforeEach(() => {
  vi.stubEnv('OBS_CONSOLE_DATABASE_URL', 'postgres://synthetic:synthetic@127.0.0.1/directory_test');
  database.rows = [...MIRROR];
  database.query.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.includes('from si_locations') ? database.rows : [],
  }));
  __resetDirectory();
});
afterEach(() => vi.unstubAllEnvs());

describe('the words callers actually use', () => {
  const CASES: Array<[string, string, string]> = [
    // spoken, canonical it should resolve to, the name we must FILE
    ['Downtown LA', 'Azul Vision DTLA', 'Los Angeles'],
    ['downtown los angeles', 'Azul Vision DTLA', 'Los Angeles'],
    ['Los Angeles', 'Azul Vision DTLA', 'Los Angeles'],
    ['DTLA', 'Azul Vision DTLA', 'Los Angeles'],
    ['Riverside', 'Azul Vision Riverside Latham', 'Riverside'],
    ['Mission Hills', 'Azul Vision Mission Hlls', 'Mission Hills'],
    ['North Valley Eye', 'Azul Vision Mission Hlls', 'Mission Hills'],
    ['Magan', 'Azul Vision Covina', 'Covina'],
    ['Willow', 'Azul Vision Willow', 'Long Beach Willow'],
  ];

  for (const [spoken, canonical, fileAs] of CASES) {
    it(`"${spoken}" resolves, and files as "${fileAs}"`, async () => {
      const hit = await lookupLocation(spoken);
      expect(hit, `"${spoken}" did not resolve at all`).toBeTruthy();
      expect(hit!.canonical).toBe(canonical);
      expect(hit!.fileAs).toBe(fileAs);
    });
  }

  it('resolves the NextGen typo and the correct spelling alike', async () => {
    // The mirror itself is missing an 'i'. A caller who says it properly
    // should not be punished for that.
    expect((await lookupLocation('mission hlls'))?.canonical).toBe('Azul Vision Mission Hlls');
    expect((await lookupLocation('mission hills'))?.canonical).toBe('Azul Vision Mission Hlls');
  });

  it('resolves the retired name inside a longer caller phrase to the current clinic', async () => {
    const hit = await lookupLocation('I usually go to the North Valley Eye office');
    expect(RETIRED_CLINIC_NAMES['north valley eye']).toBe('Mission Hills');
    expect(hit?.canonical).toBe('Azul Vision Mission Hlls');
    expect(hit?.fileAs).toBe('Mission Hills');
  });
});

describe('an alias must never steal another clinic', () => {
  it('honours the real directory key when the retired alias collides', async () => {
    database.rows.push({ nextgen_name: 'Magan', facility_kind: 'clinic', volume_90d: 10 });
    const hit = await lookupLocation('Magan');
    expect(hit?.canonical).toBe('Magan');
    expect((await lookupLocation('Covina'))?.canonical).toBe('Azul Vision Covina');
  });

  it('leaves Long Beach pointing at Long Beach', async () => {
    // "Azul Vision Willow" is filed as "Long Beach Willow", which makes
    // "long beach" a tempting alias. It is a DIFFERENT clinic with 9,241
    // appointments a quarter, and sending those callers to Willow would be
    // worse than not resolving at all.
    const hit = await lookupLocation('Long Beach');
    expect(hit?.canonical).toBe('Atlantis Eyecare Long Beach');
  });

  it('does not alias a bare "la"', () => {
    // Two characters, and a Spanish article. The reason-159 lesson: a short
    // token matched loosely fires everywhere.
    const all = LOCATION_ALIASES.flatMap((a) => a.spoken);
    expect(all).not.toContain('la');
  });

  it('keeps every ordinary clinic resolving on its city name', async () => {
    expect((await lookupLocation('Encinitas'))?.canonical).toBe('Azul Vision Encinitas');
    expect((await lookupLocation('Azul Vision Encinitas'))?.fileAs).toBeUndefined();
  });
});

describe('the table itself', () => {
  it('points every alias at a mirror key in brand-stripped lower case', () => {
    for (const a of LOCATION_ALIASES) {
      expect(a.mirror, a.mirror).toBe(directoryKey(a.mirror));
      expect(a.fileAs.length).toBeGreaterThan(0);
      expect(a.spoken.length).toBeGreaterThan(0);
    }
  });

  it('stays small — it is a named-exceptions list, not a fuzzy matcher', () => {
    // A fuzzy matcher would paper over exactly the drift this exists to make
    // visible, and would eventually route a caller to the wrong clinic.
    expect(LOCATION_ALIASES.length).toBeLessThanOrEqual(8);
  });
});
