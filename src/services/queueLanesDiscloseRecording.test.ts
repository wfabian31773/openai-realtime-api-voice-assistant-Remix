/**
 * THE FOUR QUEUE LANES MUST TELL THE CALLER THE CALL IS RECORDED.
 *
 * MEASURED 2026-09-16: of 667 substantive calls, the **401** on optical,
 * surgery, tech and records carried no disclosure at all. California is a
 * two-party-consent state and this is a healthcare practice, so this is a
 * compliance gap rather than a stylistic one. Task #79, open since before the
 * cutover; `pcp` got its disclosure on 2026-09-15 (#304) and these four were
 * left out.
 *
 * THE CLAUSE IS `noIvrAgent`'s, VERBATIM — "All calls are being recorded for
 * quality assurance purposes" — an operator-approved sentence already live on
 * two lanes, not one written here. The closed-office notice and the 911
 * direction are deliberately NOT copied: those belong to the after-hours line,
 * and requiring a clinical-safety sentence on a business-hours queue would be
 * inventing a rule rather than applying one (standing instruction 1).
 *
 * ## The trap this file exists to hold, and it is not the obvious one
 *
 * Putting the sentence in the greeting is easy. KEEPING it there is not.
 *
 * `personaliseGreeting` runs AFTER `missingMandatoryCopy` on both pipelines
 * (runtime `voiceRuntime.ts:1025`, old core `voiceAgentRoutes.ts:4517`), and on
 * these four lanes its style is `append` — which calls `stripTrailingQuestion`
 * and deletes everything from the last sentence boundary to the closing `?`.
 * So a disclosure comma-joined into the closing question passes the gate and is
 * then dropped on the wire, for every recognised caller.
 *
 * That is not hypothetical. `greetingPersonalisation.test.ts:147` already
 * proves it of the no-ivr string: `stripTrailingQuestion(NO_IVR)` does NOT
 * contain "being recorded". And recognition is now the COMMON case — on
 * 2026-09-16, 65% of pcp, 72% of surgery, 67% of optical and 64% of tech calls
 * were greeted by name — so the broken shape would have failed on most traffic
 * while a naive "does the greeting contain it?" test stayed green.
 *
 * Hence: every assertion below that matters runs the greeting through
 * personalisation first.
 */
import { describe, it, expect, beforeAll } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
process.env.OPENAI_API_KEY ??= 'sk-test';

type LaneGreetings = ReadonlyArray<readonly [string, string]>;

let LANES: LaneGreetings;
let personaliseGreeting: typeof import('./greetingPersonalisation')['personaliseGreeting'];
let greetingStyleFor: typeof import('./greetingPersonalisation')['greetingStyleFor'];
let missingMandatoryCopy: typeof import('./greetingPersonalisation')['missingMandatoryCopy'];
let MANDATED_COPY_LANES: ReadonlyArray<string>;
let compliantFallbackGreeting: typeof import('./compliantFallbackGreeting')['compliantFallbackGreeting'];
let chooseGreeting: typeof import('../runtime/voiceRuntime')['chooseGreeting'];

beforeAll(async () => {
  const gp = await import('./greetingPersonalisation');
  personaliseGreeting = gp.personaliseGreeting;
  greetingStyleFor = gp.greetingStyleFor;
  missingMandatoryCopy = gp.missingMandatoryCopy;
  MANDATED_COPY_LANES = gp.MANDATED_COPY_LANES;
  compliantFallbackGreeting = (await import('./compliantFallbackGreeting')).compliantFallbackGreeting;
  chooseGreeting = (await import('../runtime/voiceRuntime')).chooseGreeting;

  const [optical, surgery, tech, records] = await Promise.all([
    import('../agents/opticalAgent'),
    import('../agents/surgeryAgent'),
    import('../agents/techAgent'),
    import('../agents/recordsAgent'),
  ]);
  LANES = [
    ['optical', optical.opticalAgentConfig.greeting],
    ['surgery', surgery.surgeryAgentConfig.greeting],
    ['tech', tech.techAgentConfig.greeting],
    ['records', records.recordsAgentConfig.greeting],
  ] as const;
});

/** The operator-approved sentence, as `noIvrAgent` words it. */
const DISCLOSURE = /calls are being recorded for quality assurance purposes/i;

describe('the four queue lanes disclose that the call is recorded', () => {
  it('every lane registry greeting carries the clause', () => {
    for (const [lane, greeting] of LANES) {
      expect(greeting, `${lane} greeting has no recording disclosure`).toMatch(DISCLOSURE);
    }
  });

  /**
   * THE LOAD-BEARING ONE. A disclosure the caller never hears is not a
   * disclosure, and on these four lanes most callers are recognised.
   */
  it('the clause SURVIVES personalisation, which is what a recognised caller hears', () => {
    for (const [lane, greeting] of LANES) {
      const spoken = personaliseGreeting(greeting, 'Wayne', greetingStyleFor(lane));
      expect(spoken, `${lane}: personalisation stripped the disclosure`).toMatch(DISCLOSURE);
      expect(spoken, `${lane}: personalisation stopped asking the name`).toMatch(
        /Am I speaking with Wayne\?/,
      );
    }
  });

  it('each lane is registered, so a database row cannot silently drop it', () => {
    for (const [lane] of LANES) {
      expect(MANDATED_COPY_LANES, `${lane} is not in MANDATORY_GREETING_COPY`).toContain(lane);
      expect(
        missingMandatoryCopy(lane, 'Thanks for calling, how can I help?'),
        `${lane} accepts a greeting with no disclosure`,
      ).toEqual(['recording disclosure']);
      expect(missingMandatoryCopy(lane, LANES.find(([l]) => l === lane)![1])).toEqual([]);
    }
  });

  it('each lane has a compliant fallback that itself satisfies the requirement', () => {
    for (const [lane] of LANES) {
      const fallback = compliantFallbackGreeting(lane);
      expect(fallback, `${lane} has mandatory copy and no fallback`).toBeTruthy();
      expect(missingMandatoryCopy(lane, fallback!)).toEqual([]);
    }
  });

  /**
   * The runtime's own precedence. A configured `agents.welcome_greeting`
   * without the clause must lose to the registry string that has it — this is
   * the path #304 found was one database row from useless on pcp.
   */
  it('a database greeting without the clause loses to the registry one', () => {
    for (const [lane, greeting] of LANES) {
      expect(
        chooseGreeting(lane, 'Hi, thanks for calling. How can I help?', greeting),
        `${lane}: a non-compliant database row won`,
      ).toBe(greeting);
    }
  });

  /**
   * THE SECOND COPY. `voiceAgentRoutes.ts` authors its own greeting literal per
   * lane inside `registerOverflowLine`, independent of the registry config —
   * and the two have ALREADY drifted (the optical route says "customers" where
   * the registry says "patients"). That drift is not fixed here, but this
   * property must not join it: a lane that falls back to the old core must
   * still disclose. Read from the file, because the literals are inside a
   * function this test cannot call.
   */
  it('the old core\'s own copy of each greeting carries the clause too', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');
    for (const [lane] of LANES) {
      const block = src.slice(src.indexOf(`slug: '${lane}',`));
      const greeting = block.slice(0, block.indexOf('});'));
      expect(greeting, `the old-core ${lane} greeting has no disclosure`).toMatch(
        /calls are being recorded for quality assurance purposes/i,
      );
    }
  });

  /**
   * The lanes that must NOT have gained anything. no-ivr keeps all three of
   * its requirements and answering-service stays unconstrained — this change
   * adds a disclosure to four lanes, it does not redefine the others.
   */
  it('does not disturb the other lanes', () => {
    expect(missingMandatoryCopy('answering-service', 'anything at all')).toEqual([]);
    expect(
      missingMandatoryCopy('no-ivr', 'Thank you for calling. How can I help?').sort(),
    ).toEqual(['911 direction', 'closed-office notice', 'recording disclosure']);
  });
});
