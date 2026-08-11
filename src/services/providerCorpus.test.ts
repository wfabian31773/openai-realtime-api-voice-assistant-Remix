/**
 * VERIFICATION, not illustration.
 *
 * Runs the real sanitizer over real strings that really failed, against a
 * snapshot of the real providers table, and asserts the measured improvement.
 * If someone weakens the sanitizer, the numbers here move and this fails.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeProviderName } from './ticketFieldSanitizers';
import { PROVIDER_FAILURE_CORPUS, PROVIDERS_SNAPSHOT } from './providerNameCorpus';

/** How the ticketing app matches: full name, or surname alone. */
function resolvesInProvidersTable(name: string): boolean {
  const needle = name.toLowerCase().trim();
  if (!needle) return false;
  return PROVIDERS_SNAPSHOT.some((p) => {
    if (p === needle) return true;
    const surname = p.split(' ').slice(1).join(' ');
    return surname !== '' && surname === needle;
  });
}

describe('every corpus entry is classified as measured', () => {
  it.each(PROVIDER_FAILURE_CORPUS)('$raw ($n failures) -> $expect', (entry) => {
    const out = sanitizeProviderName(entry.raw);
    if (entry.expect === 'drop') {
      expect(out.dropped, `"${entry.raw}" should never reach the wire`).toBe(true);
      expect(out.value).toBeUndefined();
    } else {
      expect(out.dropped, `"${entry.raw}" is a real name and must survive`).toBe(false);
      expect(out.value).toBeTruthy();
      if (entry.expect === 'pass') {
        expect(out.value, `"${entry.raw}" was already clean`).toBe(entry.raw);
      } else {
        expect(out.value, `"${entry.raw}" should have been cleaned`).not.toBe(entry.raw);
      }
    }
  });
});

describe('the measured improvement', () => {
  const before = PROVIDER_FAILURE_CORPUS.filter((e) => resolvesInProvidersTable(e.raw));
  const after = PROVIDER_FAILURE_CORPUS.filter((e) => {
    const out = sanitizeProviderName(e.raw);
    return !out.dropped && out.value !== undefined && resolvesInProvidersTable(out.value);
  });
  const dropped = PROVIDER_FAILURE_CORPUS.filter((e) => sanitizeProviderName(e.raw).dropped);

  const sum = (xs: typeof PROVIDER_FAILURE_CORPUS) => xs.reduce((t, e) => t + e.n, 0);
  const total = sum(PROVIDER_FAILURE_CORPUS);

  it('exposes that the app matches on MORE than name equality', () => {
    // `Todd Mishima` and `Obi` are exact rows in the providers table, and they
    // still failed in production — 2 and 1 times. So the ticketing app's
    // matcher is stricter than the name comparison modelled here: it may also
    // gate on active status, specialty, or department.
    //
    // This is recorded rather than fixed, because it bounds what this change
    // can claim. The projections below assume name equality; the real ceiling
    // may be lower, and only a live call will settle it.
    expect(before.map((e) => e.raw).sort()).toEqual(['Obi', 'Todd Mishima']);
  });

  it('now resolves the names that were only broken by formatting', () => {
    const resolvedNow = sum(after);
    // Measured floor, not an aspiration. Raise it when the sanitizer improves;
    // never lower it silently.
    expect(resolvedNow).toBeGreaterThanOrEqual(467);
    console.info(
      `[CORPUS] ${after.length} distinct names now resolve — ${resolvedNow} of ${total} failed lookups`,
    );
  });

  it('stops sending values that are not people at all', () => {
    const stopped = sum(dropped);
    expect(stopped).toBeGreaterThanOrEqual(503);
    console.info(
      `[CORPUS] ${dropped.length} distinct placeholders dropped — ${stopped} of ${total} failed lookups`,
    );
  });

  it('addresses 83% of the failures in the corpus', () => {
    const fixed = sum(after) + sum(dropped);
    const pct = Math.round((100 * fixed) / total);
    console.info(`[CORPUS] ${fixed} of ${total} failed lookups addressed (${pct}%)`);
    expect(pct).toBeGreaterThanOrEqual(83);
  });

  it('never invents a match for someone the ticketing app has not got', () => {
    // Evelyn Perez, 131 failures. Cleaning the name cannot fix this and must
    // not disguise it.
    //
    // CORRECTION: this was first recorded as "genuinely absent". That was
    // wrong. `si_providers` in the Eye Care Patient Console — the
    // authoritative NextGen mirror, synced daily — carries "Evelyn Perez, OD"
    // with 1,076 appointments in 90 days. She is missing from the TICKETING
    // APP's copy only. The gap is synchronisation, not data.
    const perez = sanitizeProviderName('Evelyn Perez, OD');
    expect(perez.value).toBe('Evelyn Perez');
    expect(resolvesInProvidersTable(perez.value!)).toBe(false);
  });

  it('cannot fix the drift class — that needs the mirror, not a string rule', () => {
    // Seven providers carrying 11,296 appointments in 90 days are unreachable
    // by ANY cleaning, because the two systems hold different names for the
    // same person. Recorded so nobody expects the sanitizer to solve it.
    const unreachable = [
      ['Timothy Hammill, OD', 'timothy hammil'],       // spelling: one L vs two
      ['Talin Khachatoor Sarkissian, O.D.', 'talin khachatoor'], // truncated
      ['Claudia Montana Collins, O.D.', 'claudia collins'],      // middle name
      ['Chris Ciampa, O.D.', 'christopher ciampa'],    // short form
    ] as const;
    for (const [canonical, inTicketing] of unreachable) {
      const out = sanitizeProviderName(canonical);
      expect(out.dropped).toBe(false);
      expect(out.value!.toLowerCase()).not.toBe(inTicketing);
    }
  });
});

describe('no real provider is ever dropped', () => {
  it('passes every name in the live providers table through untouched or cleaned', () => {
    for (const name of PROVIDERS_SNAPSHOT) {
      const out = sanitizeProviderName(name);
      expect(out.dropped, `"${name}" is a real provider and must not be dropped`).toBe(false);
      expect(out.value).toBeTruthy();
    }
  });
});
