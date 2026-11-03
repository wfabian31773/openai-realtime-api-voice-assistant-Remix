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
  const ownTokens = [first, ...firstWords, ...last.split(/[ _]/)];
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
  const rawCaller = lines.filter((l) => l.startsWith("CALLER:")).map((l) => l.slice("CALLER:".length).trim());
  // A transcriber often re-emits a turn with more words ("I wanted to…" then
  // "I wanted to… My name is…"): a caller line repeated, or extended, by a
  // later one is the same turn and is read once.
  const callerLines = rawCaller.filter((l, i) => !rawCaller.some((m, j) => j > i && fold(m).startsWith(fold(l).trimEnd())));
  if (!structurallySingle(callerLines, lines, first, last, firstWords, firstAlt)) return false;
  const agentLines = lines.filter((l) => !l.startsWith("CALLER:"));
  if (rawCaller.some((line) => /\b(?:transcri\w*|(?:hear|heard|hearing) (?:the following|this|it say|a message|a recording)|leave your|apolog\w*|dictat\w*|reading|recit\w*|repeat\w*|relay\w*)/i.test(line))) return false;
  // Guards read every raw turn, before duplicates are merged.
  if (
    rawCaller.some(
      (line) =>
        /["\u201C\u201D\u00AB\u00BB:]|(?:^|[^\p{L}])['`\u2018\u2019]|['`\u2018\u2019](?![\p{L}])/u.test(line) ||
        fold(line).split(/[ _]/).some((w) => REPORTERS.has(w)) ||
        LISTENING.test(fold(line)) ||
        // "I hear this. This is Mary Smith": a sentence pointing at what follows.
        /(?:^|[^\p{L}])(?:this|that|esto|eso)\s*[.!;,]/iu.test(line),
    )
  ) {
    return false;
  }
  // An introduction asked as a question ("This is Mary Smith?") or a bare "No" is
  // an echo or a rejection, never a confirmation.
  if (rawCaller.some((line) => (line.match(/[^.!?;\u00BF]*\?|\u00BF[^.!?;]*/g) ?? []).some((q) => new RegExp(INTRO_RE.source).test(fold(q))) || /(?:^|[.!;,]\s*)no\b/i.test(line.trim()))) return false;
  if (
    agentLines.some((line) => {
      // The stock greeting offers to "take a message"; anything else about a
      // message, voicemail or recording makes the caller's answer a quotation.
      const f = fold(line).replace(/ take a message /g, " ");
      return AGENT_QUOTING.test(f) || THIRD_PARTY.test(withoutOwnName(f, ownTokens)) || f.split(/[ _]/).some((w) => REPORTERS.has(w));
    })
  ) {
    return false;
  }
  if (rawCaller.some((line) => THIRD_PARTY.test(withoutOwnName(fold(line), ownTokens)))) return false;

  // Sentences of caller speech, commas and dashes ignored (folding the
  // sentence would otherwise hide nothing; a comma inside an introduction —
  // "My name is, Mary Smith" — is not a boundary).
  // The caller's words count only as an answer to a greeting, a name request
  // or a plain prompt. Any other agent question before a caller turn ("What
  // do you hear when you dial that number?") may make the answer a quotation.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith("CALLER:")) continue;
    if (!lines.slice(i + 1).some((l) => l.startsWith("CALLER:"))) break;
    if (!AGENT_OK.test(fold(lines[i] ?? "")) || LISTENING.test(fold(lines[i] ?? ""))) return false;
  }
  const sentences = callerLines
    .flatMap((l) => l.split(/[.!?;]+/))
    .map((s) => fold(s.replace(/[,\u2012-\u2015]+/g, " ")))
    .filter((s) => s.trim() !== "");
  const all = sentences.join(" ");
  if (CORRECTION.test(all) || DENIAL.test(all)) return false;
  // Talk about a name outside a fixed introduction ("Jane Jones is my name",
  // "that was wrong") is ambiguity.
  if (sentences.some((s) => NAME_TALK.test(s) && !/^ (?:\S+ )*?(?:my (?:first |last )?name is|my surname is|my name s|mi nombre es|mi apellido es|me llamo) /.test(s))) return false;
  if (/ (?:wrong|mistake|mistaken|incorrect|misspoke|equivocad[oa]|error) /.test(all)) return false;

  const nameRe = new RegExp(`^${name}(?= )`);
  let matched = 0;
  let mentions = 0;
  let halves = 0;
  const firstRe = new RegExp(`(?<= )${firstAlt}(?= )`, "g");
  const lastRe = new RegExp(`(?<= )${last.split(/[ _]/).join("[ _]")}(?= )`, "g");
  for (const s of sentences) {
    // After a match, an apology, "actually" or an "X here" introduction is a correction.
    if (matched > 0 && / (?:sorry|perdon|disculpe|actually|wait|oops|no|rather) /.test(s)) return false;
    if (/ here $/.test(s) && !new RegExp(`(?<= )${name} here $`).test(s)) return false;
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
        const rest = tail.slice(1 + hit[0].length).trim().split(" ");
        // "and" may join only a new clause ("…and I am calling"), never a
        // longer surname ("García y López").
        const after = rest[0] === "and" ? (["i", "i_m", "i_ve", "i_d"].includes(rest[1] ?? "") ? "and" : "?") : (rest[0] ?? "");
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
      // "This is my fourth request", "it's the pharmacy": a thing, not a
      // person — but only after "this is"/"it is"; "I am your patient Jane
      // Jones" is a conflict.
      if (["my", "the"].includes(w1) && /^(?:this is|it is|it s)$/.test(phrase.replace(/_/g, " "))) continue;
      if (w1 === "" || !CONTINUATIONS.has(w1)) return false;
    }
  }
  // Every mention of either half must be accounted for by a match (each
  // match mentions both halves once).
  if (matched === 0 || mentions !== matched * 2 + halves) return false;
  return true;
}

/**
 * THE STRUCTURAL RULE (GitHub Assistant block on #421): patterns alone kept
 * leaking, so before any phrasing is read the call must have this shape, or
 * the answer is false:
 *   - exactly ONE introduction phrase in all the caller's turns, and it is in
 *     the caller's first substantive turn (three words or more);
 *   - no correction or apology marker anywhere after it, in any language;
 *   - no quoting, recording or reading cue anywhere in the call;
 *   - no other personal name: any capitalised token that does not open a
 *     sentence and is not a stopword, a clinic word, a day or a month counts
 *     as one unless it is a token of this name.
 * Conservative on purpose: anything that might be another name fails safe.
 */
function structurallySingle(callerLines: string[], lines: string[], first: string, last: string, firstWords: string[], firstAlt: string): boolean {
  const own = new Set([first, ...firstWords, ...last.split(/[ _]/)]);
  const quoting = (t: string) => QUOTING_CUES.test(fold(t).replace(/ take a message | calls are being recorded /g, " "));
  if (lines.some(quoting)) return false;
  let count = 0;
  let introLine = -1;
  let introAt = 0;
  const seen = new Set<string>();
  callerLines.forEach((line, i) => {
    const f = fold(line.replace(/[.!?;,\u2012-\u2015]+/g, " "));
    for (const m of f.matchAll(INTRO_RE)) {
      const next = f.slice((m.index ?? 0) + m[0].length).trim().split(" ")[0] ?? "";
      if (NOT_INTRO_AFTER.has(next) || (next === "my" && /^(?:this is|it is|it s)$/.test((m[1] ?? "").replace(/_/g, " ")))) continue;
      // The same introduction of this same name said twice ("My name is
      // Vance Ejemplo … My name is Vance Ejemplo") is one introduction.
      const tail = f.slice((m.index ?? 0) + m[0].length);
      const key = new RegExp(`^ ${firstAlt}[ _]${last.split(/[ _]/).join("[ _]")}(?= )`).test(tail) ? `self:${m[1]}` : `${i}:${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count++;
      if (introLine >= 0) continue;
      introLine = i;
      introAt = m.index ?? 0;
    }
  });
  if (count !== 1) return false;
  const firstSubstantive = callerLines.findIndex((l) => l.split(/\s+/).filter(Boolean).length >= 3);
  if (introLine !== firstSubstantive) return false;
  const introF = fold((callerLines[introLine] ?? "").replace(/[.!?;,\u2012-\u2015]+/g, " "));
  const after = introF.slice(introAt) + " " + callerLines.slice(introLine + 1).map((l) => fold(l.replace(/[.!?;,\u2012-\u2015]+/g, " "))).join(" ");
  if (AFTER_CORRECTION.test(after)) return false;
  for (const line of callerLines) {
    for (const sentence of line.split(/[.!?;]+/)) {
      const tokens = sentence.trim().split(/[\s,\u2012-\u2015]+/).filter(Boolean);
      // A sentence-opening name is still a name when it introduces a
      // speaker: "Jane speaking", "Jane here", "Jane calling".
      const t0 = fold(tokens[0] ?? "").trim();
      if (/^(?:is|was)$/i.test(fold(tokens[1] ?? "").trim()) && /^[A-Z]/.test(tokens[0] ?? "") && !/^(?:this|it|that|there|he|she|what|here|my|who|which|today|tomorrow|everything|nothing)$/i.test(t0) && !t0.split(/[ _]/).every((x) => own.has(x))) return false;
      const lead = /^\s*([A-Z][\p{L}'-]*)\s*,/u.exec(sentence)?.[1];
      if (lead && !/^(?:hi|hello|hey|yes|yeah|yep|okay|ok|well|so|um|uh|oh|sorry|thanks|please|no|hola|bueno|si|s\u00ed|gracias|good|alright|right|sure)$/i.test(lead) && !fold(lead).trim().split(/[ _]/).every((x) => own.has(x))) return false;
      if (/^(?:speaking|here|calling|from|habla|hablando|aqui|llamando)$/i.test(fold(tokens[1] ?? "").trim()) && !t0.split(/[ _]/).every((x) => own.has(x))) return false;
      // "Jane is speaking", in any case: a transcriber that writes "jane is
      // speaking" declares a different speaker all the same (Codex, #421).
      if (/^(?:is|was|esta|estaba)$/.test(fold(tokens[1] ?? "").trim()) && /^(?:speaking|calling|here|hablando|llamando|aqui)$/.test(fold(tokens[2] ?? "").trim()) && !t0.split(/[ _]/).every((x) => own.has(x))) return false;
      for (let k = 1; k < tokens.length; k++) {
        const t = tokens[k] ?? "";
        if (!/^\p{Lu}/u.test(t)) continue;
        const f = fold(t).trim();
        if (f === "" || NAME_STOPWORDS.has(f) || f.split(/[ _]/).every((x) => own.has(x))) continue;
        return false;
      }
    }
  }
  return true;
}

/** Words after an introduction phrase that make it plainly not one. */
const NOT_INTRO_AFTER = new Set("sorry sure been about for regarding going gonna calling scheduled trying looking having urgent important".split(" "));

/** Correction or apology markers that must not follow the introduction. */
const AFTER_CORRECTION = / (?:excuse me|pardon|sorry|i mean|i meant|actually|mejor dicho|perdon|perdona|disculpe|disculpa|en realidad|quiero decir|digo|o sea|corrijo|rectifico|make that|wait|oops|no) /;

/** Quoting, recording or reading cues anywhere in the call. */
const QUOTING_CUES = / (?:grabacion|grabado|grabada|comienza|empieza|asi|mensaje|dice|dijo|decia|lee|leer|contestadora|buzon|recording|recorded|begins|began|starts|started|reads|read|says|said|quote|quoted|voicemail|message|transcript|playback|reading|chart|nurse|staff|charts|expediente|leyendo|leo) /;

/** Capitalised words that are not a personal name. */
const NAME_STOPWORDS = new Set((
  "i i_m i_ve i_ll i_d ok okay dr doctor mr mrs ms miss azul vision coordinator coordinators " +
  "monday tuesday wednesday thursday friday saturday sunday " +
  "january february march april may june july august september october november december " +
  "lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre"
).split(" "));

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
  "sorry sure about for regarding been " +
  "returning following getting interested needing waiting ready able unable confused urgent important " +
  "paciente la el de para su del mama madre hijo hija esposo esposa llamando"
).split(" "));

/** Words that may directly follow the name in a genuine introduction. */
const AFTER_NAME = new Set((
  "and i calling speaking here again um uh um_hm yes ok okay thank thanks please " +
  "llamando hablando estoy zero oh one two three four five six seven eight nine cero uno dos tres cuatro cinco seis siete ocho nueve"
).split(" "));

/** Any correction anywhere in the caller's speech. */
const CORRECTION = / (?:i[ _]mean|i[ _]meant|quiero decir|that should be|should be|should have been|correction|scratch that|i said|no wait|rather|digo|i misspoke|let me correct|actually it s|actually it is|actually this is|actually my|make that|make it|change that|instead|wait|oops|my bad|i meant to say|let me rephrase|i got that wrong|err) /;

/** Negation of an introduction or a name word anywhere ("I'm not…", "my
 * surname is not…", "no soy…", "that's not my name"). */
const DENIAL = new RegExp(
  ` (?:${INTRO_PHRASES.map((p) => p.replace(/ /g, "[ _]")).join("|")}) (?:\\w+ ){0,2}?(?:not|never|nunca|no) ` +
    `| (?:not|never|nunca|no|isn_t|wasn_t|ain_t) (?:\\w+ ){0,2}(?:name|names|surname|apellido|nombre|me|mine|him|her) ` +
    `| (?:isn_t|wasn_t|ain_t|n_t) (?:\\w+ ){0,1}(?:name|surname) | no soy | no me llamo `,
);

/** Any other person in the caller's or agent's words: "This is Mary Smith,
 * my mother", "How does your mother introduce herself?". A caller speaking for
 * or about someone else is ambiguity.
 *
 * Read as a TOKEN START, so a plural or a possessive ("my granddaughter's",
 * "my kids'", "mother-in-law", which fold to granddaughter_s, kids,
 * mother_in_law) is the same word: three Codex rounds on #421 found a
 * relative the bare word list missed (grandson, granddaughter's, "for the
 * patient"). The caller's OWN name is blanked before this is read, so a
 * record named Ella, Tia or Son is not a relative of itself (`withoutOwnName`). */
const RELATION_WORDS = (
  "she he her him his hers herself himself mother mom mum father dad daughter son husband wife sister brother " +
  "grandmother grandfather grandma grandpa grandson granddaughter grandchild grandchildren grandkid granddad grandmom grandparent " +
  "stepson stepdaughter stepmother stepfather stepmom stepdad aunt uncle niece nephew cousin child children kid parent spouse partner " +
  "caregiver guardian behalf relative family friend neighbor " +
  "ella el_la madre mama padre papa hija hijo esposo esposa marido hermana hermano abuela abuelo nieto nieta " +
  "sobrino sobrina primo prima tia tio suegro suegra yerno nuera novio novia " +
  "introduce introduces introduced presenta"
).split(" ");
const THIRD_PARTY = new RegExp(
  `(?<= )(?:${RELATION_WORDS.join("|")})(?:s|es)?(?=[ _])` +
    `|(?<= )(?:the|my|our|this|la|el|mi|su|nuestra|nuestro) (?:patient|paciente)(?:s|es)?(?=[ _])`,
);

/** A folded line with the record's own name tokens blanked, so the name being
 * confirmed never reads as somebody else. A second mention of it is still
 * caught by the mention count. */
function withoutOwnName(folded: string, own: readonly string[]): string {
  const words = own.filter((w) => w.length >= 2);
  if (words.length === 0) return folded;
  return folded.replace(new RegExp(`(?<= )(?:${words.join("|")})(?=[ _])`, "g"), " ");
}

/** Agent turns a caller's self-introduction may answer. */
const AGENT_OK = / (?:how can i help|how may i help|help you|name|nombre|who is|who am i|speaking|hello|hi|go ahead|ayudar|en que) /;

/** Words about hearing or playing audio: what follows may be a recording. */
const LISTENING = / (?:listen|listened|listening|dial|dialed|dialled|dialing|sound|sounds|sounded|play|plays|played|playing|machine|audio|goes|went|escucho|escuche|oigo|suena) /;

const NAME_TALK = / (?:name|names|named|nombre|llamo|llama|apellido|surname|surnames) /;

/** An agent turn that makes the caller's next words a quotation. */
const AGENT_QUOTING = / (?:said|say|says|saying|quote|quoted|repeat|read|reads|reading|aloud|loud|verbatim|word for word|exactly|dijo|dice|decia|leer|lea|lealo) /;

/** Folded caller words that mark reported speech somewhere in the call. */
const REPORTERS = new Set([
  "said", "says", "saying", "told", "tells", "asked", "wrote", "stated",
  "states", "replied", "replies", "responded", "say", "tell", "telling", "answered", "answers", "answering", "greeting", "repeated", "introduced", "introduces", "herself", "himself", "themselves", "announced", "claimed", "claims", "shows", "showed", "screen", "message", "email", "mail", "text", "letter", "note", "reads", "read", "recording", "voicemail", "dijo", "dice", "decia", "mensaje",
]);
