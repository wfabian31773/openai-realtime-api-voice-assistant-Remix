/**
 * THE DATE OF BIRTH THE CALLER ALREADY SAID OUT LOUD.
 *
 * 2026-09-08, one full business day on the queue lanes: 446 substantive calls,
 * 255 filed, and **75 hit the date-of-birth gate — 53 of them filed nothing**.
 * It is the single biggest cause of a call producing no ticket.
 *
 * The chain, all measured, and the third link is the one this file is for:
 *
 *  1. In 51 of the 75, the CALLER'S OWN transcribed words contain a birth year
 *     or a month name. They answered the question.
 *  2. The model then called the filing tool with no `date_of_birth` argument.
 *     75 of 75 — `dobShape` reads "(none)" on every refusal, across surgery,
 *     tech and optical.
 *  3. So the handler had nothing to parse. `dobParts.ts` got better at reading
 *     dates all week and none of it could help, because no date ever reached
 *     it.
 *  4. In 42 of the 75 that refusal is the LAST TOOL CALL OF THE CALL. The model
 *     never retries, so the "ask once then file anyway" escape
 *     (`dobEscape.ts`, the 2026-09-04 ruling) never gets its second attempt.
 *     It is unreachable in the majority of cases.
 *
 * Every fix so far has depended on the model relaying what the caller said.
 * This one stops depending on it. The words are already in the bridge's
 * `CallTranscriptLog`; nothing could see them but the bridge. This is that
 * gap bridged — the bridge posts the record here as it grows, and the four
 * filing tools read the answer back by CallSid.
 *
 * ── WHY THE ADJACENCY RULE IS THE WHOLE DESIGN ──────────────────────────────
 *
 * Filing a WRONG birthday is worse than filing none. `dobParts.ts` says so in
 * every comment, and it is not theoretical: "Marcus 17 1973" parsing as March
 * put a wrong date on a real ticket, and a wrong date silently matches the
 * wrong patient.
 *
 * Callers on these lines say dates constantly that are not their birthday — a
 * surgery date, an appointment, when their glasses were ordered, when they
 * last saw the doctor. A reader that swept every date out of a transcript
 * would invent birthdays for a living, and `valid()` cannot tell them apart:
 * a surgery date last spring is a real date in range.
 *
 * So the signal is not the date, it is WHERE THE CALLER SAID IT. A date counts
 * only when it was said while ANSWERING a request for a date of birth — inside
 * the turn that follows an agent line that OPENS A WINDOW, ending at the next
 * thing the agent says. Nothing else in the call is looked at.
 *
 * WHICH AGENT LINES OPEN A WINDOW — this is the discriminator, not first-vs-
 * last date inside one window. Codex P1b on PR #275: after a date is already
 * established, "I have your date of birth, thank you. Anything else?" used to
 * open a window because it merely MENTIONS the subject, and the caller's
 * "Yes, my surgery is September 12th, 2025" became the birthday. A mention
 * is not an ask. A window opens only when the line REQUESTS the date or
 * REQUESTS confirmation of it:
 *
 *   - a born-when phrase, or
 *   - a request/confirm cue ("may I have", "is that", "starting with the
 *     month", "need your date of birth", "except your date of birth"), or
 *   - a question mark whose question itself is about the date of birth, or
 *   - a re-ask follow-through on the same agent line ("mis-heard" /
 *     "once more") even when that cue sits in the next sentence
 *
 * A readback that asks ("I have January 4th 1958 — is that your date of
 * birth?") still opens a window, so a real correction is captured. A
 * readback that only acknowledges and changes topic does not. Measured
 * 2026-09-10 after #280: 3 of 13 live re-asks stopped opening a window
 * because the request was stated without "may I" / "?" ("I just need your
 * date of birth to get this logged."). Those cues are now asks. The P1b
 * acknowledgement is not.
 *
 * A LATER WINDOW THAT YIELDS NO DATE does not, by itself, throw the earlier
 * one away — "Yes that is correct" is an empty window and must leave the
 * date standing (Codex P1a). What DOES clear it is an attempted date the
 * parser refused: `dobShape` shows digits, a month word, or two-plus spoken
 * number words, and `readDobQuietly` returned nothing. "No, zero three
 * thirty two of fifty" is that case — a wrong birthday filed is worse than
 * a missing one, and `noteSpokenDob` deletes the cache entry rather than
 * returning early and leaving the stale value.
 *
 * WHAT THIS STILL CANNOT CATCH, stated rather than papered over:
 *
 *  - An agent line that asks for a date of birth AND some other date in the
 *    same breath ("not your date of birth — the date of your surgery") opens a
 *    window that the wrong answer can land in. Tightening that further means
 *    inventing a rule, and no such line has been seen in a transcript yet.
 *  - The question is recognised in ENGLISH and SPANISH only. The runtime's own
 *    language table also carries Tagalog, Korean, Armenian, Farsi,
 *    Vietnamese, Russian and Arabic, and a caller asked in any of those gets
 *    no window opened at all. Same known gap as the month table in
 *    `dobParts.ts`, and it needs the same evidence before it is filled: which
 *    phrasings actually arrive, in real transcripts.
 *  - A date said in WORDS reads since v199 (`numberWordsToDigits` in
 *    dobParts.ts), in both languages. A worded date that is still not a date
 *    ("zero three thirty two of fifty") is refused, and that refusal CLEARS a
 *    previously cached date instead of filing it.
 *  - A caller who volunteers a date of birth before anyone asks for one, and
 *    is never asked afterwards, opens no window. Nothing here reads it.
 *
 * ── STORAGE ────────────────────────────────────────────────────────────────
 *
 * In memory, for the length of one call, with the TTL, the ceiling, the
 * recency eviction and the sentinel rule taken from `gateAttempts.ts` and
 * `verifiedIdentity.ts` beside it. This is patient data and it has no business
 * being written anywhere durable so that one module can hand it to another.
 */

import { isTwilioCallSid } from './callSid';
import { dobShape, monthNumberFromWord, numberWordsToDigits, readDobQuietly } from './dobParts';

// ── Reading the answer out of the record ────────────────────────────────────

/** Accents folded and punctuation flattened, so one `includes` does. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The ways an agent puts a date of birth on the table.
 *
 * A mention is not enough to open a window — see `opensDobWindow`. These
 * phrases identify the SUBJECT. The scripted refusal line the four filing
 * tools speak — "may I please have the date of birth, starting with the
 * month, then the day, then the year" — matches the first entry, which is
 * the case that has to work: it is the line the caller is answering on all
 * 75 of 2026-09-08's refusals.
 */
const DOB_TOPICS = [
  'date of birth',
  'birth date',
  'birthdate',
  'birthday',
  'when were you born',
  'when was she born',
  'when was he born',
  'when were they born',
  // Spanish. "¿Cuál es su fecha de nacimiento?" folds to the first of these.
  'fecha de nacimiento',
  'cuando nacio',
  'cuando naciste',
];

/** Born-when phrases are themselves the ask, question mark or not. */
const INHERENT_ASKS = [
  'when were you born',
  'when was she born',
  'when was he born',
  'when were they born',
  'cuando nacio',
  'cuando naciste',
];

/**
 * Request or confirmation cues. A READBACK that asks ("is that right?") is
 * a request; an acknowledgement that does not use these is not.
 *
 * Folded text, so "what's" and "Cuál" become `what s` and `cual`.
 * Scored PER SENTENCE so "I have your date of birth. May I help with
 * anything else?" cannot smuggle a later `may i` onto the mention.
 */
const ASK_CUES = [
  'may i have',
  'may i please have',
  'please have',
  'can i have',
  'could i have',
  'could you give',
  'could you repeat',
  'what is',
  'what s',
  'is that',
  'is this',
  'once more',
  // Genuine re-asks that do not use "may I" or a question mark.
  // CAe3de7ada / CA74811ee4, 2026-09-10: #280 closed these windows.
  'need your date of birth',
  'need the date of birth',
  'except your date of birth',
  'except the date of birth',
  'mis heard',
  'necesito su fecha de nacimiento',
  'necesito la fecha de nacimiento',
  'excepto su fecha de nacimiento',
  'excepto la fecha de nacimiento',
  'cual es',
  'cual',
  'me puede',
  'me das',
  'digame',
  'dime',
  'empezando',
  'starting with',
];

/**
 * Cues that reopen a window when they share an agent LINE with a DOB
 * mention, even if they sit in the next sentence. CAa6a32e9c:
 * "the date of birth may have been mis-heard. Could you give it to me
 * once more?" — "once more" is the ask, "date of birth" is the previous
 * sentence. "I have your date of birth, thank you. Anything else?" has
 * neither of these, so P1b stays closed.
 */
const LINE_REASK_CUES = [
  'once more',
  'mis heard',
];

/**
 * Questions that change the subject after the date has already been taken.
 * A `?` on a sentence that also mentions DOB still does not open a window
 * when the question is one of these.
 */
const TOPIC_CHANGE_ASKS = [
  'anything else',
  'what else',
  'something else',
  'can i help',
  'may i help',
  'could i help',
  'is there anything',
  'algo mas',
];

function mentionsDobTopic(folded: string): boolean {
  return DOB_TOPICS.some((q) => folded.includes(q));
}

/**
 * Whether this agent line opens an answering window.
 *
 * THE DISCRIMINATOR IS THE LINE, NOT THE DATE INSIDE THE REPLY. Codex P1b:
 * first-vs-last date inside a window cannot save a readback that should never
 * have opened one. Each sentence is judged on its own: it must mention the
 * date of birth AND request or confirm it. "I have your date of birth, thank
 * you. Anything else?" mentions the subject in one sentence and asks a
 * different question in the next — neither sentence does both. "I have
 * January 4th 1958 — is that your date of birth?" asks about the date, so
 * it opens — that is how a correction is captured.
 */
function sentenceOpensDobWindow(sentence: string): boolean {
  const folded = fold(sentence);
  if (!mentionsDobTopic(folded)) return false;
  if (INHERENT_ASKS.some((q) => folded.includes(q))) return true;
  if (ASK_CUES.some((c) => folded.includes(c))) return true;
  if (!/[?]/.test(sentence)) return false;
  return !TOPIC_CHANGE_ASKS.some((p) => folded.includes(p));
}

/**
 * THE FORMAT, ASKED ON ITS OWN (v199).
 *
 * The scripted ask is one long sentence, and on a busy line the caller cuts
 * it off. The agent then finishes it in a line of its own — "with the month,
 * then the day, then the year." / "con el mes, luego el día y después el año."
 * / "Month, day, year again, please." — and the caller answers THAT line. It
 * names no date of birth, so until v199 it opened no window and the answer
 * went unread: 5 of the 14 calls of 2026-11-07..10 whose caller was asked and
 * whose ticket carried no date of birth (CAb6183fa70bab1e1575b9bcf867ad01e5,
 * CA2c5949f3178f9e88f08a413b1accb606, CA855265389fad269027dddc8b4b84e597,
 * CA489604ea2dd121748a8aa1f119afb134, CAf2e29ef64db1f961d224eab7cdbfcbd6).
 *
 * A sentence opens a window as the format when it is NOTHING BUT the format:
 * at least two of month / day / year (mes / día / año), and every other word
 * a filler ("with", "then", "the", "again", "please", "luego", "y", ...). "And
 * what day and year did you get them?" is not, so a glasses date cannot land
 * in it. And only once a date of birth was asked earlier on the call, and when
 * neither this line nor the agent line before it names another date (a
 * surgery, an appointment, a visit, an exam).
 */
const FORMAT_WORDS_EN = ['month', 'day', 'year'];
const FORMAT_WORDS_ES = ['mes', 'dia', 'ano'];
const FORMAT_FILLERS = new Set([
  'with', 'then', 'the', 'and', 'starting', 'start', 'beginning', 'again', 'please', 'first', 'next',
  'followed', 'by', 'after', 'that', 'finally', 'last', 'lastly', 'so', 'ok', 'okay', 'just', 'sorry',
  'in', 'order', 'of', 'a', 'your', 'interrupted', 'its', 'it', 's',
  'el', 'la', 'con', 'luego', 'y', 'despues', 'primero', 'empezando', 'comenzando', 'por', 'de', 'del',
  'en', 'orden', 'otra', 'vez', 'favor', 'su', 'solo', 'okey', 'perdon', 'e', 'al', 'final',
]);
const OTHER_DATE_SUBJECTS = new Set([
  'surgery', 'surgeries', 'procedure', 'operation', 'appointment', 'appointments', 'appt', 'visit',
  'exam', 'cirugia', 'operacion', 'procedimiento', 'cita', 'citas', 'consulta', 'visita', 'examen',
]);

function namesAnotherDate(folded: string): boolean {
  return folded.split(' ').some((w) => OTHER_DATE_SUBJECTS.has(w));
}

function sentenceIsTheFormat(sentence: string): boolean {
  const words = fold(sentence).split(' ').filter(Boolean);
  const present = (list: string[]) => list.filter((w) => words.includes(w)).length;
  const list = present(FORMAT_WORDS_EN) >= 2 ? FORMAT_WORDS_EN : present(FORMAT_WORDS_ES) >= 2 ? FORMAT_WORDS_ES : null;
  if (!list) return false;
  return words.every((w) => list.includes(w) || FORMAT_FILLERS.has(w));
}

interface WindowContext {
  /** Some earlier agent line on this call mentioned a date of birth. */
  dobAskedBefore: boolean;
  /** The agent line before this one, for the other-date check. */
  previousAgentLine?: string;
}

function opensDobWindow(agentLine: string, context: WindowContext): boolean {
  const sentences = agentLine.split(/(?<=[.!?])\s+/);
  if (sentences.some(sentenceOpensDobWindow)) return true;
  const folded = fold(agentLine);
  if (mentionsDobTopic(folded) && LINE_REASK_CUES.some((c) => folded.includes(c))) return true;
  if (!sentences.some(sentenceIsTheFormat)) return false;
  if (namesAnotherDate(folded)) return false;
  if (mentionsDobTopic(folded)) return true;
  if (!context.dobAskedBefore) return false;
  return !namesAnotherDate(fold(context.previousAgentLine ?? ''));
}

/**
 * A same-turn self-correction. First date in a window still wins when the
 * caller just keeps talking ("and my surgery is September 12th") — that is
 * P1b's sibling, and it stays. A later date wins only when the utterance
 * that carries it is "sorry, I meant …" (P1c).
 */
const CORRECTION_CUES = [
  'sorry i meant',
  'no i meant',
  'i meant',
  'queria decir',
];

/**
 * A BARE "SORRY" CORRECTS ONLY A DATE SAID BEFORE IT (v199).
 *
 * CA46c62db6bf01da345c74d15b7f28f35d, in shape "2 14, 2009, sorry, 2 21, 2010.", is a
 * caller correcting themselves mid-breath, and the strong cues above do not
 * see it. "Sorry" alone is everywhere ("Sorry, and my surgery is September
 * 12th"), so it counts only when the words before it in the same utterance
 * were themselves an attempt at a date: then the date after it is the
 * correction. With nothing date-like before it, it is an apology.
 */
const SELF_CORRECTION_CUES = ['sorry', 'perdon', 'i mean', 'mejor dicho'];

function textAfterLastCorrection(uttered: string): string | undefined {
  const folded = fold(uttered);
  let best = -1;
  let cueLen = 0;
  for (const cue of CORRECTION_CUES) {
    const idx = folded.lastIndexOf(cue);
    if (idx > best) {
      best = idx;
      cueLen = cue.length;
    }
  }
  const padded = ` ${folded} `;
  for (const cue of SELF_CORRECTION_CUES) {
    const at = padded.lastIndexOf(` ${cue} `);
    if (at < 0) continue;
    const idx = at; // padded index of the space before the cue == folded index of the cue
    if (idx <= best) continue;
    if (!looksLikeDobAttempt(folded.slice(0, idx))) continue;
    best = idx;
    cueLen = cue.length;
  }
  if (best < 0) return undefined;
  const after = folded.slice(best + cueLen).trim();
  return after || undefined;
}

function isoFromParts(parts: { year: string; month: string; day: string }): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * ONE SENTENCE THAT IS A DATE, WHEN THE WHOLE TURN IS NOT ONE (v199).
 *
 * CAb6183fa70bab1e1575b9bcf867ad01e5, in shape: "Date of birth? <a remark>.
 * June 3, 1944. 82 years old." The whole turn reads as four numbers and a
 * month, which is not one date, so it was refused. Read sentence by sentence
 * it is one date and an age. Taken only when every sentence that reads as a
 * date reads as the SAME date; two different dates in one turn stay refused.
 */
function isoFromSentences(text: string): string | undefined {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
  if (sentences.length < 2) return undefined;
  const dates = new Set<string>();
  for (const sentence of sentences) {
    const parts = readDobQuietly(sentence);
    if (parts) dates.add(isoFromParts(parts));
    else if (competesWithADate(sentence)) return undefined;
  }
  return dates.size === 1 ? [...dates][0] : undefined;
}

/**
 * A SENTENCE THAT MAY CORRECT THE DATE BESIDE IT REFUSES THE TURN (Codex P1 on
 * #447). "June 3, 1944. No, June 4." is a caller correcting the day, and the
 * correction does not read as a date on its own (no year). Taking the one
 * sentence that does read would file the date the caller has just rejected.
 * So a sentence that does not read as a date, but opens with a correction or
 * a denial, names a month, or carries two or more numbers, makes the turn
 * more than one date, and it is refused. An age ("82 years old.") and a remark
 * carry none of those and stand aside, which is the shape E case this exists
 * for.
 */
const OPENS_A_CORRECTION = /^(no|nope|nah|not|sorry|actually|wait|i mean|i meant|perdon|mejor dicho)\b/;

function competesWithADate(sentence: string): boolean {
  const folded = fold(sentence);
  if (OPENS_A_CORRECTION.test(folded)) return true;
  if (folded.split(' ').some((w) => monthNumberFromWord(w))) return true;
  return numbersIn(sentence).length >= 2;
}

function isoFromUtterance(uttered: string): string | undefined {
  const after = textAfterLastCorrection(uttered);
  if (after) {
    const corrected = readDobQuietly(after);
    if (corrected) return isoFromParts(corrected);
    // A correction the reader cannot read never falls back to the date it
    // corrected (Codex P1 on #447).
    return undefined;
  }
  const parts = readDobQuietly(uttered);
  if (parts) return isoFromParts(parts);
  return isoFromSentences(uttered);
}

/**
 * A caller utterance that tried to be a date and that the parser refused.
 *
 * `dobShape` already separates "nothing arrived" from "something arrived".
 * Confirmations ("yes that is correct") produce a letter-only shape with no
 * month and no number words — that is not an attempt. Digits (`#`), a month
 * word, or two-plus spoken number words (the known refused form, English and
 * Spanish) are. One isolated "one" ("yes that is the one") is not enough.
 */
const NUMBER_WORDS = new Set([
  'zero', 'oh',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'cero', 'uno', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete',
  'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta',
  'ochenta', 'noventa',
  'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco',
  'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve',
]);

function looksLikeDobAttempt(uttered: string): boolean {
  if (dobShape(uttered).includes('#')) return true;
  const words = fold(uttered).split(' ').filter(Boolean);
  if (words.some((w) => monthNumberFromWord(w))) return true;
  let numberWords = 0;
  for (const w of words) {
    if (NUMBER_WORDS.has(w) || /^veinti/.test(w)) numberWords += 1;
  }
  return numberWords >= 2;
}

const AGENT_PREFIX = 'AGENT: ';
const CALLER_PREFIX = 'CALLER: ';

type WindowRead =
  | { kind: 'date'; iso: string }
  | { kind: 'refused'; attempts: string[] }
  | { kind: 'empty' };

type TranscriptRead =
  | { kind: 'date'; iso: string }
  | { kind: 'cleared' }
  | { kind: 'none' };

function readWindow(lines: readonly string[], from: number): WindowRead {
  let found: string | undefined;
  const attempts: string[] = [];
  for (let j = from; j < lines.length; j += 1) {
    const next = lines[j] ?? '';
    if (!next.startsWith(CALLER_PREFIX)) break;
    const uttered = next.slice(CALLER_PREFIX.length);
    const iso = isoFromUtterance(uttered);
    if (iso) {
      if (found === undefined || textAfterLastCorrection(uttered)) {
        found = iso;
      }
      continue;
    }
    if (found === undefined && looksLikeDobAttempt(uttered)) attempts.push(uttered);
  }
  if (found !== undefined) return { kind: 'date', iso: found };
  if (attempts.length) return { kind: 'refused', attempts };
  return { kind: 'empty' };
}

/** The numbers an utterance holds, number words included. */
function numbersIn(uttered: string): number[] {
  const text = numberWordsToDigits(uttered) ?? fold(uttered);
  return text.split(' ').filter((w) => /^\d+$/.test(w)).map((w) => Number(w));
}

/**
 * A MONTH AND A DAY THAT AGREE WITH THE DATE ALREADY GIVEN DO NOT CLEAR IT
 * (v199).
 *
 * CA8ab4aaa6917b6ca300cb0d4ef2a8fc66: the caller gave a date (in shape "Junio 14, 52.") when
 * first asked, the agent asked again, and the caller said "Junio 14." — the
 * same month and day, no year. That is a partial answer that AGREES, and it
 * used to clear the date the caller had given as a refused attempt. A partial
 * that disagrees still clears it, as any refused attempt does.
 */
function agreeingPartial(uttered: string, iso: string): boolean {
  // "No, not June 3" names the held month and day to reject them (Codex P1 on
  // #447, head d0aefbb5).
  if (rejectsADate(uttered)) return false;
  const [, mm, dd] = iso.split('-');
  const month = Number(mm);
  const day = Number(dd);
  const text = numberWordsToDigits(uttered) ?? fold(uttered);
  const words = text.split(' ').filter(Boolean);
  const nums = words.filter((w) => /^\d+$/.test(w)).map(Number);
  const named = words.map((w) => monthNumberFromWord(w)).filter((m): m is string => Boolean(m));
  if (named.length === 1 && nums.length === 1) return Number(named[0]) === month && nums[0] === day;
  if (named.length === 0 && nums.length === 2) return nums[0] === month && nums[1] === day;
  return false;
}

/**
 * THE AGENT READ THE DATE BACK, AND THE CALLER DID NOT SAY NO (v199).
 *
 * The voice model hears the caller's audio, and the transcriber does not
 * always write what it heard: answers shaped like "6 3 12 del 49." and "4, 1952." are the
 * transcripts of answers the agent then read back correctly in its very next
 * line (in shape "nacida el tres de junio de mil novecientos cuarenta y nueve.
 * ¿Es correcto?" / "April fourth, nineteen fifty-two."), on
 * CA2c5949f3178f9e88f08a413b1accb606 and CAe89c5fec082bbaf2c9c58da4fdcd6f41.
 *
 * Taken only from the FIRST agent line after a window whose answer was an
 * attempted date the parser refused; only when exactly one date reads out of
 * that line and it is not an example ("por ejemplo", "for example"); only
 * when the year it reads agrees with the last number the caller said (the
 * whole year or its last two digits); and only when nothing the caller says
 * back, up to the agent's next line, is a "no", a correction, or a different
 * date.
 */
const EXAMPLE_CUES = ['por ejemplo', 'for example', 'for instance', 'such as', 'like this'];
/**
 * A "NO" ANYWHERE IN THE CALLER'S ANSWER IS A NO (Codex P1 on #447).
 * "Actually, no." starts with another word, so reading only the first word
 * missed it. The error this guards against is a date the caller rejected
 * reaching the ticket; reading a stray "no" as a denial only costs the
 * readback, which leaves the ticket where it was before v199.
 */
const DENIAL_WORDS = new Set(['no', 'nope', 'nah', 'incorrect', 'wrong', 'negative', 'incorrecto', 'incorrecta']);
const DENIAL_PHRASES = ['not right', 'not correct', 'not it', 'not my', 'thats not', 'that s not', 'equivocad'];

function isDenial(uttered: string): boolean {
  const words = fold(uttered).split(' ').filter(Boolean);
  if (words.some((w) => DENIAL_WORDS.has(w))) return true;
  const padded = ` ${words.join(' ')} `;
  return DENIAL_PHRASES.some((p) => padded.includes(` ${p}`));
}

/**
 * A denial, or a correction word anywhere ("Actually, April fifth"), in what
 * the caller says about a date already held or read back (Codex P1 on #447,
 * head d0aefbb5). Either one means that date is not the caller's answer.
 */
const CORRECTION_WORDS = /(^| )(actually|sorry|wait|i mean|i meant|perdon|mejor dicho|en realidad)( |$)/;

function rejectsADate(uttered: string): boolean {
  return isDenial(uttered) || CORRECTION_WORDS.test(fold(uttered));
}

/** What the caller said agrees with `iso`: the same full date, or its month and day. */
function confirmsTheDate(uttered: string, iso: string): boolean {
  const whole = readDobQuietly(uttered);
  if (whole) return isoFromParts(whole) === iso;
  return agreeingPartial(uttered, iso);
}

function readBack(lines: readonly string[], at: number, attempts: readonly string[]): string | undefined {
  const agentLine = (lines[at] ?? '').slice(AGENT_PREFIX.length);
  const folded = fold(agentLine);
  if (EXAMPLE_CUES.some((c) => folded.includes(c))) return undefined;
  const dates = new Set<string>();
  for (const sentence of agentLine.split(/(?<=[.!?])\s+/)) {
    const parts = readDobQuietly(sentence);
    if (parts) dates.add(isoFromParts(parts));
  }
  if (dates.size !== 1) return undefined;
  const iso = [...dates][0]!;
  const year = Number(iso.slice(0, 4));
  // The year sits last in what the caller said ("6 3 12 del 49", "4, 1952").
  const lastSaid = attempts.map((a) => numbersIn(a).slice(-1)[0]).filter((n): n is number => n !== undefined);
  if (!lastSaid.some((n) => n === year || n === year % 100)) return undefined;
  // The caller's whole answer to the readback: every caller line up to the
  // agent's next line. A "no" on the second line counts as much as on the
  // first (Codex P1 on #447).
  let answered = false;
  for (let j = at + 1; j < lines.length; j += 1) {
    const next = lines[j] ?? '';
    if (!next.startsWith(CALLER_PREFIX)) {
      if (answered) break;
      continue;
    }
    answered = true;
    const said = next.slice(CALLER_PREFIX.length);
    if (rejectsADate(said)) return undefined;
    // A date of their own that is not the one read back is a correction too.
    if (looksLikeDobAttempt(said) && !confirmsTheDate(said, iso)) return undefined;
  }
  return iso;
}

function readCallerAnswer(lines: readonly string[]): TranscriptRead {
  let latest: TranscriptRead = { kind: 'none' };
  let dobAskedBefore = false;
  let previousAgentLine: string | undefined;
  let refusedAttempts: string[] | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith(AGENT_PREFIX)) continue;
    const said = line.slice(AGENT_PREFIX.length);
    if (refusedAttempts) {
      const back = readBack(lines, i, refusedAttempts);
      if (back) latest = { kind: 'date', iso: back };
      refusedAttempts = undefined;
    }
    const opens = opensDobWindow(said, { dobAskedBefore, previousAgentLine });
    if (mentionsDobTopic(fold(said))) dobAskedBefore = true;
    previousAgentLine = said;
    if (!opens) continue;
    const window = readWindow(lines, i + 1);
    if (window.kind === 'date') latest = { kind: 'date', iso: window.iso };
    else if (window.kind === 'refused') {
      const held = latest.kind === 'date' ? latest.iso : undefined;
      if (held && window.attempts.every((a) => agreeingPartial(a, held))) continue;
      latest = { kind: 'cleared' };
      refusedAttempts = window.attempts;
    }
    // empty: confirmation / "sure." — leave the earlier answer standing.
  }
  return latest;
}

/**
 * The date of birth the caller gave in answer to being asked for one, as
 * `YYYY-MM-DD`, or undefined.
 *
 * THE LAST ASK WINS; WITHIN ONE ASK, THE FIRST DATE WINS unless the caller
 * corrects themselves in that same turn. The two halves pull in opposite
 * directions and both are load-bearing.
 *
 * ACROSS asks: an agent that asked twice asked because the first answer did not
 * survive — misheard, read back wrong, or refused by the tool — so the later
 * answer is the caller correcting the earlier one. Taking the earlier one would
 * file the value the caller has just told us is wrong.
 *
 * WITHIN one ask: the caller's answer is the FIRST date they say. Everything
 * after it in the same breath is them carrying on talking, and what they carry
 * on about is very often another date:
 *
 *   AGENT:  May I have your date of birth?
 *   CALLER: January 4th 1958
 *   CALLER: and my surgery is September 12th, 2025
 *
 * This read the surgery date as the birthday, and all four filing tools would
 * have written it to the patient record. `valid()` cannot tell the two apart —
 * a surgery date last autumn is a real date in range — so position inside the
 * answer is the only thing that separates them, UNLESS the later date is a
 * self-correction ("Sorry, I meant January 5th 1958"). That later date wins
 * (P1c). "and my surgery is…" is not a correction and still loses.
 *
 * A LINE THAT ONLY ACKNOWLEDGES THE DATE DOES NOT OPEN A WINDOW. That is the
 * P1b discriminator: "I have your date of birth, thank you. Anything else?"
 * is not an ask, so a later surgery date in the reply cannot replace the
 * birthday already given. A readback that asks for confirmation still opens
 * one, so a real correction still wins.
 *
 * AN ATTEMPTED DATE THE PARSER REFUSED CLEARS THE ANSWER. That is P1a.
 * "Yes that is correct" is not an attempt and leaves the earlier date
 * standing. "No, zero three thirty two of fifty" is an attempt, the parser
 * refuses it (there is no March 32nd), and the function returns undefined
 * rather than the value the caller has just rejected — unless the agent's
 * next line reads a date back that the caller does not deny (v199, see
 * `readBack`).
 *
 * Parsed QUIETLY. This runs over caller lines to find out whether any of them
 * is a date, so most of what it parses is not one, and every failure would
 * otherwise print `[DOB] refused a date of birth in the shape …` — a
 * documented live counter, and the instrument the 2026-09-08 finding rests on.
 * See `readDobQuietly`.
 */
export function dobFromCallerAnswer(lines: readonly string[]): string | undefined {
  const read = readCallerAnswer(lines);
  return read.kind === 'date' ? read.iso : undefined;
}

// ── The per-call store ──────────────────────────────────────────────────────

interface Entry {
  /** `YYYY-MM-DD`. Parsed again by the reader, never displayed. */
  iso: string;
  at: number;
}

const heard = new Map<string, Entry>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

function sweep(now: number): void {
  for (const [k, v] of heard) {
    if (now - v.at > TTL_MS) heard.delete(k);
  }
  if (heard.size > MAX_ENTRIES) {
    // Oldest first. Map preserves insertion order and an entry is only ever
    // re-inserted on write, so this drops the least recently touched.
    let excess = heard.size - MAX_ENTRIES;
    for (const k of heard.keys()) {
      heard.delete(k);
      if (--excess <= 0) break;
    }
  }
}

/**
 * The bridge, posting the call's record as it grows.
 *
 * Takes the whole record rather than one line, because a caller turn is
 * REPLACED in place as its cumulative transcript is re-emitted — see
 * `transcriptLog.ts`. Re-reading the record is what makes the stored answer
 * track the caller's final words instead of their first partial ones.
 *
 * NOTHING IS WRITTEN WHEN NO ANSWER IS FOUND, so a caller who gives their date
 * of birth and then talks about something else for two minutes does not lose
 * it. The exception is a later ASK window whose reply is an attempted date
 * the parser refused: that DELETES the entry. `if (!iso) return` used to
 * leave the rejected value in the cache, and the four filing tools would
 * then file it when the model omitted `date_of_birth`.
 *
 * A SENTINEL IS NOT A CALL. `call_sid` is a declared property on the filing
 * tools, so a model with no injected value supplies "unknown" or "latest", and
 * a truthiness check would make every such call share one key. Two callers
 * named the same thing — a father and a son, which these lines get constantly
 * — would then be one entry, and the second caller's ticket would carry the
 * first caller's birthday. Same rule, same reason, as `verifiedIdentity.ts`.
 */
export function noteSpokenDob(callSid: string | undefined, lines: readonly string[]): void {
  if (!isTwilioCallSid(callSid)) return;
  const read = readCallerAnswer(lines);
  const now = Date.now();
  sweep(now);
  if (read.kind === 'date') {
    heard.delete(callSid); // re-insert so insertion order tracks recency
    heard.set(callSid, { iso: read.iso, at: now });
    return;
  }
  if (read.kind === 'cleared') {
    heard.delete(callSid);
  }
}

/**
 * What this call's caller said when asked for a date of birth, or undefined.
 *
 * Validated on the READ as well as the write — not because a sentinel could be
 * in the map, since the write refuses one, but so the guard survives someone
 * later relaxing the write. Both ends state the same rule.
 *
 * NO NAME GUARD, and the difference from `verifiedDobFor` is deliberate. That
 * one hands back a date from a PATIENT RECORD, so it has to prove the ticket
 * is for that same person. This one hands back what the person on the phone
 * said in answer to being asked — and when a caller rings about somebody else,
 * the date they give when asked for "the date of birth" is the date of birth
 * the ticket wants. Adding a name match here would drop exactly the calls
 * standing instruction 5 in BACKEND_HANDOFF is about ("when anyone calls about
 * anyone else, ask the relation and who the patient is").
 */
export function spokenDobFor(callSid: string | undefined): string | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = heard.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry.iso;
}

/** Tests only. */
export function resetSpokenDobs(): void {
  heard.clear();
}
