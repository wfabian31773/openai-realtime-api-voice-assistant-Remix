# The runtime against xAI's own docs — prompt size and Spanish, 2026-09-28

**Operator, 2026-09-28:** *"the prompt size, xai specifically states that
large prompts are unnecessary, they also have their recommendations for
handling spanish calls, we need to ensure the runtime follows those docs to
the letter."*

This is the audit. Every quotation below is verbatim from `docs.x.ai`, read on
2026-09-28 — the Speech to Speech page
(`/developers/model-capabilities/audio/speech-to-speech`) and its Prompting
Guide (`…/speech-to-speech/prompting-guide`). Where the runtime departs, the
departure is named with the code that carries it and, where it exists, the
production number behind it. Nothing here is recalled from memory; the page
text was pulled to disk and diffed against `src/`.

## 0. The verdict in four lines

1. **Spanish: one departure, fixed on v75.** The runtime seeded an English
   transcription bias on every call. The docs say the model detects the
   language with no configuration and the hint is for biasing. Everything
   else on Spanish already matched the docs — regional `es-MX`, mid-session
   retarget, a lock clause in the prompt.
2. **The after-hours lane had no way to follow a Spanish caller on the
   runtime** — no `set_spoken_language`, so its hint could never move. Fixed
   on v75, ahead of the repoint.
3. **Prompt size: xAI states it in the migration guide, not as a number.**
   *"Simplify your system prompt. The model is significantly more capable, so
   your prompt should be much shorter."* The four queue lanes were rewritten
   for Grok on 2026-09-03 and conform in shape. **The after-hours prompt was
   never rewritten** — 28,478 characters of its own (~7,100 tokens) against
   6,374–7,421 for the lanes that were, none of the five sections the guide
   prescribes, and the workaround prompting the guide says to strip. **PCP
   is live on the runtime and does not carry the five sections either.**
4. **The after-hours rewrite is on this branch too (v76), gated to the
   runtime.** `src/agents/noIvrPromptForGrok.ts` carries the same rulings in
   the docs' five sections at 49% of the size, and is built only when the
   call's metadata says `pipeline: 'runtime'` — so it deploys inert on the
   old core and is live from the first runtime call after the repoint. Its
   content is policy (escalation triggers, 911, ghost calls), so § 4 lists
   what moved where and the one rule that changed, for the operator to read
   before the repoint. **Not changed:** the PCP prompt's shape (a ticket-path
   change on a live lane, needs its own before/after) and the knowledge pack
   moving to `file_search` (an architecture change with a latency cost nobody
   has measured).

## 1. What xAI actually says

### On prompt size and shape

Migration section, *Step 3 — Model-Specific Best Practices*, verbatim:

> Simplify your system prompt. The model is significantly more capable, so
> your prompt should be much shorter. Ask Grok to generalize your existing
> system prompt rather than porting it verbatim.
>
> Remove workaround prompting. Prompt hacks and edge-case fixes needed for
> GPT models are unnecessary. Strip out instructions added solely to patch
> bugs or limitations of the previous model.

Prompting Guide, verbatim, the parts that bind:

> Prompts follow a single recommended shape: second-person voice and a fixed
> section order. Prompts written this way sit closest to the training
> distribution and behave most predictably.

> Write system prompts **in the second person** ("You are…"), in Markdown,
> with these `##` sections **in this order**:
> `## Role & Persona` · `## Objective` · `## Conversation Flow` ·
> `## Guardrails & Escalation` · `## Voice & Communication Style`

> Prefer short bullets over long paragraphs. · Guide with examples. · Be
> precise. Ambiguity or conflicting instructions degrade performance.

> Only mention tools that exist in the tool definition. … Never script steps
> for capabilities the agent does not have.

> Facts are baked in verbatim. Business name, hours, prices, policies, and
> the website URL … go directly into the prompt. … **Long or document-bound
> info:** goes to the knowledge base, not the prompt.

> The greeting is separate. The agent's spoken first line is configured as
> its own field, not written into the prompt.

> Real deployments frequently append a `## CRITICAL INSTRUCTIONS` section …
> keep it short and absolute. … Use this section sparingly: every rule added
> here dilutes the emphasis of the others.

**There is no token or character limit anywhere on either page.** The
statement the operator is quoting is the migration text above: *much
shorter*, *generalize rather than port verbatim*, *strip workaround
prompting*. It is a direction, not a ceiling, and the queue lanes' 1,600
–1,900 own tokens are the only in-house measure of what "much shorter" has
meant on this fleet.

### On languages and Spanish

Supported Languages, verbatim:

> The Speech to Speech API supports 20+ languages with native-quality
> accents. **The model automatically detects the input language and responds
> naturally in the same language — no configuration required.**

> You can specify a preferred language or accent in your system instructions
> for consistent multilingual experiences.

Language Hint, verbatim:

> Bias transcription toward a specific language by setting
> `audio.input.transcription.language_hint` in `session.update`. Use a BCP-47
> code from the Supported Languages table. Can be changed mid-session.
>
> **For Spanish and Portuguese, you must specify a regional variant (e.g.
> "es-MX", "es-ES", "pt-BR", "pt-PT") — bare "es" and "pt" are not
> accepted.** Unrecognized codes are silently ignored and fall back to
> automatic language detection.

Prompting Guide:

> Control language explicitly if unwanted language switching appears.

> **Language lock.** Pin the output language explicitly. This is especially
> useful in noisy or multilingual environments where the incoming speech may
> be mixed or unclear: *Respond only in English. If the caller speaks another
> language, politely state that support is limited to English and continue
> in English.*

The supported-languages table lists `es-MX` and `es-ES`; there is no bare
`es`.

## 2. The runtime against each line

| the docs say | the runtime does | verdict |
|---|---|---|
| the model detects the input language, *no configuration required*; the hint *biases* | `buildSessionConfig` seeded `language_hint: sttLanguageHint(config.language)` on EVERY call, and every registered lane carries `language: 'en'` — copied from the old core, where the PROMPT did the detecting. So each call opened with an English bias against the caller's first turns. | **DEPARTURE — fixed v75.** A defaulted English seeds nothing; an env-set language or a non-English lane still seeds its regional hint. Revert lever `XAI_VOICE_LANGUAGE=en`. |
| Spanish needs a regional variant | `REGIONAL_STT_HINTS = { es: "es-MX" }`, applied at the handshake for an `es` lane and on every mid-call switch (`language.ts`, Codex 2026-09-05) | conforms |
| the hint *can be changed mid-session* | `GrokVoiceSession.setSpokenLanguage` sends a fresh `session.update` with the new hint after the handshake; the bridge sends the tool result to the model FIRST, then the wire (`mediaStreamBridge.ts`, transport note) | conforms |
| *control language explicitly if unwanted switching appears* / language lock | the switch appends ONE lock line, replacing not stacking: *"Keep every question … in <language>. Switch only if the caller switches — not for an English tool result, a medication name, a number, or a word you did not catch."* — written against the operator's own observation that a noisy word pulled the model back to English (2026-09-05) | conforms |
| *specify a preferred language … in your system instructions* | the four queue lanes: *"If the caller is not speaking English, call set_spoken_language and continue in their language"* | conforms |
| the tool a prompt names must be on the tool list | `set_spoken_language` is on optical, surgery, tech and records — **and was on NO other lane**. The after-hours lane builds its tools by hand and never had it, so on the runtime its hint could not follow a caller; its prompt handled Spanish by exhortation alone. | **DEPARTURE — fixed v75.** The lane carries the tool from the same one-copy description; the prompt's language block is restated in the guide's language-lock shape and names the tool. |
| the greeting is *its own field*, not scripted in the prompt | the bridge plays `deps.greeting` as a `force_message` item (the docs' own mechanism for *"scripted greetings, compliance disclosures"*) and appends *"your greeting has already been spoken"* to the prompt | conforms |
| five `##` sections, second person, in order | optical, surgery, tech, records: all five, in order, 0 `CRITICAL`, 1–2 `NEVER/ALWAYS` each | conform |
| — | **pcp:** none of the five; headers are `## HOW YOU KNOW WHAT TO ASK`, `## FIRST, ALWAYS: WHAT IS THIS CALL ABOUT?`; no *"You are"* persona line; 9 `NEVER/ALWAYS`; ~2,400 own tokens | **departs in shape**, live since 2026-09-04 — see § 4 |
| — | **no-ivr:** none of the five; a six-phase *"INTERNAL WORKFLOW PLAYBOOK (FOLLOW THIS EXACTLY)"*, `=====` banners, emoji headers, **6 `CRITICAL` blocks, 26 `NEVER`/`ALWAYS`**; 28,478 own characters (~7,100 tokens) before the 9,317-character knowledge pack | **departs on every axis the migration text names** — see § 4 |
| *strip workaround prompting … added solely to patch bugs or limitations of the previous model* | the no-ivr prompt carries: an ANTI-NARRATION list of six forbidden phrases; ANTI-REPETITION; *"DO NOT ask 'Is that correct?'"*; *"CLOSING (CRITICAL: SAY THIS ONLY ONCE)"*; INTERRUPTION RECOVERY with a worked example; a FORBIDDEN PHRASES list; a CORRECT SEQUENCE numbered 1–5 with *"THIS IS NOT OPTIONAL"* — each written against an OpenAI-era failure this file's history records | departs — § 4 |
| *keep CRITICAL short and absolute; use it sparingly* | no-ivr: six CRITICAL banners spread through the body; pcp: `# ONE QUESTION. THEN STOP TALKING.` as an H1 above everything | departs |
| *long or document-bound info goes to the knowledge base* (the session's `tools` supports `file_search`) | the knowledge pack (9,317 chars, ~2,330 tokens) leads EVERY lane's prompt on EVERY call; 4,442 of it is the office directory, 1,106 the surgeon roster. The no-ivr prompt then embeds a SECOND office list (`buildCompactLocationReference`, 2,396 chars) below the pack's. | departs — § 5; the duplicate office list is the one free trim |
| *reasoning is enabled by default … "high"* | `reasoning.effort` defaults `high`; `XAI_VOICE_REASONING_EFFORT` can set `none` | conforms |
| `turn_detection.threshold` 0.1–0.9, default 0.85; `prefix_padding_ms` default 333 | threshold 0.6 (measured down from 0.85 — CLAUDE.md, the VAD section), silence 500 ms, prefix 333 | conforms; the threshold is a measured choice inside the documented range |
| `turn_detection.idle_timeout_ms` — *the server proactively re-engages the user if no speech is detected* | the silence ladder (v68/v72) is client-side, with a stand-down for a caller already heard | not a departure — the server timer cannot express the stand-down ruling; noted so nobody rebuilds it |
| `replace` — spoken substitutions for pronunciation; *omit … instructions about pronunciation phonetics* | no prompt carries pronunciation or speaking-rate instructions (grepped) | conforms |

## 3. Spanish on the runtime, measured before anything changed

Runtime queue lanes, 2026-09-14..27, `duration >= 30`, a Spanish cue in the
CALLER's own lines (a tight list: *hola, gracias, necesito, quiero, tengo,
buenos días, buenas tardes, lentes, receta, por favor, no hablo, español,
mi hijo/hija, cirugía, medicamento, gotas, cita, consulta*):

| arm | calls | filed on the row | avg caller lines |
|---|---|---|---|
| Spanish cue, switch called | **480** | **82.3%** | 9.3 |
| Spanish cue, no switch | 27 | 66.7% | 5.2 |
| no cue, no switch | 5,126 | 68.1% | 4.8 |
| no cue, switch called | 66 | **45.5%** | 6.7 |

Restricted to calls the caller was heard on (≥ 2 caller lines): Spanish +
switch **84.4%** against 79.5% for English. **So Spanish callers are served
at least as well as English ones on the current mechanism, and the model
calls the switch on 480 of 507 (94.7%).** The seed change is docs
conformance, not the rescue of a measured loss, and the guard is written that
way: the Spanish numbers must not fall, the English ones must not move.

**The 66 no-cue switches are the worst arm on the lanes and they were
unmeasurable:** 574 `set_spoken_language` events in the window, args `{}`
and outcome `{success:true}` on every one, because `language` was not on the
timeline's outcome allow-list. It is now (v75); what those calls switched TO
is the first thing to read.

**The after-hours lane's Spanish share is 4% of records-type calls and 10.8%
fleet-wide** (CLAUDE.md, the new-or-existing row); on the old core its
transcription is configured elsewhere, and this audit does not reach it.

## 4. The prompts that do not conform, and what to do about each

### The after-hours prompt — the migration text applies to it directly

It is the OpenAI-era prompt. The 2026-09-14 trim (v18) removed 6,989
characters of borders and padding *"with no rule changed"*, and said in as
many words that reaching a Grok-sized prompt *"means deleting capability,
which is his call"*. The operator has now made that call in the direction
the docs point. What a rewrite must do, in the guide's own order:

| section | what goes there from today's prompt |
|---|---|
| `## Role & Persona` | after-hours agent for Azul Vision; recorded; no humans behind the line except the on-call provider |
| `## Objective` | take the request and file it (99% of calls); escalate exactly three cases |
| `## Conversation Flow` | the six phases as a phased flow with *Goal / How / Exit when*, one screen not six: reason → who it is about (third party, provider, B2B) → urgency → name, DOB month/day/year, callback, contact method → one summary, no "is that correct?" → `check_open_tickets`, the wait line, `create_ticket`, confirm only on `success=true` |
| `## Guardrails & Escalation` | the three escalation cases and the exact line to say; a patient asking for a human is a ticket; ghost/robot calls end and never escalate; a failed tool is never an escalation; never promise a recording or a named person; office hours answered, exact times withheld; a phone match is a candidate (v47) |
| `## Voice & Communication Style` | short sentences, one question at a time, the language lock (English/Spanish, `set_spoken_language`), numbers digit by digit, *"Anything else?"* before ending |
| `## CRITICAL INSTRUCTIONS` | ONLY: `create_ticket` before any claim of submission; `escalate_to_human` once, never twice; never wake the on-call provider for a tool failure |

**Deleted as workaround prompting**, each a patch for a failure the runtime
now handles mechanically: ANTI-REPETITION (v46 tool ceiling, v68 ladder),
INTERRUPTION RECOVERY (the bridge's barge-in), FORBIDDEN PHRASES and the
CORRECT SEQUENCE list (collapse into one CRITICAL line), the DOB re-ask rules
(v41 bounds them in the tool), the *"SERVER STATE CHECK"* paragraph (no such
message exists on the runtime), the duplicate office list.

**Kept verbatim because it is policy:** every operator ruling this file's
history pins for this lane — the three-case escalation, the 1 AM robocall
rule, B2B DOB optional, the 2026-07-25 `Request Type:` header, the wait
line before `create_ticket`, full name in one question.

**Done on v76, as its own module and its own commit, and gated so it cannot
reach the live line before the operator has read it.** `noIvrPromptShape`
picks the Grok body only when the runtime marks the call `pipeline:
'runtime'`; the old core never does. Measured built with no caller context:
**14,082 characters against 28,801 for the legacy body (49%)** — 23,399
against 38,118 once the runtime prefixes the knowledge pack — of which 2,489
is the triage block and the urgent-symptom list shared verbatim; the body's
own text is ~9,600 of it. That is still above the queue
lanes' 6,374–7,421 because this line carries escalation, ghost-call and
triage policy they do not — what is left to cut is policy. The rulings map
is a test (`noIvrPromptShapeForGrok.test.ts`): twenty-three operator rulings
that BOTH bodies must carry, the carve-out-before-technical-error ordering,
the five sections once each in order, CRITICAL exactly once, no second
office list, and every tool the prompt names present on the agent. **The one
deliberate rule change:** the recognised-caller block no longer asks for the
last name and the date of birth "IN ONE question" — it takes the last name,
then the date of birth in parts (RULE ZERO 2b). Everything else in that block
survives. The after-arm compares the old core with the old prompt against the
runtime with the new one — the same two-variable shape as the 2026-09-03
queue cutover, and the way the docs say a migration is done.

### PCP — live, and departs in shape only

~2,400 own tokens, so not the size problem; but no persona line, no five
sections, an H1 rule at the top and nine capitalised absolutes. The
one-question-then-stop rule and the director-driven intake are measured
behaviour (v21–v37) and must not move. Restructuring into the five sections
with the same sentences is a ticket-path change on a live lane:
`docs/BACKEND_HANDOFF.md` applies, the before-arm is PCP tickets per
substantive call this week, and it waits its turn behind the after-hours
rewrite.

## 5. The knowledge pack

9,317 characters, ~2,330 tokens, prefixed to every lane on every call so the
provider's prompt cache sees one shared prefix (ADR-001). The docs draw the
line at *"short key facts … verbatim"* versus *"long or document-bound info
… to the knowledge base"*, and the session's `tools` array takes a
`file_search` type. The office directory (4,442 chars) and the surgeon roster
(1,106) are the document-bound half; payment methods, partner practices and
the accuracy floor are the short-facts half and belong where they are.

Moving the directory to `file_search` changes latency on a voice call (a
retrieval before an answer about an office), changes what optical's office
ladder reads, and has no measurement behind it. **Recommendation:** measure
first — how often any lane's model answers an office question from the pack
versus routing on `resolve_location` — and decide with the number. Not built.

**The free trim:** the after-hours prompt embeds its own 2,396-character
office list below a pack that already carries one. That duplicate goes in the
rewrite.

## 6. What v75 changes, and the after-arm

| change | where | the number to read |
|---|---|---|
| a defaulted-English lane seeds no `language_hint`; env-set or non-English lanes still seed the regional hint | `grokSession.ts` `seedsLanguageHint`, `config.ts` `languageExplicit`, `laneRegistry.ts` | Spanish-cue calls: switch share (94.7%) and filing (82.3%) must not fall; no-cue filing (68.1%) and barely-heard (18.8%) must not move |
| the after-hours lane carries `set_spoken_language`, one description shared with the registry copy | `noIvrAgent.ts`, `languageTools.ts` | after the move: no-ivr `set_spoken_language` events per Spanish-cue call, target ≈ the queue lanes' 94.7% |
| the language a switch went TO reaches `tool_timeline` | `toolTimeline.ts` allow-list | the 66 no-cue switch calls: what language, and whether it was a switch at all |
| the after-hours language block in the guide's lock shape | `noIvrAgent.ts` | prompt size −0.3%; nothing measurable until the lane moves |
| **v76:** the after-hours prompt in the five-section shape, built only for `pipeline: 'runtime'` | `noIvrPromptForGrok.ts`, `noIvrAgent.ts`, `voiceRuntime.ts` | inert until the repoint; then no-ivr tickets per substantive call must not fall (56.1% before), escalations per substantive call must not rise, ghost/robot terminations must not fall |

Revert lever for the seed, no deploy: `XAI_VOICE_LANGUAGE=en` (fleet) or
`XAI_VOICE_LANGUAGE_<SLUG>=en` (one lane).

## 7. Measurement traps for whoever re-runs this

- **A Spanish cue is not a Spanish caller.** *doctor*, *para* and *una* are
  English words too; the first pass with them in the list read 28% Spanish.
  The tight list reads 8.9%, and CLAUDE.md's 10.8% used a different cue set
  on a different window. Quote the list with the number.
- **A no-cue call is over-represented among the never-heard.** By
  construction a call with a cue was heard, so any barely-heard comparison
  between the arms is biased; restrict to ≥ 2 caller lines before comparing.
- **`set_spoken_language` events before v75 say nothing about the target.**
  Do not read the 574 as Spanish switches; 76 were on calls with no Spanish
  cue.
- **Token counts here are `chars / 4`.** The `realLanes.test.ts` ceilings use
  the same estimator; neither is the provider's tokenizer.
