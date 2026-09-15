/**
 * "Would you like me to connect you, or take it here?" — "Me."
 *
 * CA02f7febc, 2026-09-14, 124 seconds. The whole call:
 *
 *   agent   "Thank you for calling Azul Vision PCP Support. How can I help
 *            you today?"
 *   caller  "Representative?"
 *   agent   [the 53-word queue-choice warning, ending in the either/or]
 *   caller  "Me."
 *
 * That is the end of the transcript. **No ticket of any provenance exists for
 * that call SID.** The caller answered, and left with nothing.
 *
 * "Me." maps to neither option. The question offers two VERB PHRASES —
 * "connect you" and "take it here" — and the caller replied with a pronoun
 * that could plausibly mean either ("connect ME" or "YOU take it, not me").
 * There is no reading of that answer the model can be confident in, so
 * `callerAcceptedQueue` cannot be filled honestly, and the tri-state's
 * `not_established` branch is the only correct one.
 *
 * ── THE FIELD IS A BOOLEAN AND THE QUESTION WAS NOT ──
 *
 * `readQueueChoice(callerAcceptedQueue: boolean | undefined)`. The answer this
 * question has to produce is YES or NO. It asked an either/or between two
 * paraphrases, which is the RULE ZERO 2c defect in its purest form: the shape
 * of the question did not match the shape of the field.
 *
 * It also ran 53 words before reaching the question and was marked
 * [interrupted] on 8+ calls, and CA606bc754 answered it with "For how long am
 * I going to stay representative? The zero doesn't even have, they transferred
 * me here."
 *
 * ── WHAT IS PRESERVED, AND THIS IS THE POINT ──
 *
 * Every piece of content the operator approved on 2026-09-13 stays, and the
 * tests below pin each one individually so a future trim cannot quietly drop
 * one:
 *
 *   - nothing gathered so far carries over with them
 *   - we cannot say how long the wait will be
 *   - we can take it here instead
 *
 * Only the SHAPE changes: it now ends in a yes/no question, so the answer
 * arrives in the form `callerAcceptedQueue` actually takes.
 *
 * ── WHAT IS NOT TOUCHED ──
 *
 * The tri-state. Silence is still not consent, and only an explicit yes
 * suppresses the ticket — that is the property protecting a caller whose
 * model wanders off, and `queueIsAChoice.test.ts` owns it.
 */
import { describe, it, expect } from 'vitest';
import { QUEUE_CHOICE_WARNING, readQueueChoice } from './queueChoice';

describe('the question matches the field it fills', () => {
  it('ends in a yes/no question, not an either/or', () => {
    expect(QUEUE_CHOICE_WARNING).toMatch(/\?$/);
    expect(
      QUEUE_CHOICE_WARNING,
      'an either/or between two verb phrases is what produced "Me."',
    ).not.toMatch(/connect you,? or take it here/i);
    expect(QUEUE_CHOICE_WARNING).not.toMatch(/\bor take it here\?/i);
  });

  /** A yes/no question ends on a single proposition. The last clause must not
   *  offer a second one for the caller to pick between. */
  it('offers one proposition in the closing question', () => {
    const closing = QUEUE_CHOICE_WARNING.split(/(?<=\.)\s+/).pop() ?? '';
    expect(closing).toMatch(/\?$/);
    expect(closing, `closing clause still branches: ${closing}`).not.toMatch(/\bor\b/i);
  });

  it('the field it fills is a boolean tri-state, unchanged', () => {
    expect(readQueueChoice(true)).toBe('accepted');
    expect(readQueueChoice(false)).toBe('declined');
    expect(readQueueChoice(undefined)).toBe('not_established');
  });
});

describe("the operator's content survives, clause by clause", () => {
  it('still says nothing gathered carries over', () => {
    expect(QUEUE_CHOICE_WARNING).toMatch(/(goes|transfers|carries) with you/i);
  });
  it('still says we cannot promise a wait time', () => {
    expect(QUEUE_CHOICE_WARNING).toMatch(/how long the wait/i);
  });
  it('still offers to take it here instead', () => {
    expect(QUEUE_CHOICE_WARNING).toMatch(/take (it|this) from here|take it here/i);
  });
  /** #265 — never speculate about who is available or when. */
  it('still speculates about nobody', () => {
    expect(QUEUE_CHOICE_WARNING).not.toMatch(/busy|shortly|as soon as|available/i);
  });
});

describe('it is shorter than the thing that got talked over', () => {
  /** 53 words before the question, [interrupted] on 8+ calls of 2026-09-14. */
  it('comes in under the 53 words that were being interrupted', () => {
    const words = QUEUE_CHOICE_WARNING.trim().split(/\s+/).length;
    expect(words, `still ${words} words`).toBeLessThan(53);
  });
});
