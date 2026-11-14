/**
 * HOW AND WHERE THE CALLER SAID THE RECORDS SHOULD GO, READ FROM THE CALL — v232.
 *
 * v188 (operator, 2026-11-08) made `file_records_ticket` ask how the requester
 * wants the records, then where, each ONCE, and file with the gap written on
 * the ticket when the answer does not come back. The answer comes back only
 * if the model puts it in `delivery_method` / `deliver_to` on its next call,
 * and on this lane it mostly does not.
 *
 * MEASURED, the records line on the runtime, 2026-11-11..11-13, every
 * `file_records_ticket` call that followed a refusal (`tool_timeline`, the
 * v198 `supplied` names): after a `delivery_method` refusal the next call
 * carried `delivery_method` on 9 of 24; after a name refusal it carried a name
 * on 0 of 13. The model re-sends the argument set of its first call, word for
 * word, while the caller answers in between. So the one ask is spent on a call
 * that does not carry the answer, and the ticket says "Delivery: NOT
 * CAPTURED" about a request whose caller said "By fax." a few seconds earlier.
 *
 * Since v188 went live (2026-11-09..11-13, Pacific days), 25 records-lane
 * Medical Records tickets say "Delivery: NOT CAPTURED"; on 19 of them the
 * caller had answered the method question with one method. In the
 * 2026-11-12/13 quality corpus that is 11 of the 12 "no delivery (caller gave
 * it)" tickets; the twelfth answered "Via portal", which is not a method.
 *
 * THE SAME DEVICE AS THE DATE OF BIRTH (`spokenDob.ts`) and the new-or-existing
 * answer (`spokenPatientStatus.ts`): the bridge posts the call's whole record
 * on every caller turn, and the tool reads back what the caller said in answer
 * to the QUESTION. Nothing is read outside an answer window, and the answer is
 * read in the shape the question asked for (RULE ZERO 2c): the question names
 * three methods, so the answer is one of three words. That is the funnel
 * working, not a parser guessing at free speech (standing instruction 3 is
 * about names; no name is read here).
 *
 * THREE THINGS ARE READ, and each fails toward what the tool did before:
 *
 *  1. THE METHOD. An agent line that offers at least two of fax, email and
 *     mail, as a question, opens a window; the caller's turns until the next
 *     agent line are the answer. Exactly one method named, and no negation in
 *     the answer, is the method. "Through our portal or through fax" is fax:
 *     portal is not a method, fax is the one they offered that is. Two methods
 *     ("fax or email is fine"), or any "no / not / don't", reads nothing.
 *  2. A FAX NUMBER THE CALLER CONFIRMED. An agent line that reads ONE
 *     ten-digit number back as a question ("… Did I get that right?"), in a
 *     fax context (the line or the caller turn it reads back names fax, or
 *     the nearest earlier agent line that names a destination named the fax,
 *     or the caller chose fax), never in a callback context, and the caller's
 *     next turn says yes. The number is the agent's own words — the
 *     model's text, not a transcription — and the caller heard it and agreed.
 *     A "no" to a fax readback clears any number held. The ticket labels it as
 *     read back and confirmed on the call.
 *  3. THAT A DESTINATION WAS GIVEN, AND FOR WHICH METHOD. An agent line asking
 *     where to send them (a fax number, an email or mailing address, "where
 *     should these be sent"), answered in the shape it asked for: a number of
 *     seven digits or more for a fax, an email address for an email, a
 *     street number and words for a mailing address — or a destination the
 *     agent read back and the caller affirmed. It does not say WHAT was given
 *     (only the fax reader does): it says the tool must not ask the caller a
 *     second time, and the ticket points the clerk at the call transcript
 *     instead of "NOT CAPTURED — confirm". Kept per method, so an email
 *     address given for a callback never stands in for a fax number.
 *  4. A CONFIRMED FAX IS ONLY GOOD UNTIL THE CALLER REPLACES IT (Codex P2 on
 *     #482). Anything later that puts it in question clears it, and the
 *     ticket falls back to the transcript pointer until a new number is read
 *     back and confirmed: a caller turn with a different number in a fax
 *     context (it names the fax or a correction, or answers a fax or
 *     destination question; never a callback or date-of-birth answer), a
 *     caller turn naming the fax with a correction or a negation ("that fax
 *     number is wrong"), a readback of a different number the caller does not
 *     confirm, and a switch of method, inside the method question ("Email.")
 *     or outside it ("Actually, can you email it instead?"). A switch outside
 *     the question also forgets the method, because nothing is read outside an
 *     answer window: the model's own argument decides it. Clearing costs a
 *     confirmed number on the ticket; keeping a replaced one sends a chart to
 *     the wrong place, so every rule errs toward clearing.
 *
 * PHI: the store holds a method word, ten digits and a method list per call, for
 * 30 minutes, the same lifetime as the date of birth beside it. Nothing here
 * logs a value.
 */
import { isTwilioCallSid } from './callSid';
import type { RecordsDeliveryMethod } from './recordsDeliveryMethod';

export interface HeardDelivery {
  /** The method the caller named in answer to the method question. */
  method?: RecordsDeliveryMethod;
  /** Ten digits the agent read back as the fax number and the caller confirmed. */
  fax?: string;
  /**
   * The methods the caller gave a destination FOR: a fax number, an email
   * address or a mailing address, in answer to the question that asked for
   * it. Per method, so an email address given as a contact never stands in
   * for the fax number a fax request needs.
   */
  given: RecordsDeliveryMethod[];
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\[interrupted\]/g, ' ')
    // "e-mail", "e mail" are one word; so is "pick-up".
    .replace(/\be[\s-]+mail/g, 'email')
    .replace(/\bpick[\s-]+up\b/g, 'pickup')
    .replace(/[^a-z0-9'@\s.?!,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Line = { role: 'agent' | 'caller'; text: string };

function parse(lines: readonly string[]): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    if (line.startsWith('AGENT:')) out.push({ role: 'agent', text: fold(line.slice('AGENT:'.length)) });
    else if (line.startsWith('CALLER:')) out.push({ role: 'caller', text: fold(line.slice('CALLER:'.length)) });
  }
  return out;
}

// ------------------------------------------------------------------ the method

const FAX = /\b(fax(es|ed|ing)?|facsimile)\b/;
const EMAIL = /\bemail(s|ed|ing)?\b/;
// "mail" on its own; "email" and "voicemail" never reach it (no word boundary
// inside them).
const MAIL = /\b(mail(ed|ing)?|postal|snail mail|by post)\b/;
const PICKUP = /\b(pickup|pick (it|them|those|these) up|in person)\b/;

function methodsNamed(text: string): Set<RecordsDeliveryMethod> {
  const found = new Set<RecordsDeliveryMethod>();
  if (FAX.test(text)) found.add('fax');
  if (EMAIL.test(text)) found.add('email');
  if (MAIL.test(text)) found.add('mail');
  if (PICKUP.test(text)) found.add('pickup');
  return found;
}

/** Any negation in the answer, and the answer is not read. */
const NEGATION = /\b(no|nope|not|don't|dont|doesn't|doesnt|never|can't|cant|cannot|won't|wont|isn't|isnt|instead)\b/;

/**
 * The agent offering the methods: two or more of fax, email and mail, asked.
 * v188's own question ("How would you like to receive the records — by fax,
 * by email, or by mail?") and the model's paraphrases of it ("How would you
 * like to receive those — by fax, by email, or by mail?") both qualify; "Does
 * fax work?" (one method) and the signing-link question (texts or email) do
 * not.
 */
export function asksForTheMethod(agentText: string): boolean {
  const offered = methodsNamed(agentText);
  offered.delete('pickup');
  return offered.size >= 2 && (agentText.includes('?') || /\bhow would you like\b/.test(agentText));
}

/** The one method a window's answer names, or undefined; `null` = named but unreadable. */
function methodInAnswer(answer: string): RecordsDeliveryMethod | null | undefined {
  const named = methodsNamed(answer);
  if (named.size === 0) return undefined;
  if (named.size > 1 || NEGATION.test(answer)) return null;
  return [...named][0];
}

// -------------------------------------------------------------- the fax number

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/**
 * Runs of digits in a line, digit words folded in. Punctuation between groups
 * ("four one five, three six six") does not break a run; a word does.
 */
export function digitRuns(text: string): string[] {
  const runs: string[] = [];
  let run = '';
  for (const token of text.split(/[\s,.\-?!]+/)) {
    if (!token) continue;
    if (/^\d+$/.test(token)) run += token;
    else if (DIGIT_WORDS[token] !== undefined) run += DIGIT_WORDS[token];
    else {
      if (run) runs.push(run);
      run = '';
    }
  }
  if (run) runs.push(run);
  return runs;
}

/** A US ten-digit number, an eleven-digit one with the leading 1 dropped. */
function tenDigits(run: string): string | undefined {
  if (run.length === 10) return run;
  if (run.length === 11 && run.startsWith('1')) return run.slice(1);
  return undefined;
}

/** The one ten-digit number in a line, if exactly one number of seven digits or more is there. */
function onlyPhoneShapedNumber(text: string): string | undefined {
  const long = digitRuns(text).filter((r) => r.length >= 7);
  if (long.length !== 1) return undefined;
  return tenDigits(long[0]);
}

const CONFIRMING = /\b(did i get that (right|correct)|is that (right|correct|the one|the number|it|where)|got that right|correct\?|right\?)/;
/** A callback or a phone number for the caller is not where the records go. */
const CALLBACK_CONTEXT = /\b(call ?back|callback|reach you|phone number|best number|cell|mobile|text)/;
const AFFIRMS = /^(?:(?:uh|um|oh|okay|ok|so)\b[\s,.]*)*(yes|yeah|yep|yup|correct|right|exactly|that's (right|correct|it)|that is (right|correct)|si|uh huh|mm hmm)\b/;
const DENIES = /^(?:(?:uh|um|oh)\b[\s,.]*)*(no|nope|not|wrong|incorrect|that's not|that is not)\b/;

/** A word that takes back or replaces what was said before. */
const CORRECTION = /\b(actually|instead|rather|different|another|wrong|incorrect|change|changed|correction|update|updated|mistake|scratch that|never ?mind)\b/;
/** A date of birth asked or given: its digits are not a fax number. */
const BIRTH_CONTEXT = /\b(date of birth|birth ?date|birthday|born|dob)\b/;
/** The caller changing how the records go, outside the method question. */
const SWITCH = /\b(actually|instead|rather|change|switch|prefer|better)\b|\b(send|email|mail|fax) (it|them|those|these|the records)\b|\bby (email|mail|fax|post)\b/;

/** "Send it to …", "use …": a number said as where the records go. */
const SEND_TO = /\b(send|sent|use|going to|go to)\b/;

/** The confirmed fax said again: the same ten digits, or its last seven to nine. */
function sameNumber(run: string, fax: string): boolean {
  if (tenDigits(run) === fax) return true;
  return run.length < 10 && fax.endsWith(run);
}

// ------------------------------------------------------------- the destination

/**
 * The agent asking where the records go. A method question is not one (it
 * names fax), and a callback question is not one.
 */
export function asksForTheDestination(agentText: string): boolean {
  if (!agentText.includes('?')) return false;
  if (asksForTheMethod(agentText)) return false;
  if (CALLBACK_CONTEXT.test(agentText)) return false;
  return /\b(fax|email address|mailing address|address)\b|\bwhere\b[^?]{0,40}\b(sent|send|go)\b|\bsend (them|these|those|it|the records) to\b/.test(
    agentText,
  );
}

/** Which destination a destination question asks for; `undefined` = "where should these be sent?". */
function destinationAskedFor(agentText: string): RecordsDeliveryMethod | undefined {
  if (FAX.test(agentText)) return 'fax';
  if (EMAIL.test(agentText)) return 'email';
  if (/\b(mailing address|address)\b/.test(agentText)) return 'mail';
  return undefined;
}

const EMAIL_SHAPE = /@|\bat\b.*\bdot\b/;

function hasLongNumber(text: string): boolean {
  return digitRuns(text).some((r) => r.length >= 7);
}

/**
 * What kind of destination an answer is, read in the shape its question
 * asked for (RULE ZERO 2c). An email address is an email destination; a
 * number of seven digits or more is a fax number unless the question asked
 * for an email or a postal address; a postal address is an answer to an
 * address question that carries a street number and some words.
 */
function destinationIn(answer: string, asked: RecordsDeliveryMethod | undefined): RecordsDeliveryMethod | undefined {
  if (EMAIL_SHAPE.test(answer)) return asked === 'fax' || asked === 'mail' ? undefined : 'email';
  if (hasLongNumber(answer)) return asked === 'email' || asked === 'mail' ? undefined : 'fax';
  if (asked === 'mail' && /\d/.test(answer) && answer.split(' ').length >= 3) return 'mail';
  return undefined;
}

/**
 * What the agent was last asking about before a readback: the nearest earlier
 * agent line that names a callback or a phone number, a fax, an email or a
 * mailing address. A number read back while the agent was collecting the fax
 * number ("What's the fax number?" … "What are the last four?" … "Did I get
 * that right?") is the fax number; one read back after "What's the best number
 * to reach you?" is not. The method question names all three and is skipped:
 * the method the caller CHOSE is the cue, and the caller's answer carries it.
 */
function nearestCue(turns: Line[], i: number): RecordsDeliveryMethod | 'callback' | undefined {
  let seen = 0;
  for (let q = i - 1; q >= 0 && seen < 8; q--) {
    const t = turns[q];
    if (t.role !== 'agent') continue;
    seen++;
    if (asksForTheMethod(t.text)) continue;
    if (CALLBACK_CONTEXT.test(t.text)) return 'callback';
    if (FAX.test(t.text)) return 'fax';
    if (EMAIL.test(t.text)) return 'email';
    if (/\b(mailing address|mail(ed|ing)?)\b/.test(t.text)) return 'mail';
  }
  return undefined;
}

// ------------------------------------------------------------------ the reader

/**
 * Everything the record says about how and where, read in call order. The
 * latest readable method wins; the latest confirmed fax wins, and anything
 * later that replaces, corrects or switches away from it clears it (point 4
 * above); a destination once given stays given.
 */
export function readRecordsDelivery(lines: readonly string[]): HeardDelivery {
  const turns = parse(lines);
  let method: RecordsDeliveryMethod | undefined;
  let fax: string | undefined;
  const given = new Set<RecordsDeliveryMethod>();

  // The agent line the current caller turn answers, and the readback that set the fax.
  let answering = -1;
  let faxSetBy = -1;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === 'caller') {
      const asked = answering >= 0 ? turns[answering].text : '';
      // A different number where a fax number could be meant replaces the confirmed one.
      if (fax && !CALLBACK_CONTEXT.test(asked) && !BIRTH_CONTEXT.test(asked) && !BIRTH_CONTEXT.test(t.text)
        && !(CALLBACK_CONTEXT.test(t.text) && !FAX.test(t.text))) {
        const replaced = digitRuns(t.text).some((r) => r.length >= 7 && !sameNumber(r, fax!));
        const faxContext = FAX.test(t.text) || CORRECTION.test(t.text) || SEND_TO.test(t.text) || FAX.test(asked)
          || (asksForTheDestination(asked) && destinationAskedFor(asked) !== 'email' && destinationAskedFor(asked) !== 'mail');
        if (replaced && faxContext) fax = undefined;
      }
      // "That fax number is wrong." The yes that confirmed it is not read this way.
      if (fax && i !== faxSetBy + 1 && FAX.test(t.text) && (CORRECTION.test(t.text) || NEGATION.test(t.text))) {
        fax = undefined;
      }
      // "Actually, can you email it instead?" Inside the method question's window
      // the answer has already set the method, so this changes nothing there.
      if (SWITCH.test(t.text)) {
        const named = methodsNamed(t.text);
        if ([...named].some((m) => m !== method)) method = undefined;
        if ([...named].some((m) => m !== 'fax')) fax = undefined;
      }
      continue;
    }
    answering = i;

    // The caller's turns that answer this agent line, up to the next agent line.
    const answers: string[] = [];
    for (let j = i + 1; j < turns.length && turns[j].role === 'caller'; j++) answers.push(turns[j].text);
    const answer = answers.join(' ');
    const first = answers[0] ?? '';

    if (asksForTheMethod(t.text) && answer) {
      const m = methodInAnswer(answer);
      if (m) method = m;
      else if (m === null) method = undefined;
      // Any answer to the method question but fax: a fax confirmed earlier is not this method's.
      if (m !== undefined && m !== 'fax') fax = undefined;
      // "We need them faxed to …": the method and its destination in one answer.
      if (m && destinationIn(answer, m)) given.add(m);
    }

    if (asksForTheDestination(t.text) && answer && !NEGATION.test(first)) {
      const kind = destinationIn(answer, destinationAskedFor(t.text));
      if (kind) given.add(kind);
    }

    // A readback of a destination, asked as a confirming question.
    if (t.text.includes('?') && CONFIRMING.test(t.text) && (hasLongNumber(t.text) || EMAIL_SHAPE.test(t.text))) {
      // The caller turn it reads back.
      let k = i - 1;
      while (k >= 0 && turns[k].role === 'caller' && !hasLongNumber(turns[k].text) && !EMAIL_SHAPE.test(turns[k].text)) k--;
      const readFrom = k >= 0 && turns[k].role === 'caller' ? turns[k].text : '';
      if (CALLBACK_CONTEXT.test(t.text) || CALLBACK_CONTEXT.test(readFrom)) continue;
      const cue = FAX.test(t.text) || FAX.test(readFrom) ? 'fax' : (nearestCue(turns, i) ?? method);
      if (cue === 'callback') continue;
      const number = onlyPhoneShapedNumber(t.text);
      if (AFFIRMS.test(first)) {
        if (EMAIL_SHAPE.test(t.text)) given.add('email');
        else if (number && cue === 'fax') {
          fax = number;
          faxSetBy = i;
          given.add('fax');
        }
      } else if (DENIES.test(first) && number && cue === 'fax') {
        fax = undefined;
      } else if (fax && number && cue === 'fax' && number !== fax) {
        // A different number read back and not confirmed: neither is safe to file.
        fax = undefined;
      }
    }
  }
  return { ...(method ? { method } : {}), ...(fax ? { fax } : {}), given: [...given] };
}

// ------------------------------------------------------------------ the store

interface Entry {
  heard: HeardDelivery;
  at: number;
}

const heardByCall = new Map<string, Entry>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

function sweep(now: number): void {
  for (const [k, v] of heardByCall) {
    if (now - v.at > TTL_MS) heardByCall.delete(k);
  }
  if (heardByCall.size > MAX_ENTRIES) {
    let excess = heardByCall.size - MAX_ENTRIES;
    for (const k of heardByCall.keys()) {
      heardByCall.delete(k);
      if (--excess <= 0) break;
    }
  }
}

function isEmpty(h: HeardDelivery): boolean {
  return !h.method && !h.fax && h.given.length === 0;
}

/**
 * The bridge, posting the call's whole record on every caller turn — the
 * record, not one line, because a caller turn is REPLACED in place as its
 * cumulative transcript is re-emitted (`spokenDob.ts`). Recomputed from the
 * whole record every time, so a reading the transcript stopped supporting goes
 * (`spokenPatientStatus.ts`, Codex round 4's third P1 on #293). A sentinel
 * CallSid is not a call: two calls with no real SID never share an entry.
 */
export function noteRecordsDelivery(callSid: string | undefined, lines: readonly string[]): void {
  if (!isTwilioCallSid(callSid)) return;
  const heard = readRecordsDelivery(lines);
  const now = Date.now();
  sweep(now);
  heardByCall.delete(callSid);
  if (isEmpty(heard)) return;
  heardByCall.set(callSid, { heard, at: now }); // re-inserted, so order tracks recency
}

/** What this call's caller said about how and where, or undefined. Validated on the read too. */
export function recordsDeliveryHeard(callSid: string | undefined): HeardDelivery | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = heardByCall.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return { ...entry.heard, given: [...entry.heard.given] };
}

/** "2025550199" as "202-555-0199": how a clerk reads a fax number. */
export function formatFax(tenDigitNumber: string): string {
  return `${tenDigitNumber.slice(0, 3)}-${tenDigitNumber.slice(3, 6)}-${tenDigitNumber.slice(6)}`;
}

/** Tests only. */
export function resetRecordsDeliveries(): void {
  heardByCall.clear();
}
