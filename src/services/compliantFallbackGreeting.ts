/**
 * THE GREETING TO USE WHEN A LANE'S MANDATORY COPY IS NOWHERE ELSE TO BE
 * FOUND.
 *
 * Two live paths let the database word a lane's greeting — `chooseGreeting`
 * (`voiceRuntime.ts:140`) on the runtime, and the override at
 * `voiceAgentRoutes.ts:4401` on the old core — and both ask
 * `missingMandatoryCopy` whether the configured string still carries the
 * sentences that lane is legally required to say. When it does not, the
 * database row is declined.
 *
 * DECLINING THE DATABASE IS NOT THE SAME AS HAVING A GREETING. That was
 * Codex's finding on #244, and it is why the old core keeps a compliant code
 * string to fall back on: in-memory metadata is lost whenever the webhook
 * lands on a different instance than the one that stored it, so "keep the code
 * greeting" can mean keeping nothing, and a bare `response.create` has the
 * model improvise an opening — which CLAUDE.md records as how the recording
 * disclosure and the 911 direction went missing in the first place.
 *
 * WHY THIS IS A TABLE AND NOT A TERNARY. The call site read
 * `agentSlug === 'no-ivr' ? WELCOME_GREETING : null`, under a comment saying
 * the `null` arm was unreachable because no other lane had mandatory copy.
 * #304 gave `pcp` mandatory copy and made it reachable — the fix for one
 * compliance gap quietly opening a worse one on the other pipeline. A table
 * cannot drift that way, because `compliantFallbackGreeting.test.ts` walks
 * `MANDATED_COPY_LANES` and fails the moment a lane has copy and no fallback.
 *
 * Each entry must itself pass `missingMandatoryCopy` for its own lane. That is
 * asserted, not assumed: a fallback that does not carry the sentence it is
 * falling back for is worse than none, because it looks like a rescue.
 */
import { WELCOME_GREETING } from '../agents/afterHoursAgent';
import { pcpAgentConfig } from '../agents/pcpAgent';
import { opticalAgentConfig } from '../agents/opticalAgent';
import { surgeryAgentConfig } from '../agents/surgeryAgent';
import { techAgentConfig } from '../agents/techAgent';
import { recordsAgentConfig } from '../agents/recordsAgent';

export const COMPLIANT_FALLBACK_GREETINGS: Readonly<Record<string, string>> = {
  // The after-hours line's registry string: closed-office notice, 911
  // direction and recording disclosure, all three.
  'no-ivr': WELCOME_GREETING,
  // PCP's own literal, which #304 put the recording disclosure into. One
  // requirement on this lane, not no-ivr's three — it is a business-hours
  // professional line.
  pcp: pcpAgentConfig.greeting,
  // The four queue lanes, 2026-09-17. Each carries the same single
  // requirement as pcp, and each value is a REFERENCE to the lane's own
  // registry literal — never a copy, so the fallback cannot drift away from
  // the greeting it is standing in for.
  optical: opticalAgentConfig.greeting,
  surgery: surgeryAgentConfig.greeting,
  tech: techAgentConfig.greeting,
  records: recordsAgentConfig.greeting,
};

/**
 * The compliant code greeting for a lane, or null when it needs none.
 *
 * Takes `undefined` because the old-core call site's `agentSlug` is optional
 * and an unknown lane has no mandatory copy, so it has nothing to fall back
 * to either — the two answers coincide and both are `null`.
 */
export function compliantFallbackGreeting(slug: string | undefined): string | null {
  return (slug && COMPLIANT_FALLBACK_GREETINGS[slug]) || null;
}
