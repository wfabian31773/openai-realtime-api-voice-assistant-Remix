/**
 * src/runtime/language.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Spoken-language normalization for the voice runtime. Callers say
 * "Spanish", the wire wants "es", and a mid-call language switch has to
 * retarget the STT hint with something the provider accepts.
 *
 * Deliberately tiny and dependency-free: the runtime must not import an
 * agent's or an application's types (ADR-001's boundary rule).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type SpokenLanguage = string;

const LANGUAGE_ALIASES: Record<string, string> = {
  en: "en", english: "en",
  es: "es", spanish: "es", español: "es", espanol: "es",
  tl: "tl", tagalog: "tl", filipino: "tl", fil: "tl",
  zh: "zh", chinese: "zh", mandarin: "zh",
  vi: "vi", vietnamese: "vi",
  ko: "ko", korean: "ko",
  hy: "hy", armenian: "hy",
  fa: "fa", farsi: "fa", persian: "fa",
  ru: "ru", russian: "ru",
  ar: "ar", arabic: "ar",
  pt: "pt", portuguese: "pt",
  fr: "fr", french: "fr",
};

/**
 * REGIONAL HINTS FOR THE STT, keyed by primary subtag.
 *
 * Operator guidance, 2026-09-05: *"After you hear Spanish, send es-MX or
 * es-ES (not es). Unrecognized codes are ignored."* A bare primary subtag
 * makes the transcriber pick a variant for itself; naming the one this
 * practice actually hears costs nothing when the provider disagrees,
 * because it falls back rather than erroring.
 *
 * es-MX because this is a Southern California eye-care practice. If the
 * caller base changes, this is the line to change — not the prompts.
 *
 * ONLY the STT hint takes the regional form. `spokenLanguageLabel()` below
 * keeps the plain subtag for anything a human or the model reads, so a
 * prompt never says "now speaking es-MX" at a person.
 */
const REGIONAL_STT_HINTS: Record<string, string> = {
  es: "es-MX",
};

/**
 * The code to put in `audio.input.transcription.language_hint`. Regional
 * where we know the region, plain everywhere else.
 */
export function sttLanguageHint(raw: string | null | undefined): string {
  const primary = normalizeSpokenLanguage(raw);
  return REGIONAL_STT_HINTS[primary] ?? primary;
}

/** Best-effort BCP-47-ish primary subtag. Unknown input is passed through
 * rather than forced to English — the provider handles more languages than
 * this table lists, and silently answering a Korean caller in English is a
 * worse failure than sending a hint the provider ignores. */
export function normalizeSpokenLanguage(raw: string | null | undefined): SpokenLanguage {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t) return "en";
  if (LANGUAGE_ALIASES[t]) return LANGUAGE_ALIASES[t];
  const primary = t.split(/[-_]/)[0] ?? t;
  if (LANGUAGE_ALIASES[primary]) return LANGUAGE_ALIASES[primary];
  if (/^[a-z]{2,8}$/.test(primary)) return primary;
  return t;
}
