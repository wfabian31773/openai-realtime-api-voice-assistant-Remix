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

/** Best-effort BCP-47-ish primary subtag. Unknown input is passed through
 * rather than forced to English — the provider handles more languages than
 * this table lists, and silently answering a Korean caller in English is a
 * worse failure than sending a hint the provider ignores. */
/**
 * Like `normalizeSpokenLanguage`, but ABSENT stays absent — task #55.
 *
 * `normalizeSpokenLanguage("")` returns "en", which is right for a mid-call
 * switch (something was established) and wrong for lane configuration, where
 * "nobody set one" is a real and different state. Defaulting it to English is
 * how every runtime call ended up pinned to English before the caller had
 * said a word, and a hard pin produces confident nonsense on exactly the
 * fields the identity gates key on — names and dates of birth. See
 * .agents/memory/transcription-config.md.
 */
export function normalizeSpokenLanguageOrNull(
  raw: string | null | undefined,
): SpokenLanguage | null {
  const t = (raw ?? "").trim();
  return t ? normalizeSpokenLanguage(t) : null;
}

export function normalizeSpokenLanguage(raw: string | null | undefined): SpokenLanguage {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t) return "en";
  if (LANGUAGE_ALIASES[t]) return LANGUAGE_ALIASES[t];
  const primary = t.split(/[-_]/)[0] ?? t;
  if (LANGUAGE_ALIASES[primary]) return LANGUAGE_ALIASES[primary];
  if (/^[a-z]{2,8}$/.test(primary)) return primary;
  return t;
}
