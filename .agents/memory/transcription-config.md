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

## Current model, and rolling back

**Default is `gpt-live-transcribe`** (flipped 2026-08-04 on the operator's
instruction, verified by live calls rather than here — there is no audio path on a
dev box, so the first real evidence is a call).

```
TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe   # rollback: env only, no deploy
TRANSCRIPTION_LANGUAGES=en,es                # optional; this is the default
TRANSCRIPTION_DELAY=low|medium|high|...      # optional; unset = API default
```

Every session logs what it started with — `[SESSION] Call config: ...
transcription=...` — so which model a given call used is answerable from the logs
rather than inferred.

### What a verification call should check, in the order these fail

1. **Audio at all.** The model string reaches the SIP accept payload, which is
   what starts the session. A model the API rejects fails the *session*, not just
   the transcript.
2. **Surnames and dates of birth.** The whole point: every identity gate keys on
   them, and the old config returned "nelsum" for Nelson.
3. **A Spanish call WITHOUT pressing 4 in the IVR.** That is the case the old
   `language: languageCode || 'en'` pin broke, and what `languages` (plural)
   exists for.
4. **Turn-taking latency.** Streaming transcription trades latency for quality.
   If the agent lags, `TRANSCRIPTION_DELAY` is the knob — deliberately unset so
   the model flip was the only variable. Related: the VAD eagerness `'low'`
   experiment was reverted on 2026-07-20 because responses lagged and callers
   repeated themselves, so this call is sensitive to it.

`TRANSCRIPTION_PROMPT` and `TRANSCRIPTION_KEYWORDS` contain **no patient data** —
they ship in every session payload and describe the setting only. Keep it that
way; patient surnames cannot be enumerated, which is what `prompt` is for.

## The VAD threshold, measured for the first time (2026-09-03)

`turn_detection.threshold` on the Grok Voice Agent API takes **0.1–0.9 and
defaults to 0.85**. The runtime shipped with the default, unexamined, from the
day it was written.

"Barely heard" — a call lasting 30 seconds or more on which the caller was
transcribed **at most once** — on the two lanes that ran both pipelines on the
cutover day:

| lane | old core (OpenAI SIP) | this runtime at 0.85 |
|---|---|---|
| surgery | 6/46 = 13.0% | 13/40 = **32.5%** |
| tech | 7/75 = 9.3% | 18/76 = **23.7%** |

Replicated independently on both lanes, roughly tripling. Two calls ran 132 and
155 seconds with the greeting played and the caller never audible at all.

**The distribution is what identifies the cause, and it is bimodal.** When the
VAD fires, this runtime captures MORE than the old core — tech callers average
348 characters against 324, in fewer and longer segments. Speech is not lost
once a segment starts; segments fail to start.

That also kills the reading you would take from raw line counts alone. Caller
lines per call fell (7.5 → 5.3 on tech) and the obvious conclusion — "the
runtime hears less" — is FALSE. It hears less often and more fully. You need
both the count and the volume to tell those apart, and only one of them is in
`call_logs`.

Now `RUNTIME_VAD_THRESHOLD`, default 0.6, clamped to the documented range
because a typo must not disable turn detection on every live call.

**Measure BOTH directions or you have not measured it.** Lowering a VAD
threshold trades silence for false triggers — the agent stopping mid-sentence
because of a cough, a television, a second person in the room. Barely-heard has
to fall AND interruptions per call must not climb. A win on one is not a win.

### Also from that docs read, and not yet used

- `idle_timeout_ms` — "re-engages the user after silence". We have a dead-air
  watchdog in the bridge that does something adjacent; the provider-side option
  has never been tried and might be cheaper.
- `keyterms`, up to 100 — already wired via `laneKeyterms`.
- `language_hint` takes BCP-47, so `es-MX` is available and more specific than
  `es`. Untested.
