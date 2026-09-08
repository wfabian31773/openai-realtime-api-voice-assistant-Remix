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
 * Nothing is added beyond what one of the two original branches already had,
 * plus nothing — widening the grant is a policy change, and this is a
 * consistency fix.
 */
const HUMAN_NOUNS =
  '(?:person|human|someone|somebody|rep|representative|agent|front desk|receptionist|office|team)';

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

/** Naming a human without a verb: "I want a real person." */
const A_REAL_PERSON = /\b(?:live person|real person|actual person|human being)\b/i;

/**
 * True when the narrative records an explicit request to be put through.
 *
 * Exported so the rule has one home and one test file. It is read by
 * `handoff_to_pcp`; the director's `eligibleByAsk` reads the flag this sets.
 */
export function asksForAPerson(narrative: string): boolean {
  return SPEAK_TO.test(narrative) || CONNECT_TO.test(narrative) || A_REAL_PERSON.test(narrative);
}
