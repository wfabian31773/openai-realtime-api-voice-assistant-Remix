/**
 * WAS THE CALLER TOLD THEIR REQUEST IS RECORDED?
 *
 * Operator, 2026-10-19, approving the exemption to that morning's ruling
 * ("any caller that hangs up will not get their ticket submitted, plain and
 * simple"): *"yes, build the readback exemption for the hang-up withdrawal."*
 *
 * The hang-up withdrawal (v100) asks the ticketing app to close and archive
 * every ticket on the call that names no patient. On its first afternoon and
 * evening it withdrew 12 tickets at a hang-up, and on 7 of them the caller had
 * already been told the request was recorded. For example:
 *
 *   - CA50d11c65cda76504450e4a94e1fed2a9: "I've logged your request on ticket
 *     PCP-…. Is there anything else I can help you with?", then the caller
 *     hung up, which is how a finished call ends;
 *   - CA7aafe2bd35a016c34fb9620f4517d271, CA7122a5500e2219b618bde2f07a2824eb:
 *     the refused transfer's own line, "I've taken this down and the right
 *     team will follow up with you", then the caller hung up;
 *   - CAb651aef19a2763e3d2cb61e8d95cf5ef: the same line, then the caller hung
 *     up on the follow-up email question.
 *
 * The whole day is the corpus in toldItWasRecorded.test.ts.
 *
 * Each of those callers was promised a follow-up, and the withdrawal removed
 * the only record of it — the v18 shape, a caller told their request is filed
 * whose request does not exist. So the withdrawal now stands aside when the
 * agent has said either of the two things the operator named:
 *
 *   1. A TICKET NUMBER THIS CALL FILED, in any rendering. grok-voice-3.0 —
 *      every lane from v101 — spells numbers out: on tech's 3.0 canary days
 *      (10-17..19) the readback was "V-A-seven-three-six-zero-one" on calls
 *      where the literal number appears nowhere in the transcript. So the line
 *      is folded first: digit words become digits and everything that is not a
 *      letter or a digit goes, which turns "P-C-P seven three six seven nine",
 *      "PCP-73679" and "P C P 7 3 6 7 9" into the same "pcp73679". THE
 *      PREFIX IS PART OF THE MATCH, not only the digits (Codex P2, #355): the
 *      fold runs separate numbers together, so a callback number, a ZIP code
 *      or "suite 736, 79" can carry a ticket's five digits in a line that read
 *      out no ticket at all. Measured before choosing it, every filed call on
 *      optical, surgery, tech, records and pcp from 2026-10-13 to 10-20:
 *      1,813 read their number aloud, on 2.0 and 3.0 alike, and the prefix
 *      sat directly in front of the digits on all 1,813 — 0 read the digits
 *      without it. Only a number filed on THIS call counts — a number read
 *      from an older ticket is not this request.
 *   2. THE REFUSED TRANSFER'S OWN CLAIM, "taken this down" — the
 *      `handoff_not_eligible_task_created` line in refusals.ts, which is only
 *      reached once the fallback filing has succeeded. Its failure sibling
 *      makes no claim and does not count; a test holds both to this function.
 *
 * NOTHING ELSE COUNTS, DELIBERATELY. A model paraphrase ("the ticket's in,
 * you're all set") is a claim too, but a list of paraphrases is the hand-
 * written cue surface that cost twelve P1s on #293, and a phrase this misses
 * leaves exactly the behaviour the ruling chose. Only AGENT lines are read: a
 * caller repeating a number back is not the agent telling them.
 *
 * A LINE CUT SHORT STILL COUNTS — a barge-in, or a hang-up mid-sentence. The
 * two errors are not the same size: keeping a ticket the caller only half
 * heard costs a staffer ten seconds; withdrawing one the caller was told about
 * breaks a promise nobody will ever see broken.
 */

/** Digit words the model speaks in a readback, folded to digits. */
const DIGIT_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/** The refused transfer's claim, as refusals.ts words it. */
const RECORDED_CLAIMS = ['taken this down'];

/** Lowercase, digit words to digits, then only letters and digits remain. */
function fold(line: string): string {
  return line
    .toLowerCase()
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGIT_WORDS[w])
    .replace(/[^a-z0-9]/g, '');
}

/**
 * A ticket number folded the way a line is — "PCP-73679" → "pcp73679" — so the
 * prefix and the digits must be read together. Fewer than four digits could
 * turn up in any sentence, so such a number is never matched.
 */
function ticketKey(ticketNumber: string): string | undefined {
  return ticketNumber.replace(/\D/g, '').length >= 4 ? fold(ticketNumber) : undefined;
}

function agentLines(transcript: string): string[] {
  return transcript
    .split('\n')
    .filter((l) => l.startsWith('AGENT:'))
    .map((l) => l.slice('AGENT:'.length));
}

export function toldTheCallerItWasRecorded(transcript: string, filedTicketNumbers: readonly string[]): boolean {
  const numbers = filedTicketNumbers.map(ticketKey).filter((k): k is string => Boolean(k));
  for (const line of agentLines(transcript)) {
    const lower = line.toLowerCase();
    if (RECORDED_CLAIMS.some((claim) => lower.includes(claim))) return true;
    if (numbers.length === 0) continue;
    const folded = fold(line);
    if (numbers.some((key) => folded.includes(key))) return true;
  }
  return false;
}
