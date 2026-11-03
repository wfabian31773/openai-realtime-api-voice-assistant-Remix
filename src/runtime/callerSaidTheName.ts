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

/**
 * Whole words only, letters only, case and accents folded the store's way.
 *
 * A hyphen or an apostrophe BETWEEN two letters joins them into one token
 * ("Smith-Jones" -> "smith_jones", "O'Brien" -> "o_brien", "Smith's" ->
 * "smith_s"), so a surname can only match a whole spoken token. Before this,
 * `nameKey` turned the joiner into a space and "Mary Smith" matched "This is
 * Mary Smith-Jones" (Codex P2, #421). The record's surname is folded the same
 * way, so a hyphenated surname still matches when it is said in full.
 */
const JOINER = /(\p{L}\p{M}*)\s*[-\u2010\u2011]\s*(?=\p{L})|(\p{L}\p{M}*)['`\u2018\u2019\u02BC](?=\p{L})/gu;
function fold(text: string): string {
  const joined = text.replace(JOINER, (_m, a?: string, b?: string) => `${a ?? b}_`);
  return ` ${nameKey(joined).replace(/[^a-z_\s]/g, " ").replace(/\s+/g, " ").trim()} `;
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
  const firstWords = fold(firstName).trim().split(/[ _]/);
  const first = firstWords[0] ?? "";
  const last = fold(lastName).trim();
  if (first.length < 2 || last.length < 2) return false;
  // Inside the record's name a space and a joiner are the same separator
  // ("Garcia Lopez" on file, "Garcia-Lopez" said), but the match must END on a
  // token boundary: a joiner straight after it means the speaker's surname
  // carries on ("Smith" on file, "Smith-Jones" said) and is not this name.
  // The first name is its first word ("Anne" for "Anne-Marie") or, when
  // joined, the whole of it said in full ("Anne-Marie" / "Anne Marie").
  const firstAlt =
    firstWords.length > 1 && firstName.match(/[-\u2010-\u2015'`\u2018\u2019\u02BC]/)
      ? `(?:${first}|${firstWords.join("[ _]")})`
      : first;
  const name = [firstAlt, ...last.split(/[ _]/)].join("[ _]");
  return transcript
    .split("\n")
    .filter((line) => line.startsWith("CALLER:"))
    // Sentence boundaries are cut BEFORE folding, which would turn them into
    // spaces and join the end of one sentence to the start of the next. An
    // en or em dash ("Mary Smith — I need…") is a clause break, not a joiner;
    // only a hyphen (ASCII, U+2010, U+2011) joins a surname.
    .flatMap((line) => line.slice("CALLER:".length).split(/[.!?;:,\u2012-\u2015]+/))
    .some((sentence) => introducesAs(fold(sentence), name));
}

const NEGATORS = new Set(["no", "not", "never", "nunca"]);

/**
 * `folded` is padded with a space at each end (see `fold`); `name` is a regex
 * source of letters and `[ _]` only. The name must be followed by a SPACE:
 * "_" after it is a hyphenated surname carrying on ("smith_jones") or a
 * possessive ("smith_s" — "Mary Smith's daughter").
 */
function introducesAs(folded: string, name: string): boolean {
  for (const intro of INTRODUCTIONS) {
    // "I'm" folds to "i_m" (a joined apostrophe), listed here as "i m".
    const re = new RegExp(`(?<= )${intro.replace(/ /g, "[ _]")} ${name}(?= )`, "g");
    for (const m of folded.matchAll(re)) {
      const before = folded.slice(0, m.index).trim().split(/[ _]/).pop() ?? "";
      const after = folded.slice(m.index + m[0].length + 1);
      // A possessive the joiner missed ("Smith 's daughter") still folds to
      // "smith s daughter"; Spanish negates BEFORE the verb ("No soy Mary Smith").
      if (!/^s(?: |$)/.test(after) && !NEGATORS.has(before)) return true;
    }
  }
  return false;
}
