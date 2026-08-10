/**
 * Shared caller-answer parsing for the new core.
 *
 * Every line asks for the same handful of things — a name, a date of birth —
 * so they must recognise them identically. Two Gate B findings live here:
 * "So this is the" was accepted as a patient name, and "August twenty-seven,
 * forty-five" was not recognised as a date of birth at all, which sent a
 * verified-able patient to a transfer.
 */

const NOT_NAME_WORDS = new Set([
  'i', 'im', 'me', 'my', 'you', 'your', 'we', 'he', 'she', 'they', 'it', 'this', 'that', 'the', 'a', 'an',
  'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'need', 'want',
  'call', 'called', 'calling', 'seen', 'see', 'before', 'appointment', 'doctor', 'prescription', 'refill',
  'yes', 'no', 'not', 'please', 'thanks', 'thank', 'ok', 'okay', 'hello', 'hi', 'about', 'for', 'with',
  // "Yeah" was missing while "yes" was present, so "Yeah. It’s Wayne Fabian."
  // parsed as first name "Yeah", surname "Wayne Fabian". Callers say all of
  // these; none of them is a name.
  'yeah', 'yep', 'yup', 'nope', 'nah', 'alright', 'um', 'uh', 'er', 'mm', 'mhm', 'hey',
  'and', 'but', 'just', 'know', 'think', 'get', 'got', 'like', 'would', 'could', 'should', 'there', 'here',
  'so', 'well', 'right', 'sure', 'sorry', 'again', 'now', 'then', 'one', 'two', 'first', 'last', 'name',
  // A split utterance ("It's Wayne Fabian. Date of" / "birth is 03/17/1973")
  // put "Date of" in the surname and searched the records for "Wayne Date
  // of" — a patient with 43 appointments came back not found.
  'date', 'dates', 'birth', 'born', 'dob', 'of',
  // Contractions. An apostrophe is legitimate in a surname (O'Brien,
  // D'Angelo), so the token test cannot simply reject one — which is how
  // "It's" came to be filed as a patient's first name. These are listed
  // instead. Deepgram's smart formatting emits the curly apostrophe, so both
  // forms are here; a lookup against the mirror is not the place to discover
  // that U+2019 and U+0027 are different characters.
  "it's", 'it’s', "that's", 'that’s', "he's", 'he’s', "she's", 'she’s',
  "there's", 'there’s', "let's", 'let’s', "we're", 'we’re', "i'm", 'i’m',
  "what's", 'what’s', "who's", 'who’s', "here's", 'here’s', "they're", 'they’re',
  "you're", 'you’re', "don't", 'don’t', "can't", 'can’t', "i've", 'i’ve',
  'si', 'yo', 'mi', 'el', 'la', 'de', 'que', 'por', 'para', 'necesito', 'quiero', 'gracias', 'es', 'soy',
]);

/** Legitimate inside a surname, filler at the start of a sentence. */
const SURNAME_PARTICLES = new Set(['de', 'la', 'las', 'los', 'del', 'van', 'von', 'di', 'da', 'el', 'san', 'santa']);

/** A name is not a sentence: 2-4 real words, none of them filler. */
export function looksLikeName(text: string): { first: string; last: string } | null {
  const raw = text.trim().replace(/^(my name is|this is|it['’]?s|i['’]?m|es|soy)\s+/i, '');
  // "Lemaire, L-E-M-A-I-R-E" — drop the spelled-out echo, keep the word.
  const deSpelled = raw.replace(/\b(?:[a-záéíóúñ]-){2,}[a-záéíóúñ]\b/gi, ' ');
  const words = deSpelled
    .split(/[\s,]+/)
    // Sentence punctuation is not part of a name, and leaving it attached is
    // not harmless: "Yeah. It's Wayne Fabian." lost BOTH real names —
    // "Yeah." and "Fabian." failed the token test on their full stops, while
    // "It's" passed it, because names legitimately contain apostrophes. Two
    // tokens survived, so the check succeeded and returned first name "It's",
    // surname "Wayne". The mirror was then searched for a patient surnamed
    // Wayne, and the live 20:48 call came back no_match with 43 appointments
    // sitting in the record.
    // PUNCTUATION only — not "everything that is not a letter". Stripping
    // digits too turned "17th" into "th", so "March 17th, 1973" answered as a
    // name became first "March", surname "th".
    .map((w) => w.replace(/^[.,;:!?"“”'’()[\]]+|[.,;:!?"“”()[\]]+$/g, ''))
    .filter((w) => /^[a-záéíóúñ'-]{2,}$/i.test(w));
  if (words.length < 2 || words.length > 4) return null;
  // Filler words are rejected anywhere EXCEPT the particles inside a compound
  // surname. "de", "la", "van" and the rest are Spanish and Dutch fillers at
  // the start of a sentence and part of the name in the middle of one, and
  // this practice has a lot of "de la Cruz". Position decides.
  if (words.some((w, i) => NOT_NAME_WORDS.has(w.toLowerCase()) && !(i > 0 && SURNAME_PARTICLES.has(w.toLowerCase()))))
    return null;
  return { first: words[0], last: words.slice(1).join(' ') };
}

/**
 * The name inside a sentence.
 *
 * looksLikeName is deliberately strict — it exists because "I have seen
 * before" was once stored as a patient name — but real callers do not answer
 * in bare names. Live call 2026-08-10:
 *
 *   AGENT:  May I have the patient's first and last name?
 *   CALLER: Sure, the patient's first and last name is Wayne Fabian and the
 *           date of birth is March 17th, 1973.
 *   AGENT:  May I have the patient's first and last name?
 *
 * Perfectly transcribed, perfectly answered, and thrown away. So: peel off
 * the lead-in, cut the sentence at the point another field starts, and hand
 * what is left to the same strict checker. Nothing is loosened — a sentence
 * that still does not look like a name is still rejected.
 */
export function findNameIn(text: string): { first: string; last: string } | null {
  const direct = looksLikeName(text);
  if (direct) return direct;

  // Cut at the point a DIFFERENT field starts, so "and the date of birth is
  // March 17th" can never become part of the surname.
  // "date of" without "birth" is the same clause, split across turns by the
  // transcriber. Cutting only on the complete phrase let the fragment through.
  const trimmed = text.split(/\b(?:date of(?:\s+birth)?|d\.?o\.?b\.?|born|birthday|fecha de nacimiento)\b/i)[0];

  // Branch 1 — the caller SIGNPOSTED it: "...the patient's name is X".
  // Only here do we scan for the name, because the caller told us one is
  // coming. Scanning arbitrary sentences turns "uh let me look it up" into
  // the patient "Uh Let", which is exactly the class of bug the strict
  // parser exists to prevent.
  const named = /\b(?:name is|name'?s|nombre es)\s+(.+)$/i.exec(trimmed);
  if (named) {
    const run: string[] = [];
    for (const tok of named[1].split(/[\s,]+/).filter(Boolean)) {
      const word = tok.replace(/[.,;!?]+$/, '');
      if (/^[a-záéíóúñ'-]{2,}$/i.test(word) && !NOT_NAME_WORDS.has(word.toLowerCase())) {
        run.push(word);
        if (run.length === 4) break;
      } else if (run.length >= 2) {
        break; // a complete name, then a word that is not one — stop there
      } else {
        run.length = 0;
      }
    }
    return run.length >= 2 ? { first: run[0], last: run.slice(1).join(' ') } : null;
  }

  // Branch 2 — no signpost. Drop only conversational lead-in, then hand what
  // is left to the SAME strict checker, which still rejects anything
  // sentence-shaped.
  const stripped = trimmed
    // The separator class must include the FULL STOP: "Sure. It's Wayne
    // Fabian" stopped stripping at "Sure." and filed "It's" as the first name.
    // ['’]? everywhere, and the FULL STOP in the separator class. Deepgram's
    // smart formatting returns "It’s" with a curly apostrophe, which a
    // straight-quote pattern silently fails to match — and then the lead-in
    // survives into the name.
    .replace(/^(?:\s*(?:yes|yeah|yep|sure|ok|okay|so|well|um+|uh+|er+|hi|hello|it['’]?s|its|that['’]?s|this is|my|his|her|their|for|si|s[ií]|claro|bueno)\b[,.'’\s]*)+/i, '')
    .replace(/[.,;!?]+\s*$/, '')
    .trim();
  return stripped ? looksLikeName(stripped) : null;
}

const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5',
  seis: '6', siete: '7', ocho: '8', nueve: '9',
};

/**
 * A phone or fax number read out as words.
 *
 * Live call 2026-08-10: "seven six zero eight six zero one four three four"
 * — a complete, correct fax number that the digit regex could not see, so the
 * agent asked again and filed the ticket without it. Callers read numbers off
 * bottles and letterheads; they do not say "seven-six-zero" as digits.
 *
 * Returns 10 or 11 digits only. A shorter run is an address, a year, or an
 * option number, and guessing at those is how a wrong number reaches a
 * patient's chart.
 */
export function spokenDigitsToNumber(text: string): string | null {
  const tokens = text.toLowerCase().split(/[\s,.-]+/).filter(Boolean);
  let run = '';
  let best = '';
  for (const tok of tokens) {
    const bare = tok.replace(/[^a-z0-9]/g, '');
    if (/^\d+$/.test(bare)) {
      run += bare;
    } else if (SPOKEN_DIGITS[bare] !== undefined) {
      run += SPOKEN_DIGITS[bare];
    } else if (bare === 'double' || bare === 'triple') {
      continue; // handled by the repeat that follows
    } else {
      if (run.length > best.length) best = run;
      run = '';
    }
  }
  if (run.length > best.length) best = run;
  if (best.length === 11 && best.startsWith('1')) return best.slice(1);
  return best.length === 10 ? best : null;
}

const MONTHS =
  '(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)';
const NUMBER_WORDS =
  '(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte|treinta)';

/**
 * Recognise a date of birth in the forms callers actually say:
 * "5/10/1983", "May 10 1983", and — the one that was missing — spoken
 * numbers: "August twenty-seven, forty-five".
 */
export const DOB_PATTERN = new RegExp(
  [
    // 5/10/1983, 5-10-83
    String.raw`\b\d{1,2}[\/\-\s]\d{1,2}[\/\-\s]\d{2,4}\b`,
    // May 10 1983 / May 10th, 1983
    `\\b${MONTHS}\\b[\\s,]+\\d{1,2}(?:st|nd|rd|th)?[\\s,]+(?:19|20)?\\d{2}\\b`,
    // August twenty-seven forty-five  (month + spoken numbers)
    `\\b${MONTHS}\\b[\\s,-]+(?:${NUMBER_WORDS}[\\s,-]*){1,4}`,
    // Month name anywhere plus a 4-digit year later in the sentence
    `\\b${MONTHS}\\b[\\s\\S]{0,30}\\b(?:19|20)\\d{2}\\b`,
  ].join('|'),
  'i',
);

export function looksLikeDob(text: string): boolean {
  return DOB_PATTERN.test(text);
}

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30,
};

const MONTH_NUM: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Take a day off the front of a spoken number sequence: "twenty seven" -> 27. */
function takeDay(vals: number[]): { day: number | null; rest: number[] } {
  if (!vals.length) return { day: null, rest: vals };
  if (vals.length >= 2 && vals[0] >= 20 && vals[0] < 100 && vals[1] < 10) {
    return { day: vals[0] + vals[1], rest: vals.slice(2) };
  }
  return { day: vals[0], rest: vals.slice(1) };
}

/** "nineteen fifty nine" -> 1959, "forty five" -> 45, "nineteen eighty" -> 1980. */
function spokenYear(vals: number[]): number | null {
  if (!vals.length) return null;
  if ((vals[0] === 19 || vals[0] === 20) && vals.length >= 2) {
    return vals[0] * 100 + vals.slice(1).reduce((a, b) => a + b, 0);
  }
  return vals.reduce((a, b) => a + b, 0);
}

/** A two-digit spoken year: 45 -> 1945, 05 -> 2005 (birth years, never future). */
function expandYear(n: number): number {
  if (n >= 100) return n;
  const asTwenty = 2000 + n;
  return asTwenty <= 2026 ? asTwenty : 1900 + n;
}

/**
 * Normalize a spoken date of birth to YYYY-MM-DD, which is what identity
 * verification requires. Recognising "August twenty-seven, forty-five"
 * without converting it left the caller failing verification anyway
 * (review 2026-08-09) — recogniser and converter ship together.
 * Returns null when the utterance is not a usable date.
 */
export function normalizeSpokenDob(text: string): string | null {
  const s = text
    .toLowerCase()
    .replace(/[,]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, '$1'); // "10th" -> "10"
  const iso = s.match(/\b((?:19|20)\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(+iso[2]).padStart(2, '0')}-${String(+iso[3]).padStart(2, '0')}`;
  const numeric = s.match(/\b(\d{1,2})[\/\s.](\d{1,2})[\/\s.](\d{2,4})\b/);
  if (numeric) {
    const y = expandYear(Number(numeric[3]));
    return `${y}-${String(+numeric[1]).padStart(2, '0')}-${String(+numeric[2]).padStart(2, '0')}`;
  }
  const monthMatch = s.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/,
  );
  if (!monthMatch) return null;
  const month = MONTH_NUM[monthMatch[1]];
  const after = s.slice(s.indexOf(monthMatch[1]) + monthMatch[1].length).trim().split(/\s+/);

  let day: number | null = null;
  let year: number | null = null;
  const digits = after.filter((w) => /^\d{1,4}$/.test(w)).map(Number);
  if (digits.length >= 2) {
    day = digits[0];
    year = expandYear(digits[digits.length - 1]);
  } else {
    // Spoken numbers, in order: the day first, then the year.
    const vals = after.map((w) => (/^\d{1,4}$/.test(w) ? Number(w) : WORD_NUM[w])).filter((n): n is number => n !== undefined);
    const taken = takeDay(vals);
    day = taken.day;
    const y = spokenYear(taken.rest);
    year = y === null ? null : expandYear(y);
  }
  if (!day || !year || day < 1 || day > 31 || year < 1900 || year > 2026) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
