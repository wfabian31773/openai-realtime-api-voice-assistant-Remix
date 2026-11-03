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
  // correction ("Sorry, I mean Mary Jones") overrides what came before. So
  // every introduction on every caller line is weighed, and the answer is
  // true only when at least one genuine self-introduction names this person
  // and nothing else in the call identifies the caller differently.
  //
  // Where that reading is ambiguous it fails SAFE (false, no ticket), because
  // a false "yes" files a ticket under the wrong patient and a false "no"
  // only leaves the call as it was before v168:
  //   - reported speech: a caller who quotes anything, or mentions a message,
  //     a voicemail, an email, or someone saying or introducing something,
  //     anywhere in the call;
  //   - any correction ("I mean …", "I meant …") followed by a name-like
  //     word, however it is punctuated ("I mean, Mary Jones"). A correction always overrides the earlier introduction, but
  //     whether it corrects the caller's own name or a mention of someone
  //     else ("calling about Mary Jones, sorry, I mean Mary Smith") cannot be
  //     told apart reliably, so it never confirms — it only cancels;
  //   - a denial of this name ("Actually, I'm not Mary Smith") anywhere.
  const callerLines = transcript
    .split("\n")
    .filter((line) => line.startsWith("CALLER:"))
    .map((line) => line.slice("CALLER:".length));
  if (
    callerLines.some(
      (line) =>
        /["\u201C\u201D\u00AB\u00BB]|(?:^|[^\p{L}])['`\u2018\u2019]|['`\u2018\u2019](?![\p{L}])/u.test(line) ||
        fold(line).split(/[ _]/).some((w) => REPORTERS.has(w)) ||
        [...fold(line).matchAll(/ (?:i[ _]mean(?:t)?|quiero decir)((?: [a-z_]+)*)/g)].some(([, tail]) => {
          const w = tail.trim().split(/[ _]/).find((x) => !FILLER.has(x)) ?? "";
          // A correction with nothing after it ("Sorry, I mean" — the name
          // comes on the next turn) is unresolved, and cancels too.
          return w === "" || !NOT_A_NAME.has(w);
        }) ||
        // A colon introduces what someone else said ("My mother replied: …").
        /:/.test(line),
    )
  ) {
    return false;
  }
  let confirmed = false;
  for (const line of callerLines) {
    // Clause boundaries are cut BEFORE folding, which would turn them into
    // spaces and join one clause to the next. An en or em dash is a clause
    // break, not a joiner; only a hyphen (ASCII, U+2010, U+2011) joins.
    for (const sentence of line.split(/[.!?]+/)) {
      // An introduction is the caller's own only if nothing but greetings and
      // filler precede it in its SENTENCE ("My mother always goes, this is
      // Mary Smith" is a mention).
      let prefixPlain = true;
      for (const clause of sentence.split(/[;:,\u2012-\u2015]+/)) {
        // "I am not actually Mary Smith": an introduction, a negation and this
        // name in one clause, in that order, is a denial however it is worded.
        const f = fold(clause);
        const intro = INTRODUCTIONS.map((i) => i.replace(/ /g, "[ _]")).join("|");
        if (new RegExp(`(?<= )(?:${intro}) (?:.* )?(?:not|never|nunca) (?:.* )?${name}(?= )`).test(f)) return false;
        for (const ev of introductions(clause, name)) {
          if (ev.denied || ev.cancels) return false;
          if (ev.who === false) return false;
          // Only an introduction that OPENS its clause (greetings and filler
          // aside) is the caller's own: "My mother would say this is Mary
          // Smith" or "the message said this is Mary Smith" is a mention.
          if (ev.who === true && ev.opens && prefixPlain) confirmed = true;
        }
        if (!f.trim().split(/[ _]/).filter(Boolean).every((w) => OPENERS.has(w) || FILLER.has(w))) prefixPlain = false;
      }
    }
  }
  return confirmed;
}

/** Words that may come before an introduction that opens its clause. */
const OPENERS = new Set(["hi", "hello", "hey", "yes", "yeah", "yep", "ok", "okay", "so", "and", "good", "morning",
  "afternoon", "evening", "hola", "buenos", "buenas", "dias", "tardes", "noches", "si", "bueno", "alo", "there"]);

/** Clauses that carry no content of their own ("Sorry, I mean …"). */
const FILLER = new Set(["sorry", "oops", "no", "wait", "um", "umm", "uh", "uhm", "er", "erm", "hmm", "oh", "like", "actually", "well", "perdon", "perdón", "digo"]);

const NEGATORS = new Set(["no", "not", "never", "nunca"]);

/** Folded caller words that mark reported speech somewhere in the call. */
const REPORTERS = new Set([
  "said", "says", "saying", "told", "tells", "asked", "wrote", "stated",
  "states", "replied", "replies", "responded", "say", "tell", "telling", "answered", "answers", "answering", "greeting", "repeated", "introduced", "introduces", "herself", "himself", "themselves", "announced", "claimed", "claims", "shows", "showed", "screen", "message", "email", "mail", "text", "letter", "note", "reads", "read", "recording", "voicemail", "dijo", "dice", "decia", "mensaje",
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
  "scheduled supposed worried concerned interested confused booked married pregnant diabetic " +
  "tomorrow today yesterday because completely totally almost currently already been out over sick having done ready able sure afraid glad happy calling worried scared unable available home back late early new old waiting " +
  "tomorrow today yesterday because that what who how why when where there this it is was " +
  "la el su mi un una de que para por muy").split(" "));

/** The raw clause carries folded word `w` with a capital initial. */
function capitalised(clause: string, w: string): boolean {
  return clause.split(/[^\p{L}\p{M}'\u2019-]+/u).some((raw) => /^\p{Lu}/u.test(raw) && fold(raw).trim() === w);
}

type Intro = { who: boolean | null; denied: boolean; cancels: boolean; opens: boolean };

/**
 * Every introduction in one clause, in order. `who` is true when it names
 * this person (`name`, a regex source of letters and `[ _]` only), false
 * when it names someone else, null when it names nobody (negated,
 * a possessive, or not followed by a name at all). The name must end on a
 * SPACE: "_" after it is a hyphenated surname carrying on ("smith_jones") or
 * a possessive ("smith_s").
 */
function introductions(clause: string, name: string): Intro[] {
  const folded = fold(clause);
  const alt = INTRODUCTIONS.map((i) => i.replace(/ /g, "[ _]")).join("|");
  const out: Intro[] = [];
  for (const m of folded.matchAll(new RegExp(`(?<= )(${alt})(?= )`, "g"))) {
    const intro = m[1].replace(/_/g, " ");
    const correction = /^(?:i mean|i meant|quiero decir)$/.test(intro);
    const head = folded.slice(0, m.index).trim().split(/[ _]/);
    const before = head.pop() ?? "";
    const rest = folded.slice(m.index + m[0].length);
    const opens = head.concat(before).filter(Boolean).every((w) => OPENERS.has(w) || FILLER.has(w));
    // English negates AFTER the verb ("I am not…"); a leading "No" is a
    // correction ("No, I am John Jones"). Spanish negates before ("No soy…").
    const negated = before === "no" ? /^(?:soy|habla|me llamo)$/.test(intro) : NEGATORS.has(before);
    const ignored = negated;
    // "I'm not Mary Smith" / "this is not Mary Smith": a denial of this name.
    if (new RegExp(`^ (?:not|never|no) ${name}(?= )`).test(rest)) {
      out.push({ who: null, denied: true, cancels: false, opens });
      continue;
    }
    if (new RegExp(`^ ${name}(?= )`).test(rest)) {
      const after = rest.replace(new RegExp(`^ ${name} `), "");
      // A possessive the joiner missed ("Smith 's daughter") still folds to
      // "smith s daughter"; Spanish negates BEFORE the verb ("No soy Mary Smith").
      const possessive = /^s(?: |$)/.test(after);
      out.push({ who: ignored || possessive || correction ? null : true, denied: negated && !possessive, cancels: correction && !negated, opens });
      continue;
    }
    const [w1 = "", w2 = ""] = rest.trim().split(" ");
    // One name-like word is enough to be someone else ("I mean John de
    // Vries"): a false conflict only fails safe. Ordinary words after "I am" are
    // listed in NOT_A_NAME; no suffix rule ("mohammed", "kimberly" are names).
    const looksLikeName =
      w1.length >= 1 && !NEGATORS.has(w1) &&
      // "a"/"i" is an article or pronoun unless written as an initial
      // ("I am A. Jones", or "I am A Jones").
      (!["a", "i"].includes(w1) ||
        // …or "I am A." cut off by the initial's own period.
        (/^\s*$/.test(rest.trim().split(" ").slice(1).join(" ")) && /\b(?:am|is|m)\s+[AI]\s*$/.test(clause)) ||
        (capitalised(clause, w1) && capitalised(clause, w2) && !NOT_A_NAME.has(w2))) && !/^s(?:_|$)/.test(w1) &&
      (STRONG.has(intro) || capitalised(clause, w1) ||
        !NOT_A_NAME.has(w1));
    // A correction cancels on any name-like word, initials included ("I mean J. Jones").
    const cancels = correction && !ignored && w1.length >= 1 && !NOT_A_NAME.has(w1) && !FILLER.has(w1);
    out.push({ who: !ignored && looksLikeName ? false : null, denied: false, cancels, opens });
  }
  return out;
}
