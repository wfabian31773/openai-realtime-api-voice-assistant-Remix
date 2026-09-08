/**
 * What the office hears before it accepts a warm transfer.
 *
 * There is exactly one way to accept: press a key. The accept handler
 * (`/api/voice/warm-transfer-accept`) hangs up on anything else, and that is
 * deliberate — a digit is positive proof of a person, and it replaced an
 * answering-machine rule that scored a staffed hunt group as `machine` and hung
 * up on live people.
 *
 * So the briefing must never offer a second way in. It did:
 *
 *   'Press any key to accept, or remain on the line to connect.'
 *
 * A staffer who did the second thing was hung up on by the first rule. The
 * recording was giving an instruction the code would not honour, on the
 * professional line, to referring providers.
 *
 * This module exists so that promise is a pure string with a test on it rather
 * than a literal buried in a 7,000-line route file.
 */

/** Details the office is told before deciding whether to take the caller. */
export interface PcpBriefingDetails {
  /**
   * Who is on the phone.
   *
   * ADDED 2026-09-08, because it was not here at all. The operator, on the
   * fields he wants captured before a warm transfer: "that would be obviously
   * the name of the person who's calling, the reason they're calling... and
   * who they are, basically, what's your role, what's your title." The first
   * of those three was the one field the office was never told.
   */
  callerName?: string | null;
  /** e.g. "Care coordinator at Optum Clinic" — omitted when unknown. */
  providerInfo?: string | null;
  /** Why they are calling — omitted when unknown. */
  reason?: string | null;
}

/**
 * Placeholder text that must never be spoken to a human.
 *
 * On 2026-09-08 `pcpAgent` built its `providerInfo` as
 * `` `${state.callerRole}, ${state.callerOrganization}` ``. A template literal
 * stringifies `undefined`, so a caller who said only "representative" produced
 * the string "undefined, undefined" — non-empty, therefore truthy, therefore
 * past every `details.x ? ... : null` guard in this file. The staffer picking
 * up heard "Caller organization and role: undefined, undefined."
 *
 * Fixed at the source as well. This exists because the source is four
 * different agents and this function is the last thing between them and a
 * person's ear, so it is the right place for a floor rather than a duplicate.
 */
const PLACEHOLDER = /^(undefined|null|nan|,|\s|-)*$/i;

/**
 * The value, or nothing — never a placeholder, and never a fragment that is
 * only the punctuation left over from missing parts ("undefined, " and ", "
 * both reduce to nothing).
 */
export function cleanBriefingValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !PLACEHOLDER.test(part))
    .join(', ')
    // Every caller of this is about to append a full stop. A narrative that
    // already ends in one produced "…to speak to a representative.." — spoken
    // aloud to a staffer as an audible stumble.
    .replace(/[.\s]+$/, '');
  return stripped.length ? stripped : null;
}

/**
 * Phrases that offer a way to accept the transfer OTHER than a keypress.
 *
 * Kept as a list rather than one regex because each entry is a specific thing
 * someone might reasonably write, and a failure should name which one.
 */
const RIVAL_ACCEPT_PHRASES: readonly RegExp[] = [
  /remain on the line/i,
  /stay on the line/i,
  /hold(ing)? to (connect|accept)/i,
  /do nothing/i,
  /no action (is )?(required|needed)/i,
  /wait to be connected/i,
];

/**
 * True when `text` tells the office it can accept without pressing a key.
 *
 * Exported so any briefing — PCP's or scheduling's — can be guarded by the same
 * rule rather than each one being reviewed by eye.
 */
export function describesNonKeypressAccept(text: string): string | null {
  for (const phrase of RIVAL_ACCEPT_PHRASES) {
    const hit = text.match(phrase);
    if (hit) return hit[0];
  }
  return null;
}

/**
 * The PCP warm-transfer briefing.
 *
 * Says who is calling and why, then stops. How to accept is spoken by the
 * TwiML's own `PRESS_PROMPT`, before and after this text — repeating it here
 * only creates the opportunity to contradict it.
 */
export function buildPcpTransferBriefing(details: PcpBriefingDetails): string {
  const name = cleanBriefingValue(details.callerName);
  const who = cleanBriefingValue(details.providerInfo);
  const why = cleanBriefingValue(details.reason);
  return [
    'This is the Azul Vision PCP support assistant with a live professional caller transfer.',
    name ? `Caller: ${name}.` : 'The caller did not give a name.',
    who ? `Caller organization and role: ${who}.` : null,
    why ? `Reason: ${why}.` : null,
    /**
     * SAY WHEN WE DO NOT KNOW WHO THIS IS, rather than saying nothing.
     *
     * The operator's worry, 2026-09-08: "if someone just says, you know,
     * representative, you don't know, you... how can you warm transfer?" A
     * briefing that simply omits every unknown is indistinguishable from one
     * that was never built, and the staffer accepts a caller with no idea they
     * are starting from zero. One sentence turns that into a handover.
     *
     * IT KEYS ON IDENTITY, NOT ON ALL THREE FIELDS. The first version fired
     * only when name, role/organisation AND reason were all absent, which
     * never happens on the live path: `reason` is the handoff narrative and
     * `handoff_to_pcp` requires one, so `why` is always set — the sentence was
     * unreachable from the agent and only ever fired from a direct builder
     * call. Worse, the narrative on a bare ask IS the ask ("Caller asked to
     * speak to a representative"), so the briefing read as though it carried a
     * reason while telling the staffer nothing about who was on the phone.
     * That is precisely the case this exists for.
     */
    !name && !who
      ? 'We were not able to take their details before they asked to be put through — please start by asking who they are and what they need.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** The single instruction the office is given, and the only accept the handler honours. */
export const PRESS_PROMPT = 'Press any key to take this caller.';

export interface WarmTransferScriptInput {
  /** The briefing — who is calling and why. */
  say: string;
  /** Where the `<Gather>` posts the keypress. */
  acceptUrl: string;
}

/**
 * XML-escape text bound for a `<Say>` body.
 *
 * The briefing carries a caller's organisation and a free-text reason, so an
 * ampersand is a matter of when, not if — "Smith & Jones Medical Group" is an
 * ordinary practice name. Unescaped it makes the TwiML malformed, Twilio
 * rejects the document, and the transfer dies with no useful error.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The TwiML the office leg answers into: press-prompt, briefing, press-prompt,
 * then the same again once if nothing was pressed.
 *
 * The second `<Gather>` carries `actionOnEmptyResult` so silence still reaches
 * the accept handler and is recorded as a decline, rather than falling through
 * to Twilio's own hangup where it would look like an unanswered dial.
 */
export function buildWarmTransferScript({ say, acceptUrl }: WarmTransferScriptInput): string {
  const spoken = escapeXml(say);
  const prompt = escapeXml(PRESS_PROMPT);
  const url = escapeXml(acceptUrl);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="dtmf" numDigits="1" timeout="8" action="${url}" method="POST">` +
    `<Say voice="Polly.Joanna">${prompt}</Say>` +
    `<Say voice="Polly.Joanna">${spoken}</Say>` +
    `<Say voice="Polly.Joanna">${prompt}</Say>` +
    `</Gather>` +
    `<Gather input="dtmf" numDigits="1" timeout="10" actionOnEmptyResult="true" action="${url}" method="POST">` +
    `<Say voice="Polly.Joanna">Repeating: ${spoken}</Say>` +
    `<Say voice="Polly.Joanna">${prompt}</Say>` +
    `</Gather>` +
    `</Response>`
  );
}
