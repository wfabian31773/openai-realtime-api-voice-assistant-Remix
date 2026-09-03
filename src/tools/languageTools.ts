/**
 * FOLLOW THE CALLER'S LANGUAGE.
 *
 * Operator instruction, 2026-09-03: *"connect the runtime to be able to switch
 * languages mid stream flawlessly based on user input or request."*
 *
 * The machinery already existed and was wired to nothing.
 * `GrokVoiceSession.setSpokenLanguage()` (src/runtime/grokSession.ts) retargets
 * Grok's STT `language_hint` and appends an instruction telling the model to
 * follow the caller — written, unit-tested, and called by no production code
 * path until this tool.
 *
 * WHY A TOOL AND NOT A DETECTOR
 *
 * Standing instruction 3: *"Why are you trying to determine what a first name
 * is? You'll never ever get it to work like that."* Deciding which language a
 * caller is speaking is the same class of problem as deciding what a name is —
 * the model already knows, and a regex over transcript text would be wrong at
 * the edges that matter (a Spanish surname in an English sentence, a caller who
 * opens in English and switches, "¿habla español?").
 *
 * So the model decides and calls this. The tool's own description carries the
 * instruction, which is why no queue prompt grows by a line for this: the
 * operator's standing direction on the Grok migration was to use the tools and
 * the model's reasoning rather than longer prompts.
 *
 * WHAT THIS TOOL DOES AND DOES NOT DO
 *
 * It normalises and validates, and that is all. The transport step — sending
 * `session.update` with the new hint — belongs to the bridge, exactly like the
 * hangup tool's (see the TRANSPORT NOTE in mediaStreamBridge.ts): the tool runs
 * first and the transport acts only on a result that says it should. A tool
 * that reached into the session would be untestable offline and would couple
 * the library to one transport.
 *
 * MEASURED FIRST, per the operator's own rule about quoting numbers. Spanish
 * queue calls in the 15 days to 2026-09-03 file at 67.0% against 51.4% for
 * everything else (285 calls), and Grok transcribes Spanish accurately with the
 * hint still set to "en" — so this is NOT a fix for a bleeding wound. It closes
 * a capability gap: a caller who switches language mid-call, or asks to be
 * served in another one, is now followed instead of ignored.
 */
import { registerTool, missing, type ToolResult } from './registry';
import { normalizeSpokenLanguage } from '../runtime/language';

/**
 * Normalise what the model heard into a tag the wire accepts.
 *
 * The tool deliberately does NOT decide whether the switch is a no-op. Which
 * language the session is currently listening in is live transport state that
 * moves during the call, and the only way a tool could see it is through call
 * context frozen at session construction — which would be stale the moment the
 * first switch happened, and would then refuse every switch back. The bridge
 * owns that state and skips a redundant `session.update` itself.
 */
export function normalizeRequestedLanguage(requested: string): string | undefined {
  const raw = String(requested ?? '').trim();
  if (!raw) return undefined;
  const to = normalizeSpokenLanguage(raw);
  return to && to.trim() ? to : undefined;
}

registerTool({
  name: 'set_spoken_language',
  layer: 'agent',
  timeoutMs: 2000,
  description:
    'Switch the language you speak and listen in, for the rest of this call. ' +
    'Call this the moment the caller speaks a language other than the one you ' +
    'are using, or asks to be helped in another language — then carry on in ' +
    'that language and take their request as normal. Do not announce the ' +
    'switch or ask permission; just answer them in their language. Keep the ' +
    'ARGUMENTS you send to every other tool in English (names, dates, yes/no) ' +
    'no matter what language you are speaking.',
  input_schema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description:
          'The language the caller is speaking, as a name or an ISO code — ' +
          '"Spanish", "es", "Tagalog", "Korean", "Armenian".',
        askAs: 'Which language would you prefer?',
      },
    },
    required: ['language'],
  },
  async handler(input): Promise<ToolResult> {
    const to = normalizeRequestedLanguage(String(input.language ?? ''));
    if (!to) {
      return missing(['language'], 'Which language would you like me to use?');
    }
    /**
     * `language` is what the bridge reads to perform the transport step. It is
     * the normalized tag, never the caller's word for it, so the wire always
     * gets something the provider accepts.
     */
    return {
      success: true,
      language: to,
      message: `Now speaking ${to}. Continue in that language.`,
    };
  },
});
