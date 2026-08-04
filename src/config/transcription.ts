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
 * DEFAULT FLIPPED to `gpt-live-transcribe` on 2026-08-04, on the operator's
 * instruction, with live verification calls to follow. See the note on
 * DEFAULT_TRANSCRIPTION_MODEL for the rollback and for what those calls should
 * check. This cannot be verified from a dev box: there is no audio path here, so
 * the first real evidence is a call.
 */

/** Models that accept `languages` (plural), `keywords` and `prompt`. */
const NEXT_GEN_MODELS = new Set(['gpt-live-transcribe', 'gpt-transcribe']);

/**
 * `gpt-live-transcribe` as of 2026-08-04, on the operator's call — they are
 * verifying with live calls in both languages.
 *
 * ROLLBACK, if those calls come back wrong: set
 *
 *     TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
 *
 * and restart. No deploy, no code change. Every session logs the model it
 * started with (`[SESSION] Call config: ... transcription=...`), so which model a
 * given call actually used is answerable from the logs rather than inferred.
 *
 * WHAT TO WATCH on the verification calls, in the order these fail:
 *   1. Audio at all — this model string reaches the SIP accept payload, which is
 *      what starts the session. A model the API rejects fails the session, not
 *      just the transcript.
 *   2. Surnames and dates of birth. That is the whole point: every identity gate
 *      keys on them, and the old config returned "nelsum" for Nelson.
 *   3. A Spanish call WITHOUT pressing 4 in the IVR. That is the case the old
 *      `language: languageCode || 'en'` pin broke, and the one `languages`
 *      (plural) exists for.
 *   4. Turn-taking latency. Streaming transcription trades latency for quality;
 *      if responses lag, TRANSCRIPTION_DELAY tunes it (see transcriptionDelay).
 *      Note the VAD eagerness 'low' experiment was reverted on 2026-07-20 for
 *      exactly this reason, so the call is sensitive to it.
 */
export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';

/** The model to fall back to if the new one misbehaves. Documented, not used. */
export const PREVIOUS_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

export function transcriptionModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = (env.TRANSCRIPTION_MODEL ?? '').trim();
  return m || DEFAULT_TRANSCRIPTION_MODEL;
}

export function supportsVocabularyHints(model: string): boolean {
  return NEXT_GEN_MODELS.has(model);
}

/** The `delay` values gpt-live-transcribe accepts, cheapest latency first. */
const DELAY_VALUES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * Latency/accuracy trade for the streaming transcriber.
 *
 * Unset by default and therefore ABSENT from the payload, so the API's own
 * default applies and the model flip is the only variable in the operator's
 * verification calls. If those calls show the agent lagging the caller, this is
 * the knob — and it is the same failure the VAD eagerness 'low' experiment
 * produced on 2026-07-20 (responses lagged, callers repeated themselves and
 * "hello?"-ed into the gap), which is why it is not being pre-tuned blind.
 */
export function transcriptionDelay(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const d = (env.TRANSCRIPTION_DELAY ?? '').trim().toLowerCase();
  return DELAY_VALUES.has(d) ? d : undefined;
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
    const delay = transcriptionDelay(env);
    return {
      model,
      languages: ordered,
      prompt: TRANSCRIPTION_PROMPT,
      keywords: TRANSCRIPTION_KEYWORDS,
      ...(delay ? { delay } : {}),
    };
  }

  // Older single-language models. A pin ONLY when the call established one;
  // otherwise omit the field entirely so the model auto-detects. The previous
  // `language: languageCode || 'en'` is precisely the bug: it asserted English
  // about callers nobody had asked.
  return established ? { model, language: established } : { model };
}
