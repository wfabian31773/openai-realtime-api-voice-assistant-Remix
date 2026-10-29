/**
 * A PER-CALL STORE THE RUNTIME WRITES IS READ THROUGH THE SAME MODULE COPY — v141.
 *
 * The fourth time this class has fired (v78 the language tool, v90 the PCP
 * floor, v115 the SI Assistant identity), and the first time it disabled two
 * features for their whole lives without anything noticing.
 *
 * THE MECHANISM, reproduced rather than argued. The bridge
 * (`mediaStreamBridge.ts`) writes what the caller said into two per-call
 * stores through STATIC imports: `noteSpokenDob` (the date-of-birth backstop,
 * #280/#281, 2026-09-10) and `notePatientStatus` (RULE ZERO 2a, v70,
 * 2026-09-24). The tools read them back through `await import(...)`: the four
 * filing tools for the date of birth, `lookup_patient` for the new-or-existing
 * answer. On Node 22 that is one module and one Map. On Node 20, which Replit
 * runs (`.replit`: `nodejs-20`), the dynamic import evaluates the module a
 * SECOND time, with an empty Map. So both readers have answered "nothing heard"
 * on every production call since they shipped, while every test and every CI
 * run (Node 22) saw them work. `probes/perCallStoresReachTheTools.probe.ts`,
 * run on `main` under Node 20: the filing tool refuses for a date of birth the
 * bridge had just stored, and the lookup runs for a caller who just said
 * "New."; under Node 22 and on this branch under Node 20, both work.
 *
 * WHAT IT COST, measured on the Hub (call_turns timestamps, tool_timeline):
 *
 *  - 2026-10-20..10-28, the runtime queue lanes: 276 `date_of_birth` refusals,
 *    and on 165 of them (60%) the caller had ALREADY answered the agent's
 *    date-of-birth question with a date before the filing tool ran. That is
 *    the exact shape the backstop exists to catch. Each one cost the caller a
 *    second ask, and the ask-once escape then filed the ticket with the date
 *    marked unavailable: of the 54 such calls on 10-26..10-28, 52 tickets
 *    carry no date of birth at all.
 *  - Since v70 (2026-09-25): 0 `suppressed = 'caller_said_new'` in 9,292
 *    queue-lane `lookup_patient` events, though at least 25 callers answered
 *    the question with a bare "New." on a call that went on to look them up.
 *
 * The real calls, by SID (synthetic stand-ins only; the words stay in the Hub):
 *
 *   date of birth answered, then refused, ticket filed with none
 *   CA1596d31b1974059e3b84b1cff8d8548e  surgery 10-28
 *   CA15ac9aacf75635dfd6ee23491b00885d  tech    10-28
 *   CA407a815e68fb5d84b1961c8496f00aba  tech    10-28
 *   CA43a0306365d9531b5d438379af1be50f  optical 10-28
 *   CAa8e915b3547bf0aefc1462db90a89dd8  records 10-28
 *   CA75272752e6f1f66599ab61aa1ddf7790  surgery 10-28
 *   CA0d064693538fc9a9034d108a3a84134d  tech    10-27
 *   CA75e9b74959eecd8a8be3811d2e4d114e  optical 10-27
 *   CAc5e1cea95504795bd8ba975d1d8b3e0c  records 10-27
 *   CA57010120abb126b85a84350179d4ab53  surgery 10-27
 *   CA269002480ef78e04d6d9b3096b32e6b5  optical 10-26
 *   CA42cc91024154cbfa600509682a4d73c0  surgery 10-26  (no ticket at all)
 *
 *   answered "New.", looked up anyway
 *   CA504c1d7b0191fd6f2b4fa56d9ae783c9  surgery 10-19
 *   CA8999b37e5b057f0e902570c687faea3b  optical 10-19
 *   CAabe4c85f9dec02f4f44a4a8e03d65f90  tech    10-13
 *   CA30623ff316c3609a843a90e334c4828e  optical 10-02
 *   CA4c8ecbd2b6aefeebee7ba404a02b418d  optical 09-28
 *   CAbfc7f25db50c273a41ea8151c7a6ed2d  surgery 09-25
 *
 * THE RULE, written for the class rather than the two modules. A module under
 * src/tools or src/services that a runtime source imports statically and that
 * keeps a module-level Map is never reached through a runtime `import()`
 * anywhere in src. Each earlier guard in `toolModulesAreImportedOneWay.test.ts`
 * named one family after it had fired; this one finds the stores itself, so a
 * fifth store written by the runtime is covered the day it is added.
 *
 * WHY THE BEHAVIOURAL HALF IS OPT-IN. vitest resolves both import styles
 * through one module graph on any Node version, so no assertion inside this
 * suite can see the split; the source rule is what goes red in CI. The probe
 * runs the real tools in a real tsx process and is what proves the fix: set
 * NODE20_BIN to a Node 20 binary to run it.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const SRC = join(__dirname, '..');
const ROOT = join(SRC, '..');

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.testkit.ts')) continue;
    if (name.endsWith('.probe.ts')) continue;
    out.push(full);
  }
  return out;
}

/** Comments stripped first: a docblock that QUOTES the forbidden form is documentation. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const resolveSpec = (from: string, spec: string) => resolve(dirname(from), spec).replace(/\.ts$/, '');

/** A module-level keyed store: `const x = new Map<…>()` at the top level. */
const KEEPS_A_STORE = /^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*new\s+Map\b/m;

/** Modules under src/tools or src/services that a runtime source imports statically and that keep a store. */
function storesTheRuntimeHolds(): Set<string> {
  const held = new Set<string>();
  for (const file of productionSources(join(SRC, 'runtime'))) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const m of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["'];/gm)) {
      const target = resolveSpec(file, m[1]);
      if (!target.startsWith(join(SRC, 'tools') + '/') && !target.startsWith(join(SRC, 'services') + '/')) continue;
      if (!existsSync(`${target}.ts`)) continue;
      if (KEEPS_A_STORE.test(withoutComments(readFileSync(`${target}.ts`, 'utf8')))) held.add(target);
    }
  }
  return held;
}

/**
 * Every RUNTIME `import('…')` in a source. A type position —
 * `import('./x').SomeType` — loads nothing and is not counted; `.then(`,
 * `.catch(` and `.finally(` are runtime and are.
 */
function runtimeImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of withoutComments(source).matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)(\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    const member = m[3];
    if (member && !['then', 'catch', 'finally'].includes(member)) continue;
    out.push(m[1]);
  }
  return out;
}

function runtimeImportTargets(file: string): string[] {
  return runtimeImportSpecifiers(readFileSync(file, 'utf8')).map((spec) => resolveSpec(file, spec));
}

const rel = (p: string) => p.slice(SRC.length + 1);

describe('a per-call store the runtime writes is imported one way', () => {
  const held = storesTheRuntimeHolds();

  it('finds the stores it is guarding (the scan is not vacuous)', () => {
    const names = [...held].map((t) => basename(t));
    expect(names).toEqual(
      expect.arrayContaining(['spokenDob', 'spokenPatientStatus', 'verifiedIdentity', 'symptomCorroboration']),
    );
  });

  it('no production source reaches one through a runtime import()', () => {
    const offenders: string[] = [];
    for (const file of productionSources(SRC)) {
      for (const target of runtimeImportTargets(file)) {
        if (held.has(target)) offenders.push(`${rel(file)} -> ${basename(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan sees a runtime import() and ignores a type position (both directions)', () => {
    // laneRegistry's one lazy import of the registry is a runtime import.
    expect(runtimeImportTargets(join(SRC, 'runtime/laneRegistry.ts')).map(rel)).toContain('config/agents');
    // afterHoursEscalationGate names a TYPE from symptomCorroboration this way,
    // which loads nothing and must not read as a second copy.
    expect(runtimeImportTargets(join(SRC, 'services/afterHoursEscalationGate.ts')).map(rel)).not.toContain(
      'services/symptomCorroboration',
    );
  });

  it('the scan reads all three shapes: await, .then(), and a type position it skips', () => {
    expect(
      runtimeImportSpecifiers(
        [
          "const a = await import('./awaited');",
          "import('./chained').then((m) => m.go());",
          "let t: import('./typeOnly').Shape;",
          "// await import('./commented')",
        ].join('\n'),
      ),
    ).toEqual(['./awaited', './chained']);
  });

  it('the four filing tools read the spoken date of birth through a static import', () => {
    for (const tool of ['opticalTools', 'surgeryTools', 'techTools', 'medicalRecordsTools']) {
      const source = withoutComments(readFileSync(join(SRC, `tools/${tool}.ts`), 'utf8'));
      expect(source, tool).toMatch(/^import \{ spokenDobFor \} from '\.\/spokenDob';$/m);
      expect(source, tool).not.toMatch(/import\(\s*['"]\.\/spokenDob['"]\s*\)/);
    }
  });

  it('lookup_patient reads the new-or-existing answer through a static import', () => {
    const source = withoutComments(readFileSync(join(SRC, 'tools/sharedPatientTools.ts'), 'utf8'));
    expect(source).toMatch(/^import \{ noteStatusOverride, patientStatusFor \} from '\.\/spokenPatientStatus';$/m);
    expect(source).not.toMatch(/import\(\s*['"]\.\/spokenPatientStatus['"]\s*\)/);
  });

  it('both stores are leaves, which is what makes a static import free', () => {
    // Several dynamic imports in this repo defer a database or env-validating
    // load. These two must stay leaves, or the static import above starts
    // paying a load-time cost and this docblock is the one to reread.
    for (const store of ['spokenDob', 'spokenPatientStatus']) {
      const source = withoutComments(readFileSync(join(SRC, `tools/${store}.ts`), 'utf8'));
      const specs = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"];/gm)].map((m) => m[1]);
      expect(specs.every((s) => s === './callSid' || s === './dobParts'), `${store}: ${specs.join(', ')}`).toBe(true);
    }
  });
});

describe('the probe, under the Node version production runs (opt-in: NODE20_BIN)', () => {
  const node20 = process.env.NODE20_BIN;

  it.skipIf(!node20)('the real tools see what the bridge stored, in a real tsx process', () => {
    const run = spawnSync(
      node20 as string,
      [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(SRC, 'runtime/probes/perCallStoresReachTheTools.probe.ts')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://stub:stub@ci-stub.invalid:5432/stub',
          EYECARE_AGENT_API_KEY: process.env.EYECARE_AGENT_API_KEY ?? 'ci-test-stub-key',
        },
      },
    );
    const line = run.stdout.split('\n').find((l) => l.startsWith('{"node"'));
    expect(line, run.stderr.slice(-2000)).toBeDefined();
    const result = JSON.parse(line as string) as Record<string, unknown>;
    expect(String(result.node)).toMatch(/^v20\./);
    expect(result.spokenDobReachedTheFilingTool).toBe(true);
    expect(result.newAnswerReachedTheLookup).toBe(true);
  });
});
