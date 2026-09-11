/**
 * THE OFFICE NAMED INSIDE A SENTENCE.
 *
 * Every case below is a phrase a real caller used, or a hazard the mirror
 * actually contains. The measurement that motivated this, 2026-09-11 against
 * the real Console mirror: six of twelve such phrases resolved, and every
 * single failure was a bare key with a word around it.
 *
 * The fixture is REAL `si_locations` data, trimmed. Two of its rows exist
 * only as hazards and must never be removed:
 *
 *   `Long Beach Memorial` — a HOSPITAL whose key contains the Long Beach
 *   clinic's key. Without longest-wins, a caller naming the hospital is sent
 *   to our clinic.
 *
 *   `H Jones Surgery Center` — shares Willow's street. It is here so the
 *   street-matching that is deliberately NOT built cannot be added later
 *   without tripping a test.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  __resetDirectory,
  directoryKey,
  lookupLocation,
  LOCATION_ALIASES,
  type DirectoryLocation,
} from './consoleDirectory';

const ROWS: Array<[string, string, number]> = [
  ['Azul Vision Riverside Latham', 'clinic', 11399],
  ['Atlantis Eyecare Long Beach', 'clinic', 9241],
  ['Azul Vision Pasadena', 'clinic', 8840],
  ['Azul Vision Monrovia', 'clinic', 7477],
  ['Azul Vision Mission Hlls', 'clinic', 7259],
  ['Azul Vision DTLA', 'clinic', 4810],
  ['Azul Vision Willow', 'clinic', 3373],
  ['Azul Vision Mission Viejo', 'clinic', 1321],
  ['Azul Vision Covina', 'clinic', 2864],
  ['Azul Vision Upland', 'clinic', 6694],
  // These five are here as CONTROLS on the rule that was rejected. A
  // cardinal-direction rule would have broken every one of them, and
  // callers said each of these phrases in the measured window.
  ['Azul Vision West Hills', 'clinic', 3135],
  ['Atlantis Eyecare Anaheim', 'clinic', 3712],
  ['Azul Vision Redlands', 'clinic', 6564],
  ['Azul Vision Glendale', 'clinic', 6309],
  ['Azul Vision Glendora', 'clinic', 4829],
  // Hazards. See the header.
  ['Long Beach Memorial', 'hospital', 0],
  ['H Jones Surgery Center', 'surgery_center', 280],
  ['Azul Vision Riverside LASIK Suite', 'surgery_center', 6],
];

function buildDirectory(): void {
  const locations = new Map<string, DirectoryLocation>();
  for (const [name, kind, volume] of ROWS) {
    const key = directoryKey(name);
    const entry: DirectoryLocation = {
      canonical: name,
      key,
      facilityKind: kind,
      volume90d: volume,
    };
    locations.set(key, entry);
    const bare = key.replace(/^(azul vision|atlantis eyecare)\s+/, '');
    if (bare !== key && !locations.has(bare)) locations.set(bare, entry);
  }
  for (const alias of LOCATION_ALIASES) {
    const entry = locations.get(alias.mirror);
    if (!entry) continue;
    entry.fileAs = alias.fileAs;
    for (const spoken of alias.spoken) {
      const k = directoryKey(spoken);
      const existing = locations.get(k);
      if (existing && existing !== entry) continue;
      locations.set(k, entry);
    }
  }
  __resetDirectory({ providers: new Map(), locations, loadedAt: Date.now() } as never);
}

beforeEach(buildDirectory);

describe('an office named inside a longer phrase', () => {
  // Each of these is a phrase that MISSED before this change.
  const RECOVERED: Array<[string, string]> = [
    // CAa28557a1…, optical 2026-09-09. The agent said "I'm not finding an
    // office by that name" twice, to a caller naming an office that resolves.
    ['downtown Riverside', 'Azul Vision Riverside Latham'],
    // CAefddb2f4…, optical 2026-09-09.
    ['Mission Viejo, by the Crown Valley', 'Azul Vision Mission Viejo'],
    // Wayne, 2026-09-11, on how patients actually name the offices: "they
    // just say the name of the city, Long Beach on Spring Street".
    ['Long Beach on Spring Street', 'Atlantis Eyecare Long Beach'],
    ['I go to the one in Upland', 'Azul Vision Upland'],
    ['the Pasadena office please', 'Azul Vision Pasadena'],
  ];

  it.each(RECOVERED)('resolves %j', async (spoken, canonical) => {
    expect((await lookupLocation(spoken))?.canonical).toBe(canonical);
  });

  it('still resolves every bare name exactly as before', async () => {
    for (const bare of ['Riverside', 'Long Beach', 'Pasadena', 'Mission Viejo', 'Upland']) {
      expect((await lookupLocation(bare))).not.toBeNull();
    }
    expect((await lookupLocation('Long Beach'))?.canonical).toBe('Atlantis Eyecare Long Beach');
  });
});

describe('subsumption, not length — the rule that keeps callers out of the wrong office', () => {
  it('prefers Willow over the Long Beach clinic when the city is a fragment of it', async () => {
    expect((await lookupLocation('Long Beach Willow'))?.canonical).toBe('Azul Vision Willow');
  });

  it('refuses when Willow and Long Beach are named DISJOINTLY', async () => {
    // The first draft returned the Long Beach clinic here, because
    // "long beach" is longer than "willow". Two offices, neither a fragment
    // of the other, so the caller is asked once more instead of misrouted.
    expect(await lookupLocation('the willow office in long beach')).toBeNull();
  });

  it('does NOT send a caller naming Long Beach Memorial to our Long Beach clinic', async () => {
    expect((await lookupLocation('I had it done at Long Beach Memorial'))?.canonical)
      .toBe('Long Beach Memorial');
  });

  it('prefers the LASIK suite over the Riverside clinic when the caller names it', async () => {
    expect((await lookupLocation('the Riverside LASIK Suite'))?.canonical)
      .toBe('Azul Vision Riverside LASIK Suite');
  });
});

describe('two offices in one phrase refuses rather than guessing', () => {
  it('returns nothing when the caller names two different offices', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await lookupLocation('is it Upland or Covina')).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('different offices'));
    info.mockRestore();
  });

  it('refuses on three disjoint offices too, however the caller phrased it', async () => {
    // Tempting to let "Mission Viejo" win for being longest. It must not:
    // length is not specificity, which is the bug the header records.
    expect(await lookupLocation('not Upland, not Covina, Mission Viejo')).toBeNull();
  });

  it('does NOT call two keys for the SAME office ambiguous', async () => {
    // "willow" and "long beach willow" are both keys for Willow. One office,
    // two names — that is a resolution, not a conflict.
    expect((await lookupLocation('the Long Beach Willow office'))?.canonical)
      .toBe('Azul Vision Willow');
  });
});

describe('what it must NOT start matching', () => {
  it('refuses a name that is not an office at all', async () => {
    expect(await lookupLocation('Isdale')).toBeNull();
    expect(await lookupLocation('somewhere near the freeway')).toBeNull();
  });

  it('does not match on a street, which is out of scope by design', async () => {
    // "Redondo" is Willow's street and lives in address_line1, which load()
    // does not read. If this ever starts passing, street matching has been
    // added and it needs the within-city scoring the header describes —
    // Foothill Blvd is Monrovia, not Pasadena.
    expect(await lookupLocation('the office down on Redondo')).toBeNull();
  });

  it('ignores a street the caller adds and keeps the city they named', async () => {
    expect((await lookupLocation('Pasadena over on Foothill'))?.canonical)
      .toBe('Azul Vision Pasadena');
  });

  it('"downtown" alone is still DTLA, but does not vote inside a phrase', async () => {
    // Both halves matter. Exact lookup is untouched, so the alias still
    // works; containment skips it, so "downtown Riverside" is Riverside and
    // not an ambiguity between two offices.
    expect((await lookupLocation('downtown'))?.canonical).toBe('Azul Vision DTLA');
    expect((await lookupLocation('downtown Riverside'))?.canonical)
      .toBe('Azul Vision Riverside Latham');
    expect((await lookupLocation('the downtown LA office'))?.canonical)
      .toBe('Azul Vision DTLA');
  });

  it('does not match a key on a partial word', async () => {
    // "covina" sits inside "west covina", which is a different city. Token
    // boundaries, not substrings.
    expect(await lookupLocation('Uplander')).toBeNull();
    expect(await lookupLocation('Pasadenas')).toBeNull();
  });

  it('returns null when the directory is unavailable', async () => {
    __resetDirectory(null);
    expect(await lookupLocation('downtown Riverside')).toBeNull();
  });
});

describe('a city whose name CONTAINS one of ours is not one of ours', () => {
  /**
   * Codex P1 on PR #286, and it was already merged when the review landed.
   *
   * MEASURED over 30 days / 10,715 transcripts, 2026-09-11: "west covina" on
   * 13 calls against 42 mentioning Covina at all — **roughly a third of every
   * Covina mention** — and "south pasadena" on 4 of 157. Both are real,
   * separate, adjacent cities.
   */
  it.each([
    ['the office in West Covina'],
    ['West Covina'],
    ['I go to the one in West Covina'],
    ["I'm in South Pasadena"],
  ])('refuses %j rather than routing to the city inside it', async (spoken) => {
    expect(await lookupLocation(spoken)).toBeNull();
  });

  it('still resolves the bare city when nothing qualifies it', async () => {
    expect((await lookupLocation('the office in Covina'))?.canonical)
      .toBe('Azul Vision Covina');
    expect((await lookupLocation('Pasadena over on Foothill'))?.canonical)
      .toBe('Azul Vision Pasadena');
  });

  it('understands a caller who says both — the mask is per mention', async () => {
    // "not West Covina, Covina". One clean mention is enough, because a
    // caller correcting themselves must not be punished with a refusal.
    expect((await lookupLocation('not West Covina, Covina'))?.canonical)
      .toBe('Azul Vision Covina');
  });

  it('masks a repeated foreign city, not just its first mention', async () => {
    // Two mentions share the space between them, so a single replace leaves
    // the second standing and the office inside it still votes.
    expect(await lookupLocation('West Covina, I said West Covina')).toBeNull();
  });
});

describe('the generic direction rule that was REJECTED, pinned by its casualties', () => {
  /**
   * A cardinal-direction rule — "north/south/east/west in front voids the
   * match" — was written first and thrown away, because the transcripts say
   * it prevents 17 misroutes and creates 17 refusals. Every phrase below was
   * said by a real caller in the measured window and names a real office of
   * ours. If one of these ever starts returning null, that rule has been
   * reintroduced and it is costing more than it saves.
   */
  it.each([
    ['south Anaheim', 'Atlantis Eyecare Anaheim'],
    ['west Redlands', 'Azul Vision Redlands'],
    ['north Glendale', 'Azul Vision Glendale'],
    ['south Glendora', 'Azul Vision Glendora'],
    ['east Willow', 'Azul Vision Willow'],
    ['north Long Beach', 'Atlantis Eyecare Long Beach'],
  ])('%j still resolves', async (spoken, canonical) => {
    expect((await lookupLocation(spoken))?.canonical).toBe(canonical);
  });

  it('does not touch an office whose OWN name starts with a direction', async () => {
    expect((await lookupLocation('West Hills'))?.canonical)
      .toBe('Azul Vision West Hills');
    expect((await lookupLocation('the West Hills office'))?.canonical)
      .toBe('Azul Vision West Hills');
  });

  it('leaves "downtown Riverside" alone', async () => {
    // The one call this whole feature exists for.
    expect((await lookupLocation('downtown Riverside'))?.canonical)
      .toBe('Azul Vision Riverside Latham');
  });
});
