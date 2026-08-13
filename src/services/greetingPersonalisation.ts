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
 */
export type GreetingStyle = 'replace' | 'append';

/**
 * The queue lines append.
 *
 * Their greeting does a second job besides saying hello: "All of our
 * coordinators are currently assisting other patients, but I can take a
 * message" pre-empts the ask for a human on a line that CANNOT transfer.
 * Operator-dictated, and worth more than the sentence it costs.
 */
export function greetingStyleFor(agentSlug: string | undefined): GreetingStyle {
  return agentSlug === 'optical' || agentSlug === 'surgery' || agentSlug === 'tech'
    ? 'append'
    : 'replace';
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
 * decides nothing about recognition — it either happened or it did not.
 */
export function personaliseGreeting(
  greeting: string,
  recognisedFirstName: string,
  style: GreetingStyle,
): string {
  const name = String(recognisedFirstName ?? '').trim();
  if (!name || !greeting?.trim()) return greeting;

  if (style === 'replace') {
    return `Hello, thank you for calling Azul Vision. Am I speaking with ${name}?`;
  }
  return `${stripTrailingQuestion(greeting)} Am I speaking with ${name}?`.trim();
}
