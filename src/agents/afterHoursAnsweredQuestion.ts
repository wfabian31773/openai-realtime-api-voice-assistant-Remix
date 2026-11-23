/**
 * v267: an after-hours call is "answered" only when nothing is owed.
 *
 * `record_answered_question` tells the after-hours teardown floor that the
 * caller needs nothing more (`answeredWithoutTicket`), so the floor files no
 * ticket. On 6 no-ivr calls of 2026-11-08..22 the agent told the caller the
 * team would follow up, or the caller said yes to an offer to pass something
 * along, or the caller asked to move an appointment, and the agent then
 * recorded the call as answered: no ticket filed, and the floor skipped the
 * call because of that record.
 *
 * The tool now asks the model whether anything is left for staff
 * (`follow_up_owed`, required on the wire; standing instruction 3: the read
 * is the model's, not a phrase list over the transcript). A yes is refused:
 * nothing is recorded as answered, the model is told to file, and the
 * refusal stays on the timeline, so `answeredWithoutTicket` no longer reads
 * the call as answered and the floor files it if the caller hangs up first.
 * An omitted answer records the call as answered, as before.
 */

export const FOLLOW_UP_OWED_DESCRIPTION =
  'true when anything is left for staff: you said someone will call, text, follow up or pass on a message; the caller said yes to such an offer; or they asked for something you cannot do on this call (book, move or cancel an appointment, a refill, a message). false only when every request was answered and nothing was promised.';

export const FOLLOW_UP_OWED_FIX =
  'Something is still owed to the caller, so this call is not answered. Call create_ticket now with what they asked for and the follow-up they were promised; do not ask again for anything you already have. Never tell the caller to call back.';

export function answeredQuestionResult(followUpOwed: boolean | undefined): Record<string, unknown> {
  if (followUpOwed === true) {
    return { success: false, ticketCreated: false, refused: 'follow_up_owed', fix: FOLLOW_UP_OWED_FIX };
  }
  return { success: true, ticketCreated: false, callbackRequired: false };
}
