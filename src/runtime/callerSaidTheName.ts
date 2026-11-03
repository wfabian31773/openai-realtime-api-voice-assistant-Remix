/**
 * DID THE CALLER SAY THIS NAME? — v168.
 *
 * Operator ruling, 2026-10-29: "we should not be filing nameless tickets but
 * we also need to make sure that we did not get the name in transcripts nor
 * did we match the phone number to a patient on lookup." v142 honoured the
 * first half where a tool had received the name. This is the second half, and
 * it is NOT a name detector (standing instruction 3): it never decides what a
 * name is. It is handed a name the process already holds — the person the
 * calling number belongs to — and answers one question: did the caller say
 * both halves of it in their own words?
 *
 * That is the validation RULE ZERO step 2 asks for. A phone number is a
 * candidate to confirm; a caller who says "my name is <first> <last>" and is
 * on that person's number has confirmed it as far as a name can. A household
 * member shares a surname and not usually a first name, so BOTH are required.
 *
 * Fails safe in every direction that matters: a transcription that spells the
 * surname differently, a nickname, a caller who never says their name, or a
 * caller line that names somebody else all answer false, and the sweep then
 * behaves exactly as before (no name, no ticket).
 */
import { nameKey } from "../tools/verifiedIdentity";

/** Whole words only, letters only, case and accents folded the store's way. */
function fold(text: string): string {
  return ` ${nameKey(text).replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * THE CALLER'S OWN INTRODUCTION — the only place a name is evidence of who is
 * speaking. Folded the same way as the sentence (`fold`), so "I'm" is "i m"
 * and "Mi nombre es" carries no accent.
 */
const INTRODUCTIONS = [
  "my name is",
  "my name s",
  "this is",
  "i am",
  "i m",
  "it is",
  "it s",
  "mi nombre es",
  "me llamo",
  "soy",
  "habla",
];

/**
 * True when ONE sentence of ONE caller line — never the agent's — introduces
 * the caller by this name: an introduction ("my name is", "this is", "I'm",
 * "mi nombre es", "soy"…) immediately followed by the first word of
 * `firstName` and then the whole of `lastName`, with nothing between.
 *
 * Three Codex rounds on #421 found three ways for a bare mention to name the
 * wrong person, and each was the same root cause — reading a MENTION as an
 * INTRODUCTION:
 *   - two people: "This is John Smith. Please call Mary Jones";
 *   - a boundary folded away: "This is Mary Jones. Smith is my surgeon", or an
 *     answer "Mary." followed by "Smith is my surgeon";
 *   - a denial: "I am not Mary Smith, she is my mother."
 * So the name must follow the introduction directly, inside one sentence of
 * one turn: "I am not Mary Smith" fails (not), "this call is for Mary Smith"
 * fails (call is for), and "this is Mary Smith's daughter" fails (a possessive
 * after the name). A middle name said aloud fails too. Every one of those
 * fails SAFE — no ticket, as before — and all seven corpus callers introduced
 * themselves plainly ("This is…", "My name is…", "Mi nombre es…").
 *
 * The first name is cut to its first word because the record carries middle
 * initials and second names ("Vince V") that nobody says; the surname is kept
 * whole because a compound surname ("Garcia Lopez") said in part is the
 * household shape this guards against. A half under two letters never
 * matches: a one-letter "name" is a word on every line.
 */
export function callerSaidTheName(
  transcript: string,
  firstName: string,
  lastName: string,
): boolean {
  const first = fold(firstName).trim().split(" ")[0] ?? "";
  const last = fold(lastName).trim();
  if (first.length < 2 || last.length < 2) return false;
  const name = `${first} ${last}`;
  return transcript
    .split("\n")
    .filter((line) => line.startsWith("CALLER:"))
    // Sentence boundaries are cut BEFORE folding, which would turn them into
    // spaces and join the end of one sentence to the start of the next.
    .flatMap((line) => line.slice("CALLER:".length).split(/[.!?;:,]+/))
    .some((sentence) => introducesAs(fold(sentence), name));
}

const NEGATORS = new Set(["no", "not", "never", "nunca"]);

/** `folded` is padded with a space at each end (see `fold`). */
function introducesAs(folded: string, name: string): boolean {
  for (const intro of INTRODUCTIONS) {
    let at = folded.indexOf(` ${intro} ${name} `);
    while (at !== -1) {
      const after = folded.slice(at + intro.length + name.length + 3);
      const before = folded.slice(0, at).trim().split(" ").pop() ?? "";
      // "Mary Smith's daughter" folds to "mary smith s daughter"; Spanish
      // negates BEFORE the verb ("No soy Mary Smith").
      if (!/^s(?: |$)/.test(after) && !NEGATORS.has(before)) return true;
      at = folded.indexOf(` ${intro} ${name} `, at + 1);
    }
  }
  return false;
}
