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
 * It never sets a request reason. On Medical Records the sweep sends the
 * department's catch-all reason beside it (see `buildSweptTicket`).
 */
import OpenAI from "openai";
import { sanitizeForSms } from "../services/gsm7";

/** What the model was asked, answered as it answered. Injected in tests. */
export type RequestAsker = (transcript: string) => Promise<{ request?: string | null } | null>;

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
export const askModelForTheRequest: RequestAsker = async (transcript) => {
  const key = process.env.OPENAI_API_KEY;
  if (process.env.REQUEST_FROM_RECORDING_DISABLED === "1") return null;
  if (!key || !transcript.trim()) return null;
  client ??= new OpenAI({ apiKey: key, timeout: REQUEST_READ_TIMEOUT_MS, maxRetries: 0 });
  const res = await client.chat.completions.create({
    model: REQUEST_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: REQUEST_INSTRUCTIONS },
      { role: "user", content: transcript },
    ],
  });
  const text = res.choices[0]?.message?.content ?? "";
  const parsed = JSON.parse(text) as { request?: unknown };
  return { request: typeof parsed?.request === "string" ? parsed.request : null };
};

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";

/**
 * Shapes that must never reach a description. Each is a reason to DROP the
 * answer; none of them edits it.
 */
const NEVER_IN_A_DESCRIPTION: readonly RegExp[] = [
  // Seven or more digits, however they are separated: a phone or fax number.
  /\d(?:[\s().\/-]*\d){6,}/,
  // Four digits in a row: a year, a ZIP code, a ticket or account number.
  /\d{4,}/,
  // A numeric date: 1/2, 01-02-50, 3.14.
  /\b\d{1,2}\s*[\/.-]\s*\d{1,2}\b/,
  // A month with a day number, either order: "March 3", "3rd of March".
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "i"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "i"),
  // A spelled-out year or four spelled digits in a row (a number read out).
  /\b(?:nineteen|twenty)[\s-]+(?:oh|hundred|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i,
  new RegExp(`\\b${DIGIT_WORD}(?:[\\s,-]+${DIGIT_WORD}\\b){3,}`, "i"),
  // Date-of-birth words.
  /\b(?:born|birth\s*date|date\s+of\s+birth|birthday|dob|d\.o\.b)\b/i,
  // An email address or a web address.
  /@|https?:|\bwww\.|\.(?:com|net|org)\b/i,
  // A street address: a house number, a word or two, a street word.
  /\b\d{1,5}\s+[a-z]+(?:\s+[a-z]+)?\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl)\b/i,
  // A title followed by a capitalised word: a person named.
  /\b(?:[Dd]r|[Dd]octor|[Mm]rs?|[Mm]s|[Mm]iss|[Nn]urse)\.?\s+[A-Z][a-z]/,
];

/** The model telling us it found nothing. */
const SAYS_NOTHING_WAS_ASKED =
  /\b(?:no (?:clear |specific |actual )?(?:request|reason)|(?:did not|didn't|does not|doesn't) (?:say|state|specify|mention|give)|not (?:stated|said|clear|specified|provided|mentioned|given)|unclear|unknown|unspecified|nothing specific|n\/a)\b/i;

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

/** True when a name half we already hold for this call appears in the sentence as words. */
function namesAHeldName(sentence: string, heldNames: readonly string[]): boolean {
  const words = foldWords(sentence).map((w) => w.replace(/'/g, ""));
  const joined = ` ${words.join(" ")} `;
  for (const raw of heldNames) {
    const half = foldWords(raw ?? "").map((w) => w.replace(/'/g, "")).filter(Boolean);
    if (!half.length) continue;
    if (half.join("").length >= 2 && joined.includes(` ${half.join(" ")} `)) return true;
    for (const w of half) if (w.length >= 3 && words.includes(w)) return true;
  }
  return false;
}

/**
 * The model's sentence, cleaned for a ticket description, or undefined.
 * `heldNames` is every patient name half this call holds (verified, stated,
 * heard, the calling number's record, the pre-context candidate).
 */
export function usableRequest(raw: string | null | undefined, heldNames: readonly string[] = []): string | undefined {
  let s = sanitizeForSms(String(raw ?? "")).value.replace(/\s+/g, " ").trim();
  s = s.replace(/^["']+|["']+$/g, "").trim();
  if (s.length < REQUEST_MIN_CHARS || s.length > REQUEST_MAX_CHARS) return undefined;
  if (s.split(" ").length < 3) return undefined;
  if (NEVER_IN_A_DESCRIPTION.some((re) => re.test(s))) return undefined;
  if (SAYS_NOTHING_WAS_ASKED.test(s)) return undefined;
  if (/callback request taken/i.test(s)) return undefined;
  if (foldWords(s).every((w) => CARRIES_NO_TOPIC.has(w))) return undefined;
  if (namesAHeldName(s, heldNames)) return undefined;
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * What the caller asked for, from the recording, or null. Never throws; the
 * caller of this is a teardown filer with nobody watching.
 */
export async function requestFromTheRecording(
  transcript: string,
  ask: RequestAsker = askModelForTheRequest,
  heldNames: readonly string[] = [],
): Promise<string | null> {
  let answer: Awaited<ReturnType<RequestAsker>> = null;
  try {
    answer = await ask(transcript);
  } catch (e) {
    // The error type only: an error body could carry the transcript.
    console.warn(`[REQUEST FROM RECORDING] the model did not answer (${(e as Error)?.name ?? "error"})`);
    return null;
  }
  if (!answer || typeof answer.request !== "string" || !answer.request.trim()) return null;
  const sentence = usableRequest(answer.request, heldNames);
  if (!sentence) {
    // PHI-free: that it happened, never what the sentence said.
    console.warn("[REQUEST FROM RECORDING] the model's sentence failed a check — not used");
    return null;
  }
  return sentence;
}
