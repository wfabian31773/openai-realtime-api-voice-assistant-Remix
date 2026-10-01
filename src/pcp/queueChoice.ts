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
 * THE TICKET IS WITHHELD — 2026-09-13, reversed 09-15, RESTORED 2026-10-01.
 *
 * Operator, 2026-10-01:
 *
 *   "if the caller chooses to go into the queue, do not create the ticket. i
 *    know that may differ from the record but update the md and let's get this
 *    squared away, if you choose the queue, we dont generate a ticket. As long
 *    as we are explaining this on the call as we should, we should be fine."
 *
 * THE EXPLANATION IS ALREADY ON THE CALL: `QUEUE_CHOICE_WARNING` below tells
 * the caller "nothing we've gone over transfers with you" before they choose,
 * and it was written for the 09-13 no-ticket rule and never changed. The
 * prompt never changed either ("Yes means the queue, no ticket and nothing
 * kept"). From 09-15 to 10-01 the CODE filed anyway, at DIALING — so this is
 * the code moving back into line with the words the caller hears.
 *
 * THE HISTORY, because it flipped twice and the next reader will ask: 09-13
 * no ticket (the queue answers at 36% and nobody works the voicemails); 09-15
 * "yes to the v14 reversal", Rosa's file-it-anyway design, at DIALING so no
 * staffer reads it as a conversation; 10-01 no ticket again. What the 09-15
 * reversal bought — the accepted arm countable in `tickets.pcp_handoff_*` — is
 * given back: count accepted transfers from `call_logs.runtime_outcome =
 * 'transferred'` on the pcp lane, never from tickets, where they now read as
 * a fall.
 *
 * ONE CASE STILL FILES, AND IT IS NOT AN EXCEPTION TO THE RULING. A queue that
 * never picks up is answered with "I have your request recorded and the team
 * will follow up" on a leg the agent no longer holds; a ticket is filed then
 * so that sentence is true. A caller who hangs up while it rings files
 * nothing — "if they drop off, their record is lost, their choice" (09-13).
 * See `queueChoiceOwesATicket` in queueDialSettlement.ts.
 *
 * AND THE REDIRECT'S OWN SENTENCE CHANGES WITH IT: the approved TwiML line
 * ends "I've taken your details down", which is false with nothing filed, so
 * the transport drops that clause for this caller (`requestOnRecord: false`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE CHOICE GOVERNS — THREE THINGS, NAMED AT THEIR OWN SITES.
 *
 *   1. THE EMPTY ROUND. A caller who said yes is asked nothing further —
 *      *"they asked for a person, get them to a person"* (2026-09-13). The
 *      sentence immediately before has just told them what we have gathered
 *      does not carry over; asking for their name in the next breath
 *      contradicts the warning we made them listen to.
 *   2. THE SWEEP'S EXIT. Teardown does not file "CALLER HUNG UP BEFORE THE
 *      REQUEST WAS COMPLETE" behind somebody sitting in the queue where they
 *      asked to be.
 *   3. THE FILING. No pre-dial write, no post-dial write, and a settle
 *      callback that files only when the queue never picks up.
 *
 * `suppressesTicket` used to answer all three with one boolean, and that is
 * the welding this file has been bitten by before — `connectsToHuman` reading
 * `defaultDisposition` welded the LENGTH OF THE INTAKE to WHETHER WE DIAL. So
 * each consequence reads `choseTheQueue` at its own site: the ruling ties them
 * together today, and a future one that splits them has three places to
 * change rather than one boolean to untangle.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS MODULE REFUSES TO INFER: SILENCE IS NOT CONSENT.
 *
 * `accepted` is a tri-state on purpose. The model is asked to come back with
 * the caller's answer, and on this line it demonstrably does not always come
 * back — 42 of 75 date-of-birth refusals on 2026-09-08 were the LAST tool
 * event of their call.
 *
 * WHAT THE TRI-STATE PROTECTS, under the 2026-10-01 rule, is two things. An
 * `accepted` reading suppresses the ticket again — so silence read as yes
 * would lose a request with nothing written anywhere — and it REDIRECTS THE
 * CALLER, which cannot be taken back.
 *
 * The redirect is the worse of the two to get wrong. An `accepted` reading is
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
 * Since 2026-10-01 this decides what is ASKED, what TEARDOWN does, AND whether
 * a ticket is filed — the operator's ruling ties all three to the one choice.
 * See the note at the top of this file for the history and the one case that
 * still files.
 */
export function choseTheQueue(choice: QueueChoice): boolean {
  return choice === 'accepted';
}
