/**
 * ADDING A LANE TO `MANDATORY_GREETING_COPY` MADE A "UNREACHABLE" BRANCH
 * REACHABLE, AND IT OPENS THE CALL UNSCRIPTED.
 *
 * #304 added `pcp` to `MANDATORY_GREETING_COPY` so a database greeting
 * without a recording disclosure can no longer outrank the compliant code
 * literal. That is the right fix and it covers both live paths, because
 * `voiceRuntime.ts:146` and `voiceAgentRoutes.ts:4423` both consult
 * `missingMandatoryCopy`.
 *
 * It also walked into a comment the old core had written about itself:
 *
 *     // No lane but no-ivr has mandatory copy today, so this is
 *     // unreachable — and it says so rather than failing silently if a
 *     // second lane is ever added to MANDATORY_GREETING_COPY.
 *
 * A second lane was added. On the old core, a call whose in-memory metadata
 * was lost AND whose database row is non-compliant now falls into that branch,
 * logs `✗✗`, and lets the model improvise an opening — which CLAUDE.md records
 * as how the recording disclosure and the 911 direction went missing in the
 * first place, on four live SD calls of 2026-08-06. Before #304 that same call
 * would at least have taken the database greeting.
 *
 * So the #304 fix, alone, would have traded "recorded without a disclosure"
 * for "recorded without a disclosure AND unscripted" on that path. Narrow —
 * PCP has run on the Grok runtime since 2026-09-04 — but the branch exists,
 * it is one routing decision away, and the comment claiming it cannot be
 * reached is now false.
 *
 * THE FIX IS A TABLE, NOT A SECOND TERNARY ARM, so the next lane added to
 * `MANDATORY_GREETING_COPY` cannot repeat this: the first test below fails the
 * moment a lane has mandatory copy and no compliant greeting to fall back on.
 */
import { describe, it, expect, vi } from 'vitest';

// `pcpAgentConfig` lives in the PCP agent module, which validates env at
// import. Same preamble as `lostRequestFloor.test.ts`; nothing here touches a
// database.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

const { COMPLIANT_FALLBACK_GREETINGS, compliantFallbackGreeting } = await import(
  './compliantFallbackGreeting'
);
const { MANDATED_COPY_LANES, missingMandatoryCopy } = await import('./greetingPersonalisation');

describe('every lane with mandatory copy has a compliant greeting to fall back on', () => {
  it('covers every lane in MANDATORY_GREETING_COPY', () => {
    for (const lane of MANDATED_COPY_LANES) {
      expect(compliantFallbackGreeting(lane), `${lane} has mandatory copy and no fallback`).toBeTruthy();
    }
  });

  for (const [lane, greeting] of Object.entries(COMPLIANT_FALLBACK_GREETINGS)) {
    it(`the ${lane} fallback itself satisfies the copy it is falling back for`, () => {
      expect(missingMandatoryCopy(lane, greeting)).toEqual([]);
    });
  }

  it('a lane with no mandatory copy gets no fallback, which is correct', () => {
    // `surgery` was the example here until 2026-09-17, when all four queue
    // lanes gained the recording disclosure and it stopped being a lane
    // without mandatory copy. The assertion is NOT loosened — it is pointed at
    // a slug that still qualifies, because what it proves is that the table
    // answers null for a lane it does not cover, and a stale example would
    // have proved that by accident of the table being incomplete.
    expect(compliantFallbackGreeting('answering-service')).toBeNull();
    expect(MANDATED_COPY_LANES).not.toContain('answering-service');
  });
});

/**
 * The old core reads this table at `voiceAgentRoutes.ts:4455`. A test that
 * only exercised the table would pass while the call site kept its hardcoded
 * `agentSlug === 'no-ivr' ? … : null` — the sink, not the source. So the wire
 * is read from the file, the device `ticketRequirements.test.ts` already uses.
 */
describe('the old core actually consults the table', () => {
  it('voiceAgentRoutes picks its fallback from compliantFallbackGreeting', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/voiceAgentRoutes.ts', 'utf8');
    expect(src).toMatch(/const fallback = compliantFallbackGreeting\(agentSlug\)/);
    expect(src, 'the hardcoded single-lane ternary is what this replaces').not.toMatch(
      /const fallback = agentSlug === 'no-ivr' \? WELCOME_GREETING : null/,
    );
  });
});
