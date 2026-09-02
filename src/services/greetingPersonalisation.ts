/**
 * One opening, not two.
 *
 * The greeting is forced verbatim ("Say exactly this greeting"), and an agent
 * whose caller was recognised also carries a prompt block telling it the
 * greeting has already played and to open with "Am I speaking with <name>?".
 * Both are only true if the greeting itself was personalised first. When it is
 * not, the model starts the configured line and abandons it mid-phrase.
 *
 * Reported by the operator on 2026-08-12 — "when the pre context arrives it
 * cuts off the greeting" — and visible in the transcript as:
 *
 *     AGENT: Thank you for calling Azul
 *     AGENT: Am I speaking with Wayne?
 *
 * This lives in its own module because the first version of it was a regex
 * inline in a 7,000-line route file, keyed on one hardcoded phrase, and the
 * only test that could reach it was one that read the source as text.
 */

import { isLunchClosure } from '../utils/timeAware';

/**
 * How a line combines its greeting with the confirm question.
 *
 *   'replace'  the confirm question IS the greeting.
 *   'append'   keep the greeting, swap only its closing question.
 *   null       say the greeting verbatim; do not personalise it at all.
 */
export type GreetingStyle = 'replace' | 'append';

/**
 * A line EARNS personalisation. The default is to say its greeting verbatim.
 *
 * This used to default to 'replace' for every unlisted slug, which was safe
 * only by accident: on the SIP path `azulMetadataRef` is assigned in the
 * optical, surgery, tech, records and azul-scheduling branches and nowhere
 * else, so no other line ever had a recognised name to personalise with, and
 * the default was unreachable. The voice runtime calls `fetchPrecontext` for
 * EVERY lane, which made it reachable — and the first two lines it reached
 * are the two that must never be personalised:
 *
 * - **no-ivr** is the after-hours line. Its greeting carries the closed-office
 *   notice, the 911 direction and the recording disclosure, and `noIvrAgent`'s
 *   own pre-context block exists to defend them: "YOUR GREETING IS NOT
 *   OPTIONAL AND MUST NOT BE SHORTENED... DO NOT open with a name
 *   confirmation", citing 2026-08-01 12:21 UTC, when the greeting was cut off
 *   after "Thank you for calling" and a caller was never told to dial 911 and
 *   never told the call was recorded. 'replace' would do that deliberately,
 *   in the forced verbatim greeting, where the model cannot decline. Even
 *   'append' would not be safe here: the recording disclosure shares its
 *   sentence with the trailing question, so stripping the question strips the
 *   disclosure with it.
 * - **pcp** treats the caller's first reply as the call purpose ("Your
 *   greeting already asked... you are RECORDING what they just said"). Ask
 *   "Am I speaking with Wayne?" instead and the purpose recorded is "yes".
 *
 * Both raised by Codex on #240, as was the converse: **answering-service**
 * belongs in the map. Its prompt carries the same matched-caller block the
 * queue lines do — "YOUR GREETING HAS ALREADY PLAYED. Do NOT greet again...
 * Go straight to the confirmation" — and its greeting is the same shape,
 * pre-empting the ask for a human ("all of our operators are currently on
 * the phone assisting other patients") and ending in a question. Leaving it
 * out would have given it the defect this whole module exists to remove:
 * a prompt certain the greeting was personalised, and a greeting that was
 * not. A slug belongs in this map once someone has
 * read its greeting and its prompt and decided what personalising it costs.
 *
 * The queue lines append: their greeting does a second job besides saying
 * hello — "All of our coordinators are currently assisting other patients,
 * but I can take a message" pre-empts the ask for a human on a line that
 * CANNOT transfer. Operator-dictated, and worth more than the sentence it
 * costs. azul-scheduling keeps the wholesale replacement it has always had.
 */
const GREETING_STYLES: Readonly<Record<string, GreetingStyle>> = {
  'answering-service': 'append',
  optical: 'append',
  surgery: 'append',
  tech: 'append',
  records: 'append',
  'azul-scheduling': 'replace',
};

export function greetingStyleFor(agentSlug: string | undefined): GreetingStyle | null {
  return GREETING_STYLES[String(agentSlug ?? '')] ?? null;
}

/**
 * Everything up to, but not including, the question the greeting ends with.
 *
 * Strips whatever the trailing question is rather than one known phrase.
 * `welcome_greeting` is admin-editable and outranks the configured string, so
 * matching on "How can I help you today?" meant any edit to that wording turned
 * personalisation into a no-op — leaving the configured question and the
 * confirm question back to back, which is the defect this exists to remove.
 * Raised by Codex on #178.
 *
 * A greeting that is entirely one question yields an empty stem, and the
 * confirm question then stands alone. That is correct.
 */
export function stripTrailingQuestion(greeting: string): string {
  const text = String(greeting ?? '').trim();
  const bySentence = text.replace(/\s*[^.!?]*\?\s*$/, '').trim();
  if (bySentence) return bySentence;

  // Nothing left, and the greeting was not itself one short question: it is a
  // chain of comma-joined clauses ending in its question, so the sentence rule
  // has no boundary to stop at and takes the whole line. The answering
  // service's greeting is exactly this shape —
  //
  //   "Hello, thank you for calling Azul Vision, all of our operators are
  //    currently on the phone assisting other patients, how may I help you
  //    today?"
  //
  // — and appending to an empty stem would have thrown away the
  // busy-operators line, which is the half that pre-empts the ask for a
  // human. The last comma is where such a greeting joins its question.
  //
  // Reached ONLY when the sentence rule returned nothing, so no greeting that
  // already produced a stem can change: the live queue lines are untouched.
  // Raised by Codex on #240.
  const comma = text.lastIndexOf(',');
  if (text.endsWith('?') && comma > 0) {
    return `${text.slice(0, comma).trim()}.`;
  }
  return bySentence;
}

/**
 * The greeting a recognised caller should hear.
 *
 * Returns the greeting unchanged when there is no name to use, so the caller
 * decides nothing about recognition — it either happened or it did not, and
 * unchanged when the line has no style: not every greeting may be rewritten.
 */
export function personaliseGreeting(
  greeting: string,
  recognisedFirstName: string,
  style: GreetingStyle | null,
): string {
  const name = String(recognisedFirstName ?? '').trim();
  if (!style || !name || !greeting?.trim()) return greeting;

  if (style === 'replace') {
    return `Hello, thank you for calling Azul Vision. Am I speaking with ${name}?`;
  }
  return `${stripTrailingQuestion(greeting)} Am I speaking with ${name}?`.trim();
}

/**
 * Copy a lane's greeting must contain, whatever the database says.
 *
 * `agents.welcome_greeting` is the source of truth for how an agent opens,
 * and deliberately so — a boot that overwrote operator edits was a real
 * incident (`seedAgents.ts` still carries the note). But "the operator may
 * word the greeting" is not the same as "any greeting is acceptable". The
 * no-IVR line is the after-hours service: `noIvrAgent`'s own pre-context
 * block demands the whole greeting before anything else, naming the incident
 * where a caller "was never told to dial 911 in an emergency and was never
 * told the call was recorded".
 *
 * This is not hypothetical drift. On 2026-08-31 the live `no-ivr` row read:
 *
 *   "Thank you for calling Azul Vision. Our offices are currently closed. If
 *    this is a medical emergency, please hang up and dial 911. Otherwise,
 *    I'm happy to help — how may I assist you?"
 *
 * — 911 and the closed-office notice present, the recording disclosure
 * absent. So making the configured greeting outrank the registry string, as
 * the SIP path does, would have taken that disclosure off the runtime too.
 * Raised by Codex on #240.
 *
 * Deliberately narrow: only the lane that has legally-shaped copy, and only
 * the two statements. Everything else is the operator's wording to choose.
 */
/**
 * The ways an ordinary sentence reverses itself, immediately before a phrase.
 *
 * Codex found this twice on #244, each time one step narrower than the last:
 * first that the checks were bare keyword tests, so "calls are not being
 * recorded" read as compliant; then that a negation matching only the literal
 * word `not` still lets "calls aren't being recorded" through. Both apostrophes
 * are covered because an admin typing into a web form gets whichever one their
 * keyboard produces.
 *
 * ADJACENCY IS THE WHOLE DESIGN. The negator has to sit immediately before the
 * phrase it reverses, so "if this is not an emergency I can take a message; if
 * it is a medical emergency, please dial 911" stays compliant — the `not`
 * belongs to "an emergency", not to dialling. A looser test would reject
 * legitimate wording, and a rejected row falls back to the code greeting with
 * only a log line, which is an operator edit that returns success and changes
 * nothing.
 */
const NEGATOR = String.raw`(?:\bcannot\b|\bnot\b|n['\u2019]t\b|\bnever\b)`;

/**
 * ONE COPULA MAY SIT BETWEEN THE NEGATOR AND THE PHRASE.
 *
 * `cannot` came from Codex on PR #244 — `\bnot\b` cannot match the `not`
 * inside `cannot`, so "calls cannot be recorded" read as compliant. Checking
 * that against the live wording turned up a SECOND hole it had not named:
 * "calls can not be recorded" also passed, and there the negator matches
 * perfectly well. What failed was the phrase — it allowed "being recorded" and
 * not "be recorded", so nothing lined up after the negator.
 *
 * Hence the optional `be|being|been` here rather than another alternative in
 * each phrase: the same auxiliary appears between a negator and every one of
 * these clauses, and fixing it once is what stops the next variant needing a
 * tenth round.
 *
 * ADJACENCY IS STILL THE DESIGN, and one short auxiliary does not loosen it.
 * "If this is not an emergency I can take a message; if it is a medical
 * emergency, please dial 911" still passes — `an` is not a copula, so the
 * `not` stays attached to "an emergency" where it belongs. So does "please
 * don't hesitate to leave a message — all calls are being recorded".
 */
/**
 * AND A RUN OF ADVERBS MAY SIT THERE TOO — Codex, round thirteen.
 *
 * "Calls are not currently being recorded" passed. The negator had to sit
 * immediately before the optional copula, and `currently` is neither, so
 * nothing lined up after the `not` and the denial read as a disclosure.
 *
 * `-ly` adverbs rather than another enumerated list, because the list is the
 * bug: the closed-office clause already carried `(?:currently|presently)` and
 * the recording clause did not, which is precisely how one of them was open
 * and the other was not. Currently, presently, normally, usually, generally,
 * typically and everything else of that shape are one rule now.
 *
 * ADJACENCY IS STILL THE DESIGN. An adverb modifies the verb it precedes, so
 * crossing one keeps the negator attached to the same clause. "If this is not
 * an emergency I can take a message; if it is a medical emergency, please dial
 * 911" still passes — `an` is not an adverb or a copula, so the `not` stays
 * where it belongs.
 */
const ADVERBS = String.raw`(?:\s+\w+ly\b)*`;

function negated(greeting: string, phrase: string): boolean {
  return new RegExp(`${NEGATOR}${ADVERBS}\\s+(?:be|being|been)?\\s*${phrase}\\b`, 'i').test(greeting);
}

const MANDATORY_GREETING_COPY: Readonly<
  Record<string, ReadonlyArray<{ label: string; present: (g: string) => boolean }>>
> = {
  'no-ivr': [
    // THREE, not two. `noIvrAgent` names them: "the two things this line
    // exists to say: that offices are closed, and that a medical emergency
    // means calling 911 — plus the recording disclosure." I quoted that
    // sentence and then encoded two of the three, so "For emergencies dial
    // 911. Calls are recorded. How can I help?" would have passed and taken
    // the after-hours status off the line (Codex, #240).
    //
    // NEGATION, added 2026-09-01 (Codex, #244). These were bare keyword tests,
    // so "our offices are not closed", "do not dial 911" and "calls are not
    // being recorded" all reported the mandatory copy as PRESENT — and this
    // check is the compliance boundary for a field an admin can edit. A row
    // that says the opposite of the required sentence would have outranked the
    // known-safe code greeting.
    //
    // Each negation is anchored to its own phrase rather than "a 'not'
    // somewhere near". A loose test would reject legitimate wording — "if this
    // is not a medical emergency, leave a message; otherwise dial 911" is a
    // perfectly good greeting — and a rejected row falls back silently to the
    // code greeting, which is this repo's other recurring failure: an edit that
    // returns success and changes nothing.
    {
      label: 'closed-office notice',
      // The enumerated `(?:currently|presently)` that used to sit in this
      // phrase is gone: `negated()` crosses any -ly adverb now, so keeping a
      // private list here would suggest the general rule does not exist.
      present: (g) => /clos(ed|ing)\b/i.test(g) && !negated(g, String.raw`clos(?:ed|ing)`),
    },
    {
      /**
       * THE NUMBER IS NOT THE DIRECTION — Codex, PR #244, the round after the
       * negation fix and narrower again.
       *
       * Requiring `\b911\b` and then subtracting negations is the wrong shape:
       * it accepts anything containing the token unless one of a fixed list of
       * reversals is spotted, so "911 is not available" and "please don't use
       * 911" both passed — neither contains `dial|call|contact|phone`, so
       * neither could be caught by negating those verbs. Chasing that with
       * more negations is unbounded; every phrasing nobody thought of is a
       * false accept, and a false accept here means an emergency caller is
       * never told where to go.
       *
       * Inverted, so the check is what the clause must SAY rather than what it
       * must avoid: an affirmative direction to 911. Both live greetings
       * satisfy it — the registry string says "please dial 911", the database
       * row says "please hang up and dial 911" — and the negation guard stays
       * on top for "don't call 911".
       */
      label: '911 direction',
      present: (g) =>
        /\b(?:dial|call|contact|phone)\s+911\b/i.test(g) &&
        !negated(g, String.raw`(?:need\s+to\s+)?(?:dial|call|contact|phone)\s+911`) &&
        !/\bno\s+need\s+to\s+(?:dial|call|contact|phone)\s+911\b/i.test(g),
    },
    {
      /**
       * THE WORD IS NOT THE DISCLOSURE — the same inversion as the 911
       * direction above, and for the same reason, one round later.
       *
       * Requiring `record(ed|ing)` and subtracting negations accepts anything
       * containing the token unless a reversal is spotted, so every phrasing
       * nobody thought of is a false accept — and a false accept here means a
       * caller is recorded without being told. Codex found the adverb hole
       * ("not currently being recorded"); "ask about our recording policy"
       * would have passed too, and no amount of negation-chasing catches that.
       *
       * So the check is what the clause must SAY: the call is, may be, or will
       * be recorded. Both live greetings satisfy it — the registry string and
       * the lunch greeting both say "All calls are being recorded for quality
       * assurance purposes" — and the negation guard stays on top.
       */
      label: 'recording disclosure',
      present: (g) =>
        /\b(?:is|are|was|were|be|being|been)\s+(?:being\s+)?record(?:ed|ing)\b/i.test(g) &&
        !negated(g, String.raw`(?:being\s+)?record(?:ed|ing)`),
    },
  ],
};

/**
 * THE LUNCH HOUR IS NOT AFTER HOURS.
 *
 * Operator, 2026-09-01: *"no-ivr callers are any hours outside of business
 * hours — a 7am call is no-ivr, our offices are still closed. If it is during
 * lunch, our offices are closed between 12-1, so that should be said."*
 *
 * The standing greeting says "you have reached the after hours call service",
 * which is true at 7am and wrong at 12:30 — the practice is open today, it is
 * at lunch, and a caller told they have reached an after-hours service assumes
 * nobody is back until tomorrow. `isLunchClosure()` (src/utils/timeAware.ts,
 * weekdays, hour 12, already carrying the 2026-08-06 directive that this
 * window gets a callback rather than a transfer attempt) decides which one.
 *
 * A whole alternative greeting rather than surgery on the configured string:
 * rewriting the operator's own wording with a regex is how the closed-office
 * clause and the 911 direction get lost. This is one constant, reviewable in
 * one place, and it carries all three mandatory statements itself — which the
 * test asserts by running it back through `missingMandatoryCopy`.
 */
const LUNCH_GREETINGS: Readonly<Record<string, string>> = {
  'no-ivr':
    'Thank you for calling Azul Vision. Our offices are closed for lunch between twelve and one. ' +
    'If this is a medical emergency, please dial 911. All calls are being recorded for quality ' +
    'assurance purposes. How can I help you?',
};

/**
 * The lunch-hour greeting for this lane, or null when the lane has none or it
 * is not lunch. `now` is injectable so this is testable without a clock.
 */
export function lunchGreetingFor(
  agentSlug: string | undefined,
  now?: { hour: number; shortDay: string },
): string | null {
  const candidate = LUNCH_GREETINGS[String(agentSlug ?? '')];
  if (!candidate) return null;
  return isLunchClosure(now) ? candidate : null;
}

/**
 * What a candidate greeting is missing for this lane, or [] when it is
 * complete (and always [] for a lane with nothing mandatory).
 */
export function missingMandatoryCopy(
  agentSlug: string | undefined,
  greeting: string | null | undefined,
): string[] {
  const required = MANDATORY_GREETING_COPY[String(agentSlug ?? '')];
  if (!required) return [];
  const text = String(greeting ?? '');
  return required.filter((r) => !r.present(text)).map((r) => r.label);
}
