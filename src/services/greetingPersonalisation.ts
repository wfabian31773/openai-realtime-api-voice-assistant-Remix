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
 * Both raised by Codex on #240. A slug belongs in this map once someone has
 * read its greeting and its prompt and decided what personalising it costs.
 *
 * The queue lines append: their greeting does a second job besides saying
 * hello — "All of our coordinators are currently assisting other patients,
 * but I can take a message" pre-empts the ask for a human on a line that
 * CANNOT transfer. Operator-dictated, and worth more than the sentence it
 * costs. azul-scheduling keeps the wholesale replacement it has always had.
 */
const GREETING_STYLES: Readonly<Record<string, GreetingStyle>> = {
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
  return String(greeting ?? '').replace(/\s*[^.!?]*\?\s*$/, '').trim();
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
