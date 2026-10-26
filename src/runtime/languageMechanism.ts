/**
 * src/runtime/languageMechanism.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FOLLOWING THE CALLER'S LANGUAGE IS THE PIPELINE'S JOB, SO THE PIPELINE SAYS SO.
 *
 * Operator ruling, 2026-09-15: *"the things that are applicable to any
 * conversation should be in the runtime; things applicable to that agent
 * itself should be in the prompt."* And 2026-09-28, of the xAI-docs audit:
 * *"Shouldn't this be for the runtime in general?"*
 *
 * Until v77 the MECHANISM — call `set_spoken_language` the moment the caller
 * speaks another language, switch only if they switch, keep tool arguments
 * in English, translate the quoted asks — was written into each lane's
 * prompt separately (four queue lanes, then the after-hours lane on v75) and
 * the tool was listed by each lane separately; pcp had neither. That is the
 * recognised-caller block written four times over (v27) in a fifth place.
 * The bridge already did the transport step by NAME for any lane
 * (`DEFAULT_LANGUAGE_TOOL_NAMES`), so the runtime knew the tool and every
 * prompt re-explained it.
 *
 * Now the runtime binds the tool to every lane (`laneRegistry`,
 * `RUNTIME_OWNED_TOOLS`) and appends ONE copy of the mechanism, here, into
 * the section xAI's Prompting Guide puts language control — *"Language
 * lock … under Voice & Communication Style"*; *"Control language explicitly
 * if unwanted language switching appears."* What stays with the lane is the
 * POLICY: which languages the line speaks. That is configuration
 * (`spokenLanguages` on the agent's registration; ADR-001's "agents as
 * configuration"), rendered into the same sentence, so a lane that speaks
 * English and Spanish only (the after-hours line, an old-core-era rule the
 * operator has not revisited) and a lane that follows any caller (every
 * queue lane; a Turkish caller was followed live on 2026-09-03) get the one
 * mechanism with their own first clause.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { normalizeSpokenLanguage } from "./language";

const LABELS: Record<string, string> = {
  en: "English", es: "Spanish", tl: "Tagalog", ko: "Korean", vi: "Vietnamese",
  zh: "Chinese", hy: "Armenian", fa: "Farsi", ru: "Russian", ar: "Arabic",
  pt: "Portuguese", fr: "French",
};

/** "es" → "Spanish"; an unknown code is returned as given rather than guessed. */
export function languageLabel(code: string): string {
  const c = normalizeSpokenLanguage(code);
  return LABELS[c] ?? code;
}

/** The sentence a mechanism-carrying prompt is recognised by; also what makes
 * `withLanguageMechanism` idempotent. */
export const LANGUAGE_MECHANISM_MARKER = "call set_spoken_language with that language";

const VOICE_SECTION = "## Voice & Communication Style";

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The lane's language POLICY, from its registration. No list means the lane
 * follows the caller into any language the provider can speak.
 */
export function renderLanguagePolicy(spokenLanguages?: readonly string[]): string {
  const names = [...new Set((spokenLanguages ?? []).map(languageLabel))];
  if (names.length === 0) {
    return "You follow the caller into their language — never tell them you cannot help them in it.";
  }
  const list = joinNames(names);
  return `This line speaks ${list}. For any other language, say in English that this line can help in ${list}, and continue in English.`;
}

/** The runtime's one copy of the mechanism, as bullets for the Voice section. */
export function languageMechanism(spokenLanguages?: readonly string[]): string {
  return [
    `- Language: ${renderLanguagePolicy(spokenLanguages)} Start in English. Never assume a language from a name — read it from the caller's first substantive words. The moment the caller speaks a language this line speaks, other than the one you are using, or asks for it, ${LANGUAGE_MECHANISM_MARKER} and continue in it — every question, confirmation and wait line. Do not announce the switch or ask permission.`,
    "- Switch only if the caller switches. An English tool result, a medication name, a number or a word you did not catch is not a switch.",
    "- Every question written in this prompt is a shape to translate, not a script to read.",
    "- Keep every tool ARGUMENT in English (names, dates, yes/no) whatever language you are speaking.",
  ].join("\n");
}

/**
 * Append the mechanism to a lane's prompt: at the end of its
 * `## Voice & Communication Style` section when it has one (the guide's
 * placement), otherwise as that section at the end. Idempotent, so a prompt
 * that somehow already carries it is not told twice.
 */
export function withLanguageMechanism(instructions: string, spokenLanguages?: readonly string[]): string {
  if (instructions.includes(LANGUAGE_MECHANISM_MARKER)) return instructions;
  const block = languageMechanism(spokenLanguages);
  const at = instructions.indexOf(`${VOICE_SECTION}\n`);
  if (at === -1) {
    return `${instructions.replace(/\s+$/, "")}\n\n${VOICE_SECTION}\n${block}`;
  }
  const bodyStart = at + VOICE_SECTION.length + 1;
  const nextHeader = instructions.indexOf("\n## ", bodyStart);
  const sectionEnd = nextHeader === -1 ? instructions.length : nextHeader;
  const section = instructions.slice(bodyStart, sectionEnd).replace(/\s+$/, "");
  const rest = instructions.slice(sectionEnd);
  return `${instructions.slice(0, bodyStart)}${section}\n${block}${rest.startsWith("\n") ? "\n" + rest : rest}`;
}
