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
 * The webhook's own allowlist — a THIRD gate, ahead of `validAgentSlugs`.
 *
 * This is the one that actually broke Optical. The first fix added `case
 * 'optical':` to the factory switch and added the slug to `validAgentSlugs`,
 * and the call STILL answered as after-hours, because the webhook coerces to
 * after-hours before `observeCall` is ever called.
 *
 * The comment above it in the source says, verbatim: "This list is a SECOND
 * allowlist, separate from validAgentSlugs in observeCall(); both must know a
 * slug or the call is silently answered by the after-hours agent." The code
 * warned about exactly this, and I checked two of the gates and not the third.
 */
const VALID_INBOUND: string[] = (() => {
  const m = ROUTES.match(/const validInboundAgents = \[([^\]]+)\]/);
  expect(m, 'validInboundAgents has moved or been renamed').toBeTruthy();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

/** Outbound-only agents. They never arrive on an inbound webhook. */
const VALID_OUTBOUND: string[] = (() => {
  const m = ROUTES.match(/const validOutboundAgents = \[([^\]]+)\]/);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
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

describe('an inbound slug must clear EVERY gate, not just the last one', () => {
  // A slug has to survive four independent places before a caller hears the
  // right agent:
  //
  //   1. validInboundAgents   (webhook)        ← broke Optical
  //   2. validAgentSlugs      (observeCall)
  //   3. the factory switch   (observeCall)
  //   4. the agent registry
  //
  // Each one silently falls back to after-hours. Nothing forces them to agree,
  // so this does.
  const inboundHardcoded = VALID_SLUGS.filter(
    (s) => !NOT_HARDCODED.has(s) && !VALID_OUTBOUND.includes(s) && s !== 'dev-no-ivr',
  );

  for (const slug of inboundHardcoded) {
    it(`'${slug}' is in validInboundAgents`, () => {
      expect(
        VALID_INBOUND.includes(slug),
        `'${slug}' clears observeCall but the WEBHOOK will coerce it to after-hours ` +
          `before observeCall is ever called — this is what happened to Optical`,
      ).toBe(true);
    });
  }
});

describe('a line that recognises callers must be in PRECONTEXT_SLUGS', () => {
  // The SIXTH list. `precontext` is what lets an agent open with "Am I speaking
  // with Wayne?" instead of asking a patient to identify themselves to a system
  // already holding their chart. If the slug is not here, the lookup is never
  // started, `racePrecontext()` returns null, and the agent silently opens cold
  // — no error, no log, just a worse call.
  const PRECONTEXT: string[] = (() => {
    const m = ROUTES.match(/const PRECONTEXT_SLUGS = new Set\(\[([^\]]+)\]/);
    expect(m, 'PRECONTEXT_SLUGS has moved or been renamed').toBeTruthy();
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  })();

  it('includes optical', () => {
    expect(
      PRECONTEXT,
      'optical passes precontext to its agent but the lookup is never started',
    ).toContain('optical');
  });

  it('every line that reads precontext also requests it', () => {
    // A case that passes `precontext:` to its factory while its slug is absent
    // from PRECONTEXT_SLUGS always receives null.
    for (const slug of VALID_INBOUND) {
      const caseStart = FACTORY_SWITCH.indexOf(`case '${slug}':`);
      if (caseStart === -1) continue;
      const nextCase = FACTORY_SWITCH.indexOf("case '", caseStart + 10);
      const body = FACTORY_SWITCH.slice(caseStart, nextCase === -1 ? undefined : nextCase);
      if (/precontext:/.test(body)) {
        expect(
          PRECONTEXT.includes(slug),
          `'${slug}' passes precontext to its agent but is not in PRECONTEXT_SLUGS — ` +
            `it will always receive null`,
        ).toBe(true);
      }
    }
  });
});

describe('the metadata fallback resolves by list, not by literal', () => {
  /** PRIORITY 2 — used when the X-agentSlug SIP header does not arrive. */
  const PRIORITY_2 = (() => {
    const start = ROUTES.indexOf('// PRIORITY 2: Check metadata');
    expect(start, 'the PRIORITY 2 metadata block has moved').toBeGreaterThan(-1);
    const block = ROUTES.slice(start, ROUTES.indexOf('For phone-based routing', start));
    // Strip comments. The block's own comment quotes the old `=== 'no-ivr'`
    // pattern to explain why it was removed, and a scan that reads prose as
    // code would fail on the explanation of the fix.
    return block
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  })();

  it('consults validInboundAgents rather than naming slugs one at a time', () => {
    // This block used to check `=== 'no-ivr'`, `=== 'after-hours'`, the
    // outbound list and the legacy list — and nothing else. Every other inbound
    // line fell through and kept the default, which is 'after-hours'. It rarely
    // bit only because the SIP header normally arrives.
    expect(
      PRIORITY_2.includes('validInboundAgents'),
      'the metadata fallback must use the shared allowlist, or each new line ' +
        'silently answers as after-hours whenever the SIP header is missing',
    ).toBe(true);
  });

  it('does not resolve any inbound slug by string equality', () => {
    for (const slug of VALID_INBOUND) {
      expect(
        PRIORITY_2.includes(`=== '${slug}'`),
        `PRIORITY 2 special-cases '${slug}' by name — that is the pattern that ` +
          `left five other lines unhandled`,
      ).toBe(false);
    }
  });
});

describe('the Optical line specifically', () => {
  it('is an accepted slug at both gates', () => {
    expect(VALID_SLUGS).toContain('optical');
    expect(VALID_INBOUND).toContain('optical');
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
