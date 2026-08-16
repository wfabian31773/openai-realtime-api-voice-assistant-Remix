/**
 * A GATE IS NOT A FAULT, AND THE CALLER MUST NEVER HEAR ABOUT IT.
 *
 * Three defects on the PCP line, one shape. From CA1de3229a (2026-08-14, a
 * referring coordinator from Dr. Chen's office, 188 seconds):
 *
 *   "I'm sorry, but it looks like a direct handoff isn't available for this
 *    purpose."
 *   "It looks like something isn't finalized yet."
 *   "Something still isn't finalized. Let me walk through the key details
 *    again."
 *
 * Every one of those is the model paraphrasing a slug it was handed with no
 * instructions — `handoff_not_eligible`, then `durable_disposition_required`
 * four times over. Measured over the ten days to 2026-08-16: 211 of 240
 * handoff refusals, 33 of 85 task refusals, 26 of 82 termination refusals.
 * None of them told the model anything.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PCP_REFUSALS, refusePcp } from './refusals';

const agentSrc = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8');

describe('every refusal the agent can return carries instructions', () => {
  /**
   * The structural check, and the one that survives the next tool being added:
   * a bare object literal is how all of these started, so the literal itself is
   * what is banned.
   */
  it('no bare `{ success: false, error }` literal is left in the agent', () => {
    const code = agentSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const bare = code.match(/\{\s*success:\s*false\s*,\s*error:/g) ?? [];
    expect(bare, `found ${bare.length} refusal(s) returned without guidance`).toEqual([]);
  });

  it('every slug the agent refuses with has copy written for it', () => {
    const slugs = [...agentSrc.matchAll(/refusePcp\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    // Sanity: the scan found the sites at all.
    expect(slugs.length).toBeGreaterThanOrEqual(10);
    for (const slug of new Set(slugs)) {
      expect(PCP_REFUSALS[slug], `${slug} has no entry in PCP_REFUSALS`).toBeDefined();
    }
  });

  it('the two dynamic slugs resolve too', () => {
    // `access.reason` and the handoff ternary pass variables, not literals, so
    // the scan above cannot see them.
    for (const slug of [
      'scheduling_not_allowed',
      'no_authoritative_source',
      'staff_verification_failed',
      'patient_medical_records_pathway_isolated',
      'handoff_not_eligible',
      'handoff_not_eligible_task_created',
    ]) {
      expect(PCP_REFUSALS[slug], `${slug} has no entry`).toBeDefined();
    }
  });
});

describe('guidance never becomes something the caller hears', () => {
  /**
   * Each guidance string has to carry its own muzzle. This is not belt-and-
   * braces: STATE-OF-PLAY §3 records an earlier attempt at mouthpiece rules
   * where "the model read them to patients."
   */
  /**
   * SILENCE OR AN APPROVED LINE — never the model's own words.
   *
   * A refusal is one of two things. Either the caller should notice nothing,
   * and the guidance has to say so explicitly; or we genuinely owe them an
   * explanation, and then there is a `say` holding the words we chose. What is
   * banned is the third case, which is what shipped: no muzzle and no line, so
   * the model wrote its own.
   */
  it('every refusal either muzzles the model or hands it a line', () => {
    const muzzle = /NOT AN ERROR|say nothing|Say nothing|do not mention|Do not mention|never tell|Never tell|never that|Say the line above/;
    for (const [slug, copy] of Object.entries(PCP_REFUSALS)) {
      const ok = muzzle.test(copy.guidance) || Boolean(copy.say);
      expect(ok, `${slug} neither forbids narration nor supplies a caller line`).toBe(true);
    }
  });

  it('guidance always names something to do instead', () => {
    // A refusal with no exit is the deadlock that trapped a caller for 188s.
    // "Speak the approved line and carry on" is a legitimate exit — the request
    // is already filed on that path — so it counts alongside the tool calls.
    for (const [slug, copy] of Object.entries(PCP_REFUSALS)) {
      expect(
        copy.guidance,
        `${slug} guidance refuses without naming a next action`,
      ).toMatch(
        /create_pcp_task|record_pcp_intake|handle_patient_medical_records_request|terminate_call|ask |Ask |close|Deliver the line|Say the line/,
      );
    }
  });

  it('the prompt tells the model guidance is never spoken', () => {
    expect(agentSrc).toMatch(/NEVER read this out/);
    expect(agentSrc).toMatch(/guidance/);
  });
});

describe('the sentences the agent actually said are now ruled out', () => {
  /**
   * Named directly, because a generic rule is easy to write and easy to drift
   * away from. These are the caller-facing phrases from the transcript.
   */
  const banned = ['not available for this purpose', 'finalized', 'unavailable'];

  it('the handoff refusal forbids the exact vocabulary it produced', () => {
    const g = PCP_REFUSALS.handoff_not_eligible_task_created.guidance;
    expect(g).toMatch(/unavailable/);
    expect(g).toMatch(/not available for this purpose/);
    expect(g).toMatch(/[Nn]ever tell a caller/);
  });

  it('the disposition refusal forbids the goodbye loop', () => {
    const g = PCP_REFUSALS.durable_disposition_required.guidance;
    expect(g).toMatch(/unfinished/);
    expect(g).toMatch(/do NOT say goodbye again/);
  });

  it('the prompt bans the phrases outright, not only the individual guidance', () => {
    // Wrapped at 80 columns like the rest of the prompt, so a phrase can be
    // split across a newline. Compare on collapsed whitespace.
    const flat = agentSrc.toLowerCase().replace(/\s+/g, ' ');
    for (const phrase of banned) {
      expect(flat, `prompt does not ban "${phrase}"`).toContain(phrase.toLowerCase());
    }
    expect(agentSrc).toMatch(/Never say goodbye twice/);
  });
});

describe('`say` is for the caller and `guidance` is for the model', () => {
  /**
   * azulRubric grades every `outcome.say` for verbatim delivery, so anything
   * placed there is a promise that the agent should speak roughly those words.
   * A directive in that field would both fail the grader and invite exactly
   * the behaviour this whole change exists to stop.
   */
  it('no `say` reads like an instruction', () => {
    for (const [slug, copy] of Object.entries(PCP_REFUSALS)) {
      if (!copy.say) continue;
      expect(copy.say, `${slug} say looks like a directive`).not.toMatch(
        /NOT AN ERROR|call create_pcp_task|record_pcp_intake|do not |Do not |never |Never /,
      );
      // A line for a caller is a sentence, not a slug.
      expect(copy.say).toMatch(/^[A-Z].*[.?]$/);
    }
  });

  it('a refusal the caller is owed nothing about carries no `say`', () => {
    // Purely internal sequencing problems. The caller should notice nothing.
    for (const slug of [
      'call_purpose_required',
      'durable_disposition_required',
      'durable_ticket_required_before_handoff',
      'director_disposition_mismatch',
    ]) {
      expect(PCP_REFUSALS[slug].say, `${slug} should say nothing to the caller`).toBeUndefined();
    }
  });

  it('a genuine dependency failure DOES give the caller a line', () => {
    // The one class where silence would be worse: we really cannot do the thing.
    expect(PCP_REFUSALS.schedule_lookup_failed.say).toBeTruthy();
    expect(PCP_REFUSALS.handoff_not_eligible_task_created.say).toBeTruthy();
  });
});

describe('refusePcp()', () => {
  it('returns the failure shape callers already expect', () => {
    const r = refusePcp('call_purpose_required');
    expect(r.success).toBe(false);
    expect(r.error).toBe('call_purpose_required');
    expect(r.guidance).toBeTruthy();
  });

  it('preserves the fields the call site was already returning', () => {
    // handoff_not_eligible_task_created carries the fallback ticket number —
    // losing it would turn a filed request into an invisible one.
    const r = refusePcp('handoff_not_eligible_task_created', {
      handoffStatus: 'HANDOFF_UNAVAILABLE',
      ticketNumber: 'PCP-51592',
      fallbackRecorded: true,
    });
    expect(r.ticketNumber).toBe('PCP-51592');
    expect(r.fallbackRecorded).toBe(true);
    expect(r.say).toBeTruthy();
  });

  it('resolves a parameterised slug from its head', () => {
    // `missing_required_field:callbackNumber` and
    // `disposition_not_allowed: Disposition HAND_OFF is not allowed...` both
    // appear in production timelines.
    const a = refusePcp('missing_required_field:callbackNumber');
    const b = refusePcp('disposition_not_allowed: Disposition HAND_OFF is not allowed for PCP purpose x');
    for (const r of [a, b]) expect(r.guidance).toBeTruthy();
    // The full slug is preserved for diagnosis even when the copy is generic.
    expect(a.error).toBe('missing_required_field:callbackNumber');
  });

  it('an unknown slug still gets a muzzle and a floor, and never throws', () => {
    // The fail-safe direction: a slug nobody wrote copy for is exactly how the
    // original behaviour arose, so the default cannot be silence.
    const r = refusePcp('something_nobody_has_written_yet');
    expect(r.guidance).toMatch(/do not apologize/i);
    expect(r.guidance).toMatch(/create_pcp_task/);
    expect(r.say).toBeUndefined();
  });
});

describe('the refusal is observable afterwards', () => {
  it('guidance is on the timeline allow-list', () => {
    // Without this the timeline records the slug and not the fact that the
    // agent was told what to do — which is the read CA1de3229a needed.
    const timeline = readFileSync(new URL('../services/toolTimeline.ts', import.meta.url), 'utf8');
    expect(timeline).toMatch(/'guidance',/);
  });

  it('guidance carries no caller data — it is a constant map', () => {
    // The PHI argument for storing it at all: every string is written here,
    // and nothing interpolates.
    const src = readFileSync(new URL('./refusals.ts', import.meta.url), 'utf8');
    const map = src.slice(src.indexOf('export const PCP_REFUSALS'), src.indexOf('const DEFAULT_GUIDANCE'));
    expect(map, 'a template literal in the copy map could interpolate caller data').not.toMatch(/\$\{(?!FILE_IT)/);
  });
});
