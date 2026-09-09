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
 * the turn that follows an agent line asking for one, ending at the next thing
 * the agent says. Nothing else in the call is looked at.
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
 *    cannot read "zero one zero four five eight", so neither can this.
 *
 * ── STORAGE ────────────────────────────────────────────────────────────────
 *
 * In memory, for the length of one call, with the TTL, the ceiling, the
 * recency eviction and the sentinel rule taken from `gateAttempts.ts` and
 * `verifiedIdentity.ts` beside it. This is patient data and it has no business
 * being written anywhere durable so that one module can hand it to another.
 */

import { isTwilioCallSid } from './callSid';
import { readDobQuietly } from './dobParts';

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
 * The ways an agent asks for a date of birth.
 *
 * Deliberately phrases and not a question mark: a READBACK is a request too
 * ("I have March 17th 1983, is that right?" — no, and here is the right one),
 * and the correction that follows it is exactly the answer worth having. What
 * matters is that the agent put the subject on the table, not the grammar it
 * used.
 *
 * The scripted refusal line the four filing tools speak — "may I please have
 * the date of birth, starting with the month, then the day, then the year" —
 * matches the first entry, which is the case that has to work: it is the line
 * the caller is answering on all 75 of 2026-09-08's refusals.
 */
const DOB_QUESTIONS = [
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

function asksForDateOfBirth(agentLine: string): boolean {
  const folded = fold(agentLine);
  return DOB_QUESTIONS.some((q) => folded.includes(q));
}

const AGENT_PREFIX = 'AGENT: ';
const CALLER_PREFIX = 'CALLER: ';

/**
 * The date of birth the caller gave in answer to being asked for one, as
 * `YYYY-MM-DD`, or undefined.
 *
 * THE LAST ONE WINS. An agent that asked twice asked because the first answer
 * did not survive — it was misheard, read back wrong, or the tool refused it —
 * so the later answer is the caller correcting the earlier one. Taking the
 * first would file the value the caller has just told us is wrong.
 *
 * Parsed QUIETLY. This runs over caller lines to find out whether any of them
 * is a date, so most of what it parses is not one, and every failure would
 * otherwise print `[DOB] refused a date of birth in the shape …` — a
 * documented live counter, and the instrument the 2026-09-08 finding rests on.
 * See `readDobQuietly`.
 */
export function dobFromCallerAnswer(lines: readonly string[]): string | undefined {
  let answer: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith(AGENT_PREFIX)) continue;
    if (!asksForDateOfBirth(line.slice(AGENT_PREFIX.length))) continue;
    // The answering turn: every caller line up to the next thing the agent
    // says. More than one is ordinary — "Sure." lands as its own line, then
    // the date.
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (!next.startsWith(CALLER_PREFIX)) break;
      const parts = readDobQuietly(next.slice(CALLER_PREFIX.length));
      if (parts) answer = `${parts.year}-${parts.month}-${parts.day}`;
    }
  }
  return answer;
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
 * it.
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
  const iso = dobFromCallerAnswer(lines);
  if (!iso) return;
  const now = Date.now();
  sweep(now);
  heard.delete(callSid); // re-insert so insertion order tracks recency
  heard.set(callSid, { iso, at: now });
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
