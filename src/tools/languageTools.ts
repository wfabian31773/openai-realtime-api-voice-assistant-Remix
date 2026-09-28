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
import { registerTool, missing, type ToolResult, type ToolFailure } from './registry';
import { normalizeSpokenLanguage } from '../runtime/language';
import { languageLabel, renderLanguagePolicy } from '../runtime/languageMechanism';

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

/**
 * ONE COPY OF THE TOOL'S WORDS. The registry lanes get it through
 * `registerTool` below; the after-hours lane builds its tools by hand
 * (`recordedTool` in noIvrAgent.ts) and imports these two so the model on
 * every lane reads the same sentence — two near-identical copies is the
 * `explicitAsk.ts` noun-list drift this repo has already paid for.
 */
export const SET_SPOKEN_LANGUAGE_TOOL_NAME = 'set_spoken_language';
/** The half of the description every lane shares, whatever its policy. */
const SET_SPOKEN_LANGUAGE_DESCRIPTION_TAIL =
  'Do not announce the ' +
  'switch or ask permission; just answer them in their language. Keep the ' +
  'ARGUMENTS you send to every other tool in English (names, dates, yes/no) ' +
  'no matter what language you are speaking.';
export const SET_SPOKEN_LANGUAGE_DESCRIPTION =
  'Switch the language you speak and listen in, for the rest of this call. ' +
  'Call this the moment the caller speaks a language other than the one you ' +
  'are using, or asks to be helped in another language — then carry on in ' +
  'that language and take their request as normal. ' +
  SET_SPOKEN_LANGUAGE_DESCRIPTION_TAIL;

/**
 * THE TOOL'S WORDS AGREE WITH THE LANE'S POLICY (Codex P2 on #336).
 *
 * The runtime binds this tool to every lane, and the after-hours line
 * declares `spokenLanguages: ['en', 'es']`. With the one description above,
 * that lane's prompt said "for any other language, continue in English"
 * while its tool said "call this the moment the caller speaks another
 * language — then carry on in that language": two instructions on one
 * subject, and the tool's result is the NEWER one, so a Tagalog caller would
 * have had the whole session retargeted into Tagalog against the policy. A
 * lane with a policy therefore gets a description written FOR that policy —
 * the same tail, a different head — and `spokenLanguageResult` below refuses
 * at dispatch, so a model that calls it anyway moves nothing on the wire.
 * A lane with no policy keeps the original words verbatim.
 */
export function spokenLanguageToolDescription(spokenLanguages?: readonly string[]): string {
  const names = policyNames(spokenLanguages);
  if (!names) return SET_SPOKEN_LANGUAGE_DESCRIPTION;
  return (
    `${renderLanguagePolicy(spokenLanguages)} Call this the moment the caller ` +
    `speaks ${names} other than the one you are using, or asks for it — then ` +
    'carry on in that language and take their request as normal. Do NOT call ' +
    'it for any other language: it will be refused, and you say in English ' +
    `that this line can help in ${names} and continue in English. ` +
    SET_SPOKEN_LANGUAGE_DESCRIPTION_TAIL
  );
}

/** "English and Spanish", or undefined when the lane follows any caller. */
function policyNames(spokenLanguages?: readonly string[]): string | undefined {
  const names = [...new Set((spokenLanguages ?? []).map(languageLabel))];
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The PHI-free reason on a refused switch — on the timeline allow-list
 * already (v70's `suppressed`), so every refusal is countable from SQL. */
export const LANGUAGE_NOT_SPOKEN_HERE = 'language_not_spoken_here';

export interface LanguageRefusal extends ToolFailure {
  suppressed: typeof LANGUAGE_NOT_SPOKEN_HERE;
  /** For the MODEL (v43: never the channel the agent speaks). */
  fix: string;
}

/** True when the lane declares no policy, or the requested tag is one of the
 * languages it declares. Compared on normalised tags, so "Spanish" and "es"
 * and "es-MX" are one language. */
export function languageAllowedOnThisLine(to: string, spokenLanguages?: readonly string[]): boolean {
  if (!spokenLanguages || spokenLanguages.length === 0) return true;
  const allowed = new Set(spokenLanguages.map((l) => normalizeSpokenLanguage(l)));
  return allowed.has(normalizeSpokenLanguage(to));
}
export const SET_SPOKEN_LANGUAGE_ARG_DESCRIPTION =
  'The language the caller is speaking, as a name or an ISO code — ' +
  '"Spanish", "es", "Tagalog", "Korean", "Armenian".';

/** The result the bridge acts on: `language` is the normalized tag the wire
 * accepts, never the caller's word for it. Shared with the after-hours
 * lane's hand-built copy for the same one-copy reason as the description. */
export function spokenLanguageResult(
  requested: string,
  spokenLanguages?: readonly string[],
): ToolResult {
  const to = normalizeRequestedLanguage(requested);
  if (!to) {
    return missing(['language'], 'Which language would you like me to use?');
  }
  if (!languageAllowedOnThisLine(to, spokenLanguages)) {
    /**
     * NO `language` KEY, deliberately: `languageToSwitchTo` (the bridge) reads
     * that key off a `success: true` result and nothing else, so a refusal
     * shaped like this cannot reach `setSpokenLanguage` and cannot retarget
     * the transcriber. No `message` either — the caller hears the policy
     * sentence from the prompt, in English, not a tool's rule read aloud.
     */
    const names = policyNames(spokenLanguages)!;
    const refusal: LanguageRefusal = {
      success: false,
      error: LANGUAGE_NOT_SPOKEN_HERE,
      suppressed: LANGUAGE_NOT_SPOKEN_HERE,
      fix:
        `${renderLanguagePolicy(spokenLanguages)} The caller asked for ${languageLabel(to)}, ` +
        'which this line does not speak, so NOTHING was switched. Say, in English, that this ' +
        `line can help in ${names}, then continue in English. Do not call this tool again for ` +
        `${languageLabel(to)}.`,
    };
    return refusal;
  }
  return {
    success: true,
    language: to,
    message: `Now speaking ${to}. Continue in that language.`,
  };
}

// The LITERAL name on the next line, not the constant: serverRegistration.test.ts
// reads `registerTool({\n  name: '…'` off the source to prove every tool a lane
// declares is reachable over HTTP, and a guard that reads source cannot follow
// an identifier (or see past a comment between the two lines).
// noIvrSpeaksTheCallersLanguage.test.ts pins the constant to the bridge's own
// name table, so the two spellings cannot drift apart without a test going red.
registerTool({
  name: 'set_spoken_language',
  layer: 'agent',
  timeoutMs: 2000,
  description: SET_SPOKEN_LANGUAGE_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description: SET_SPOKEN_LANGUAGE_ARG_DESCRIPTION,
        askAs: 'Which language would you prefer?',
      },
    },
    required: ['language'],
  },
  async handler(input): Promise<ToolResult> {
    /**
     * `language` on the result is what the bridge reads to perform the
     * transport step. It is the normalized tag, never the caller's word for
     * it, so the wire always gets something the provider accepts.
     *
     * `spoken_languages` is INJECTED by the runtime from the lane's
     * registration (laneRegistry's `runtimeOwnedTools`) — the `lane` shape
     * `lookup_patient` uses: not a schema field, merged under the model's
     * arguments, so the model can neither set it nor be asked for it. Absent
     * (the HTTP surface, a lane with no policy) the tool follows any caller.
     */
    const declared = Array.isArray(input.spoken_languages)
      ? (input.spoken_languages as unknown[]).filter((l): l is string => typeof l === 'string')
      : undefined;
    return spokenLanguageResult(String(input.language ?? ''), declared);
  },
});
