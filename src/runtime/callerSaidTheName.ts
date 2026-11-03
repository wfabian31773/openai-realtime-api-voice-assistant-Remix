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
  // ALLOWLIST DESIGN (#421, after thirteen Codex rounds of patching): the
  // answer is true only when the caller's own words contain a fixed
  // self-introduction phrasing with this name IMMEDIATELY after it, and
  // nothing in the call makes that ambiguous. Every doubt answers false — a
  // false "no" only leaves the call as it was before v168, a false "yes"
  // files a ticket under the wrong patient. Specifically, false when:
  //   - any quoting context: a quote mark, a colon, or a reporting word
  //     ("said", "message", "voicemail"…) on a caller line, or an agent turn
  //     asking what someone said or to read something out;
  //   - any correction phrasing anywhere ("I mean", "that should be"…);
  //   - any negation near an introduction or a name word ("I'm not…",
  //     "my surname is not Smith", "no soy…");
  //   - any self-introduction phrasing followed by anything other than this
  //     name or a short list of plainly non-name words ("I'm calling…",
  //     "it's about…"). Matching is case-insensitive and no word is dropped
  //     as "too common to be a name": "i am an nguyen" is a conflict;
  //   - any other mention of either half of this name outside a match.
  const lines = transcript.split("\n");
  const callerLines = lines.filter((l) => l.startsWith("CALLER:")).map((l) => l.slice("CALLER:".length));
  const agentLines = lines.filter((l) => !l.startsWith("CALLER:"));
  if (
    callerLines.some(
      (line) =>
        /["\u201C\u201D\u00AB\u00BB:]|(?:^|[^\p{L}])['`\u2018\u2019]|['`\u2018\u2019](?![\p{L}])/u.test(line) ||
        fold(line).split(/[ _]/).some((w) => REPORTERS.has(w)),
    )
  ) {
    return false;
  }
  if (agentLines.some((line) => AGENT_QUOTING.test(fold(line)))) return false;

  // Sentences of caller speech, commas and dashes ignored (folding the
  // sentence would otherwise hide nothing; a comma inside an introduction —
  // "My name is, Mary Smith" — is not a boundary).
  const sentences = callerLines
    .flatMap((l) => l.split(/[.!?;]+/))
    .map((s) => fold(s.replace(/[,\u2012-\u2015]+/g, " ")))
    .filter((s) => s.trim() !== "");
  const all = sentences.join(" ");
  if (CORRECTION.test(all) || DENIAL.test(all)) return false;

  const nameRe = new RegExp(`^${name}(?= )`);
  let matched = 0;
  let mentions = 0;
  let halves = 0;
  const firstRe = new RegExp(`(?<= )${firstAlt}(?= )`, "g");
  const lastRe = new RegExp(`(?<= )${last.split(/[ _]/).join("[ _]")}(?= )`, "g");
  for (const s of sentences) {
    mentions += (s.match(firstRe) ?? []).length + (s.match(lastRe) ?? []).length;
    for (const m of s.matchAll(INTRO_RE)) {
      const phrase = m[1] ?? "";
      let tail = s.slice((m.index ?? 0) + m[0].length);
      tail = tail.replace(/^(?: (?:um|umm|uh|uhm|er|erm))+(?= )/, "");
      const words = tail.trim().split(" ").filter(Boolean);
      const w1 = words[0] ?? "";
      if (HALF_INTROS.has(phrase)) {
        // "my last name is Smith" — neutral only when it is exactly this half.
        const half = phrase.includes("first") ? first : last;
        if (!new RegExp(`^ ${half.split(/[ _]/).join("[ _]")}(?: |$)`).test(`${tail} `) || words.length > half.split(/[ _]/).length) return false;
        halves++;
        continue;
      }
      const hit = nameRe.exec(tail.slice(1));
      if (hit) {
        const after = tail.slice(1 + hit[0].length).trim().split(" ")[0] ?? "";
        // Only an introduction that opens its sentence (greetings and filler
        // aside) is the caller's own: "My mother always goes, this is Mary
        // Smith" is a mention, and a mention of this name is ambiguity.
        const before = s.slice(0, m.index ?? 0).trim().split(" ").filter(Boolean);
        if (!before.every((w) => OPENERS.has(w))) return false;
        if (after === "" || AFTER_NAME.has(after)) {
          matched++;
          continue;
        }
        return false; // "This is Mary Smith Jones", "Mary Smith_s"
      }
      if (w1 === "" || !CONTINUATIONS.has(w1)) return false;
    }
  }
  // Every mention of either half must be accounted for by a match (each
  // match mentions both halves once).
  if (matched === 0 || mentions !== matched * 2 + halves) return false;
  return true;
}

/** Words that may precede a genuine introduction in its sentence. */
const OPENERS = new Set((
  "hi hello hey yes yeah yep ok okay so and good morning afternoon evening um umm uh uhm er erm hmm oh well " +
  "hola buenos buenas dias tardes noches si bueno"
).split(" "));

const INTRO_PHRASES = [
  "my first name is", "my last name is", "my surname is", "mi apellido es", "my name is", "my name s",
  "mi nombre es", "me llamo", "this is", "i am", "i m", "it is", "it s", "soy", "habla",
];
const HALF_INTROS = new Set(["my first name is", "my last name is", "my surname is", "mi apellido es"]);
const INTRO_RE = new RegExp(`(?<= )(${INTRO_PHRASES.map((p) => p.replace(/ /g, "[ _]")).join("|")})(?= )`, "g");

/** Words after an introduction that plainly are not a name. Nothing that is
 * also a given name or surname belongs here; a missing word only fails safe. */
const CONTINUATIONS = new Set((
  "calling call here trying looking wondering having going gonna scheduled supposed worried concerned " +
  "sorry sure about for regarding in at with from the my your his her our their this that been " +
  "returning following getting interested needing waiting ready able unable confused urgent important " +
  "paciente la el de para su del mama madre hijo hija esposo esposa llamando"
).split(" "));

/** Words that may directly follow the name in a genuine introduction. */
const AFTER_NAME = new Set((
  "and i calling speaking here from again um uh my the um_hm hi hello yes ok okay thank thanks please " +
  "y llamando hablando de desde estoy zero oh one two three four five six seven eight nine cero uno dos tres cuatro cinco seis siete ocho nueve"
).split(" "));

/** Any correction anywhere in the caller's speech. */
const CORRECTION = / (?:i[ _]mean|i[ _]meant|quiero decir|that should be|should be|should have been|correction|scratch that|i said|no wait|rather|digo|i misspoke|let me correct|actually it s|actually it is|actually this is|actually my) /;

/** Negation of an introduction or a name word anywhere ("I'm not…", "my
 * surname is not…", "no soy…", "that's not my name"). */
const DENIAL = new RegExp(
  ` (?:${INTRO_PHRASES.map((p) => p.replace(/ /g, "[ _]")).join("|")}) (?:\\w+ ){0,2}?(?:not|never|nunca|no) ` +
    `| (?:not|never|nunca|no|isn_t|wasn_t|ain_t) (?:\\w+ ){0,2}(?:name|names|surname|apellido|nombre|me|mine|him|her) ` +
    `| (?:isn_t|wasn_t|ain_t|n_t) (?:\\w+ ){0,1}(?:name|surname) | no soy | no me llamo `,
);

/** An agent turn that makes the caller's next words a quotation. */
const AGENT_QUOTING = / (?:said|say|says|saying|quote|quoted|repeat|read|reads|reading|aloud|loud|verbatim|word for word|exactly|dijo|dice|decia|leer|lea|lealo) /;

/** Folded caller words that mark reported speech somewhere in the call. */
const REPORTERS = new Set([
  "said", "says", "saying", "told", "tells", "asked", "wrote", "stated",
  "states", "replied", "replies", "responded", "say", "tell", "telling", "answered", "answers", "answering", "greeting", "repeated", "introduced", "introduces", "herself", "himself", "themselves", "announced", "claimed", "claims", "shows", "showed", "screen", "message", "email", "mail", "text", "letter", "note", "reads", "read", "recording", "voicemail", "dijo", "dice", "decia", "mensaje",
]);
