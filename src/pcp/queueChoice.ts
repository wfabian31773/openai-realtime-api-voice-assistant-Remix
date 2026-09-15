/**
 * THE CALLER CHOOSES: the live queue, or we take it here.
 *
 * Operator ruling, 2026-09-13, replacing the announcement Rosa's design shipped
 * on 09-08:
 *
 *   "For anyone that requests to speak to a representative, that should trigger
 *    the warning... We Will Not create tickets for anyone that chooses to be
 *    transferred. if they drop off, their record is lost. Their choice. If they
 *    accept, we transfer them to the queue, if they want to continue, we create
 *    a ticket with all the information needed."
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
 * WHY THE TICKET IS WITHHELD, AND WHAT THAT OVERRIDES.
 *
 * Rosa's design, approved 2026-09-08, said the opposite: *"a ticket should be
 * created even when they are transferred and it should be searchable by phone
 * number."* The operator overrode it on 09-13 with the reason on the record —
 * the live queue answers at 36% and nobody works the voicemails, so a ticket
 * filed behind a transfer is a record nobody reads. A caller who chooses the
 * queue is choosing the queue.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS MODULE REFUSES TO INFER: SILENCE IS NOT CONSENT.
 *
 * `accepted` is a tri-state on purpose. The model is asked to come back with
 * the caller's answer, and on this line it demonstrably does not always come
 * back — 42 of 75 date-of-birth refusals on 2026-09-08 were the LAST tool
 * event of their call. If "no answer yet" collapsed into "accepted", a model
 * that wandered off would suppress the ticket AND never dial, and the request
 * would be gone with nothing anywhere.
 *
 * So only an explicit yes suppresses the ticket. Anything else — no, unclear,
 * or the model simply not answering — files. Filing is the recoverable
 * outcome; a lost request is not, and the operator's "their choice" is about a
 * caller who chose, not about one who was never asked.
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

/** Whether this outcome means we hand them over and file nothing. */
export function suppressesTicket(choice: QueueChoice): boolean {
  return choice === 'accepted';
}
