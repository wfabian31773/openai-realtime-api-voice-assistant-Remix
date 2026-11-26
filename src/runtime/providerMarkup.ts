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
 * How many bytes of 8 kHz mu-law audio (8,000 a second) the words before a tag
 * may play. xAI sends a sentence's text before its audio, so when a tag shows
 * up the words before it are often still being spoken (handleAgentTranscriptDelta
 * in mediaStreamBridge.ts). The audio cannot be split at the tag exactly, so
 * this errs toward letting those words finish: it is above every line measured
 * on grok-voice-3.0 (synthetic lines, 2026-11-26), from 419 bytes a character
 * on a long sentence to 756 on "Okay, bye.", with a fixed part for the pause a
 * response starts and ends with. A tag that makes no sound (`<turn_end>`,
 * `<silence />`) then costs the words nothing. A tag that is read aloud (a tool
 * call written out as text) can still be heard for the slack, at most about
 * 0.75 s after a goodbye-length line.
 */
export const MARKUP_AUDIO_FIXED_BYTES = 6000;
export const MARKUP_AUDIO_BYTES_PER_CHAR = 550;

export function audioForWordsBeforeMarkup(wordsBeforeTag: string): number {
  const chars = wordsBeforeTag.trim().length;
  return chars === 0 ? 0 : MARKUP_AUDIO_FIXED_BYTES + MARKUP_AUDIO_BYTES_PER_CHAR * chars;
}
