/**
 * HOW THE CALLER SAID THE RECORDS SHOULD GO, READ FROM THE CALL — v232.
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
 * TWO THINGS ARE READ, and neither is a destination:
 *
 *  1. THE METHOD. An agent line that offers at least two of fax, email and
 *     mail, as a question, opens a window; the caller's turns until the next
 *     agent line are the answer. The LATEST window the caller answered
 *     decides it, wholly: exactly one method named, and no negation in the
 *     answer, is the method. "Through our portal or through fax" is fax:
 *     portal is not a method, fax is the one they offered that is. Two methods
 *     ("fax or email is fine"), any "no / not / don't", or none at all
 *     ("Actually, I don't know") is no method, even if an earlier window named
 *     one. A repeat of the question nobody answered changes nothing. A
 *     later turn that names the method beside a negation or a correction
 *     ("Actually, do not fax the records") forgets it, and so does a switch
 *     said outside the question ("Actually, email it instead"): neither
 *     reads a new method, so a retraction or a switch never leaves the old
 *     method on the ticket and nothing is read outside a window. Both err
 *     toward forgetting; a forgotten method files NOT CAPTURED, as on main.
 *  2. THAT A DESTINATION WAS GIVEN, AND FOR WHICH METHOD. An agent line asking
 *     where to send them, answered in the shape it asked for: a number of
 *     seven digits or more for a fax, an email address for an email, a
 *     street number and words for a mailing address. It is a list of method
 *     names and never the destination: the tool does not ask the caller a
 *     second time, and the ticket points the clerk at the recording instead
 *     of "NOT CAPTURED". Kept per method, so an email address given as a
 *     contact never stands in for a fax number.
 *
 * A DESTINATION IS NEVER READ FROM THE TRANSCRIPT. The first version also read
 * a fax number the agent read back and the caller confirmed, and wrote it on
 * the ticket as "read back and confirmed". It drew three review rounds on #482
 * (a replacement number, then a method switch, then "Yes, actually that fax
 * number is wrong" read as a yes), each a way to put a number the caller had
 * taken back on a records ticket, which faxes a patient's chart to the wrong
 * place. Withdrawn on the #476 ruling ("Shrink the reader", operator,
 * 2026-11-13): a destination on the ticket is the one the MODEL sent, as on
 * `main`, and otherwise the clerk reads it from the recording.
 *
 * PHI: the store holds a method word and a method list per call, for 30
 * minutes. Nothing here logs a value.
 */
import { isTwilioCallSid } from './callSid';
import type { RecordsDeliveryMethod } from './recordsDeliveryMethod';

export interface HeardDelivery {
  /** The method the caller named in answer to the method question. */
  method?: RecordsDeliveryMethod;
  /**
   * The methods the caller gave a destination FOR, in answer to the question
   * that asked for it. Method names only, never the destination itself. Per
   * method, so an email address given as a contact never stands in for the
   * fax number a fax request needs.
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
 * The delivery question: it asks how they want to RECEIVE THE RECORDS (the
 * funnel's own wording), or names the records, copies or the chart. A
 * question naming two methods about something else ("Did you send the
 * authorization by fax or email?", github-actions P2 on `0ce95d97`) opens no
 * window, so its answer is never a delivery method.
 */
const ABOUT_RECEIVING_THE_RECORDS = /\b(receive|records?|copies|copy|chart)\b/;

/**
 * The agent offering the methods: two or more of fax, email and mail, asked.
 * v188's own question ("How would you like to receive the records — by fax,
 * by email, or by mail?") and the model's paraphrases of it ("How would you
 * like to receive those — by fax, by email, or by mail?") both qualify; "Does
 * fax work?" (one method), the signing-link question (texts or email) and a
 * two-method question about anything but receiving the records do not.
 */
export function asksForTheMethod(agentText: string): boolean {
  const offered = methodsNamed(agentText);
  offered.delete('pickup');
  return (
    offered.size >= 2 &&
    (agentText.includes('?') || /\bhow would you like\b/.test(agentText)) &&
    ABOUT_RECEIVING_THE_RECORDS.test(agentText)
  );
}

/** The one method a window's answer names; none, several, or a negation is no method. */
function methodInAnswer(answer: string): RecordsDeliveryMethod | undefined {
  const named = methodsNamed(answer);
  if (named.size !== 1 || NEGATION.test(answer)) return undefined;
  return [...named][0];
}

// ------------------------------------------------------------ digit runs

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

// ------------------------------------------------------------- the destination

/** A callback or a phone number for the caller is not where the records go. */
const CALLBACK_CONTEXT = /\b(call ?back|callback|reach you|phone number|best number|cell|mobile|text)/;

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

// ------------------------------------------------------------------ the reader

/** A correction: with the stored method named beside it, the method is taken back. */
const RETRACTS = /\b(actually|rather|change|changed|wrong|mistake|scratch that|never ?mind)\b/;
/** The caller changing how the records go, outside the method question. */
const SWITCH = /\b(actually|instead|rather|change|switch|prefer|better)\b|\b(send|email|mail|fax) (it|them|those|these|the records)\b|\bby (email|mail|fax|post)\b/;

/**
 * Everything the record says about how, and whether a destination was given,
 * read in call order. The latest answered method question decides the
 * method, a retraction or a switch outside the question forgets it, and a destination once given stays
 * given.
 */
export function readRecordsDelivery(lines: readonly string[]): HeardDelivery {
  const turns = parse(lines);
  let method: RecordsDeliveryMethod | undefined;
  const given = new Set<RecordsDeliveryMethod>();

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === 'caller') {
      const named = methodsNamed(t.text);
      // "Actually, do not fax the records." The stored method named beside a
      // negation or a correction is forgotten, whatever the caller meant by
      // it: a method the caller may have taken back is never filed.
      if (method && named.has(method) && (NEGATION.test(t.text) || RETRACTS.test(t.text))) method = undefined;
      // "Actually, can you email it instead?" Forgotten, not read: the model's
      // own argument decides it. Inside the method question's window the
      // answer has already set the method, so this changes nothing there.
      if (SWITCH.test(t.text) && [...named].some((m) => m !== method)) method = undefined;
      continue;
    }

    // The caller's turns that answer this agent line, up to the next agent line.
    const answers: string[] = [];
    for (let j = i + 1; j < turns.length && turns[j].role === 'caller'; j++) answers.push(turns[j].text);
    const answer = answers.join(' ');
    const first = answers[0] ?? '';

    // The latest method question the caller answered decides the method,
    // wholly: one method named with no negation is the method, and anything
    // else ("Actually, I don't know", two methods, "not fax") is none. The
    // `spokenPatientStatus.ts` rule, latest window wins.
    if (asksForTheMethod(t.text) && answer) {
      const m = methodInAnswer(answer);
      method = m;
      // "We need them faxed to …": the method and its destination in one answer.
      if (m && destinationIn(answer, m)) given.add(m);
    }

    if (asksForTheDestination(t.text) && answer && !NEGATION.test(first)) {
      const kind = destinationIn(answer, destinationAskedFor(t.text));
      if (kind) given.add(kind);
    }
  }
  return { ...(method ? { method } : {}), given: [...given] };
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
  return !h.method && h.given.length === 0;
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

/** Tests only. */
export function resetRecordsDeliveries(): void {
  heardByCall.clear();
}
