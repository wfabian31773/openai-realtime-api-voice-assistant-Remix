/**
 * src/runtime/config.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Grok connection settings for the voice runtime, read from the
 * environment ONCE and passed down. Per-lane overrides use the slug so one
 * runtime can give every lane its own voice and language without a code
 * change (ADR-001 layer 2: agents as configuration):
 *
 *     XAI_VOICE_NAME_<SLUG>      e.g. XAI_VOICE_NAME_SURGERY
 *     XAI_VOICE_LANGUAGE_<SLUG>
 *
 * falling back to XAI_VOICE_NAME / XAI_VOICE_LANGUAGE, then the defaults.
 * The model is PINNED by default rather than tracking `grok-voice-latest`
 * — xAI's own guidance for production, and a silent model change on a
 * patient line is exactly the kind of drift a deploy marker cannot catch.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { normalizeSpokenLanguage, normalizeSpokenLanguageOrNull, type SpokenLanguage } from "./language";

export type GrokReasoningEffort = "none" | "high";

export interface GrokRuntimeVoiceConfig {
  apiKey: string;
  model: string;
  voiceName: string;
  /**
   * The lane's configured language, or null when nobody configured one.
   *
   * Null is NOT "English" — it means send no STT pin and let the provider
   * detect. Task #55: defaulting this to "en" pinned every runtime call to
   * English before the caller spoke.
   */
  language: SpokenLanguage | null;
  reasoningEffort: GrokReasoningEffort;
}

const DEFAULT_MODEL = "grok-voice-think-fast-2.0";
const DEFAULT_VOICE = "eve";

/** Env keys are upper-snake: `azul-scheduling` -> `AZUL_SCHEDULING`. */
function envSuffix(slug: string): string {
  return slug.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * The per-lane env lookup: `<BASE>_<SLUG>` first, then plain `<BASE>`,
 * then nothing. Exported because laneRegistry.ts needs to know whether a
 * value was set EXPLICITLY — a default returned from here is
 * indistinguishable from a real setting, and if the default won, a lane's
 * own registered voice could never take effect.
 */
export function pickLaneEnv(
  env: Record<string, string | undefined>,
  base: string,
  slug: string | undefined,
): string | undefined {
  if (slug) {
    const scoped = env[`${base}_${envSuffix(slug)}`];
    if (scoped && scoped.trim()) return scoped.trim();
  }
  const general = env[base];
  return general && general.trim() ? general.trim() : undefined;
}

export function loadGrokRuntimeVoiceConfig(
  env: Record<string, string | undefined> = process.env,
  slug?: string,
): GrokRuntimeVoiceConfig {
  // Only an explicit "none" disables reasoning; anything else keeps the
  // default high effort that the live lanes run on today.
  const effortRaw = (pickLaneEnv(env, "XAI_VOICE_REASONING_EFFORT", slug) ?? "").toLowerCase();
  return {
    apiKey: env.XAI_API_KEY ?? "",
    model: pickLaneEnv(env, "XAI_VOICE_MODEL", slug) ?? DEFAULT_MODEL,
    voiceName: pickLaneEnv(env, "XAI_VOICE_NAME", slug) ?? DEFAULT_VOICE,
    language: normalizeSpokenLanguageOrNull(pickLaneEnv(env, "XAI_VOICE_LANGUAGE", slug)),
    reasoningEffort: effortRaw === "none" ? "none" : "high",
  };
}
