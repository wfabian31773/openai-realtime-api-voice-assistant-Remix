/**
 * Everything an agent can call must also be reachable on the HTTP surface.
 *
 * WHY THIS EXISTS
 *
 * `tools/server.ts` imported only `opticalTools`. The voice agent imports
 * `surgeryTools` itself, so on a live call all seven tools existed — but the
 * HTTP surface published five and answered
 *
 *   POST /api/tools/file_surgery_ticket
 *   404  {"error":"no such tool: file_surgery_ticket","availableTools":[ ...5 ]}
 *
 * One registry, two different contents depending on which module happened to
 * pull it in. Nothing failed loudly; the surface was simply incomplete, and
 * stayed that way until someone called it directly.
 *
 * The registry is populated by import side effects, which is convenient and
 * invisible. This test is what makes it visible: it reads the agent registry
 * for the tool names each queue declares, and fails if `tools/server.ts` does
 * not register them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The tool modules `tools/server.ts` imports for their side effects. */
const SERVER_SIDE_EFFECT_IMPORTS: string[] = (() => {
  const src = readFileSync(join(__dirname, 'server.ts'), 'utf8');
  return [...src.matchAll(/^import\s+'\.\/([A-Za-z0-9_]+)';$/gm)].map((m) => m[1]);
})();

describe('the HTTP surface registers every tool module', () => {
  it('imports the shared patient tools', () => {
    expect(SERVER_SIDE_EFFECT_IMPORTS).toContain('sharedPatientTools');
  });

  it('imports every per-queue tool module that exists', () => {
    // READ FROM DISK, not hardcoded.
    //
    // This assertion used to carry the comment "Discovered from the agents, not
    // hardcoded — a hardcoded list here would have the same blind spot as the
    // import it is checking", written directly above a hardcoded list of three.
    // On 2026-08-13 two queues were added and both walked straight through it:
    // file_records_ticket and file_hub_ticket were callable on a live call and
    // 404 over HTTP, which is character-for-character the defect this file
    // exists to prevent.
    //
    // A guard whose coverage has to be extended by hand only guards what
    // somebody remembered to extend it with.
    const onDisk = readdirSync(__dirname)
      .filter((f) => /^[A-Za-z0-9_]+Tools\.ts$/.test(f))
      .map((f) => f.replace(/\.ts$/, ''));
    expect(onDisk.length, 'no tool modules found — the glob is wrong').toBeGreaterThan(3);

    const missing = onDisk.filter((m) => !SERVER_SIDE_EFFECT_IMPORTS.includes(m));
    expect(
      missing,
      `tools/server.ts does not import: ${missing.join(', ')} — those tools 404 on /api/tools/:name`,
    ).toEqual([]);
  });
});

describe('every tool an agent declares is reachable over HTTP', () => {
  /** Tool names a module registers, read from its source. */
  function registeredBy(module: string): string[] {
    const src = readFileSync(join(__dirname, `${module}.ts`), 'utf8');
    return [...src.matchAll(/registerTool\(\{\s*\n\s*name:\s*'([^']+)'/g)].map((m) => m[1]);
  }

  /** Tool names an agent declares, read from its source. */
  function declaredBy(agentFile: string, constName: string): string[] {
    const src = readFileSync(join(__dirname, '..', 'agents', `${agentFile}.ts`), 'utf8');
    const block = src.match(new RegExp(`export const ${constName} = \\[([^\\]]+)\\]`));
    expect(block, `${constName} not found in ${agentFile}.ts`).toBeTruthy();
    return [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  it('has no agent naming a tool the HTTP surface cannot run', () => {
    // Read from source rather than imported: importing an agent pulls in the
    // database, and a guard that only runs where the database is configured is
    // not a guard. The defect this catches is a missing IMPORT, which is a
    // property of the source text.
    const reachable = new Set(SERVER_SIDE_EFFECT_IMPORTS.flatMap(registeredBy));

    // Every agent that declares a *_TOOLS list, found on disk. Hardcoding the
    // queues here was the other half of the same blind spot: `records` and
    // `hub` were absent from this list too, so even a correct module check
    // would not have caught their tools going missing.
    const agentDir = join(__dirname, '..', 'agents');
    const agentFiles = readdirSync(agentDir).filter((f) => /Agent\.ts$/.test(f));
    const declarations: Array<[string, string]> = [];
    for (const file of agentFiles) {
      const src = readFileSync(join(agentDir, file), 'utf8');
      for (const m of src.matchAll(/export const ([A-Z0-9_]+_TOOLS) = \[/g)) {
        declarations.push([file.replace(/\.ts$/, ''), m[1]]);
      }
    }
    expect(declarations.length, 'no *_TOOLS declarations found — the scan is wrong').toBeGreaterThan(3);

    const unreachable: string[] = [];
    for (const [agentFile, constName] of declarations) {
      for (const name of declaredBy(agentFile, constName)) {
        if (!reachable.has(name)) unreachable.push(`${agentFile}:${name}`);
      }
    }

    expect(
      unreachable,
      `callable on a live call but 404 over HTTP: ${unreachable.join(', ')}`,
    ).toEqual([]);
  });
});
