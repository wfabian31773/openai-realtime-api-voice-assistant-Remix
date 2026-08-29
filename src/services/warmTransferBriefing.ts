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
  /** e.g. "Care coordinator at Optum Clinic" — omitted when unknown. */
  providerInfo?: string | null;
  /** Why they are calling — omitted when unknown. */
  reason?: string | null;
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
  return [
    'This is the Azul Vision PCP support assistant with a live professional caller transfer.',
    details.providerInfo ? `Caller organization and role: ${details.providerInfo}.` : null,
    details.reason ? `Reason: ${details.reason}.` : null,
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
