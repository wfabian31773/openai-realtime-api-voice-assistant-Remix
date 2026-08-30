/**
 * XML escaping for TwiML bodies and attributes.
 *
 * A conference name is derived from a CallSid and is safe, but a callerId
 * comes from configuration and the briefing carries a caller's organisation —
 * "Smith & Jones Medical Group" is an ordinary practice name, and unescaped it
 * makes the document malformed, Twilio rejects it, and the transfer dies with
 * no useful error.
 */
export function escapeConferenceXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
