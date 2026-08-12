/**
 * Every registered agent must be REACHABLE, not merely correct.
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-08-12 the Optical agent was registered in `config/agents.ts`, given a
 * webhook at `/api/voice/optical`, and added to `validAgentSlugs`. Its own unit
 * tests passed: fourteen of them, calling `createOpticalAgent` directly.
 *
 * The first real call came out as **after-hours**.
 *
 * `voiceAgentRoutes.ts` builds hardcoded agents through a `switch (effectiveSlug)`
 * and there was no `case 'optical':`. It fell to `default:`, threw
 * "Unknown hardcoded agent", and the error path coerced the call to after-hours.
 *
 * Nothing in the agent could have caught that, because the agent was fine. The
 * gap was between the registry and the transport, and it is exactly the kind of
 * gap a unit test never sees: every test that called the factory directly
 * skipped the step that was broken.
 *
 * So these tests assert the WIRING rather than the behaviour. They read the
 * transport as text, which is crude, and that is the point — the thing being
 * checked is whether one file mentions what another file declares.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Importing the registry pulls in agents that open a database pool at module
// load. These tests never reach it — they read wiring — but the import still
// has to get past the env check.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

const ROUTES = readFileSync(join(__dirname, '..', 'voiceAgentRoutes.ts'), 'utf8');

/** The `switch (effectiveSlug)` that turns a slug into a live agent. */
const FACTORY_SWITCH = (() => {
  const start = ROUTES.indexOf('if (isHardcodedAgent && agentFactory) {');
  expect(start, 'the hardcoded-agent factory switch has moved or been renamed').toBeGreaterThan(-1);
  const end = ROUTES.indexOf('Unknown hardcoded agent', start);
  return ROUTES.slice(start, end);
})();

/** Slugs the session router will accept without coercing to after-hours. */
const VALID_SLUGS: string[] = (() => {
  const m = ROUTES.match(/const validAgentSlugs = \[([^\]]+)\]/);
  expect(m, 'validAgentSlugs has moved or been renamed').toBeTruthy();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

/**
 * Agents whose slug is accepted but which are resolved from the database rather
 * than the hardcoded switch. `demo` is the standalone transport; `dev-no-ivr`
 * IS in the switch and is listed here only so the intent is explicit.
 */
const NOT_HARDCODED = new Set(['demo']);

describe('an accepted slug must reach a factory', () => {
  for (const slug of VALID_SLUGS.filter((s) => !NOT_HARDCODED.has(s))) {
    it(`'${slug}' has a case in the factory switch`, () => {
      // Without this, the slug passes validation, reaches the switch, hits
      // `default:`, throws, and the caller silently gets after-hours. That is
      // what happened to the Optical line's first live call.
      expect(
        FACTORY_SWITCH.includes(`case '${slug}':`),
        `'${slug}' is in validAgentSlugs but has no case in the factory switch — ` +
          `a call on that line will be coerced to after-hours`,
      ).toBe(true);
    });
  }
});

describe('the Optical line specifically', () => {
  it('is an accepted slug', () => {
    expect(VALID_SLUGS).toContain('optical');
  });

  it('has a webhook route of its own', () => {
    expect(ROUTES).toMatch(/path:\s*'\/api\/voice\/optical'/);
  });

  it('stamps X-agentSlug from the line config rather than a literal', () => {
    // The overflow lines share one handler; the slug has to come from the
    // registration, or Optical calls would arrive stamped answering-service.
    expect(ROUTES).toMatch(/X-agentSlug=\$\{opts\.slug\}/);
  });

  it('is registered in the agent registry', async () => {
    const { agentRegistry } = await import('../config/agents');
    const cfg = agentRegistry.getAgentConfig('optical');
    expect(cfg, 'optical is not in the registry').toBeTruthy();
    expect(cfg!.enabled).toBe(true);
    expect(agentRegistry.getAgentFactory('optical')).toBeTruthy();
  });

  it('is passed no handoff callback', () => {
    // Operator ruling 2026-08-12: only PCP and Scheduling transfer. The case
    // must pass `undefined` where other lines pass `handoffCallback`.
    const caseBody = FACTORY_SWITCH.slice(
      FACTORY_SWITCH.indexOf("case 'optical':"),
      FACTORY_SWITCH.indexOf("case 'pcp':"),
    );
    expect(caseBody).toContain('agentFactory(undefined,');
    expect(caseBody).not.toContain('handoffCallback');
  });
});

describe('every registry agent the router accepts is enabled', () => {
  it('has no accepted slug pointing at a disabled or missing registration', async () => {
    const { agentRegistry } = await import('../config/agents');
    const broken: string[] = [];
    for (const slug of VALID_SLUGS.filter((s) => !NOT_HARDCODED.has(s))) {
      const cfg = agentRegistry.getAgentConfig(slug);
      if (!cfg || !cfg.enabled) broken.push(slug);
    }
    expect(broken, `accepted slugs with no usable registration: ${broken.join(', ')}`).toEqual([]);
  });
});
