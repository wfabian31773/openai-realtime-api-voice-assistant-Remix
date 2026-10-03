/**
 * A MODULE THAT REGISTERS TOOLS AT LOAD IS NEVER REACHED THROUGH `import()`.
 *
 * THE OUTAGE THIS GUARDS AGAINST. On 2026-09-28 at 14:17 UTC the operator
 * republished v77. From the first runtime call at 14:23:22 UTC until the
 * rollback, EVERY call on EVERY runtime lane died at setup:
 *
 *   ERROR call setup failed for CA565a7f5b8bc12a8f8318348896376e3a:
 *     [TOOLS] duplicate tool name: set_spoken_language
 *
 * `registerTool` (src/tools/registry.ts) refuses a second registration of a
 * name, and `languageTools.ts` registers `set_spoken_language` at module top
 * level. The API process (server/index.ts, which serves `/voice/*`) had already
 * loaded that module through `src/tools/server.ts`'s static import; v77's
 * `runtimeOwnedTools` then did `await import("../tools/languageTools")` inside
 * `resolveLane`, and on Node 20 — the version Replit runs — that dynamic import
 * evaluated the module a SECOND time. Reproduced here with the API process's
 * exact boot shape (the runtime and the tool surface both dynamically imported,
 * then a lane resolved): Node 20 throws, Node 22 does not. Every test and every
 * local probe ran on Node 22, which is why nothing caught it before it reached
 * a live line.
 *
 * THE RULE. A module whose top level calls `registerTool` is imported
 * STATICALLY, everywhere on the runtime and agent paths. A static import goes
 * through the same loader and the same cache as the boot-time one, so the
 * module is evaluated once whatever Node version is underneath. `registerTool`
 * stays strict on purpose: making it idempotent would have hidden this
 * duplicate AND every genuine one (two files claiming one name), and the second
 * instance's handlers would have shadowed the first's.
 *
 * It is the `identityStoreHasOneImportStyle` rule for a second module family,
 * and this time the hazard that rule was written against has actually fired.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const SRC = join(__dirname, '..');

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.testkit.ts')) continue;
    out.push(full);
  }
  return out;
}

/** Comments stripped first, as identityStoreHasOneImportStyle does and for the
 *  same reason: a docblock that QUOTES the forbidden form is documentation. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The modules whose top level calls registerTool — evaluated twice, they throw. */
function toolRegisteringModules(): Set<string> {
  const out = new Set<string>();
  for (const file of productionSources(join(SRC, 'tools'))) {
    if (/^registerTool\(/m.test(withoutComments(readFileSync(file, 'utf8')))) {
      out.add(file.replace(/\.ts$/, ''));
    }
  }
  return out;
}

/** Every `import('…')` in a source, resolved against the importing file. */
function dynamicImportTargets(file: string): string[] {
  const source = withoutComments(readFileSync(file, 'utf8'));
  const targets: string[] = [];
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    targets.push(resolve(dirname(file), spec).replace(/\.ts$/, ''));
  }
  return targets;
}

describe('a module that registers tools at load is imported one way', () => {
  const registering = toolRegisteringModules();

  it('finds the modules it is guarding (the scan is not vacuous)', () => {
    const names = [...registering].map((f) => basename(f)).sort();
    expect(names).toContain('languageTools');
    expect(names).toContain('medicalRecordsTools');
    expect(names.length).toBeGreaterThanOrEqual(7);
  });

  it('is never reached through a dynamic import from the runtime or the agents', () => {
    const offenders: string[] = [];
    for (const dir of ['runtime', 'agents']) {
      for (const file of productionSources(join(SRC, dir))) {
        for (const target of dynamicImportTargets(file)) {
          if (registering.has(target)) {
            offenders.push(`${file.slice(SRC.length + 1)} -> ${basename(target)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('binds the runtime-owned language tool through a static import (the v78 fix itself)', () => {
    const lane = withoutComments(readFileSync(join(SRC, 'runtime/laneRegistry.ts'), 'utf8'));
    expect(lane).toMatch(
      /^import \{[^}]*\bspokenLanguageToolDescription\b[^}]*\} from "\.\.\/tools\/languageTools";$/m,
    );
    expect(lane).toMatch(/^import \{[^}]*\brealtimeToolsFor\b[^}]*\} from "\.\.\/tools\/realtimeAdapter";$/m);
    expect(lane).not.toMatch(/import\(\s*["']\.\.\/tools\/languageTools["']\s*\)/);
    expect(lane).not.toMatch(/import\(\s*["']\.\.\/tools\/realtimeAdapter["']\s*\)/);
  });

  it('keeps registerTool strict — an idempotent registry would have hidden this and every real duplicate', () => {
    const registry = withoutComments(readFileSync(join(SRC, 'tools/registry.ts'), 'utf8'));
    expect(registry).toMatch(/if \(registry\.has\(def\.name\)\) \{\s*throw new Error\(`\[TOOLS\] duplicate tool name: \$\{def\.name\}`\);/);
  });
});

/**
 * AND AN AGENT MODULE IS NEVER REACHED THROUGH `import()` FROM THE RUNTIME (v90).
 *
 * The same Node 20 double evaluation, in a second module family, and this one
 * fired silently for nine days instead of loudly for one afternoon. Every agent
 * module keeps per-call state at module level (pcpAgent's `pcpCallMetadata`,
 * the director handles, the identity stores it reads). The runtime builds each
 * call's agent from `src/config/agents.ts`, which imports the agents
 * statically and is itself reached through ONE lazy `import("../config/agents")`
 * in laneRegistry. pcpFloor.ts then reached pcpAgent with its own
 * `import("../agents/pcpAgent")`, and on Node 20 that was a second copy with an
 * empty metadata map: the PCP floor logged "has intake but no metadata" on
 * every call and filed nothing (13 lines on 2026-10-02; 0 floor POSTs since
 * v69). Nothing threw, so nothing alarmed.
 *
 * THE RULE. The runtime reaches an agent ONLY through the registry. Anything
 * it needs from an agent module travels on that agent's registration (as
 * `teardownSweep` now does), so it is the factory's own module by construction.
 */
describe('an agent module is reached only through the registry', () => {
  it('no runtime source dynamic-imports anything under src/agents', () => {
    const agentsDir = join(SRC, 'agents');
    const offenders: string[] = [];
    for (const file of productionSources(join(SRC, 'runtime'))) {
      for (const target of dynamicImportTargets(file)) {
        if (target.startsWith(agentsDir + '/')) offenders.push(`${file.slice(SRC.length + 1)} -> ${basename(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan sees a dynamic import when there is one (not vacuous)', () => {
    // laneRegistry's one lazy import of the registry must be found, or the
    // rule above is passing because the scanner reads nothing.
    const lane = dynamicImportTargets(join(SRC, 'runtime/laneRegistry.ts')).map((t) => t.slice(SRC.length + 1));
    expect(lane).toContain('config/agents');
  });
});
