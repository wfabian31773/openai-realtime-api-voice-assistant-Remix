/**
 * THE IDENTITY STORE IS IMPORTED ONE WAY, EVERYWHERE.
 *
 * `verifiedIdentity.ts` keeps its state in a module-level `Map`. Until this
 * test, production reached that Map through TWO different import styles: a
 * static `import` in the runtime's readers (voiceRuntime, runtimeIdentity,
 * sweepRunner, runtimeTurns, registry) and `await import('./verifiedIdentity')`
 * at ten call sites in the tools and at the runtime's own pre-context write.
 *
 * WHAT THIS IS NOT. I published a claim on 2026-09-25 that those two styles
 * were resolving to two module instances — a CJS `require` cache and an ESM
 * registry — and that this explained the production symptom the v58 and v61
 * instruments measured: `precontextWrite = 'stored'` on 325 of 625
 * `identity_summary` rows while `storeSize` read 0 on all 625.
 *
 * THAT CLAIM IS REFUTED, by reproduction rather than by argument. A probe
 * inside this package, run the way production runs (`npx tsx`, which is what
 * `npm start` does), imports this module both ways and gets ONE instance: the
 * same function object, and a dynamic write that the static reader sees. So
 * the split was never the cause, and the `storeSize 0` finding is STILL OPEN —
 * do not read this file as having closed it.
 *
 * WHY THE RULE IS WORTH KEEPING ANYWAY. Two import styles for one piece of
 * mutable module state is a hazard whose cost is invisible until the day the
 * module graph changes under it — a bundler that splits a chunk, a move to
 * `"type": "module"`, a second entry point. This repo has already paid twice
 * for two copies of one thing drifting apart: the noun lists in
 * `explicitAsk.ts` that cost the operator his own transfer on `CAa2a3a1c1`,
 * and the recognised-caller block that was written four times and contradicted
 * itself. One style removes the class.
 *
 * THE SECOND ASSERTION IS THE REASON THE FIRST ONE IS SAFE. Static importing
 * is only free because this module is a LEAF: it pulls in `callSid` (which
 * imports nothing) and `dobParts`, and touches no database, no `server/storage`
 * and no environment validation. Several of the dynamic imports elsewhere in
 * this repo exist precisely to defer that kind of load-time cost. If somebody
 * gives `verifiedIdentity` a heavy dependency, the justification for the first
 * assertion is gone and this test should go red so they read this docblock
 * rather than discovering it through a boot failure.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/** `await import('…/verifiedIdentity')`, whichever quote style and depth. */
const DYNAMIC = /await\s+import\(\s*['"][^'"]*verifiedIdentity['"]\s*\)/;

/**
 * COMMENTS ARE STRIPPED FIRST, and the first run of this test is why. The v71
 * marker docblock in `readiness.ts` explains the change by quoting the form it
 * removed, and the scan reported that file as an offender — prose describing
 * the rule read to the pattern exactly like a violation of it. That is the same
 * distinction `recognisedCallerBlock.test.ts` already draws when it compares
 * prompt text with comments stripped, so a comment quoting a rule counts as
 * documentation rather than a second copy of it.
 *
 * It is a scanner, not a parser: a `//` inside a string literal (a URL, say)
 * takes the rest of that line with it. That cannot produce a false PASS here,
 * because a real `await import('./verifiedIdentity')` is not a URL and does not
 * sit behind one on the same line — it can only ever remove more text than a
 * parser would, and what it removes is not this pattern.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the identity store has one import style', () => {
  it('is never reached through a dynamic import in production code', () => {
    const offenders = productionSources(SRC)
      .filter((f) => DYNAMIC.test(withoutComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('is imported statically by the writers as well as the readers', () => {
    // The two writers are the ones that mattered: the runtime's pre-context
    // write and `lookup_patient`'s. A reader-only rule would leave the halves
    // that actually disagree free to drift apart again.
    const runtime = readFileSync(join(SRC, 'runtime/voiceRuntime.ts'), 'utf8');
    expect(runtime).toMatch(
      /^import \{[^}]*\brememberVerifiedIdentity\b[^}]*\} from "\.\.\/tools\/verifiedIdentity";$/m,
    );

    const shared = readFileSync(join(SRC, 'tools/sharedPatientTools.ts'), 'utf8');
    expect(shared).toMatch(
      /^import \{[^}]*\brememberVerifiedIdentity\b[^}]*\} from '\.\/verifiedIdentity';$/m,
    );
  });

  it('stays a leaf module, which is what makes a static import free', () => {
    const source = readFileSync(join(SRC, 'tools/verifiedIdentity.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);

    expect(specifiers.sort()).toEqual(['./callSid', './dobParts']);
  });
});
