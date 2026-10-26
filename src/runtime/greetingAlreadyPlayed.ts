/**
 * TELL THE MODEL ITS GREETING HAS ALREADY BEEN SPOKEN — once, for every lane.
 *
 * WHAT HAPPENED
 *
 * 2026-09-03: 13 runtime calls have the practice's opening greeting in the
 * transcript TWICE or THREE times. Those calls averaged 175 seconds against a
 * fleet average of 89 — the caller waits through the whole opening again,
 * twice, before they can say what they rang about.
 *
 * Six of the seven triple-greeting calls are the same shape: the caller speaks
 * during or just after the opening and asks for another language ("Speak
 * Spanish", "No. Speak Spanish", "Adres yok mu?"), and the model answers by
 * reproducing its opening line.
 *
 * WHY THE EXISTING INSTRUCTION DID NOT STOP IT
 *
 * Every queue prompt already carries "Your greeting has already played. Do NOT
 * greet again" — INSIDE the pre-context recognition block, which is only built
 * when caller-ID matched a single person. Pre-context matched on ZERO of the
 * day's 143 substantive queue calls (si_persons holds 3,774 of 915,843
 * patients), so the line was never in a live prompt. It was true guidance
 * behind a branch that never fires.
 *
 * WHY IT LIVES HERE AND NOT IN THE FOUR PROMPTS
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. It is a property of THIS TRANSPORT, not of any lane. The runtime plays
 *    the greeting itself, before the model's first turn, on every call that
 *    has one. That makes the statement unconditionally true here and only
 *    conditionally true anywhere else.
 * 2. Prompt budget. Operator, 2026-09-03: *"grok requires minimal prompting,
 *    we should not be near our ceilings."* Tech sits at 1,584 tokens against a
 *    1,600 ceiling — sixteen tokens of headroom, and this line does not fit in
 *    four prompts. Appended by the runtime it is paid once, is impossible for
 *    a lane to forget, and cannot be trimmed away by someone shortening a
 *    prompt who does not know why it was there.
 *
 * A lane with NO greeting gets nothing appended: the model opens the call
 * itself there, and telling it otherwise would be false.
 */
export const GREETING_ALREADY_PLAYED =
  ' Your opening greeting has ALREADY been spoken to this caller before your ' +
  'first turn. Never say it again — not if they interrupted it, not if they ' +
  'answered in another language, not if you did not understand them. If you ' +
  'did not catch what they said, ask them to repeat it.';

export function withGreetingAlreadyPlayed(
  instructions: string,
  greeting: string | null,
): string {
  if (!greeting) return instructions;
  // Idempotent: a lane whose own prompt already says it does not need it twice,
  // and the recognition block still carries its own wording.
  if (instructions.includes('ALREADY been spoken')) return instructions;
  return instructions + GREETING_ALREADY_PLAYED;
}
