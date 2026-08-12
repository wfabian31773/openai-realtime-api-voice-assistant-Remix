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
import { readFileSync } from 'fs';
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
    // Discovered from the agents, not hardcoded — a hardcoded list here would
    // have the same blind spot as the import it is checking.
    const missing = ['opticalTools', 'surgeryTools'].filter(
      (m) => !SERVER_SIDE_EFFECT_IMPORTS.includes(m),
    );
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

    const unreachable: string[] = [];
    for (const [queue, agentFile, constName] of [
      ['optical', 'opticalAgent', 'OPTICAL_TOOLS'],
      ['surgery', 'surgeryAgent', 'SURGERY_TOOLS'],
    ] as const) {
      for (const name of declaredBy(agentFile, constName)) {
        if (!reachable.has(name)) unreachable.push(`${queue}:${name}`);
      }
    }

    expect(
      unreachable,
      `callable on a live call but 404 over HTTP: ${unreachable.join(', ')}`,
    ).toEqual([]);
  });
});
