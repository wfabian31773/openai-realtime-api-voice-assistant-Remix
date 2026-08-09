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
  'and', 'but', 'just', 'know', 'think', 'get', 'got', 'like', 'would', 'could', 'should', 'there', 'here',
  'so', 'well', 'right', 'sure', 'sorry', 'again', 'now', 'then', 'one', 'two', 'first', 'last', 'name',
  'si', 'yo', 'mi', 'el', 'la', 'de', 'que', 'por', 'para', 'necesito', 'quiero', 'gracias', 'es', 'soy',
]);

/** A name is not a sentence: 2-4 real words, none of them filler. */
export function looksLikeName(text: string): { first: string; last: string } | null {
  const raw = text.trim().replace(/^(my name is|this is|it'?s|i'?m|es|soy)\s+/i, '');
  // "Lemaire, L-E-M-A-I-R-E" — drop the spelled-out echo, keep the word.
  const deSpelled = raw.replace(/\b(?:[a-záéíóúñ]-){2,}[a-záéíóúñ]\b/gi, ' ');
  const words = deSpelled.split(/[\s,]+/).filter((w) => /^[a-záéíóúñ'-]{2,}$/i.test(w));
  if (words.length < 2 || words.length > 4) return null;
  if (words.some((w) => NOT_NAME_WORDS.has(w.toLowerCase()))) return null;
  return { first: words[0], last: words.slice(1).join(' ') };
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
