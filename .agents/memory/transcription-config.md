# Input transcription — model, language, and why names come back garbled

All four call sites now go through `src/config/transcription.ts`. Before that the
model and language were hardcoded in `voiceAgentRoutes` at `sessionOptions`, the
`session.update` config, the SIP `buildInitialConfig`, and the accept payload —
and three of them disagreed about whether to send a language at all.

## The bug that mattered

The accept payload had `language: languageCode || 'en'`. Two things make that
severe:

1. **The accept payload is the one that starts the session.** The file's own
   comment: a later `session.update` "cannot change it".
2. **Spanish is only reachable by pressing 4 in the IVR.** Every Spanish speaker
   who did not press 4 was force-decoded as English.

Pinning the wrong language does not degrade gracefully — it produces *confident
nonsense*. Symptoms all over the pilot transcripts:

```
"nelsum" (Nelson) · "Chwi" / "D-H-W-I" · "Ano" · "Can for seventy-one" (Oct 4 1971)
"Maniwan Butsali" → "Moutsali" → "Boutsalee" · "Bon tardis" (buenas tardes) · "Aynı."
```

This is worse here than in a general voice bot because **every downstream gate
keys on a name or a date of birth** — `verify_patient_identity`,
`sage_handoff`'s identity requirement, the director's disclosure rules. A garbled
surname doesn't degrade the conversation, it fails the call.

`buildTranscriptionConfig` now sends a language **only when the call actually
established one** (explicit `languageForCall`, IVR option 4 / metadata Spanish,
or an agent deliberately configured non-English). Plain `'en'` from the default
chain is an *assumption*, so the field is omitted and the model auto-detects.
Note the distinction in `voiceAgentRoutes`: `languageCode` always resolves to
something; `establishedLanguageCode` is the one to pass here.

## Model choice

`gpt-4o-mini-transcribe` is the cheap tier of an older generation (`modelPricing`
has it at half the audio-input cost of `gpt-4o-transcribe`), and the code pins the
**undated alias**.

Per OpenAI's Realtime transcription guide the current models for this job are
**`gpt-live-transcribe`** (streaming, minimal latency) and **`gpt-transcribe`**.
Only those accept:

- **`languages`** (plural) — the bilingual case, which is exactly this practice
- **`keywords`** — office names, provider surnames, appointment vocabulary
- **`prompt`** — describes the setting so specialised vocabulary decodes
- **`delay`** — latency/accuracy tuning

OpenAI also reports the `gpt-4o-mini-transcribe-2025-12-15` snapshot producing
~70% fewer hallucinations than previous gpt-4o-transcribe models, so even staying
in this family, pinning the undated alias is the wrong move.

## Upgrading (one env var, no deploy)

The default deliberately stays on the current model: a swap changes every live
patient call and **cannot be verified from a dev box with no audio path**.
Everything else — bilingual `languages`, `keywords`, `prompt` — is wired and
tested behind the model check.

```
TRANSCRIPTION_MODEL=gpt-live-transcribe     # recommended
TRANSCRIPTION_LANGUAGES=en,es               # optional; this is the default
```

Flip it, place one call in each language, confirm surnames and dates come back
clean, and keep it. Unset to roll back.

`TRANSCRIPTION_PROMPT` and `TRANSCRIPTION_KEYWORDS` contain **no patient data** —
they ship in every session payload and describe the setting only. Keep it that
way; patient surnames cannot be enumerated, which is what `prompt` is for.
