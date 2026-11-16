/**
 * WHAT THE CALLER ASKED FOR, READ FROM THE RECORDING — v201.
 *
 * Operator, 2026-11-11: tickets that say "reason not captured" leave staff
 * calling back just to find out what the call was about, and that has to stop.
 *
 * Measured over the fourteen Pacific days 2026-10-28..11-10: 290 agent
 * tickets on optical, surgery, tech and records carried the ticketing app's
 * "Callback needed - reason not captured" subject (surgery 88, optical 77,
 * records 65, tech 60). On 263 of them no filing tool ran at all: the teardown
 * request sweep filed them after the caller hung up, and with nothing the
 * model had written down (`draftedRequest.ts`) it sent its placeholder
 * description, which the app subjects that way (`lib/voice-agent/no-reason.ts`).
 * On the business day of 2026-11-10 a transcript reader found the caller had
 * said what they wanted on 31 of the 36.
 *
 * So where the sweep would file the placeholder because nothing was drafted,
 * this asks a model for ONE short plain sentence of what the caller asked for.
 * Extraction is the model's job, not a regex's (standing instruction 3); the
 * same model and account the grader and `nameFromTheRecording.ts` already use
 * (gpt-4o-mini on OPENAI_API_KEY), so the transcript goes nowhere it does not
 * already go.
 *
 * WHAT MAKES IT SAFE ENOUGH TO PUT IN A DESCRIPTION nobody watched being filed:
 *   1. The answer is CHECKED in code (`usableRequest`), and anything that
 *      fails a check is dropped, never trimmed into shape: bounded length,
 *      at least three words, no run of digits that reads like a phone number,
 *      a date or a year, no month-and-day, no date-of-birth words, no email,
 *      no web address, no street address, no "Dr. <Name>"-shaped title, and
 *      none of the patient names this call already holds (a containment check
 *      against names we have, not a name detector). An answer that says
 *      nothing specific ("Wants a call back", "No request stated") is dropped
 *      too, so a call that really said nothing keeps the placeholder and the
 *      app's callback-needed flag stays honest.
 *   2. GSM-7 sanitised, like every description the filing tools send.
 *   3. The staff side of the ticket says where the sentence came from.
 *   4. No key, a timeout, an error, a refusal, or the off switch
 *      (REQUEST_FROM_RECORDING_DISABLED=1) answers null, and the sweep files
 *      exactly what it filed before.
 *
 * It never sets a request reason. On Medical Records it is the description
 * too since v203 (operator, 2026-11-11): a records request opens a case on
 * pathway review, because a swept ticket states no requester; see the note
 * above `REQUEST_FROM_RECORDING_NOTE` in `requestSweep.ts`.
 *
 * NOT CAUGHT, stated: a person's name the call does not hold, said with no
 * title ("Wants records for Maria sent over"). The description is staff-facing
 * (the app does not text it), so that is a name on a ticket, not a disclosure.
 *
 * v241: A SENTENCE THAT FAILS A CONTENT CHECK GETS ONE MORE ASK. Measured in
 * the deployment log, 2026-11-12..15: 75 sentences came back and 16 (21%)
 * failed a check, and every one of the 16 left the ticket on the placeholder,
 * with nothing asked again. On the placeholder corpus of 2026-11-12/13 (37
 * tickets), at least 5 calls held a real request the caller said plainly (a
 * doctor named, a visit date, a glasses order) that a sentence naming the
 * doctor or the date would carry, and the checks were right to drop. So when
 * the reason is the CONTENT (a number or date, an email or web address, a
 * street address, a person's name or title, or the length) the model is told
 * which kind of thing to leave out and asked once more; the second answer goes
 * through the same checks, and a second failure files the placeholder as
 * before. A sentence that says nothing was asked, the placeholder, or only
 * words with no topic is a correct drop and is never asked again. The held
 * names are never sent back to the model. Each failure is logged with its kind
 * and the call's SID, never the sentence.
 */
import OpenAI from "openai";
import { sanitizeForSms } from "../services/gsm7";
import { nameKey } from "../tools/verifiedIdentity";

/**
 * v241: the second ask. `previous` is the model's own first sentence, handed
 * back so it can rewrite it; `leaveOut` says which kind of thing made it
 * unusable. Never a held name.
 */
export interface RequestRetry {
  previous: string;
  leaveOut: string;
}

/** What the model was asked, answered as it answered. Injected in tests. */
export type RequestAsker = (
  transcript: string,
  retry?: RequestRetry,
) => Promise<{ request?: string | null } | null>;

/** Teardown waits on this; the caller has already gone. */
export const REQUEST_READ_TIMEOUT_MS = 6_000;
export const REQUEST_MODEL = "gpt-4o-mini";
/** One short sentence. Longer is dropped, not cut. */
export const REQUEST_MAX_CHARS = 160;
export const REQUEST_MIN_CHARS = 12;

export const REQUEST_INSTRUCTIONS =
  "You read a phone call transcript from an eye-care practice. Lines start with AGENT: or CALLER:. " +
  "The caller hung up before the agent wrote their request down. " +
  "Write ONE short plain sentence, in English, of what the CALLER asked the practice to do or wanted to know, " +
  "so a staff member can act on it without calling back to ask what the call was about. " +
  'Examples: "Wants to reschedule a post-op visit to next week." "Asking whether contact lenses have arrived." ' +
  "Start with a word like Wants, Asking, Needs or Requesting. Use only what the CALLER asked for; never add what the agent said or offered. " +
  "Do not include any names of people, dates of birth, dates, phone or fax numbers, email addresses, street addresses, " +
  "ticket numbers or any other numbers. At most 20 words. " +
  "If the caller did not say what they wanted, return null. Do not guess. " +
  'Answer with JSON only: {"request": string or null}.';

let client: OpenAI | null = null;

/** The production asker. Null when there is no key, when switched off, or on any failure. */
export const askModelForTheRequest: RequestAsker = async (transcript, retry) => {
  const key = process.env.OPENAI_API_KEY;
  if (process.env.REQUEST_FROM_RECORDING_DISABLED === "1") return null;
  if (!key || !transcript.trim()) return null;
  client ??= new OpenAI({ apiKey: key, timeout: REQUEST_READ_TIMEOUT_MS, maxRetries: 0 });
  const res = await client.chat.completions.create({
    model: REQUEST_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: requestMessages(transcript, retry),
  });
  const text = res.choices[0]?.message?.content ?? "";
  const parsed = JSON.parse(text) as { request?: unknown } | null;
  // v245 (github-actions review of #488): the model's value is passed through
  // as it came, never normalised to null. `askOnce` is the one place that
  // decides what it is: an explicit null or a blank sentence is the model
  // reading no request; a missing field, a number, an object or any other
  // shape is a format failure, so the call keeps what main files.
  return { request: parsed?.request as string | null | undefined };
};

/**
 * The messages the model is sent. On the second ask the conversation carries
 * the model's own first answer and one correction naming what to leave out.
 */
export function requestMessages(
  transcript: string,
  retry?: RequestRetry,
): { role: "system" | "user" | "assistant"; content: string }[] {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: REQUEST_INSTRUCTIONS },
    { role: "user", content: transcript },
  ];
  if (retry) {
    messages.push({ role: "assistant", content: JSON.stringify({ request: retry.previous }) });
    messages.push({ role: "user", content: retryCorrection(retry.leaveOut) });
  }
  return messages;
}

/** The correction for the second ask: what was wrong, then the rules again. */
export function retryCorrection(leaveOut: string): string {
  return (
    `That sentence cannot go on the ticket: ${leaveOut} ` +
    "Write it again as ONE short plain sentence of what the CALLER asked for, at most 20 words, " +
    "starting with Wants, Asking, Needs or Requesting. " +
    "Refer to people only by their role, such as the doctor, the patient, the pharmacy or a family member. " +
    "Do not include any names, dates, times, numbers, email or web addresses, or street addresses. " +
    "If the caller did not say what they wanted, return null. Do not guess. " +
    'Answer with JSON only: {"request": string or null}.'
  );
}

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** The same months, every one but May, which is also an ordinary word ("she may first need…"). */
const MONTH_NOT_MAY =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** Spanish months, read on an accent-folded copy. */
const MONTH_ES =
  "(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|se?tiembre|septiembre|octubre|noviembre|diciembre)";
const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
/** A day of the month spoken as a word, ordinal: first … thirty-first. */
const DAY_ORDINAL =
  "(?:(?:twenty|thirty)[\\s-]+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)";
/** A day of the month spoken as a word, cardinal: one … thirty-one. */
const DAY_CARDINAL =
  "(?:(?:twenty|thirty)(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";
/** A Spanish day of the month: uno … treinta y uno, primero. */
const DAY_ES =
  "(?:primero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci(?:seis|siete|ocho|nueve)|veinte|veinti(?:uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)|treinta(?:\\s+y\\s+uno)?)";
/** A number spoken as words, for a house number read out ("twelve thirty four"). */
const NUMBER_WORD =
  "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)";
/** Street words, full and abbreviated, capitalised as a street name is. */
const STREET_WORD_CAPITALISED =
  "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Terrace|Ter|Trail|Trl|Plaza|Square|Sq|Loop|Crescent|Alley)";

/**
 * v241: why a sentence was dropped. The content kinds are what a second ask
 * can fix; the last three are the model telling us nothing was asked, and are
 * never asked again.
 */
export type UnusableKind =
  | "too_short"
  | "too_long"
  | "too_few_words"
  | "number_or_date"
  | "contact"
  | "address"
  | "person"
  | "says_nothing"
  | "placeholder"
  | "no_topic";

/** The kinds a second ask can fix. */
export const RETRYABLE_KINDS: ReadonlySet<UnusableKind> = new Set<UnusableKind>([
  "too_short",
  "too_long",
  "too_few_words",
  "number_or_date",
  "contact",
  "address",
  "person",
]);

/** What the second ask tells the model to leave out, by kind. */
export const LEAVE_OUT: Readonly<Record<UnusableKind, string>> = {
  too_short: "it was too short to act on; it must name what the caller wanted in at least three words.",
  too_few_words: "it was too short to act on; it must name what the caller wanted in at least three words.",
  too_long: "it was too long; it must be at most 20 words.",
  number_or_date: "it contained a number, a date, a time, a year or a date of birth.",
  contact: "it contained an email or web address.",
  address: "it contained a street address, a suite or unit number, or a PO box.",
  person: "it contained a person's name or title.",
  says_nothing: "",
  placeholder: "",
  no_topic: "",
};

/**
 * Shapes that must never reach a description. Each is a reason to DROP the
 * answer; none of them edits it. v241: each carries the kind of thing it
 * caught, which is what the second ask names.
 */
const NEVER_IN_A_DESCRIPTION: readonly { re: RegExp; kind: UnusableKind }[] = [
  // Seven or more digits, however they are separated: a phone or fax number.
  { re: /\d(?:[\s().\/-]*\d){6,}/, kind: "number_or_date" },
  // Four digits in a row: a year, a ZIP code, a ticket or account number.
  { re: /\d{4,}/, kind: "number_or_date" },
  // A numeric date: 1/2, 01-02-50, 3.14.
  { re: /\b\d{1,2}\s*[\/.-]\s*\d{1,2}\b/, kind: "number_or_date" },
  // A month with a day number, either order: "March 3", "3rd of March".
  { re: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "i"), kind: "number_or_date" },
  { re: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "i"), kind: "number_or_date" },
  // v205: the same dates SPOKEN AS WORDS, either order: "March third",
  // "June twenty first", "the twenty-first of June", "third of March". May
  // before a day counts only as the capitalised month before an ordinal
  // ("May fifth"): "she may first need a referral" is English.
  { re: new RegExp(`\\b${MONTH_NOT_MAY}\\.?\\s+(?:the\\s+)?${DAY_ORDINAL}\\b`, "i"), kind: "number_or_date" },
  { re: new RegExp(`\\bMay\\s+(?:the\\s+)?${DAY_ORDINAL}\\b`), kind: "number_or_date" },
  { re: new RegExp(`\\b${MONTH_NOT_MAY}\\.?\\s+${DAY_CARDINAL}\\b`, "i"), kind: "number_or_date" },
  { re: new RegExp(`\\b(?:${DAY_ORDINAL}|${DAY_CARDINAL})\\s+of\\s+${MONTH}\\b`, "i"), kind: "number_or_date" },
  // A spelled-out year or four spelled digits in a row (a number read out).
  {
    re: /\b(?:nineteen|twenty)[\s-]+(?:oh|hundred|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i,
    kind: "number_or_date",
  },
  // v205: a year from 2000 on, read out ("two thousand five").
  { re: /\btwo[\s-]+thousand\b/i, kind: "number_or_date" },
  { re: new RegExp(`\\b${DIGIT_WORD}(?:[\\s,-]+${DIGIT_WORD}\\b){3,}`, "i"), kind: "number_or_date" },
  // Date-of-birth words.
  { re: /\b(?:born|birth\s*date|date\s+of\s+birth|birthday|dob|d\.o\.b)\b/i, kind: "number_or_date" },
  // An email address or a web address.
  { re: /@|https?:|\bwww\.|\.(?:com|net|org)\b/i, kind: "contact" },
  // A street address: a house number, a word or two, a street word.
  {
    re: /\b\d{1,5}\s+[a-z]+(?:\s+[a-z]+)?\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl)\b/i,
    kind: "address",
  },
  // v205: a longer one, as the model writes a street name, capitalised: a
  // house number (digits, or read out as words), up to four capitalised words,
  // a capitalised street word: "12 Old Mill Creek Road", "1234 N Main St",
  // "twelve thirty four Main Street". Capitalised because "3 pairs shipped the
  // fastest way" is not an address. Each word starts with a capital and ends
  // at required whitespace, so nothing here can backtrack without end.
  {
    re: new RegExp(`\\b(?:\\d{1,6}|${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD}){0,3})\\s+(?:[A-Z][a-z]*\\.?\\s+){1,4}${STREET_WORD_CAPITALISED}\\b`),
    kind: "address",
  },
  // v205: the rest of an address: a suite, unit or apartment number, a PO box.
  { re: /\b(?:[Ss]uite|[Ss]te|[Aa]pt|[Aa]partment|[Uu]nit)\.?\s*#?\s*(?:\d|[A-Z]\b)/, kind: "address" },
  { re: /#\s*\d/, kind: "address" },
  { re: /\bp\.?\s*o\.?\s*box\b|\bpost\s+office\s+box\b/i, kind: "address" },
  // A title followed by a capitalised word: a person named.
  { re: /\b(?:[Dd]r|[Dd]octor|[Mm]rs?|[Mm]s|[Mm]iss|[Nn]urse)\.?\s+[A-Z][a-z]/, kind: "person" },
];

/**
 * v205: a named street with no house number is a place, not an address
 * ("the CVS on Foothill Boulevard" tells staff which pharmacy), so it is
 * refused only beside a word that makes it somebody's home or mailing
 * address ("mailed to West Foothill Boulevard"). Measured over 14 Pacific
 * days of agent ticket text on optical, surgery, tech and records
 * (2026-10-28..11-10, 10,601 request-sized sentences): a bare named street
 * appears in 485, 449 of them a pharmacy on the tech line; with a home or
 * mailing word, 2, neither a pharmacy. Capitalised, and not the sentence's
 * first word ("Wants Court papers" is not a street).
 */
const NAMED_STREET =
  /(?<=\s)(?:[A-Z][a-z]+\s+){1,4}(?:Street|Avenue|Road|Boulevard|Drive|Lane|Way|Court|Place|Circle|Parkway|Highway|Terrace|Trail|Plaza)\b/;
const HOME_OR_MAILING = /\b(?:mail|mailed|mailing|home|lives?|living|resides?|address)\b/i;

/**
 * v205: Spanish dates and years, read on an accent-folded, lower-cased copy
 * ("tres de marzo", "3 de marzo", "marzo 3", "dos mil cinco"). The model is
 * asked for English, and does not always answer in it.
 */
const NEVER_IN_A_DESCRIPTION_ES: readonly RegExp[] = [
  new RegExp(`\\b(?:${DAY_ES}|\\d{1,2})\\s+de\\s+${MONTH_ES}\\b`),
  new RegExp(`\\b${MONTH_ES}\\s+\\d{1,2}\\b`),
  /\b(?:dos\s+mil|mil\s+novecientos)\b/,
];

/** Lower-cased, accents removed: what the Spanish shapes are read against. */
function folded(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The model telling us it found nothing. */
const SAYS_NOTHING_WAS_ASKED =
  /\b(?:no (?:clear |specific |actual )?(?:request|reason)|(?:did not|didn't|does not|doesn't) (?:say|state|specify|mention|give)|not (?:stated|said|clear|specified|provided|mentioned|given)|unclear|unknown|unspecified|nothing specific|n\/a)\b/i;
const SAYS_NOTHING_WAS_ASKED_ALL = new RegExp(SAYS_NOTHING_WAS_ASKED.source, "gi");

/**
 * v245 (github-actions review of #488): the words a no-request conclusion is
 * built from, beside the says-nothing phrase itself. "Caller did not state a
 * specific request." is made of nothing else; "Wants clarification of unclear
 * pre-surgery instructions" is not, because "clarification", "pre-surgery"
 * and "instructions" are a topic.
 */
const NO_REQUEST_CONCLUSION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "any", "anything", "nothing", "no", "caller", "callers", "caller's", "patient", "patient's", "they", "he", "she", "it",
  "their", "his", "her", "what", "why", "was", "were", "is", "are", "been", "be", "for", "of", "to", "about", "this",
  "call", "calling", "called", "request", "requests", "reason", "reasons", "purpose", "specific", "clear", "actual",
  "particular", "made", "given", "stated", "mentioned", "provided", "said", "asked", "wanted", "needed", "want", "need",
  "on", "and", "or", "so", "yet", "there",
]);

/**
 * True only when the whole sentence is a conclusion that nothing was asked:
 * it says so, and once that phrase is taken out every word left is one a
 * conclusion is built from. Anything with a topic in it is not a conclusion,
 * so it is dropped as before and the call files the placeholder (main).
 */
export function concludesNothingWasAsked(raw: string): boolean {
  const s = sanitizeForSms(String(raw ?? "")).value.replace(/\s+/g, " ").trim();
  if (!SAYS_NOTHING_WAS_ASKED.test(s)) return false;
  const rest = foldWords(s.replace(SAYS_NOTHING_WAS_ASKED_ALL, " "));
  return rest.every((w) => NO_REQUEST_CONCLUSION_WORDS.has(w));
}

/**
 * Words that carry no request on their own. A sentence made only of these
 * ("Wants to speak with someone", "Has a question", "Requesting a call back")
 * names no topic, so it is dropped and the ticket keeps the placeholder:
 * staff would still have to call to find out what the call was about, and the
 * app's "reason not captured" flag is then the truth.
 */
const CARRIES_NO_TOPIC: ReadonlySet<string> = new Set([
  "a", "an", "the", "to", "with", "for", "about", "on", "of", "and", "or", "in", "at", "from", "if", "be", "is", "was",
  "my", "his", "her", "their", "our", "your", "them", "they", "he", "she", "someone", "somebody", "anyone", "anybody",
  "caller", "patient", "wants", "want", "wanted", "wanting", "asking", "asks", "asked", "ask", "needs", "need", "needed",
  "requesting", "requests", "requested", "request", "calling", "called", "calls", "call", "would", "like", "has", "have",
  "had", "get", "speak", "speaking", "talk", "talking", "back", "callback", "return", "returning", "returned", "missed",
  "person", "live", "human", "real", "representative", "agent", "staff", "team", "member", "someone's", "question",
  "questions", "help", "information", "info", "assistance", "something", "general", "message", "leave", "leaving",
  "transferred", "transfer", "connected", "connect", "please", "again",
]);

function foldWords(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * A name broken into words the way the identity store folds a name
 * (`nameKey`: accents gone, an apostrophe, hyphen or full stop a space), then
 * anything else that is not a letter a space too. Both sides go through it, so
 * "O'Brien", "O’Brien", "OBrien", "O Brien" and the possessive "O'Brien's"
 * meet on the same words. v205: the sentence used to keep the apostrophe in
 * the word and the held name did not, so "Lake's" and "O’Brien" got through.
 */
function nameWords(s: string): string[] {
  return nameKey(s)
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when a name half we already hold for this call appears in the sentence as words. */
function namesAHeldName(sentence: string, heldNames: readonly string[]): boolean {
  const words = nameWords(sentence);
  const joined = ` ${words.join(" ")} `;
  // A name the model ran together or split ("OBrien" / "O Brien"): every
  // word, and every two neighbouring words written as one.
  const solid = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) solid.add(words[i] + words[i + 1]);
  for (const raw of heldNames) {
    const half = nameWords(raw ?? "");
    if (!half.length) continue;
    const compact = half.join("");
    if (compact.length >= 2 && joined.includes(` ${half.join(" ")} `)) return true;
    if (compact.length >= 3 && solid.has(compact)) return true;
    for (const w of half) if (w.length >= 3 && words.includes(w)) return true;
  }
  return false;
}

/**
 * The sentence cleaned for a ticket description, or why it cannot be one.
 * The checks that mean the model found nothing (it says so, it is the
 * placeholder, or every word carries no topic) are read first, so a sentence
 * that is both a no-topic line and carries a number ("Wants a call back at
 * <number>") reads as no_topic and is not asked again. Whether a sentence is
 * dropped does not depend on that order; only the kind does.
 */
export function checkRequest(
  raw: string | null | undefined,
  heldNames: readonly string[] = [],
): { sentence: string } | { kind: UnusableKind } {
  let s = sanitizeForSms(String(raw ?? "")).value.replace(/\s+/g, " ").trim();
  s = s.replace(/^["']+|["']+$/g, "").trim();
  if (SAYS_NOTHING_WAS_ASKED.test(s)) return { kind: "says_nothing" };
  if (/callback request taken/i.test(s)) return { kind: "placeholder" };
  if (foldWords(s).every((w) => CARRIES_NO_TOPIC.has(w))) return { kind: "no_topic" };
  if (s.length < REQUEST_MIN_CHARS) return { kind: "too_short" };
  if (s.length > REQUEST_MAX_CHARS) return { kind: "too_long" };
  if (s.split(" ").length < 3) return { kind: "too_few_words" };
  const hit = NEVER_IN_A_DESCRIPTION.find(({ re }) => re.test(s));
  if (hit) return { kind: hit.kind };
  if (NAMED_STREET.test(s) && HOME_OR_MAILING.test(s)) return { kind: "address" };
  const plain = folded(s);
  if (NEVER_IN_A_DESCRIPTION_ES.some((re) => re.test(plain))) return { kind: "number_or_date" };
  if (namesAHeldName(s, heldNames)) return { kind: "person" };
  return { sentence: /[.!?]$/.test(s) ? s : `${s}.` };
}

/**
 * The model's sentence, cleaned for a ticket description, or undefined.
 * `heldNames` is every patient name half this call holds (verified, stated,
 * heard, the calling number's record, the pre-context candidate).
 */
export function usableRequest(raw: string | null | undefined, heldNames: readonly string[] = []): string | undefined {
  const checked = checkRequest(raw, heldNames);
  return "sentence" in checked ? checked.sentence : undefined;
}

/** Why a sentence cannot be a description, or undefined when it can. */
export function whyUnusable(raw: string | null | undefined, heldNames: readonly string[] = []): UnusableKind | undefined {
  const checked = checkRequest(raw, heldNames);
  return "kind" in checked ? checked.kind : undefined;
}

/**
 * One ask, as it came back. `none` is the MODEL saying the caller asked for
 * nothing (`{"request": null}` or an empty sentence); `not_asked` is an asker
 * that did not ask at all (no key, switched off, no transcript), which says
 * nothing about the call; `failed` is a throw.
 */
type AskResult =
  | { kind: "answer"; text: string }
  | { kind: "none" }
  | { kind: "not_asked" }
  | { kind: "failed" };

async function askOnce(
  ask: RequestAsker,
  transcript: string,
  retry: RequestRetry | undefined,
  where: string,
): Promise<AskResult> {
  let answer: Awaited<ReturnType<RequestAsker>> = null;
  try {
    answer = await ask(transcript, retry);
  } catch (e) {
    // The error type only: an error body could carry the transcript.
    console.warn(
      `[REQUEST FROM RECORDING] the model did not answer${retry ? " the second ask" : ""} (${(e as Error)?.name ?? "error"})${where}`,
    );
    return { kind: "failed" };
  }
  if (!answer) return { kind: "not_asked" };
  // v245 (github-actions review of #488): a missing or non-string request is
  // a malformed answer, not the model reading no request. Only an explicit
  // null or a blank sentence is `none`.
  const request: unknown = (answer as { request?: unknown }).request;
  if (request !== null && typeof request !== "string") {
    console.warn(`[REQUEST FROM RECORDING] the model's answer had no usable request field${retry ? " on the second ask" : ""}${where}`);
    return { kind: "failed" };
  }
  if (request === null || !request.trim()) {
    // v241: counted, so the calls where the model read no request can be read
    // back by SID. v245 (held for the operator): on the queue lanes a first
    // ask that answers this files nothing.
    console.info(`[REQUEST FROM RECORDING] the model read no request${retry ? " on the second ask" : ""}${where}`);
    return { kind: "none" };
  }
  return { kind: "answer", text: request };
}

/**
 * v245: WHAT THE READER CONCLUDED, not only the sentence. `nothing_asked` is
 * the model's own answer on the FIRST ask: no request (`{"request": null}`),
 * or a sentence saying nothing was asked. `person_only` is a sentence whose
 * every word carries no topic ("Wants to speak with someone"). A sentence
 * that failed a content check (after v241's second ask) is `dropped`; a throw,
 * or an asker that never asked, is `failed`. Only `nothing_asked` changes what
 * the sweep files, and only on the lanes `sweepRunner` names.
 */
export type RequestReading =
  | { verdict: "read"; request: string }
  | { verdict: "nothing_asked" }
  | { verdict: "person_only" }
  | { verdict: "dropped"; kind: UnusableKind | "none_on_the_second_ask" }
  | { verdict: "failed" };

/**
 * What the reader concluded about the call. Never throws; the caller of this
 * is a teardown filer with nobody watching. v241: a sentence that fails a
 * content check is asked for once more, naming what to leave out; the second
 * answer is checked the same way. `callSid` only labels the log lines.
 */
export async function readTheRequest(
  transcript: string,
  ask: RequestAsker = askModelForTheRequest,
  heldNames: readonly string[] = [],
  callSid?: string,
): Promise<RequestReading> {
  const where = callSid ? ` (${callSid})` : "";
  const first = await askOnce(ask, transcript, undefined, where);
  if (first.kind === "none") return { verdict: "nothing_asked" };
  if (first.kind !== "answer") return { verdict: "failed" };
  const checked = checkRequest(first.text, heldNames);
  if ("sentence" in checked) return { verdict: "read", request: checked.sentence };
  // PHI-free: which kind of check, never what the sentence said.
  if (!RETRYABLE_KINDS.has(checked.kind)) {
    console.warn(`[REQUEST FROM RECORDING] the model's sentence failed a check (${checked.kind}) — not used${where}`);
    // v245 (github-actions review of #488): only a sentence that is wholly a
    // no-request conclusion counts as the model reading nothing. A says-nothing
    // word inside a real request ("unclear instructions") is dropped as before.
    if (checked.kind === "says_nothing" && concludesNothingWasAsked(first.text)) return { verdict: "nothing_asked" };
    if (checked.kind === "no_topic") return { verdict: "person_only" };
    return { verdict: "dropped", kind: checked.kind };
  }
  console.warn(`[REQUEST FROM RECORDING] the model's sentence failed a check (${checked.kind}) — asking once more${where}`);
  const second = await askOnce(ask, transcript, { previous: first.text, leaveOut: LEAVE_OUT[checked.kind] }, where);
  // The first answer held a sentence, so a second "none" is not the model
  // reading no request; the call keeps what main files.
  if (second.kind === "none") return { verdict: "dropped", kind: "none_on_the_second_ask" };
  if (second.kind !== "answer") return { verdict: "dropped", kind: checked.kind };
  const again = checkRequest(second.text, heldNames);
  if ("sentence" in again) {
    console.info(`[REQUEST FROM RECORDING] the second answer was used${where}`);
    return { verdict: "read", request: again.sentence };
  }
  console.warn(`[REQUEST FROM RECORDING] the second answer failed a check too (${again.kind}) — not used${where}`);
  return { verdict: "dropped", kind: again.kind };
}

/** What the caller asked for, from the recording, or null (v201's shape). */
export async function requestFromTheRecording(
  transcript: string,
  ask: RequestAsker = askModelForTheRequest,
  heldNames: readonly string[] = [],
  callSid?: string,
): Promise<string | null> {
  const reading = await readTheRequest(transcript, ask, heldNames, callSid);
  return reading.verdict === "read" ? reading.request : null;
}
