/**
 * INPUT TRANSCRIPTION CONFIG — one place, because it was four.
 *
 * The model and language were hardcoded at four separate call sites in
 * voiceAgentRoutes (sessionOptions, the session.update config, the SIP
 * buildInitialConfig, and the accept payload). Three of them disagreed about
 * whether to send a language at all. That is the same trap the file already
 * documents for SIP_MAX_DURATION_MS — "a hardcoded value used to live on this
 * line, unreferenced; changing it did nothing".
 *
 * WHY THIS MATTERS (2026-08-04 review). Transcripts across the pilot are full of
 * mangled identity data, which is worse here than in a normal voice bot because
 * every downstream gate keys on a name or a date of birth:
 *
 *   "nelsum" (Nelson) · "Chwi" / "D-H-W-I" · "Ano" · "Can for seventy-one"
 *   (October 4, 1971) · "Maniwan Butsali" → "Moutsali" → "Boutsalee" ·
 *   "Bon tardis" (buenas tardes) · "Aynı."
 *
 * Two causes, both fixed here.
 *
 * 1. THE ACCEPT PAYLOAD HARD-DEFAULTED TO ENGLISH (`language: languageCode ||
 *    'en'`). That payload is the one that actually starts the session — the file
 *    notes a later session.update "cannot change it". Spanish is only reachable
 *    by pressing 4 in the IVR, so every Spanish speaker who did not press 4 was
 *    force-decoded as English. Pinning the wrong language does not degrade
 *    gracefully; it produces confident nonsense, which is where "Bon tardis"
 *    comes from. We now send a language ONLY when the call actually establishes
 *    one, and let the model auto-detect otherwise.
 *
 * 2. NO DOMAIN VOCABULARY. Nothing told the transcriber it was listening to
 *    surnames, two San Diego office names and a fixed set of appointment types.
 *    The newer transcription models take `prompt` and `keywords` for exactly
 *    this; the model in use takes neither.
 *
 * MODEL CHOICE. `gpt-4o-mini-transcribe` is the cheap tier of an older
 * generation (modelPricing has it at half the audio-input cost of
 * `gpt-4o-transcribe`). Per OpenAI's Realtime transcription guide the current
 * models for this job are `gpt-live-transcribe` (streaming, minimal latency) and
 * `gpt-transcribe`, and only those accept `languages` (plural — the bilingual
 * case, which is exactly this practice), `keywords`, and `prompt`. OpenAI also
 * reports the `gpt-4o-mini-transcribe-2025-12-15` snapshot producing ~70% fewer
 * hallucinations than previous gpt-4o-transcribe models, so even staying on this
 * family, the undated alias is the wrong thing to pin.
 *
 * The default here stays on the CURRENT model deliberately: a model swap changes
 * every live patient call and cannot be verified from a dev box with no audio
 * path. Everything else — bilingual languages, keywords, prompt — is wired and
 * tested, so the upgrade is one environment variable:
 *
 *     TRANSCRIPTION_MODEL=gpt-live-transcribe
 *
 * Flip it, place one call in each language, confirm names and dates come back
 * clean, and it stays. Roll back by unsetting it; no deploy either way.
 */

/** Models that accept `languages` (plural), `keywords` and `prompt`. */
const NEXT_GEN_MODELS = new Set(['gpt-live-transcribe', 'gpt-transcribe']);

export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

export function transcriptionModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = (env.TRANSCRIPTION_MODEL ?? '').trim();
  return m || DEFAULT_TRANSCRIPTION_MODEL;
}

export function supportsVocabularyHints(model: string): boolean {
  return NEXT_GEN_MODELS.has(model);
}

/**
 * Languages this practice actually operates in, most likely first. Only sent to
 * models that accept the plural form; a single-language model gets a pin only
 * when the call has established one (see buildTranscriptionConfig).
 */
export function practiceLanguages(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.TRANSCRIPTION_LANGUAGES ?? '').trim();
  if (!raw) return ['en', 'es'];
  const list = raw.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ['en', 'es'];
}

/**
 * What the transcriber is listening to. Kept short and factual: the guide says
 * to "describe the recording or its setting", not to supply instructions.
 *
 * Deliberately contains NO patient data. It ships in every session payload and
 * describes the setting only.
 */
export const TRANSCRIPTION_PROMPT =
  'Inbound telephone calls to a San Diego area ophthalmology and optometry practice. ' +
  'Callers state their surname, spell it letter by letter, and give a date of birth. ' +
  'Expect patient surnames, clinic locations, provider names, and eye-care terms.';

/**
 * Terms the transcriber gets wrong and that the call cannot proceed without:
 * the two office names, the provider surnames seen in the appointment data, and
 * the appointment vocabulary. Patient surnames cannot be enumerated — that is
 * what `prompt` is for.
 */
export const TRANSCRIPTION_KEYWORDS = [
  // Offices and practice
  'Azul Vision', 'Encinitas', 'Oceanside', 'Carlsbad', 'Vista', 'San Marcos',
  // Providers seen in live appointment records
  'Nayer', 'Bock', 'Kim', 'Thompson', 'Choi',
  // Appointment and clinical vocabulary the rules engine keys on
  'refraction', 'dilated exam', 'comprehensive exam', 'glaucoma', 'cataract',
  'follow up', 'consult', 'post-op', 'OCT', 'visual field', 'optometrist',
  'ophthalmologist', 'intraocular', 'IOL', 'YAG', 'blepharitis',
];

export interface TranscriptionConfigInput {
  /** ISO code, ONLY when the call has actually established a language (IVR
   *  option 4, an explicit metadata language, a stored agent language).
   *  Undefined means "we do not know" — and we must not guess. */
  establishedLanguage?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the `audio.input.transcription` object.
 *
 * Returns a plain object rather than an SDK type on purpose: the model is a
 * runtime-configurable string, and the accept payload is serialised straight to
 * the wire. Typing it to the installed SDK's union would make changing the model
 * a compile error rather than an environment change.
 */
export function buildTranscriptionConfig(
  input: TranscriptionConfigInput = {},
): Record<string, unknown> {
  const env = input.env ?? process.env;
  const model = transcriptionModel(env);
  const established = (input.establishedLanguage ?? '').trim().toLowerCase() || null;

  if (supportsVocabularyHints(model)) {
    // Plural form: name every language the practice runs in, putting the
    // established one first when we have it. This is the bilingual case the
    // single `language` field could never express.
    const langs = practiceLanguages(env);
    const ordered = established
      ? [established, ...langs.filter((l) => l !== established)]
      : langs;
    return {
      model,
      languages: ordered,
      prompt: TRANSCRIPTION_PROMPT,
      keywords: TRANSCRIPTION_KEYWORDS,
    };
  }

  // Older single-language models. A pin ONLY when the call established one;
  // otherwise omit the field entirely so the model auto-detects. The previous
  // `language: languageCode || 'en'` is precisely the bug: it asserted English
  // about callers nobody had asked.
  return established ? { model, language: established } : { model };
}
