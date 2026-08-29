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

import { normalizeSpokenLanguage, type SpokenLanguage } from "./language";

export type GrokReasoningEffort = "none" | "high";

export interface GrokRuntimeVoiceConfig {
  apiKey: string;
  model: string;
  voiceName: string;
  language: SpokenLanguage;
  reasoningEffort: GrokReasoningEffort;
}

const DEFAULT_MODEL = "grok-voice-think-fast-2.0";
const DEFAULT_VOICE = "eve";

/** Env keys are upper-snake: `azul-scheduling` -> `AZUL_SCHEDULING`. */
function envSuffix(slug: string): string {
  return slug.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function pick(
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
  const effortRaw = (pick(env, "XAI_VOICE_REASONING_EFFORT", slug) ?? "").toLowerCase();
  return {
    apiKey: env.XAI_API_KEY ?? "",
    model: pick(env, "XAI_VOICE_MODEL", slug) ?? DEFAULT_MODEL,
    voiceName: pick(env, "XAI_VOICE_NAME", slug) ?? DEFAULT_VOICE,
    language: normalizeSpokenLanguage(pick(env, "XAI_VOICE_LANGUAGE", slug) ?? "en"),
    reasoningEffort: effortRaw === "none" ? "none" : "high",
  };
}
