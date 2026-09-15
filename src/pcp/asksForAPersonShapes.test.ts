/**
 * "CALLER ASKED FOR A REPRESENTATIVE." DID NOT MATCH.
 *
 * That is the plainest way a model can narrate an ask for a person, and
 * `asksForAPerson` returned false for it — so the director never granted
 * `eligibleByAsk`, the ticket filed without `dispositionGrantedByExplicitAsk`,
 * and the caller heard the patient refusal instead of being connected.
 *
 * The module's own header records this phrase failing a test on 2026-09-08 and
 * the author fixing THE TEST rather than the code. It was never fixed. This
 * file is the fix and the proof, and the shapes below are taken from the PCP
 * line's first full day rather than imagined.
 *
 * WHAT WAS MISSING, mechanically: both existing branches require a VERB OF
 * CONNECTION — `speak|talk to/with`, or `connect|transfer|put through|get me`.
 * "asked FOR" is neither. Every phrasing built on it fell through:
 *
 *     "Caller asked for a representative."              <- missed
 *     "Caller asked for the operator."                  <- missed
 *     "Caller requested a live agent."                  <- missed
 *     "Caller asked to speak to the operator."          <- missed (noun)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `operator` JOINS THE SHARED NOUN LIST, AND `coordinator` DOES NOT.
 *
 * Both were measured over the 170 substantive PCP calls of 2026-09-14, on the
 * caller's own lines, before either was considered:
 *
 *   operator      6 occurrences, 6 of them asks, 0 role statements
 *                 ("Operator?", "Let me have the operator", "Transfer the
 *                  call to the operator", "Speak to a operator")
 *   coordinator  24 occurrences, 1 ask, 23 ROLE STATEMENTS
 *                 ("Outreach coordinator." x7, "Referral coordinator." x6,
 *                  "Coordinator." x5 — answers to "What is your role?")
 *   supervisor    3 occurrences, 1 ask, 2 role statements
 *
 * Those role statements are the #99 shape — the defect where `'surgery center'`
 * matched a caller's EMPLOYER and misrouted their ticket to department 2.
 *
 * MUTATION TESTING CORRECTED THE JUSTIFICATION BEFORE IT SHIPPED. Adding
 * `coordinator` to the noun list fails none of these tests, because all 23 of
 * those lines are bare nouns and every branch requires a verb. THE VERB
 * REQUIREMENT, NOT THE NOUN LIST, is what keeps a job title out of a dial —
 * and that is what the last describe block below pins. The refusal therefore
 * rests on what it can claim: one call of benefit in 170, against two words
 * that are measurably job titles on this line and would be the first to
 * misfire if this module were ever widened toward bare nouns.
 *
 * `operator` is safe for a reason that is a property of the word, not of one
 * day's data: nobody introduces themselves as "the operator" to an answering
 * line. It is a role you ask FOR, never one you claim.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE NEW BRANCH ENDS AT A PHRASE BOUNDARY.
 *
 * `office` and `team` are in the shared noun list and they can OWN things:
 * "asked for the office fax number", "asked for the team's direct line". Under
 * a bare `for ... <noun>` those become dials. So the ask-for branch requires
 * the noun to END the phrase — punctuation or end of string — which keeps
 * "asked for a representative." and rejects "asked for the office fax number."
 *
 * The noun list itself is NOT split to achieve this. One shared list is the
 * whole point of this module: two near-identical lists is what let `team`
 * drift out of one branch and cost the operator his own transfer.
 */
import { describe, it, expect } from 'vitest';
import { asksForAPerson } from './explicitAsk';

describe('the shapes a model actually writes', () => {
  const asks = [
    'Caller asked for a representative.',
    'Caller asked for the operator.',
    'Caller asked for a person.',
    'Caller requested a live agent.',
    'Caller is requesting a representative.',
    'Caller wants a representative.',
    'Caller asked for someone.',
  ];
  for (const n of asks) {
    it(`matches: ${n}`, () => expect(asksForAPerson(n)).toBe(true));
  }
});

describe('the shapes that already worked keep working', () => {
  const asks = [
    'Caller asked to speak to a representative.',
    'Caller asked us to put them through to a representative.',
    'Caller wants to speak with someone.',
    'Hi, can I speak to the, can I speak to the team please?',
    'Caller asked to be connected to the office.',
    'I want a real person.',
  ];
  for (const n of asks) {
    it(`still matches: ${n}`, () => expect(asksForAPerson(n)).toBe(true));
  }
});

describe('operator is recognised; a job title is not a request', () => {
  it('matches an ask for the operator with a verb', () => {
    expect(asksForAPerson('Caller asked to speak to the operator.')).toBe(true);
    expect(asksForAPerson('Caller asked for the operator.')).toBe(true);
    // "transferred" stays deliberately unmatched — the module excludes the
    // inflected form because it narrates things that happened TO records and
    // patients, and the two negatives below are why. No live call needed it.
    expect(asksForAPerson('Records were transferred to the office last week.')).toBe(false);
  });

  /**
   * The 23-to-1 measurement above, as an assertion. These are the exact
   * answers callers gave to "What is your role?" on 2026-09-14.
   */
  const roleStatements = [
    'Caller is the outreach coordinator at a medical group.',
    'Caller is a referral coordinator asking about a referral status.',
    'Caller states their role is surgery coordinator.',
    'Caller is the office supervisor.',
    'Caller is a clinic supervisor calling about a patient.',
  ];
  for (const n of roleStatements) {
    it(`does NOT dial on a job title: ${n}`, () => expect(asksForAPerson(n)).toBe(false));
  }
});

describe('a mention of a human is still not an ask', () => {
  const notAsks = [
    // Review 2026-08-09 — the rule this module was kept narrow for.
    'Caller from the front desk asking about a referral.',
    'Records were transferred to the office last week.',
    'Her care was transferred to another provider.',
    // The possessive shapes the phrase boundary exists to reject.
    'Caller asked for the office fax number.',
    "Caller asked for the team's direct line.",
    'Caller asked for the representative case number they were given.',
    // No human noun at all.
    'Caller asked for a referral status update.',
    'Caller asked for an appointment next Tuesday.',
  ];
  for (const n of notAsks) {
    it(`does NOT match: ${n}`, () => expect(asksForAPerson(n)).toBe(false));
  }
});

/**
 * THE PROPERTY THAT ACTUALLY PROTECTS US, pinned separately because the noun
 * list does not provide it and a reader could easily believe it does.
 *
 * Every branch needs a VERB. A bare noun — which is how a caller answers
 * "What is your role?", and 23 of 24 `coordinator` mentions on 2026-09-14 —
 * can never reach the dial, whatever is in HUMAN_NOUNS. If a future change
 * adds a bare-noun branch, these go red, and that is the moment to re-read
 * the measurement in the header.
 */
describe('a bare noun is never an ask, whatever the noun list holds', () => {
  const bare = [
    'Representative.',
    'Operator.',
    'Coordinator.',
    'Referral coordinator.',
    'Office supervisor.',
    'Front desk.',
    'Agent',
  ];
  for (const n of bare) {
    it(`bare noun does not reach the dial: ${n}`, () => expect(asksForAPerson(n)).toBe(false));
  }
});

/**
 * TWO WAYS THE ASK-FOR BRANCH SAID YES WHEN THE CALLER HAD NOT ASKED.
 * Both found by Codex on PR #301, both in the branch added above, both live
 * until this block.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 1. A NEGATED ASK IS NOT AN ASK. "Caller did not ask for a representative."
 *    matched, because the branch reads the verb and never looks at what sits
 *    in front of it.
 *
 *    THE GUARD IS SCOPED TO THE MATCH, NOT TO THE NARRATIVE, and that is the
 *    whole design. CLAUDE.md records the grader's `connect you` check being
 *    written THREE times: the first two suppressed the entire sentence on
 *    finding a negation, so "I can't transfer you, but I can connect you with
 *    the team" lost its affirmative half and a real broken promise graded as a
 *    pass. A narrative-wide `/not.*ask/` here is that same mistake pointed the
 *    other way — it would drop a real transfer. So the check looks only at the
 *    text IMMEDIATELY BEFORE the verb it matched, and every match in the
 *    narrative gets its own look. The last case below is the one that pins it.
 *
 * 2. `ASK` TAKES A PERSON AS ITS OBJECT, so `for` cannot be optional after it.
 *    "Caller asked the representative, but they could not provide the status."
 *    is a caller who SPOKE to somebody, narrated with the same verb. `want`,
 *    `request` and `would like` have no such reading — "Caller wants a
 *    representative." is an ask with no `for` in it — so `for` stays optional
 *    for those three and is now mandatory for forms of `ask`.
 */
describe('a negated ask is not an ask', () => {
  const negated = [
    'Caller did not ask for a representative.',
    'Caller did not request a representative.',
    'Caller never asked for a person.',
    "Caller didn't ask for a rep.",
    'Caller was not asking for the operator.',
  ];
  for (const n of negated) {
    it(`does NOT match: ${n}`, () => expect(asksForAPerson(n)).toBe(false));
  }

  /**
   * THE CASE THE SCOPING EXISTS FOR. A negation earlier in the narrative must
   * not swallow a real ask later in it — that is the grader's own three-times
   * mistake, and here it would cost a caller their transfer.
   */
  it('a negation does not suppress a real ask later in the same narrative', () => {
    expect(
      asksForAPerson('Caller did not ask for a representative, but later asked for the operator.'),
    ).toBe(true);
  });
});

describe('asking a person is not asking for one', () => {
  const spokeTo = [
    'Caller asked the representative, but they could not provide the status.',
    'Caller asked the office, and was told to call back.',
    'Caller asked the front desk.',
  ];
  for (const n of spokeTo) {
    it(`does NOT match: ${n}`, () => expect(asksForAPerson(n)).toBe(false));
  }

  /** `for` is mandatory only after `ask`; these three never take a person. */
  it('want, request and would like still need no "for"', () => {
    expect(asksForAPerson('Caller wants a representative.')).toBe(true);
    expect(asksForAPerson('Caller requested a live agent.')).toBe(true);
    expect(asksForAPerson('Caller would like an operator.')).toBe(true);
  });
});

/**
 * "LIVE REPRESENTATIVE." — A REAL CALLER, NOT A CONSTRUCTED ONE.
 *
 * `CA0cecc9296e`, 2026-09-14, 368 seconds. It is one of the 17 that ended
 * with no ticket, and it is from the number that rang SIX times that evening
 * — the caller whose last words on the line at 23:01 were "Why you sending me
 * to the same AI thing again? I need to talk to a human being."
 *
 * The line did not latch. Every verb branch needs a verb and there is none,
 * and `A_REAL_PERSON` — which exists precisely so a bare noun PHRASE can
 * count — listed only `live person`, `real person`, `actual person` and
 * `human being`. "Live representative" and "live agent" are the same
 * construction with a different head noun.
 *
 * WHY THE ADJECTIVE IS THE SAFETY PROPERTY HERE, and why this is not the
 * bare-noun widening the block below forbids. The measured danger on this
 * lane is the caller's own JOB TITLE — 23 of 24 `coordinator` mentions are
 * answers to "What is your role?". Nobody's job title is "live
 * representative": `live`, `real` and `actual` are words a caller reaches for
 * to say "not this machine", never words they use to introduce themselves.
 * That is a property of the construction, not of one day's sample.
 *
 * The verb requirement stands for every OTHER branch. This one narrow phrase
 * family is the exception `A_REAL_PERSON` already was; it is now the right
 * size.
 *
 * Found by `replay20260914.test.ts` — the point of that file.
 */
describe('a bare "live/real/actual <human>" is an ask, and nothing wider is', () => {
  const asks = [
    'Caller said: Live representative.',
    'Caller said: Live agent.',
    'Caller said: I want a real person.',
    'Caller said: Real representative.',
    'Caller said: Actual human.',
    'Caller said: Human being.',
  ];
  for (const n of asks) {
    it(`matches: ${n}`, () => expect(asksForAPerson(n)).toBe(true));
  }

  /**
   * The adjective is doing the work. Without it these are the job titles and
   * bare mentions the module refuses on measurement, and they stay refused.
   */
  const notAsks = [
    'Caller said: Representative.',
    'Caller said: Agent.',
    'Caller is the live events coordinator at a medical group.',
    'Caller asked for the live chat link.',
    'Caller mentioned a real problem with the referral.',
  ];
  for (const n of notAsks) {
    it(`does NOT match: ${n}`, () => expect(asksForAPerson(n)).toBe(false));
  }
});
