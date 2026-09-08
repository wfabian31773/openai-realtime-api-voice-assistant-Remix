/**
 * WHAT WE MUST KNOW BEFORE WE PUT SOMEBODY THROUGH — asked once, never twice.
 *
 * Operator, 2026-09-08, on yielding to an explicit ask: *"if someone just says,
 * you know, representative, you don't know, you... how can you warm transfer?
 * You would need to have, like, say, okay, before you transfer, make sure you
 * have these required fields. And that would be obviously the name of the
 * person who's calling, the reason they're calling... and who they are,
 * basically, like, what's your role, what's your title."*
 *
 * And his ruling on the shape: **"the ask wins, one round then transfer
 * anyway."**
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ONE ROUND AND NOT A GATE.
 *
 * The obvious design is to refuse the transfer until the fields are present.
 * That design has already been shipped on this line once, and it destroyed
 * requests: on 2026-08-06 `requireState` raised on any missing field, callers
 * heard "it seems like there was an issue recording", and twenty-one medical
 * records requests reached the line and left no ticket at all (see the long
 * note in ticketRequirements.ts). A caller who will not answer must never lose
 * the thing they rang for — and on this path what they rang for IS the
 * transfer, so trapping them in questions is the failure, not the protection.
 *
 * So: ask once, in one turn, for whatever is missing. Then dial, whatever they
 * said. If they answer, the office gets a briefing. If they do not, the office
 * gets a caller and a sentence saying we could not take their details — which
 * `buildPcpTransferBriefing` now says out loud — and that is still better than
 * the interrogation, because the staffer can ask and the agent cannot.
 *
 * ONE TURN, NOT ONE FIELD, and this is a deliberate exception to the line's
 * "one question at a time" rule. The alternative is three rounds before a
 * transfer, which is the interrogation this line keeps being corrected for
 * (CAdc07bca1: nine questions before the caller could say anything). The rule
 * exists to stop the agent stacking questions across a whole intake; here the
 * whole intake IS one question, asked once, standing between a caller and the
 * person they asked for.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT ON THE LIST, and why each was considered.
 *
 *   organisation   Comes free with the role nine times out of ten, and asking
 *                  for it separately is the extra turn this design exists to
 *                  avoid. It reaches the briefing when the model records it.
 *   patient name   The field that turned the operator's own call into an
 *                  interrogation — seven questions before anyone reached the
 *                  patient. Whoever picks up can ask; they have the caller on
 *                  the line and we do not.
 *   callback       Already seeded from caller ID on this line, and confirming
 *                  it is a separate ruling (standing instruction 12) that
 *                  belongs to FILING, not to connecting.
 */

import type { PcpConversationState } from './director';

/** The three the operator named, and nothing else. */
export type PreTransferField = 'callerName' | 'callerRole' | 'callPurpose';

/**
 * WHY `callPurpose` STANDS IN FOR "the reason they're calling".
 *
 * The handoff tool's `narrative` argument is always present — the schema
 * requires it — so it cannot tell us whether a reason was actually given. And
 * on a bare ask the narrative IS the ask: "Caller asked to speak to a
 * representative" reads like a reason and carries none. `callPurpose` is the
 * model's classification of why they rang, recorded through
 * `record_pcp_intake`, so its absence is the honest signal that we do not know.
 */
const FIELDS: readonly PreTransferField[] = ['callerName', 'callerRole', 'callPurpose'];

/** How each gap is named to the caller, in the order they are asked. */
const LABELS: Record<PreTransferField, string> = {
  callerName: 'your name',
  callerRole: 'your role there',
  callPurpose: 'what this is regarding',
};

/** What we still do not know about a caller we are about to put through. */
export function preTransferGaps(state: PcpConversationState): PreTransferField[] {
  return FIELDS.filter((field) => !state[field]);
}

/**
 * The one sentence, built from what is actually missing.
 *
 * Never asks for something already given — being asked your name again after
 * you have said it is the specific complaint that produced the intake script
 * (operator, 2026-08-14: "the sequencing is off"). Returns null when nothing is
 * missing, so the caller with a complete intake is never delayed at all.
 */
export function preTransferQuestion(gaps: readonly PreTransferField[]): string | null {
  if (!gaps.length) return null;
  const parts = gaps.map((field) => LABELS[field]);
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Of course — before I connect you, may I take ${list}?`;
}
