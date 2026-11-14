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
 *    window that the wrong answer can land in. Since v207 such a window can
 *    give a date of birth when none is held but cannot replace one unless the
 *    caller's own words call it their birthday; a different date in it clears
 *    the held one instead (see `DateSubject`).
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
import {
  dobShape,
  monthNumberFromWord,
  negatesADate,
  numberWordsToDigits,
  readDobQuietly,
  rejectsADate,
  withoutAnAge,
} from './dobParts';

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
  'surgery', 'surgeries', 'procedure', 'procedures', 'operation', 'operations', 'appointment',
  'appointments', 'appt', 'visit', 'visits', 'exam', 'exams', 'cirugia', 'cirugias', 'operacion',
  'procedimiento', 'cita', 'citas', 'consulta', 'visita', 'examen',
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

/**
 * WHAT THE AGENT LAST ASKED A DATE ABOUT (v207).
 *
 * The format said on its own opens a window only when the date the agent was
 * last asking about is the date of birth. v199 read only the agent line just
 * before it, and a caller's "Could you repeat that?" puts a line between: the
 * agent asks for a surgery date, the caller asks it to repeat, the agent says
 * "Sure." and then "The month, day, and year.", and the surgery date was read
 * as the birthday (Codex post-merge sweep of #447). The subject now carries
 * from line to line until an agent line names another one.
 *
 * `mixed` is a line that asks for the date of birth and names another date in
 * the same breath ("Could you repeat the date of birth and the date of your
 * procedure?", the after-hours read-back "I have …, date of birth …, and you
 * need to reschedule your appointment, is that right?"). Its window can give a
 * date of birth when none is held, but a date in it that differs from the one
 * held does not replace it unless the caller's own words say it is their
 * birthday: it may be the other date. It clears the held date instead, since
 * which one it is cannot be told.
 */
type DateSubject = 'dob' | 'mixed' | 'other';

interface WindowContext {
  /** Some earlier agent line on this call mentioned a date of birth. */
  dobAskedBefore: boolean;
  /** What the agent last asked a date about, carried across agent lines. */
  lastSubject?: DateSubject;
}

interface WindowOpening {
  mixed: boolean;
}

function asksForTheBirthday(agentLine: string): boolean {
  const sentences = agentLine.split(/(?<=[.!?])\s+/);
  if (sentences.some(sentenceOpensDobWindow)) return true;
  const folded = fold(agentLine);
  return mentionsDobTopic(folded) && LINE_REASK_CUES.some((c) => folded.includes(c));
}

function opensDobWindow(agentLine: string, context: WindowContext): WindowOpening | null {
  const folded = fold(agentLine);
  const other = namesAnotherDate(folded);
  if (asksForTheBirthday(agentLine)) return { mixed: other };
  const sentences = agentLine.split(/(?<=[.!?])\s+/);
  if (!sentences.some(sentenceIsTheFormat)) return null;
  if (other) return null;
  if (mentionsDobTopic(folded)) return { mixed: false };
  if (!context.dobAskedBefore) return null;
  if (context.lastSubject === 'dob') return { mixed: false };
  if (context.lastSubject === 'mixed') return { mixed: true };
  return null;
}

function subjectOf(agentLine: string, before: DateSubject | undefined): DateSubject | undefined {
  const folded = fold(agentLine);
  if (namesAnotherDate(folded)) return asksForTheBirthday(agentLine) ? 'mixed' : 'other';
  if (mentionsDobTopic(folded)) return 'dob';
  return before;
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
  return parts ? isoFromParts(parts) : undefined;
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
  /** `at`: the line the date came from. `namesTheBirthday`: that line's own words say it is. */
  | { kind: 'date'; iso: string; at: number; namesTheBirthday: boolean }
  | { kind: 'refused'; attempts: string[] }
  | { kind: 'empty' };

/**
 * A CALLER SENTENCE ABOUT ANOTHER DATE IS NOT AN ANSWER ABOUT THE BIRTHDAY
 * (v207).
 *
 * "June 3, 1944. I mean the surgery was December 5, 2025." read the "I mean"
 * as a correction and filed the surgery date as the date of birth (Codex
 * post-merge sweep of #447); "My surgery is December 5, 2025." in answer to a
 * second ask did the same. A sentence that names a surgery, an appointment, a
 * visit or an exam is taken out before the turn is read for a date of birth,
 * for a correction, or for an attempt that would clear one. A birthday said in
 * the same sentence as another date ("June 3, 1944, and my surgery is
 * December 5") is lost with it, which is the safe side: on the 14 days to
 * 2026-11-11, 30 caller lines carried a year and another date's name, and
 * every one that answered a date-of-birth question said the birthday in a
 * sentence of its own.
 */
function aboutTheBirthday(uttered: string, dateBefore = false): { text: string; withdrew: boolean } {
  let kept: string[] = [];
  let withdrew = false;
  for (const sentence of uttered.split(/(?<=[.!?])\s+/)) {
    const denial = birthdayDenial(sentence);
    if (denial && looksLikeDobAttempt([...kept, denial.before].join(' '))) {
      kept = [];
      withdrew = true;
      continue;
    }
    if (!namesAnotherDate(fold(sentence))) {
      kept.push(sentence);
      continue;
    }
    const dateInTurn = looksLikeDobAttempt(kept.join(' '));
    if ((dateInTurn || dateBefore) && withdrawsTheDateBefore(sentence, dateInTurn)) {
      kept = [];
      withdrew = true;
    }
  }
  return { text: kept.join(' '), withdrew };
}

/**
 * A SENTENCE ABOUT ANOTHER DATE THAT TAKES BACK THE DATE BEFORE IT (v207,
 * Codex P1 on #454, round 3). "June 3, 1944. Sorry, that is my surgery date."
 * read June 3rd, 1944, because the sentence that withdrew it names the
 * surgery and was dropped with its "sorry"; v206 read no date. After a date in
 * the same turn, or earlier in the same window, a sentence that names another
 * date and carries no date of its own withdraws it when it opens with a
 * correction ("Sorry, I meant the surgery.", "Perdón, la cirugía.", v206's own
 * correction cues), or says the date was the other one and nothing else
 * ("That is my surgery date.", "Esa es la fecha de mi cirugía."). A sentence
 * that only mentions the other date is not a withdrawal ("This is about my
 * surgery.", "It's for my appointment.", "Yeah, so I'm sorry, but I can't go
 * today to my appointment."), and a sentence with a date of its own corrects
 * nothing about the birthday ("I mean the surgery was December 5, 2025.", the
 * operator's case 4). Over the 14 days to 2026-11-11, 9 of 2,052 caller lines
 * with a date had a later sentence naming another date beside a pointer or a
 * correction word; none of them took a birthday back.
 */
const LEADING_FILLERS = /^(?:(?:uh|um|oh|so|and|well|okay|ok|no|bueno|o sea)\s+)*/;
const WEAK_CUES = /^(?:(?:sorry|oops|actually|wait|perdon)\s+)+/;
const STRONG_CUE = /^(?:i mean|i meant|mejor dicho|queria decir|en realidad)( |$)/;
const POINTER = /^(?:that|this|it|ese|esa|eso|esta|este|esto) (?:s|is|was|es|era|fue)( |$)/;
const WHAT_THE_DATE_WAS = new Set([
  'my', 'the', 'her', 'his', 'our', 'a', 'of', 'date', 'day', 'mi', 'la', 'el', 'su', 'sus', 'de', 'del',
  'fecha', 'dia',
]);

/**
 * `dateInTurn`: a date was said earlier in this same turn. Only then does a
 * bare "sorry" or "perdón" take it back, which is v206's own rule for a bare
 * "sorry" (`SELF_CORRECTION_CUES`); a strong cue or "that is my surgery date"
 * also takes back a date from an earlier turn of the same ask.
 */
function withdrawsTheDateBefore(sentence: string, dateInTurn: boolean): boolean {
  if (carriesADate(sentence)) return false;
  const opened = fold(sentence).replace(LEADING_FILLERS, '');
  const weak = WEAK_CUES.test(opened);
  if (weak && dateInTurn) return true;
  const rest = opened.replace(WEAK_CUES, '').replace(LEADING_FILLERS, '');
  if (STRONG_CUE.test(rest)) return true;
  const pointed = POINTER.exec(rest);
  if (!pointed) return false;
  const words = rest.slice(pointed[0].length).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => WHAT_THE_DATE_WAS.has(w) || OTHER_DATE_SUBJECTS.has(w))
    && words.some((w) => OTHER_DATE_SUBJECTS.has(w));
}

/** A digit, a number said in words, or a month: the sentence says a date of its own. */
function carriesADate(sentence: string): boolean {
  const digits = numberWordsToDigits(sentence) ?? fold(sentence);
  return /\d/.test(digits) || digits.split(' ').some((w) => monthNumberFromWord(w));
}

/**
 * "THAT IS NOT MY BIRTHDAY" TAKES THE DATE BACK (v209, Codex P1 on #454,
 * round 5). "June third nineteen forty-four. That is not my birthday, it is my
 * surgery date." read June 3rd, 1944: the denial names the surgery, so the
 * other-date filter dropped it, and it opens with no correction cue. v205 and
 * v206 read none for the worded year and June 3rd for the digits.
 *
 * A denial ("not my birthday", "isn't my date of birth", "no es mi
 * cumpleaños") whose subject is a pronoun or nothing ("That is not my
 * birthday", "It isn't my date of birth", "June 3, 1944, that is not my
 * birthday") is about the date said before it: it takes back a date said
 * earlier in the same turn, the same sentence included, and in a later caller
 * line clears the held date, even when it goes on to give another one
 * ("That's not my birthday, my birthday is June 4, 1944."). A denial whose
 * subject is a date ("December 5 is not my birthday, that is my surgery date")
 * is about that date and is left to the rules for a named date, and so is
 * any other subject ("My appointment is tomorrow, not my birthday"; Codex P2
 * on #457, rounds 1 and 2). The subject is the clause before the denial, from
 * the last comma, semicolon, colon or dash. Over the 14 days to 2026-11-11 no runtime caller
 * line carried the denial, so it costs nothing measured; clearing is the safe
 * side, the date is asked again.
 */
const DENIES_THE_BIRTHDAY =
  /(?<![a-z])(?:not|isn'?t|wasn'?t|no es|no era|no fue)(?: (?:really|even|actually|realmente))? (?:my|mi|the|la|el|su|her|his) (?:birthday|birthdate|birth date|date of birth|dob|d\.? ?o\.? ?b\.?|cumpleanos|fecha de nacimiento)(?![a-z])/;

/**
 * The subject a denial of the birthday may have and still be about the date
 * before it: a pronoun ("that", "it", "this", "eso") or nothing, after
 * fillers. Anything else ("My appointment is tomorrow, not my birthday",
 * "December 5 is not my birthday") is about something else and clears
 * nothing (Codex P2 on #457, rounds 1 and 2).
 */
const PRONOUN_OR_NO_SUBJECT =
  /^(?:(?:no|yes|yeah|well|so|and|but|oh|uh|um|sorry|wait|actually|bueno|pero|y)\s+)*(?:(?:that|this|it|eso|esa|esto|esta|ese|este)(?:'s|s| is| was)?)?$/;
/** The fillers `PRONOUN_OR_NO_SUBJECT` allows before a pronoun or nothing. */
const PRONOUN_FILLERS = /\b(?:no|yes|yeah|well|so|and|but|oh|uh|um|sorry|wait|actually|bueno|pero|y)\b/g;

/** Lower case, accents dropped, punctuation kept, curly apostrophes straight. */
function lowerKeepingPunctuation(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ');
}

/**
 * The denial of the birthday in a sentence, when its subject is not a date of
 * its own: `before` is the sentence's text before the denial's clause, which
 * may hold the date being denied. `undefined` when there is no such denial.
 */
function birthdayDenial(sentence: string): { before: string } | undefined {
  const text = lowerKeepingPunctuation(sentence);
  const m = DENIES_THE_BIRTHDAY.exec(text);
  if (!m) return undefined;
  const prefix = text.slice(0, m.index);
  const cut = Math.max(...[',', ';', ':', ' - ', '\u2014', '\u2013'].map((c) => prefix.lastIndexOf(c)));
  const subject = (cut >= 0 ? prefix.slice(cut + 1) : prefix).replace(/[^a-z' ]/g, ' ').trim();
  if (!PRONOUN_OR_NO_SUBJECT.test(subject)) return undefined;
  const before = cut >= 0 ? prefix.slice(0, cut) : '';
  // No subject after a comma ("…, not my birthday") is about the clause before
  // it: a date said there, or nothing ("My appointment is tomorrow, not my
  // birthday" is about the appointment; Codex P2 on #457, round 3).
  const bareAfterAClause = cut >= 0 && !/[a-z]/.test(subject.replace(PRONOUN_FILLERS, '')) && /[a-z0-9]/.test(before);
  if (bareAfterAClause && (!looksLikeDobAttempt(before) || namesAnotherDate(fold(before)))) return undefined;
  return { before };
}

const CALLER_BIRTHDAY_WORDS = /(^| )(born|birthday|birth|naci|nacio|nacimiento|cumpleanos)( |$)/;

function callerNamesTheBirthday(about: string): boolean {
  const folded = fold(about);
  return mentionsDobTopic(folded) || CALLER_BIRTHDAY_WORDS.test(folded);
}

/**
 * THE HELD MONTH AND DAY, NAMED (v207). "June third", "the third of June",
 * "6 3", "3 de junio". Ordinal suffixes are read as the number they are.
 */
function namesTheHeldDate(uttered: string, iso: string): boolean {
  const [, mm, dd] = iso.split('-');
  const month = Number(mm);
  const day = Number(dd);
  const text = numberWordsToDigits(withoutAnAge(uttered)) ?? fold(withoutAnAge(uttered));
  const words = text.split(' ').filter(Boolean);
  const numberAt = (j: number): number | undefined => {
    const m = /^(\d+)(?:st|nd|rd|th)?$/.exec(words[j] ?? '');
    return m ? Number(m[1]) : undefined;
  };
  for (let i = 0; i < words.length; i += 1) {
    const named = monthNumberFromWord(words[i]!);
    if (named && Number(named) === month) {
      for (const j of [i + 1, i - 1, i + 2, i - 2]) {
        if (Math.abs(j - i) === 2 && !['of', 'de', 'del', 'the'].includes(words[(i + j) / 2]!)) continue;
        if (numberAt(j) === day) return true;
      }
    }
    if (numberAt(i) === month && numberAt(i + 1) === day) return true;
  }
  return false;
}

/**
 * A SENTENCE A REJECTION MAY BE READ FROM (v207, Codex P2 on #454, round 1).
 * A sentence about another date ("My surgery is not June third.") is not
 * about the birthday and does not clear it. A sentence that names the
 * birthday as well ("My birthday is not June third, my surgery is.") is kept,
 * the other way round from `aboutTheBirthday`: reading a date from a sentence
 * that mixes two dates could take the wrong one, while clearing on one only
 * loses a date that is asked again, which is the safe side.
 */
function mayRejectTheBirthday(sentence: string): boolean {
  return !namesAnotherDate(fold(sentence)) || callerNamesTheBirthday(sentence);
}

/**
 * A SENTENCE THAT IS NOTHING BUT A DENIAL (v207, round 2): "That's wrong.",
 * "No.", "That's not right.", "That's not my birthday.", "No es correcto."
 * Only such a sentence, or one after a date the caller asked back as a
 * question, is read against the date in the sentence before it. A word not in
 * this list makes the sentence about something else ("I do not need anything
 * else."), so a missing word keeps the held date only where a statement of
 * the date is followed by a denial worded some other way.
 */
const BARE_DENIAL_WORDS = new Set([
  'no', 'nope', 'nah', 'not', 'wrong', 'incorrect', 'right', 'correct', 'that', 'thats', 's', 'is', 'it',
  'its', 'isn', 't', 'my', 'mine', 'birthday', 'date', 'of', 'birth', 'the', 'one', 'uh', 'um', 'oh',
  'es', 'eso', 'esa', 'correcto', 'correcta', 'incorrecto', 'incorrecta', 'equivocado', 'equivocada',
  'mi', 'cumpleanos', 'fecha', 'de', 'nacimiento', 'esta', 'mal',
]);

function isABareDenial(sentence: string): boolean {
  const words = fold(sentence).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => BARE_DENIAL_WORDS.has(w)) && (rejectsADate(sentence) || negatesADate(sentence));
}

/**
 * "IT IS NOT JUNE THIRD" CLEARS JUNE THIRD, WHEREVER IT IS SAID (v207).
 *
 * The rejection was read only as a refused attempt in a LATER ask window, and
 * there a partial that names the held month and day reads as agreeing, so
 * "June 3, 1944." then "It is not June third." kept June 3rd (Codex
 * post-merge sweep of #447). It was not read at all in the same turn, or after
 * a line that asks nothing. Any caller line after the one the date came from
 * clears it when a sentence names the held month and day and negates it, or
 * when the sentence after one that names it is a bare denial, or denies a
 * date the caller asked back ("June third? That's not my birthday, I don't
 * know where that came from."). A negation in another sentence does not reach
 * the date ("June third is correct. I do not need anything else.", Codex P2
 * on #454, round 2). Which date the agent last asked about is not read here:
 * "It's not June third." after a surgery question still clears, because the
 * caller may be correcting the birthday, and a held date that may be wrong is
 * not kept.
 */
function rejectsTheHeldDate(uttered: string, iso: string): boolean {
  const sentences = uttered.split(/(?<=[.!?])\s+/);
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i]!;
    // A denial in a later line clears the held date, unless the date it is
    // about, said before it in the same sentence, is another date.
    const denial = birthdayDenial(sentence);
    if (denial && (!carriesADate(denial.before) || namesTheHeldDate(denial.before, iso))) return true;
    if (!mayRejectTheBirthday(sentence) || !namesTheHeldDate(sentence, iso)) continue;
    if (negatesADate(sentence)) return true;
    const next = sentences[i + 1];
    if (next === undefined || !mayRejectTheBirthday(next)) continue;
    const askedBack = /\?\s*$/.test(sentence);
    if (isABareDenial(next)) return true;
    if (askedBack && (rejectsADate(next) || negatesADate(next))) return true;
  }
  return false;
}

type TranscriptRead =
  | { kind: 'date'; iso: string }
  | { kind: 'cleared' }
  | { kind: 'none' };

/** An attempt no held date can agree with: a date taken back in the window. */
const WITHDRAWN = 'withdrawn';

function readWindow(lines: readonly string[], from: number): WindowRead {
  let found: { iso: string; at: number; namesTheBirthday: boolean } | undefined;
  const attempts: string[] = [];
  let withdrawnAt = -1;
  for (let j = from; j < lines.length; j += 1) {
    const next = lines[j] ?? '';
    if (!next.startsWith(CALLER_PREFIX)) break;
    const { text: about, withdrew } = aboutTheBirthday(next.slice(CALLER_PREFIX.length), found !== undefined);
    if (withdrew) {
      // A date taken back, in this turn or an earlier turn of this window.
      found = undefined;
      withdrawnAt = j;
    }
    const iso = isoFromUtterance(about);
    if (iso) {
      if (found === undefined || textAfterLastCorrection(about)) {
        found = { iso, at: j, namesTheBirthday: callerNamesTheBirthday(about) };
      }
      continue;
    }
    if (found === undefined && looksLikeDobAttempt(about)) attempts.push(about);
  }
  if (found !== undefined) return { kind: 'date', ...found };
  // A withdrawn date leaves nothing standing, here or from an earlier ask.
  if (withdrawnAt >= 0) return { kind: 'refused', attempts: [...attempts, WITHDRAWN] };
  if (attempts.length) return { kind: 'refused', attempts };
  return { kind: 'empty' };
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
  // #447, head d0aefbb5), and so does "It is not June third." (v207).
  if (rejectsADate(uttered) || negatesADate(uttered)) return false;
  const [, mm, dd] = iso.split('-');
  const month = Number(mm);
  const day = Number(dd);
  const text = numberWordsToDigits(withoutAnAge(uttered)) ?? fold(withoutAnAge(uttered));
  const words = text.split(' ').filter(Boolean);
  const nums = words.filter((w) => /^\d+$/.test(w)).map(Number);
  const named = words.map((w) => monthNumberFromWord(w)).filter((m): m is string => Boolean(m));
  if (named.length === 1 && nums.length === 1) return Number(named[0]) === month && nums[0] === day;
  if (named.length === 0 && nums.length === 2) return nums[0] === month && nums[1] === day;
  return false;
}

/**
 * A DATE THE CALLER CALLS THE DATE OF BIRTH, ASKED OR NOT (v231).
 *
 * A caller leaving a message often says the patient's name and "date of
 * birth" before anyone asks: "this is for <name>, date of birth <date>",
 * "patient <name>, date of birth <date>, says that…". No agent line asked, so
 * no window opened and nothing read it: on 2026-11-12/13, 4 queue-lane
 * tickets went out with no date of birth after the caller had said one this
 * way (VA-84249, VA-84692, VA-84628 by the teardown sweep, VA-84757 in the
 * call), and over the 14 days to 2026-11-14 a transcript pattern finds this
 * shape on 9 of the 119 swept queue-lane tickets with no date of birth.
 *
 * The caller's own label is the evidence the window stands in for, so it is
 * read narrowly, and anything that casts doubt on the date reads nothing:
 *
 * - The date must come straight after the label ("date of birth <date>",
 *   "her date of birth is <date>", "DOB <date>", "fecha de nacimiento
 *   <date>"), in the same sentence, with nothing about another date (a
 *   surgery, an appointment) after it. A label followed by anything else
 *   ("date of birth, and the surgery is <date>") reads nothing, and so does a
 *   date with no label: "I was born <date>" said before any ask stays unread,
 *   as it always has (a birth is not always the patient's).
 * - The WHOLE sentence the label is in, before the label as well as after it,
 *   and every later sentence the caller says before the agent next speaks
 *   (the rest of that line and any caller lines straight after it), must
 *   carry no denial, negation, correction or withdrawal (`rejectsADate`,
 *   `negatesADate`, `withdrawsTheDateBefore`, the rules the ask window uses)
 *   and no doubt ("maybe", "I think", "probably", `UNSURE_OF_THE_DATE`). "That
 *   is not her date of birth, <date>", "I don't know her date of birth,
 *   <date> maybe" and "date of birth <date>. Sorry, I meant <date>." read
 *   nothing (connector P1 and Codex P2 on #480). A correction blocks the
 *   label rather than replacing it: reading nothing is the safe side.
 * - A later caller line, after the agent has spoken, that corrects or denies a
 *   date ("Sorry, I meant <date>.") or takes the date back ("That was her
 *   surgery date.") clears a date read from a label, even inside an ask window
 *   that read nothing else.
 * - Two different dates labelled this way on one call (two patients, or a
 *   correction) read as neither. Only outside an ask window: inside one, the
 *   window's own reading already decides.
 */
const CALLER_DOB_LABEL =
  /(?:^| )(?:date of birth|birth date|birthdate|dob|d o b|fecha de nacimiento)(?: (?:is|was|es|era))?(?= |$)/g;

/**
 * Words that say the caller is not sure of what they said. A negated doubt
 * ("not sure", "don't know", "no estoy segura") is `negatesADate`'s.
 */
const UNSURE_OF_THE_DATE =
  /(?:^| )(?:maybe|probably|perhaps|possibly|i think|i believe|i guess|i suppose|unsure|if i remember|if i recall|creo|tal vez|quizas|quiza|a lo mejor)(?= |$)/;

/** A sentence that denies, corrects, takes back or doubts a date. */
function doubtsADate(sentence: string): boolean {
  return rejectsADate(sentence) || negatesADate(sentence) || UNSURE_OF_THE_DATE.test(fold(sentence))
    || withdrawsTheDateBefore(sentence, true);
}

/**
 * A later caller line, after the agent spoke, that takes back a date read from
 * a label: a correction or a denial that gives a date ("Sorry, I meant
 * <date>.", "No, it is <date>."), or a withdrawal ("That was her surgery
 * date.", `withdrawsTheDateBefore` with no date in the turn).
 */
function takesALabelledDateBack(uttered: string): boolean {
  return uttered.split(/(?<=[.!?])\s+/).some((sentence) =>
    (carriesADate(sentence) && (rejectsADate(sentence) || negatesADate(sentence)))
    || withdrawsTheDateBefore(sentence, false));
}

/** The first word after a label must be where a date starts. */
function startsADate(folded: string): boolean {
  const first = folded.split(' ').find(Boolean) ?? '';
  return /^\d/.test(first) || Boolean(monthNumberFromWord(first)) || NUMBER_WORDS.has(first) || /^veinti/.test(first);
}

/**
 * The dates labelled as the date of birth in `uttered`. `afterwards`: what the
 * caller said after this line before the agent next spoke.
 */
function labelledDates(uttered: string, afterwards: readonly string[]): string[] {
  const out: string[] = [];
  const sentences = uttered.split(/(?<=[.!?])\s+/);
  const later = afterwards.flatMap((line) => line.split(/(?<=[.!?])\s+/));
  sentences.forEach((sentence, s) => {
    const folded = fold(sentence);
    const labels = [...folded.matchAll(CALLER_DOB_LABEL)];
    if (!labels.length) return;
    if ([sentence, ...sentences.slice(s + 1), ...later].some(doubtsADate)) return;
    labels.forEach((m, k) => {
      const from = (m.index ?? 0) + m[0].length;
      const to = labels[k + 1]?.index ?? folded.length;
      const rest = folded.slice(from, to).trim();
      if (!rest || !startsADate(rest) || namesAnotherDate(rest)) return;
      const parts = readDobQuietly(rest);
      if (parts) out.push(isoFromParts(parts));
    });
  });
  return out;
}

/** The caller lines straight after `i`, up to the next agent line. */
function callerLinesAfter(lines: readonly string[], i: number): string[] {
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j] ?? '';
    if (!line.startsWith(CALLER_PREFIX)) break;
    out.push(line.slice(CALLER_PREFIX.length));
  }
  return out;
}

function readCallerAnswer(lines: readonly string[]): TranscriptRead {
  let latest: TranscriptRead = { kind: 'none' };
  // The line the held date came from; a rejection after it clears it.
  let heldAt = -1;
  let dobAskedBefore = false;
  let lastSubject: DateSubject | undefined;
  // Whether the last agent line opened an ask window (its caller lines are the window's).
  let inWindow = false;
  // v231: the dates the caller labelled as the date of birth outside a window.
  const labelled = new Set<string>();
  // v231: the held date came from a label, so a later line may still take it
  // back. It matters only while a date is held: a clear needs no reset, and a
  // date an ask window reads resets it.
  let heldFromALabel = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith(CALLER_PREFIX)) {
      const uttered = line.slice(CALLER_PREFIX.length);
      if (latest.kind === 'date' && i > heldAt && rejectsTheHeldDate(uttered, latest.iso)) {
        latest = { kind: 'cleared' };
        heldAt = -1;
      }
      if (heldFromALabel && takesALabelledDateBack(uttered)) {
        latest = { kind: 'cleared' };
        heldAt = -1;
      }
      const afterwards = inWindow ? [] : callerLinesAfter(lines, i);
      const said = inWindow ? [] : labelledDates(uttered, afterwards);
      if (said.length) {
        for (const iso of said) labelled.add(iso);
        const [only] = labelled;
        if (labelled.size > 1 || (latest.kind === 'date' && latest.iso !== only)) {
          // Two dates of birth on one call: which is this patient's cannot be told.
          latest = { kind: 'cleared' };
          heldAt = -1;
        } else if (only) {
          latest = { kind: 'date', iso: only };
          heldAt = i;
          heldFromALabel = true;
        }
      }
      continue;
    }
    if (!line.startsWith(AGENT_PREFIX)) continue;
    const said = line.slice(AGENT_PREFIX.length);
    const opening = opensDobWindow(said, { dobAskedBefore, lastSubject });
    inWindow = Boolean(opening);
    if (mentionsDobTopic(fold(said))) dobAskedBefore = true;
    lastSubject = subjectOf(said, lastSubject);
    if (!opening) continue;
    const window = readWindow(lines, i + 1);
    const held = latest.kind === 'date' ? latest.iso : undefined;
    if (window.kind === 'date') {
      if (opening.mixed && held && window.iso !== held && !window.namesTheBirthday) {
        latest = { kind: 'cleared' };
        heldAt = -1;
      } else {
        latest = { kind: 'date', iso: window.iso };
        heldAt = window.at;
      }
      heldFromALabel = false;
    } else if (window.kind === 'refused') {
      if (held && window.attempts.every((a) => agreeingPartial(a, held))) continue;
      latest = { kind: 'cleared' };
      heldAt = -1;
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
 * rather than the value the caller has just rejected.
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
