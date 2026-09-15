/**
 * THE CALLER CHOOSES: the live queue, or we take it here.
 *
 * Operator ruling, 2026-09-13:
 *
 *   "For anyone that requests to speak to a representative, that should trigger
 *    the warning... If they accept, we transfer them to the queue, if they want
 *    to continue, we create a ticket with all the information needed."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS AT ALL — the old warning could not be a choice.
 *
 * `BLIND_TRANSFER_WARNING` is spoken by the TwiML, AFTER `redirectCallerToQueue`
 * has already started and the Media Stream is gone. By the time the caller
 * hears a word of it the agent cannot hear a reply, so their only options are
 * wait or hang up. It is an announcement. Making it a decision point means
 * moving it into the agent's own turn, before anything is filed or dialled —
 * which is what this is.
 *
 * The TwiML line stays where it is. It is now a confirmation of a choice
 * already made rather than the first the caller hears of the wait.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TICKET IS NO LONGER WITHHELD — OPERATOR, 2026-09-15, REVERSING HIMSELF.
 *
 * The 09-13 ruling had a second half: *"We Will Not create tickets for anyone
 * that chooses to be transferred. if they drop off, their record is lost.
 * Their choice."* Asked on 09-15 whether to go back to Rosa's 09-08 design —
 * file the ticket anyway, with a status that does not claim a person was
 * reached — the answer was **"yes to the v14 reversal."**
 *
 * WHAT THAT COST WHILE IT STOOD, and why it is the right reversal. The
 * accepted arm became invisible in `tickets`, and `tickets.pcp_handoff_*` is
 * the only working PCP transfer instrument we have — CLAUDE.md says to measure
 * transfers from there and never from `call_logs`. So the arm the ruling
 * created could not be counted, and "the queue answers at 36%" — the very
 * number the ruling rests on — could not be re-measured on the callers it
 * applied to.
 *
 * ROSA'S REASON WAS NEVER ANSWERED, ONLY OUTVOTED: *"a ticket should be
 * created even when they are transferred and it should be searchable by phone
 * number."* A caller who gives up in hold music has no record anywhere, and
 * nobody knows to call them back.
 *
 * THE STATUS IS WHAT MAKES BOTH TRUE AT ONCE. `DIALING` with
 * `humanAnswerStatus = TRANSFERRED_TO_QUEUE` says exactly what happened: we
 * put them through and stopped being able to see. It is never `CONNECTED`, so
 * `humanHandoffOccurred` stays false and no staffer reads it as a
 * conversation that already happened — the one thing Rosa's ticket exists to
 * prevent, and the v20 rule this does not touch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE CHOICE STILL GOVERNS, AND IT IS NOT THE TICKET.
 *
 * Two behaviours keyed on "the caller chose the queue" are UNCHANGED, because
 * the operator reversed the filing rule and nothing else:
 *
 *   1. THE EMPTY ROUND. A caller who said yes is asked nothing further —
 *      *"they asked for a person, get them to a person"* (2026-09-13). The
 *      sentence immediately before has just told them what we have gathered
 *      does not carry over; asking for their name in the next breath
 *      contradicts the warning we made them listen to.
 *   2. THE SWEEP'S EXIT. Teardown does not file "CALLER HUNG UP BEFORE THE
 *      REQUEST WAS COMPLETE" behind somebody sitting in the queue where they
 *      asked to be.
 *
 * `suppressesTicket` used to answer all three questions with one boolean.
 * That is the welding this file has been bitten by before — `connectsToHuman`
 * reading `defaultDisposition` welded the LENGTH OF THE INTAKE to WHETHER WE
 * DIAL, and flipping one silently moved the other. So the function is GONE
 * rather than changed to return false: every call site has to be re-read, and
 * the two that remain now ask `choseTheQueue`, which names what it decides.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS MODULE REFUSES TO INFER: SILENCE IS NOT CONSENT.
 *
 * `accepted` is a tri-state on purpose. The model is asked to come back with
 * the caller's answer, and on this line it demonstrably does not always come
 * back — 42 of 75 date-of-birth refusals on 2026-09-08 were the LAST tool
 * event of their call.
 *
 * THE REVERSAL ABOVE CHANGED WHAT THE TRI-STATE PROTECTS, AND DID NOT MAKE IT
 * POINTLESS. It used to guard a lost request: a model that wandered off would
 * have had its silence read as yes, suppressing the ticket, and the request
 * would be gone with nothing anywhere. The ticket now files on every arm, so
 * that particular loss is closed by the filing rule rather than by this one.
 *
 * What is left is worse to get wrong, not better. An `accepted` reading is
 * what REDIRECTS THE CALLER — it ends the Media Stream, drops them into an
 * ACD that answers 36% of the time, and we let go of the leg. Reading silence
 * as consent would put a caller who never agreed into a hold queue we cannot
 * pull them back out of, and the ticket behind them would say
 * TRANSFERRED_TO_QUEUE about a transfer they did not ask for.
 *
 * So only an explicit yes reaches the queue. Anything else — no, unclear, or
 * the model simply not answering — keeps the caller with the agent. The
 * operator's "their choice" is about a caller who chose, not about one who was
 * never asked.
 */

/**
 * What the caller hears, in the operator's own content. Option B, chosen
 * 2026-09-13 — and RESHAPED 2026-09-15 without losing a clause of it.
 *
 * IT USED TO END IN AN EITHER/OR AND THE FIELD IS A BOOLEAN.
 * `readQueueChoice` takes `boolean | undefined`, so the answer this question
 * has to produce is yes or no. It asked the caller to pick between two VERB
 * PHRASES — "connect you" and "take it here" — and on CA02f7febc the caller
 * answered:
 *
 *   agent   [the 53-word warning, ending in the either/or]
 *   caller  "Me."
 *
 * That is the last line of the transcript, and NO TICKET OF ANY PROVENANCE
 * exists for that call. "Me." maps to neither option — it can be read as
 * "connect ME" or as "YOU take it, not me" — so `callerAcceptedQueue` could
 * not be filled honestly and the request went nowhere.
 *
 * RULE ZERO 2c in its purest form: the shape of the question did not match the
 * shape of the field. It now ends on ONE proposition, answerable yes or no.
 *
 * It was also 53 words before reaching the question, marked [interrupted] on
 * 8+ calls of 2026-09-14, and CA606bc754 answered it with "For how long am I
 * going to stay representative? The zero doesn't even have, they transferred
 * me here."
 *
 * EVERY CLAUSE THE OPERATOR APPROVED SURVIVES, in their own words down to
 * "transfers with you", which `queueIsAChoice.test.ts` already pins verbatim —
 * nothing carries over, we cannot promise a wait, we can take it here — and
 * `queueChoiceIsAnswerable.test.ts` pins each one separately so a later trim
 * cannot quietly drop one. Only the closing question changed.
 *
 * The tri-state is untouched: silence is still not consent.
 */
export const QUEUE_CHOICE_WARNING =
  "Of course. Before I put you through — nothing we've gone over transfers " +
  "with you, and I can't tell you how long the wait will be. I can take it from " +
  'here instead and get it straight to the team. Would you still like me to ' +
  'put you through?';

export type QueueChoice = 'accepted' | 'declined' | 'not_established';

/**
 * Read the model's answer without letting an absent one mean yes.
 *
 * `true` is the only path to the queue. `false` is a decline. `undefined` is
 * the model returning without the answer, which is neither.
 */
export function readQueueChoice(callerAcceptedQueue: boolean | undefined): QueueChoice {
  if (callerAcceptedQueue === true) return 'accepted';
  if (callerAcceptedQueue === false) return 'declined';
  return 'not_established';
}

/**
 * Whether the caller chose the live queue over having us take it here.
 *
 * This decides what is ASKED and what TEARDOWN does — never whether a ticket
 * is filed. See the reversal note at the top of this file: since 2026-09-15
 * the ticket files on every arm, and a call site reaching for this to skip a
 * write is reintroducing the rule the operator withdrew.
 */
export function choseTheQueue(choice: QueueChoice): boolean {
  return choice === 'accepted';
}
