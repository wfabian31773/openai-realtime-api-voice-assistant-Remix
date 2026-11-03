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
 * True when the caller's own lines — never the agent's — say the first word of
 * `firstName` followed by the whole of `lastName`, as ONE name: adjacent, or
 * with a single middle name or initial between them. Two halves found apart
 * prove nothing — "This is John Smith. Please call Mary Jones" contains both
 * Mary and Smith and names neither Mary Smith (Codex P2, #421).
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
  const callerWords = fold(
    transcript
      .split("\n")
      .filter((line) => line.startsWith("CALLER:"))
      .map((line) => line.slice("CALLER:".length))
      .join(" "),
  );
  // Both halves are letters and spaces only after `fold`, so they need no
  // escaping inside the pattern.
  return new RegExp(` ${first} (?:[a-z]+ )?${last} `).test(callerWords);
}
