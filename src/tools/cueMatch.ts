/**
 * How a cue list is matched, shared by the queue taxonomies.
 *
 * Extracted from `surgeryTaxonomy` on 2026-08-13 when the optical queue turned
 * out to have the identical three defects. Two copies of this logic would have
 * meant fixing the next one twice.
 *
 * THE TWO RULES, both paid for:
 *
 * 1. FOLD BEFORE MATCHING. Optical and Surgery both matched with
 *    `text.toLowerCase().includes(cue)` and no diacritic handling, so
 *    "Consulta sobre estado de lentes" could not match a Spanish cue even if
 *    one existed. On a bilingual queue that makes half the vocabulary
 *    unreachable, and it is invisible from the code — only real tickets show it.
 *
 * 2. SHORT CUES MATCH ON A WORD BOUNDARY. `sx`, `cl`, `rx`, `iol` are the words
 *    the practice actually writes, and every one of them is short enough to be
 *    dangerous as a substring: `iol` appears inside "violet", and a two-letter
 *    `er` matched with `String.includes` is what put 479 tickets on reason 159.
 *    The fix for a short token is not to ban it but to match it as a word.
 *
 * THE THRESHOLD IS THREE, and the off-by-one is worth keeping. At four, `pain`
 * became a whole word and stopped matching "painful", so a post-op symptom
 * check missed "very red and painful". A boundary rule that reaches too far
 * silently turns stems into whole words — the opposite of the failure it
 * exists to prevent.
 */
import { fold } from './queueRouting';

export const SHORT_CUE_MAX = 3;

export function cueMatches(foldedText: string, cue: string): boolean {
  const c = fold(cue);
  if (!c) return false;
  if (c.length > SHORT_CUE_MAX) return foldedText.includes(c);
  // Cues are data, not patterns — escape before building the boundary regex.
  const safe = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`).test(foldedText);
}

/** True when any cue in the list matches, with the short-cue rule applied. */
export function anyCue(text: string, cues: string[]): boolean {
  const t = fold(text);
  return cues.some((cue) => cueMatches(t, cue));
}

/**
 * `verb × determiner × object`, the shape a hand-written cue list always gets
 * wrong.
 *
 * Reason 43 on the surgery queue carried 'schedule my surgery' and 'schedule
 * the surgery' and missed every real sentence — "schedule a cataract surgery",
 * "schedule my eye surgery", "schedule the right eye surgery" — because the
 * determiner varies and the object sits between the verb and the noun. A
 * substring cue cannot express "verb … object", and pretending otherwise fails
 * silently.
 */
export function crossProduct(verbs: string[], determiners: string[], objects: string[]): string[] {
  const out: string[] = [];
  for (const v of verbs) for (const d of determiners) for (const o of objects) out.push(`${v} ${d}${o}`);
  return out;
}
