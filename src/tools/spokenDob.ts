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
 * twenty two of fifty" is that case — a wrong birthday filed is worse than
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
 *  - Digits spelled out as WORDS still refuse, in both languages — the parser
 *    cannot read "zero one zero four five eight", so neither can this. That
 *    refusal now CLEARS a previously cached date instead of filing it.
 *
 * ── STORAGE ────────────────────────────────────────────────────────────────
 *
 * In memory, for the length of one call, with the TTL, the ceiling, the
 * recency eviction and the sentinel rule taken from `gateAttempts.ts` and
 * `verifiedIdentity.ts` beside it. This is patient data and it has no business
 * being written anywhere durable so that one module can hand it to another.
 */

import { isTwilioCallSid } from './callSid';
import { dobShape, monthNumberFromWord, readDobQuietly } from './dobParts';

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

function opensDobWindow(agentLine: string): boolean {
  if (agentLine.split(/(?<=[.!?])\s+/).some(sentenceOpensDobWindow)) return true;
  const folded = fold(agentLine);
  if (!mentionsDobTopic(folded)) return false;
  return LINE_REASK_CUES.some((c) => folded.includes(c));
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
  | { kind: 'date'; iso: string }
  | { kind: 'refused' }
  | { kind: 'empty' };

type TranscriptRead =
  | { kind: 'date'; iso: string }
  | { kind: 'cleared' }
  | { kind: 'none' };

function readWindow(lines: readonly string[], from: number): WindowRead {
  let found: string | undefined;
  let refused = false;
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
    if (found === undefined && looksLikeDobAttempt(uttered)) refused = true;
  }
  if (found !== undefined) return { kind: 'date', iso: found };
  if (refused) return { kind: 'refused' };
  return { kind: 'empty' };
}

function readCallerAnswer(lines: readonly string[]): TranscriptRead {
  let latest: TranscriptRead = { kind: 'none' };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith(AGENT_PREFIX)) continue;
    if (!opensDobWindow(line.slice(AGENT_PREFIX.length))) continue;
    const window = readWindow(lines, i + 1);
    if (window.kind === 'date') latest = { kind: 'date', iso: window.iso };
    else if (window.kind === 'refused') latest = { kind: 'cleared' };
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
 * standing. "No, zero three twenty two of fifty" is an attempt, the parser
 * refuses it by design, and the function returns undefined rather than the
 * value the caller has just rejected.
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
