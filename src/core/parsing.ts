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
