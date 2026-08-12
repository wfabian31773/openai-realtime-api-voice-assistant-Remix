/**
 * Keep free text inside the GSM-7 alphabet before it leaves us.
 *
 * WHY, and it is not about tidiness.
 *
 * A single character outside GSM-7 drags an ENTIRE SMS body into UCS-2, where
 * the segment size drops from 160 characters to 70. The ticketing agent traced
 * this on the acknowledgement for VA-50803 — a ~140-character message that
 * should be one segment:
 *
 *   Encoding          UCS2
 *   Message Segments  3
 *   Cost              $0.0249
 *
 * The cause was one typographic apostrophe (U+2019) in the word "we've".
 *
 * Cost is the smaller half. Multi-segment long-code traffic is far more exposed
 * to US carrier A2P filtering — a message that is accepted, billed, and marked
 * `sent` can still be silently dropped. So this is a deliverability fix wearing
 * a cost fix's clothes.
 *
 * OUR EXPOSURE, measured on the Support Center 2026-08-12: of 17,446 tickets
 * filed by a voice agent in 90 days, **1,700 (9.7%) carry smart punctuation in
 * the description**, plus 139 in the call summary. That is text WE sent, and it
 * feeds the patient-facing SMS.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not strip accents. `José`, `está`, `Müller` are all in GSM-7 and cost
 * nothing to keep — mangling a patient's name to save a segment would be a
 * worse bug than the one being fixed. Only characters that are BOTH outside
 * GSM-7 and have a faithful ASCII equivalent are replaced; anything else is
 * left alone, because a dropped character is a changed meaning.
 */

/**
 * Typographic characters a model emits by habit, and their GSM-7 equivalents.
 * Every replacement here preserves meaning exactly.
 */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"], // ' ' ‚ ‛ ′
  [/[“”„‟″]/g, '"'], // " " „ ‟ ″
  [/[‐‑‒–—―]/g, '-'], // ‐ ‑ ‒ – — ―
  [/…/g, '...'], // …
  [/ /g, ' '], // non-breaking space
  [/[         ]/g, ' '], // en/em/thin spaces
  [/​/g, ''], // zero-width space
  [/•/g, '-'], // •
  [/·/g, '.'], // ·
  [/⁄/g, '/'], // ⁄
  [/«/g, '"'],
  [/»/g, '"'],
  [/™/g, 'TM'], // ™
  [/®/g, '(R)'], // ®
  [/©/g, '(C)'], // ©
  [/–/g, '-'],
  [/½/g, '1/2'],
  [/¼/g, '1/4'],
  [/¾/g, '3/4'],
  [/°/g, ' degrees'], // ° is not in GSM-7
];

/**
 * The GSM 03.38 basic alphabet plus its extension table, as a character set.
 * Anything here is safe and must be left exactly as it is.
 */
const GSM7 = new Set(
  (
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
    '\f^{}\\[~]|€'
  ).split(''),
);

/** Replace what can be replaced faithfully. Leaves everything else untouched. */
export function toGsm7(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Characters still outside GSM-7 after substitution.
 *
 * Used for logging rather than blocking: if a patient's name legitimately
 * contains one, the message costs more and that is the correct trade. Knowing
 * WHICH character did it is what stops the next person guessing.
 */
export function nonGsm7Characters(text: string): string[] {
  return [...new Set([...(text ?? '')].filter((c) => !GSM7.has(c)))];
}

/** True when the text would be sent as one GSM-7 segment rather than UCS-2. */
export function isGsm7(text: string): boolean {
  return nonGsm7Characters(text).length === 0;
}

/**
 * Clean, and say what happened. Returns the text unchanged when it was already
 * clean, so a caller can log only the cases that mattered.
 */
export function sanitizeForSms(text: string): {
  value: string;
  changed: boolean;
  /** Non-GSM-7 characters that SURVIVED — accents and the genuinely unmapped. */
  remaining: string[];
} {
  const value = toGsm7(text ?? '');
  return {
    value,
    changed: value !== (text ?? ''),
    remaining: nonGsm7Characters(value),
  };
}
