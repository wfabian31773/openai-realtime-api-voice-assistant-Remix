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
  // Corrections ("Sorry, I mean Mary Jones") — see CORRECTION below.
  "i mean",
  "i meant",
  "quiero decir",
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
  // Codex P1s, #421: one clause matching is not enough. A name the caller
  // QUOTES ("the message said this is Mary Smith") is not their own, a second
  // self-introduction ("…and I am John Jones") is conflicting evidence, and a
  // correction ("Sorry, I mean Mary Jones") overrides everything before it.
  // So every introduction on every caller line is read IN SPOKEN ORDER, and
  // the answer is true only when, after the last correction, at least one
  // genuine self-introduction names this person and none names anyone else.
  //
  // Where that reading is ambiguous it fails SAFE (false, no ticket):
  //   - reported speech: once a caller line mentions a message, a voicemail or
  //     someone saying something, every introduction after it on that line is
  //     quoted, and if one of them names anyone the whole call answers false;
  //   - a correction ("I mean …") replaces earlier identities only when the
  //     clause just before it (filler like "sorry" aside), or its own clause
  //     before it, held a self-introduction; otherwise it may be correcting a
  //     mention of somebody else and is weighed as one more identity.
  let ids: boolean[] = [];
  let lastWasIntro = false;
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("CALLER:")) continue;
    let reported = false;
    for (const clause of line.slice("CALLER:".length).split(/[.!?;:,\u2012-\u2015]+/)) {
      // Clause boundaries are cut BEFORE folding, which would turn them into
      // spaces and join one clause to the next. An en or em dash is a clause
      // break, not a joiner; only a hyphen (ASCII, U+2010, U+2011) joins.
      const words = fold(clause).trim().split(" ").filter(Boolean);
      if (words.length === 0 || words.every((w) => FILLER.has(w))) continue;
      const events = introductions(clause, name, reported);
      if (reported && events.some((ev) => ev.named)) return false;
      let introHere = false;
      for (const ev of events) {
        if (ev.who === null) continue;
        if (ev.correction && (lastWasIntro || introHere)) ids = [];
        ids.push(ev.who);
        introHere = true;
      }
      lastWasIntro = introHere;
      if (words.some((w) => REPORTERS.has(w))) reported = true;
    }
  }
  return ids.length > 0 && ids.every(Boolean);
}

/** Clauses that carry no content of their own ("Sorry, I mean …"). */
const FILLER = new Set(["sorry", "oops", "no", "wait", "um", "uh", "er", "oh", "actually", "perdon", "perdón", "digo"]);

const NEGATORS = new Set(["no", "not", "never", "nunca"]);

/** Folded words that make an introduction after them reported speech. */
const REPORTERS = new Set([
  "said", "says", "saying", "told", "tells", "asked", "wrote", "stated",
  "states", "message", "voicemail", "dijo", "dice", "decia", "mensaje",
]);

/** Introductions that name a person whatever the transcript's casing. */
const STRONG = new Set(["my name is", "my name s", "mi nombre es", "me llamo"]);


/**
 * Words that, straight after a weak introduction ("this is", "I am", "it's"),
 * show it is not a name: "I am calling about…", "this is urgent". A weak
 * introduction followed by two other words counts as a name when either is
 * capitalised in the raw clause, or when lowercase unless it reads as ordinary
 * words ("I am calling", "I am completely out").
 */
const NOT_A_NAME = new Set(("a an the my his her their our your about calling call going here " +
  "just still also really very so not no sorry trying looking wondering having getting urgent " +
  "fine ok okay good his to for in on at with from regarding concerning back again only " +
  "tomorrow today yesterday because been out over sick having done ready able sure afraid glad happy calling worried scared unable available home back late early new old waiting " +
  "tomorrow today yesterday because that what who how why when where there this it is was " +
  "la el su mi un una de que para por muy").split(" "));

/** The raw clause carries folded word `w` with a capital initial. */
function capitalised(clause: string, w: string): boolean {
  return clause.split(/[^\p{L}\p{M}'\u2019-]+/u).some((raw) => /^\p{Lu}/u.test(raw) && fold(raw).trim() === w);
}

type Intro = { who: boolean | null; correction: boolean; named: boolean };

/**
 * Every introduction in one clause, in order. `who` is true when it names
 * this person (`name`, a regex source of letters and `[ _]` only), false
 * when it names someone else, null when it names nobody (negated, reported,
 * a possessive, or not followed by a name at all). The name must end on a
 * SPACE: "_" after it is a hyphenated surname carrying on ("smith_jones") or
 * a possessive ("smith_s").
 */
function introductions(clause: string, name: string, reported: boolean): Intro[] {
  const folded = fold(clause);
  const alt = INTRODUCTIONS.map((i) => i.replace(/ /g, "[ _]")).join("|");
  const out: Intro[] = [];
  for (const m of folded.matchAll(new RegExp(`(?<= )(${alt})(?= )`, "g"))) {
    const intro = m[1].replace(/_/g, " ");
    const correction = /^(?:i mean|i meant|quiero decir)$/.test(intro);
    const head = folded.slice(0, m.index).trim().split(/[ _]/);
    const before = head.pop() ?? "";
    const rest = folded.slice(m.index + m[0].length);
    const ignored = reported || NEGATORS.has(before) || head.concat(before).some((w) => REPORTERS.has(w));
    if (new RegExp(`^ ${name}(?= )`).test(rest)) {
      const after = rest.replace(new RegExp(`^ ${name} `), "");
      // A possessive the joiner missed ("Smith 's daughter") still folds to
      // "smith s daughter"; Spanish negates BEFORE the verb ("No soy Mary Smith").
      const possessive = /^s(?: |$)/.test(after);
      out.push({ who: ignored || possessive ? null : true, correction, named: !possessive });
      continue;
    }
    const [w1 = "", w2 = ""] = rest.trim().split(" ");
    const looksLikeName =
      w1.length > 1 && w2.length > 1 && !NEGATORS.has(w1) && !/^s(?:_|$)/.test(w1) &&
      (STRONG.has(intro) ||
        (capitalised(clause, w1) && capitalised(clause, w2)) ||
        (!NOT_A_NAME.has(w1) && !NOT_A_NAME.has(w2) && !/(?:ing|ed|ly)$/.test(w1)));
    out.push({ who: !ignored && looksLikeName ? false : null, correction, named: looksLikeName });
  }
  return out;
}
