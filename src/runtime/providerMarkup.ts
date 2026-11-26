/**
 * v275: markup from the provider is never the agent's words.
 *
 * xAI sometimes puts its own markup in the agent's output: a copy of a
 * line it has already spoken (`<response_segment_0_already_spoken>Great,
 * have a good day!</response_segment_0_already_spoken>`), a stage tag
 * (`<silence />`, `<turn_end>`, `<end_of_call>`), a tool call written out as
 * text (`<tool_call>…<arg_key>…`), or a note meant for the model
 * (`<system_warning>…</system_warning>`). Measured on the Hub, agent lines in
 * the 30 days to 2026-11-26: 104 carried one, on every lane that takes
 * calls; 68 opened with it. On none of them did any of the agent's words
 * follow the markup: what came after the last tag was only the bridge's own
 * `[interrupted]` or guardrail note. So the rule is: keep what came before the
 * first tag, and drop the rest.
 *
 * A tag is `<`, an optional `/`, then a letter or an underscore. Spoken text
 * reaches the transcript as words, so a `<` followed by a letter does not
 * occur in a real line.
 */
export const PROVIDER_MARKUP = /<\s*\/?\s*[A-Za-z_]/;

/** Where the first tag starts, or -1 when the text carries none. */
export function providerMarkupIndex(text: string): number {
  return text.search(PROVIDER_MARKUP);
}

/** The text before the first tag, with trailing spaces dropped. Text with no
 * tag is returned as it is. */
export function withoutProviderMarkup(text: string): string {
  const at = providerMarkupIndex(text);
  return at < 0 ? text : text.slice(0, at).trimEnd();
}

/**
 * A line whose text so far is only `<` or `</` (spaces allowed): a tag may be
 * starting, split across transcript deltas, and the next delta says whether it
 * is one. A `<` after the agent's words is not asked about: such a line plays
 * its audio whole either way.
 */
export const PROVIDER_MARKUP_MAY_OPEN = /^\s*<\s*\/?\s*$/;

export function providerMarkupMayOpen(text: string): boolean {
  return PROVIDER_MARKUP_MAY_OPEN.test(text);
}

/**
 * What a words-first line said aloud, tags taken out and everything else kept.
 * Such a line plays its audio whole, so a goodbye check reads what the caller
 * heard, the words after the tag included, never only the stored cut (#524
 * review, round 8). A tag left open runs to the end of the text.
 */
export function withoutAnyProviderMarkup(text: string): string {
  return text.replace(/<\s*\/?\s*[A-Za-z_][^>]*>?/g, " ").replace(/\s+/g, " ").trim();
}
