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
  /**
   * Whether `language` was SET (an `XAI_VOICE_LANGUAGE[_<SLUG>]` value) or
   * merely defaulted. It decides whether the session handshake seeds a
   * transcription `language_hint` at all — see `seedsLanguageHint` in
   * grokSession.ts. xAI's Speech to Speech docs: *"The model automatically
   * detects the input language and responds naturally in the same language
   * — no configuration required"*, and the hint exists to *"bias ASR
   * transcription toward a specific language"*. A defaulted English is not a
   * choice anybody made, so it must not become a bias against every caller
   * who opens in Spanish; an English somebody set on purpose still is.
   */
  languageExplicit: boolean;
  reasoningEffort: GrokReasoningEffort;
}

/**
 * grok-voice-3.0 ON EVERY LANE — operator, 2026-10-19: "switch the entire
 * runtime to 3.0".
 *
 * The model this replaced, `grok-voice-think-fast-2.0`, is the one xAI
 * deprecated on 2026-10-14: the session it opens reports
 * `model: "grok-voice-2.0"`, and xAI's note says "grok-voice-2.0 is
 * deprecated. To upgrade, set model to grok-voice-3.0" — same endpoint, same
 * session parameters, same price.
 *
 * The flip rests on the tech canary (`XAI_VOICE_MODEL_TECH=grok-voice-3.0`,
 * live 2026-10-16), measured 2026-10-19 on `call_logs` against tech's own
 * 2.0 days, substantive calls: 3.0 filed 86.8% of 257 against 84.5% of 1,267
 * (10-06..15), barely heard 5.1% against 7.2%, dead air 1 against 23,
 * provider failures 0 against 2. The offline A/B before it: 3.0 filed every
 * run it could finish and never went silent after a refusal, where 2.0 went
 * silent on 10 of 60.
 *
 * THE REVERT IS NOT A DEPLOY: `XAI_VOICE_MODEL_<SLUG>=grok-voice-think-fast-2.0`
 * puts one lane back, `XAI_VOICE_MODEL` the whole fleet, and
 * `/voice/health` (`lanes[].voiceModel`) shows which model each lane opens.
 * An `XAI_VOICE_MODEL` left set in the environment OUTRANKS this default.
 */
const DEFAULT_MODEL = "grok-voice-3.0";
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
  const envLanguage = pickLaneEnv(env, "XAI_VOICE_LANGUAGE", slug);
  return {
    apiKey: env.XAI_API_KEY ?? "",
    model: pickLaneEnv(env, "XAI_VOICE_MODEL", slug) ?? DEFAULT_MODEL,
    voiceName: pickLaneEnv(env, "XAI_VOICE_NAME", slug) ?? DEFAULT_VOICE,
    language: normalizeSpokenLanguage(envLanguage ?? "en"),
    languageExplicit: envLanguage !== undefined,
    reasoningEffort: effortRaw === "none" ? "none" : "high",
  };
}
