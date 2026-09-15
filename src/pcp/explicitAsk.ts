/**
 * DID THE CALLER ASK TO BE PUT THROUGH TO A PERSON?
 *
 * This one boolean decides more than it looks. When it is true:
 *
 *   - the director grants HAND_OFF whatever the purpose (`eligibleByAsk`),
 *     with no field requirements at all — the operator's 2026-08-14 directive,
 *     "the staffer who picks up collects what they need";
 *   - `handoff_to_pcp` stops requiring a recorded `callPurpose` first;
 *   - the ticket payload carries `dispositionGrantedByExplicitAsk`, which is
 *     what tells the ticketing app this HAND_OFF is sanctioned rather than
 *     invented (its absence is what killed 19 of 19 transfers to 2026-09-08).
 *
 * So a phrase this misses is a transfer that does not happen, a purpose gate
 * that fires instead, and a ticket that files without the sanction field.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT MISSED THE OPERATOR'S OWN OPENING LINE, and this module exists because
 * of how that was found.
 *
 * CAa2a3a1c1, 2026-09-08 12:28. His first words were:
 *
 *     "Hi, can I speak to the, can I speak to the team please?"
 *
 * There were two regexes. The `speak|talk` one listed person, human, someone,
 * somebody, rep, representative, agent, front desk, receptionist — no `team`.
 * The `connect|transfer|get me` one DID list `team` and `office`. So "speak to
 * the team" matched neither, and "speak with the office" did not either: the
 * noun sets had silently drifted apart between two lines that were written to
 * do the same job.
 *
 * The commit that shipped "transfer on the first ask, not the third" therefore
 * did not fire for the very utterance that motivated it.
 *
 * HOW IT WAS MISSED, which is the part worth keeping. An hour earlier a test
 * of mine used the narrative "Caller asked for a representative", it failed to
 * match, and I fixed THE TEST — without once asking whether the phrase from
 * the actual call matched. Codex asked (P1, PR #273), and reproduced it in one
 * line of node. Two near-identical lists are an invitation to check one and
 * assume the other.
 *
 * Hence: ONE noun list, shared. The verbs differ because they genuinely do;
 * the nouns cannot drift again because there is only one copy of them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELIBERATELY STILL NARROW. Review, 2026-08-09: "a caller from the front desk
 * asking about a referral" is not a request to be transferred, and dialling
 * the queue on it would be worse than the bug being fixed. So this matches an
 * ASK — a verb of connection aimed at a noun that means a human — and never a
 * mere mention of one.
 *
 * WHAT IT READS IS THE MODEL'S NARRATIVE, not the caller's audio. The model
 * summarises the call into `narrative`, so this is a backstop on that summary
 * rather than speech recognition. That is why the noun list tracks the words
 * the PROMPT promises to honour: those are the words the model is told the
 * caller may use, so they are the words it will write down.
 */

/**
 * Nouns that mean "a human being at Azul Vision".
 *
 * `office` and `team` are here because callers say them and the prompt
 * promises them; a person who asks for "the team" is asking for a person.
 *
 * `operator` was added 2026-09-15 and it is the only word ever added that was
 * not already in one of the two original branches, so it was measured first.
 * Over the 170 substantive PCP calls of 2026-09-14, on the callers' own lines:
 *
 *     operator      6 occurrences — 6 asks, 0 role statements
 *     coordinator  24 occurrences — 1 ask, 23 ROLE STATEMENTS
 *     supervisor    3 occurrences — 1 ask, 2 role statements
 *
 * `coordinator` and `supervisor` are NOT added, and the honest reason is
 * narrower than it first looks. "Outreach coordinator." (x7), "Referral
 * coordinator." (x6), "Coordinator." (x5) are answers to "What is your role?"
 * — the caller's own job title, and the #99 shape, where `'surgery center'`
 * matched a caller's EMPLOYER and misrouted their ticket to department 2.
 *
 * BUT THEY WOULD NOT ACTUALLY MISFIRE HERE, and the claim that they would was
 * caught by mutation testing before it shipped: adding `coordinator` to this
 * list fails NO test, because every one of those 23 lines is a bare noun and
 * all three branches require a verb. The verb requirement, not the noun list,
 * is what keeps a job title out of a phone dial.
 *
 * So the refusal rests on what it can actually claim. The benefit is ONE call
 * in 170. The cost is latent rather than live: these two words are, on the
 * measured evidence, overwhelmingly job titles on this line, so they are the
 * first things to misfire if this module is ever widened toward bare nouns —
 * and the grant behind it is a real dial into a queue staffed by three or four
 * people. Widening the grant is a policy change and the operator's to make;
 * this is a consistency fix plus one measured word.
 *
 * `operator` is safe for a reason that is a property of the word rather than
 * of one day's sample: nobody introduces themselves as "the operator" to an
 * answering line. It is a role you ask FOR, never one you claim.
 */
const HUMAN_NOUNS =
  '(?:person|human|someone|somebody|rep|representative|agent|front desk|receptionist|office|team|operator)';

/** Asking to be connected: "can I speak to the team", "talk with someone". */
const SPEAK_TO = new RegExp(`\\b(?:speak|talk)\\b\\s+(?:to|with)\\b[^.]{0,25}\\b${HUMAN_NOUNS}\\b`, 'i');

/**
 * Asking to be moved: "put me through to the office", "get me a rep",
 * "asked to be connected to the office".
 *
 * THE VERBS ARE WRITTEN FOR A SUMMARY, NOT FOR SPEECH — and that was a second
 * bug in the same line, found by this module's own test rather than in review.
 * `narrative` is what the MODEL writes ABOUT the caller, so it comes out in the
 * third person and the past tense:
 *
 *     "Caller asked us to put them through to a representative."   <- missed
 *     "Caller asked to be connected to the office."                <- missed
 *
 * The original list held `put me through`, `put me`, `get me` and a bare
 * `connect`, all of them first-person present — the words a CALLER says. The
 * model never says them, and `\bconnect\b` does not match "connected".
 *
 * `transfer` is deliberately NOT inflected. "Transferred to" routinely narrates
 * something that already happened to a record or a patient — "records were
 * transferred to the office", "her care was transferred" — and this field sits
 * upstream of a real phone dial into a queue staffed by three or four people.
 * Bare `transfer` was already here and stays; adding "transferred" would buy a
 * rare phrasing at the cost of a class of false dials.
 */
const CONNECT_TO = new RegExp(
  '\\b(?:connect(?:ed|ing)?|transfer|put\\s+(?:me|them|us|him|her)\\s+through|put\\s+(?:me|them|us|him|her)|get\\s+(?:me|them|us))\\b' +
    `[^.]{0,25}\\b${HUMAN_NOUNS}\\b`,
  'i',
);

/**
 * ASKING FOR ONE, WITHOUT A VERB OF CONNECTION.
 *
 * "Caller asked for a representative." — the plainest narration of the whole
 * rule — matched NEITHER existing branch, because both require a verb of
 * connection (`speak|talk to/with`, or `connect|transfer|put through|get me`)
 * and "asked FOR" is neither.
 *
 * This module's own header records that exact phrase failing a test on
 * 2026-09-08, and records the author fixing THE TEST instead of the code. It
 * was never fixed. On 2026-09-14 it cost a VP of Partnerships at a surgery
 * centre his transfer: he asked three ways across one 86-second call and the
 * flag never latched, so the director refused a caller the operator's own
 * 2026-09-04 rule entitles to a person — an entity who asked.
 *
 * THE PHRASE BOUNDARY IS THE SAFETY PROPERTY, and it is there because `office`
 * and `team` can OWN things. Under a bare `for ... <noun>` these would all
 * become dials into a queue staffed by three or four people:
 *
 *     "Caller asked for the office fax number."       <- rejected: " fax"
 *     "Caller asked for the team's direct line."      <- rejected: "'s"
 *     "Caller asked for the representative case
 *      number they were given."                       <- rejected: " case"
 *
 * So the noun must END the phrase — punctuation or end of string.
 *
 * `FOR` IS MANDATORY AFTER `ASK` AND OPTIONAL AFTER THE OTHERS, because `ask`
 * is the one verb here that takes a PERSON as its direct object (Codex P2,
 * #301). It was optional for all four, so:
 *
 *     "Caller asked the representative, but they could
 *      not provide the status."                       <- matched, and should
 *                                                        not: that caller SPOKE
 *                                                        to somebody
 *     "Caller asked the office, and was told to
 *      call back."                                    <- same shape
 *
 * `want`, `request` and `would like` have no such reading — nobody "wants a
 * representative" in the sense of addressing one — so they keep the optional
 * `for` and "Caller wants a representative." still matches with none.
 *
 * THE NOUN LIST IS NOT SPLIT to achieve any of that, however tempting. One
 * shared list is the entire point of this module: two near-identical lists is
 * what let `team` drift out of one branch and cost the operator his own
 * transfer on CAa2a3a1c1. The boundary and the `for` rule are properties of
 * this BRANCH; the nouns stay common to all three.
 */
const ASKED_FOR = new RegExp(
  '\\b(?:' +
    // forms of `ask` REQUIRE `for` — "asked for a rep", never "asked the rep"
    'ask(?:ed|s|ing)?(?:\\s+(?:us|me|them|him|her))?\\s+for' +
    '|' +
    // these three take no person as an object, so `for` stays optional
    '(?:request(?:ed|s|ing)?|want(?:s|ed)?|would\\s+like)(?:\\s+(?:us|me|them|him|her))?(?:\\s+for)?' +
    ')' +
    '\\s+(?:a|an|the|another|your|our)?\\s*' +
    '(?:live|real|actual|human)?\\s*' +
    HUMAN_NOUNS +
    '(?=\\s*[.,;!?]|\\s*$)',
  'ig',
);

/**
 * A NEGATED ASK IS NOT AN ASK — and the SCOPE of this check is the design.
 *
 * "Caller did not ask for a representative." matched the branch above, which
 * reads the verb and never looks at what sits in front of it (Codex P2, #301).
 *
 * The obvious fix — test the whole narrative for a negation and refuse if one
 * is found — is a mistake this codebase has already made THREE TIMES in one
 * check. CLAUDE.md records the grader's `connect you` rule being written and
 * rewritten because a narrative-wide negation suppressed the affirmative half
 * of "I can't transfer you, BUT I can connect you with the team", so real
 * broken promises graded as passes. Pointed this way it would be worse: it
 * would drop a real ask and cost a caller their transfer.
 *
 * So this is anchored with `$` and tested ONLY against the text immediately
 * preceding a match — the negator has to govern the verb that actually
 * matched, with nothing but an adverb allowed in between. Every match in the
 * narrative is examined separately, so a negation in one clause cannot reach
 * an ask in the next.
 *
 * `n't` carries no leading `\b` on purpose: there is no word boundary inside
 * "didn't", so `\bn't` would never fire and every contraction would slip past.
 */
const NEGATOR_IMMEDIATELY_BEFORE = /(?:\bnot|n't|\bnever|\bno)\s+(?:\w+ly\s+)?$/i;

/** True when at least one ask-for match is not governed by a negation. */
function asksForOneUnnegated(narrative: string): boolean {
  for (const m of narrative.matchAll(ASKED_FOR)) {
    if (!NEGATOR_IMMEDIATELY_BEFORE.test(narrative.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * NAMING A HUMAN WITHOUT A VERB — the one exception to the verb requirement,
 * and the adjective is what earns it.
 *
 * It read `live person|real person|actual person|human being`, which missed
 * `CA0cecc9296e` of 2026-09-14: a 368-second call, one of the 17 that left no
 * ticket, from the number that rang SIX times that evening. The line was
 * "Live representative." — the same construction as "live person" with a
 * different head noun, and nothing in this module caught it. Found by
 * `replay20260914.test.ts`.
 *
 * `live`, `real` and `actual` are the disambiguator, not the noun. They are
 * what a caller reaches for to say "not this machine"; nobody introduces
 * themselves with one. That matters because the measured danger on this lane
 * is the caller's own JOB TITLE — 23 of 24 `coordinator` mentions are answers
 * to "What is your role?" — and "live representative" is not a job title in
 * any organisation. So this widens the phrase family and NOT the bare-noun
 * rule: "Representative." alone is still not an ask, and a describe block in
 * the test file fails if that ever changes.
 *
 * `human being` keeps its own alternative because `being` is not in the noun
 * list and never should be.
 */
const A_REAL_PERSON =
  /\b(?:(?:live|real|actual)\s+(?:person|human|representative|rep|agent|operator)|human being)\b/i;

/**
 * True when the narrative records an explicit request to be put through.
 *
 * Exported so the rule has one home and one test file. It is read by
 * `handoff_to_pcp`; the director's `eligibleByAsk` reads the flag this sets.
 */
export function asksForAPerson(narrative: string): boolean {
  return (
    SPEAK_TO.test(narrative) ||
    CONNECT_TO.test(narrative) ||
    asksForOneUnnegated(narrative) ||
    A_REAL_PERSON.test(narrative)
  );
}
