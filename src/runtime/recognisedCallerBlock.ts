/**
 * WHAT TO TELL THE MODEL WHEN CALLER-ID ALREADY IDENTIFIED THIS PERSON.
 *
 * ONE COPY, OWNED BY THE RUNTIME. Operator, 2026-09-15:
 *
 *   "If the drifting continues then it undoes the runtime, which was the whole
 *    purpose — the things that are applicable to any conversation should be in
 *    the runtime; things applicable to that agent itself should be in the
 *    prompt."
 *
 * Caller recognition is applicable to any conversation. It was written four
 * times instead — inline in `opticalAgent`, `surgeryAgent`, `techAgent` and
 * `recordsAgent` — and the four copies drifted into a CONTRADICTION that cost
 * real callers a repeated question.
 *
 * ## The drift, and what it cost
 *
 * `personaliseGreeting` (greetingPersonalisation.ts:147) replaces the
 * greeting's closing question with "Am I speaking with <name>?" for every
 * `append`-style lane — which is all four of these. **The greeting asks it.**
 *
 * Two lanes said so. Two said the opposite:
 *
 *   tech, records   "Your greeting has already ASKED ... do NOT ask it twice."
 *   optical, surgery "Your greeting has already played ... Go straight to
 *                     confirming: 'Am I speaking with <name>?'"
 *
 * Measured over 2026-09-14/15, substantive runtime calls whose transcript
 * contains the phrase — the lane wording is the only variable:
 *
 *   | lane    | wording | calls | asked TWICE |
 *   |---------|---------|-------|-------------|
 *   | optical | wrong   |    76 |   7 (9.2%)  |
 *   | surgery | wrong   |    85 |   3 (3.5%)  |
 *   | tech    | right   |   142 |   0         |
 *
 * Zero on the lane worded correctly. That is the cost of a duplicated block,
 * and it is why this one lives here and is imported rather than pasted.
 *
 * ## The rule this states, and why it is not the old one
 *
 * The old block said: *"A first name is not verification. Ask for the last name
 * in their own words, and still collect the date of birth."* The INTENT is
 * RULE ZERO step 2 — validate before trusting a phone match — but the
 * implementation inverted the outcome. The caller's spoken surname was
 * evaluated by `verifiedDobFor`'s name guard, which treats ANY textual
 * difference as "wrong person": an accent, a compound surname, a mis-hearing.
 * A confirmation mechanism became a rejection mechanism, and the patient lost
 * a date of birth we were already holding.
 *
 * Measured on the 30 certain-phone date-of-birth refusals of 2026-09-14
 * (`src/tools/dobNameMismatch.test.ts`, the corpus): 24 were greeted by name,
 * **19 of those were then asked for their last name anyway**, and 27 of 30
 * were asked for both name and date of birth.
 *
 * **The affirmation IS the validation.** Over the same period 228 callers
 * answered the greeting's question affirmatively and 13 denied it — the check
 * works, and it is not "a first name", it is an answer to a direct question.
 * So an affirmed greeting ends the identity step. A denial still self-destructs
 * the block exactly as before; that half was always right.
 */

export interface RecognisedCaller {
  matched?: boolean;
  firstName?: string;
}

/**
 * The block, or an empty string when caller-ID vouched for nobody.
 *
 * Deliberately returns '' rather than a "we don't know you" block: a prompt
 * that tells the model what it does NOT have is a prompt that invites it to
 * say so out loud.
 */
export function recognisedCallerBlock(pc: RecognisedCaller | undefined): string {
  if (!pc?.matched || !pc.firstName) return '';
  const name = pc.firstName;
  return `
### You already know who this probably is
This number matches one person on file: first name "${name}".

- Your greeting has already ASKED "Am I speaking with ${name}?". Do NOT greet
  again and do NOT ask it twice. Take their answer and move on.
- NEVER open with "can I get your name and date of birth" when you have a
  match. Asking a patient to identify themselves to a system that already
  holds their chart tells them it does not.
- If they said YES, the identity step is DONE. Do not ask for their last name
  and do not ask for their date of birth — we hold both.
- If they said NO, or gave a different name, this number matched the WRONG
  person. Use what THEY said and ignore this block from then on.
- Do not say we recognised their number, and do not speak a last name first.
- Disclose nothing from anyone's record on the strength of this match.
`;
}

/**
 * The lanes that compose their prompt from this block, and the module each
 * one lives in.
 *
 * Exported so the drift guard can walk it rather than carrying its own list —
 * a second list is the `explicitAsk.ts` noun-list shape, which is what let
 * `team` drift and cost the operator his own transfer on `CAa2a3a1c1`.
 *
 * BOTH fields are load-bearing, and they guard different halves:
 *
 *   `module`  the guard reads that source file and fails if the block was
 *             pasted back inline, or if the import was dropped.
 *   `slug`    the guard runs `personaliseGreeting` for that lane and fails if
 *             the greeting stops asking "Am I speaking with <name>?" — which
 *             is the sentence this block's first bullet asserts as FACT. A
 *             lane whose greeting no longer asks it would have the block
 *             telling the model not to ask a question nobody asked.
 */
export interface RecognitionBlockLane {
  slug: string;
  module: string;
}

export const RECOGNITION_BLOCK_LANES: ReadonlyArray<RecognitionBlockLane> = [
  { slug: 'optical', module: 'opticalAgent' },
  { slug: 'surgery', module: 'surgeryAgent' },
  { slug: 'tech', module: 'techAgent' },
  { slug: 'records', module: 'recordsAgent' },
];
