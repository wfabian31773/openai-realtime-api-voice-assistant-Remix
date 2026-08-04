/**
 * Transcription config tests. The regression that matters is the accept
 * payload's `language: languageCode || 'en'`, which asserted English about every
 * caller who had not pressed 4 in the IVR and produced confident nonsense from
 * the Spanish speakers ("Bon tardis" for "buenas tardes").
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  PREVIOUS_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_KEYWORDS,
  TRANSCRIPTION_PROMPT,
  buildTranscriptionConfig,
  practiceLanguages,
  supportsVocabularyHints,
  transcriptionDelay,
  transcriptionModel,
} from './transcription';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('transcriptionModel', () => {
  it('defaults to gpt-live-transcribe (flipped 2026-08-04)', () => {
    expect(DEFAULT_TRANSCRIPTION_MODEL).toBe('gpt-live-transcribe');
    expect(transcriptionModel(env({}))).toBe('gpt-live-transcribe');
    expect(transcriptionModel(env({ TRANSCRIPTION_MODEL: '  ' }))).toBe('gpt-live-transcribe');
  });

  it('rolls back to the previous model by environment alone, no deploy', () => {
    expect(PREVIOUS_TRANSCRIPTION_MODEL).toBe('gpt-4o-mini-transcribe');
    expect(transcriptionModel(env({ TRANSCRIPTION_MODEL: PREVIOUS_TRANSCRIPTION_MODEL })))
      .toBe('gpt-4o-mini-transcribe');
  });

  it('the default carries the bilingual + vocabulary treatment', () => {
    // The whole reason for the flip: the previous model accepts none of these.
    const c = buildTranscriptionConfig({ env: env({}) });
    expect(c.languages).toEqual(['en', 'es']);
    expect(c.keywords).toEqual(TRANSCRIPTION_KEYWORDS);
    expect(c.prompt).toBe(TRANSCRIPTION_PROMPT);
    expect(c.language).toBeUndefined();
  });
});

describe('transcriptionDelay', () => {
  it('is absent unless set, so the model flip is the only variable', () => {
    expect(transcriptionDelay(env({}))).toBeUndefined();
    expect(buildTranscriptionConfig({ env: env({}) }).delay).toBeUndefined();
  });

  it('accepts the documented values and ignores anything else', () => {
    for (const d of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(transcriptionDelay(env({ TRANSCRIPTION_DELAY: d })), d).toBe(d);
    }
    expect(transcriptionDelay(env({ TRANSCRIPTION_DELAY: 'HIGH' }))).toBe('high');
    for (const bad of ['fastest', '200ms', 'true', '']) {
      expect(transcriptionDelay(env({ TRANSCRIPTION_DELAY: bad })), bad).toBeUndefined();
    }
  });

  it('reaches the payload when set', () => {
    expect(buildTranscriptionConfig({ env: env({ TRANSCRIPTION_DELAY: 'low' }) }).delay).toBe('low');
  });

  it('is not sent to a model that would reject it', () => {
    const c = buildTranscriptionConfig({
      env: env({ TRANSCRIPTION_MODEL: PREVIOUS_TRANSCRIPTION_MODEL, TRANSCRIPTION_DELAY: 'low' }),
    });
    expect(c.delay).toBeUndefined();
  });
});

describe('supportsVocabularyHints', () => {
  it('knows which models accept languages/keywords/prompt', () => {
    expect(supportsVocabularyHints('gpt-live-transcribe')).toBe(true);
    expect(supportsVocabularyHints('gpt-transcribe')).toBe(true);
    expect(supportsVocabularyHints('gpt-4o-mini-transcribe')).toBe(false);
    expect(supportsVocabularyHints('gpt-4o-transcribe')).toBe(false);
  });
});

describe('language pinning — the 2026-08-04 regression', () => {
  // These cover the LEGACY single-language field, which is what the bug lived
  // in. The default model now uses `languages` (plural) and is covered above.
  const legacy = env({ TRANSCRIPTION_MODEL: PREVIOUS_TRANSCRIPTION_MODEL });

  it('sends NO language when the call has not established one', () => {
    // The whole bug: `languageCode || 'en'`. An unasked caller is auto-detect,
    // not English.
    const c = buildTranscriptionConfig({ env: legacy });
    expect(c.language).toBeUndefined();
    expect(c.model).toBe(PREVIOUS_TRANSCRIPTION_MODEL);
  });

  it('pins the language when the call DID establish one (IVR option 4)', () => {
    expect(buildTranscriptionConfig({ establishedLanguage: 'es', env: legacy }).language).toBe('es');
  });

  it('treats blank and null as not established', () => {
    expect(buildTranscriptionConfig({ establishedLanguage: '', env: legacy }).language).toBeUndefined();
    expect(buildTranscriptionConfig({ establishedLanguage: null, env: legacy }).language).toBeUndefined();
  });

  it('normalises case', () => {
    expect(buildTranscriptionConfig({ establishedLanguage: 'ES', env: legacy }).language).toBe('es');
  });
});

describe('next-generation models get the bilingual + vocabulary treatment', () => {
  const e = env({ TRANSCRIPTION_MODEL: 'gpt-live-transcribe' });

  it('sends BOTH practice languages, not a single pin', () => {
    const c = buildTranscriptionConfig({ env: e });
    expect(c.languages).toEqual(['en', 'es']);
    // The plural form is the point; the singular field must not appear.
    expect(c.language).toBeUndefined();
  });

  it('puts the established language first without dropping the other', () => {
    const c = buildTranscriptionConfig({ establishedLanguage: 'es', env: e });
    expect(c.languages).toEqual(['es', 'en']);
  });

  it('carries the domain prompt and keywords', () => {
    const c = buildTranscriptionConfig({ env: e });
    expect(c.prompt).toBe(TRANSCRIPTION_PROMPT);
    expect(c.keywords).toEqual(TRANSCRIPTION_KEYWORDS);
    // The two office names the routing depends on.
    expect(TRANSCRIPTION_KEYWORDS).toContain('Encinitas');
    expect(TRANSCRIPTION_KEYWORDS).toContain('Oceanside');
  });

  it('never leaks patient data into the prompt', () => {
    // It ships on every session; it describes the setting, nothing more.
    expect(TRANSCRIPTION_PROMPT).not.toMatch(/\b\d{2}\/\d{2}\/\d{2,4}\b/);
    expect(TRANSCRIPTION_PROMPT.toLowerCase()).not.toContain('patient name is');
  });

  it('legacy models get neither, since they would be rejected', () => {
    const c = buildTranscriptionConfig({ env: env({ TRANSCRIPTION_MODEL: PREVIOUS_TRANSCRIPTION_MODEL }) });
    expect(c.keywords).toBeUndefined();
    expect(c.prompt).toBeUndefined();
    expect(c.languages).toBeUndefined();
  });
});

describe('practiceLanguages', () => {
  it('defaults to the bilingual practice', () => {
    expect(practiceLanguages(env({}))).toEqual(['en', 'es']);
  });

  it('is configurable and tolerates sloppy input', () => {
    expect(practiceLanguages(env({ TRANSCRIPTION_LANGUAGES: 'en, es , tl' }))).toEqual(['en', 'es', 'tl']);
    expect(practiceLanguages(env({ TRANSCRIPTION_LANGUAGES: ' , , ' }))).toEqual(['en', 'es']);
  });
});
