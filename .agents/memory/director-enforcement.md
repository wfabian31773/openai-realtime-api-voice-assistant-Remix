# Director enforcement — match the level to the confidence of the signal

The director (`src/director/director.ts`) rewrites live agent turns. Three
enforcement levels, escalating per topic per call: `inject` (system message the
model may heed) → `author` (cancel the in-flight utterance, dictate the exact
words) → `force_exit` (say the exit line and hand off).

`author` and `force_exit` cancel the caller's audio mid-sentence. On a true
positive that is a mercy. On a false positive it destroys the call — and it
cannot un-say anything, because the director only ever sees a line *after* it
has been spoken.

## What went wrong twice in 48 hours

Both incidents were the same shape: a rule with an uncertain signal wired
straight to `author`.

- **2026-08-03 (PR #66 → #68, #69).** The name-disclosure rule flagged the
  sanctioned `"Am I speaking with {first}?"` opening. 48 real patient calls
  cancelled mid-sentence between 15:00 and 17:00. Detection was narrowed; the
  enforcement level was left at maximum.
- **2026-08-04.** `identityEstablished()` read only the director's own
  `answered` ledger, which `extractAnswers` fills solely from a *volunteered*
  "my name is X" / "this is X" / "Surname, Firstname". The prompts require the
  agent to collect first and last name in **separate turns**, and nothing
  merged them — so `'full name'` was effectively unreachable through the
  sanctioned flow. Every later use of the caller's own name scored as a record
  disclosure. 21 of 23 azul calls touched, **zero bookings**, patients giving up
  on the recording ("I hate this"). 22 of 54 verified calls on 08-03 and 3 of 6
  on 08-04 were interrupted on callers the server had **already** returned
  `verified: true` for.

## The rules that came out of it

1. **Authoritative state beats inference.** `verify_patient_identity` returning
   `verified: true` is the real answer; a regex over prose is a guess. The tool
   layer stamps it via `director.markIdentityVerified(callId, slug, names)`
   (wired in `azulSchedulingAgent.ts`, synchronously, at the
   `verify_patient_identity` call site — *not* inside `stampVerifiedIdentity`,
   which needs a `callLogId` and awaits a DB write). If you add a rule that
   gates on some piece of call state, find out whether the server already knows
   the answer before inferring it.
2. **Never start a rule at `author` on an inferred signal.** First fire
   injects. The ladder handles a model that ignores the correction — that is
   what it is for — and a detection bug then costs one stray sentence instead
   of a day of calls.
3. **A caller identifies themselves in ways a regex does not expect.** Spelled
   names ("Allen, A-l-l-e-n", "M-A-I-V-O-N-E" with no plain pronunciation) and
   assent to a name-confirm question ("Am I speaking with Irma?" → "Mm-hmm")
   are both the caller stating their name. Both are handled in
   `observeCaller`; both were holes that produced live false positives.

## Language (`language_switch_unwarranted`)

Added 2026-08-04. The agent answered a Russian speaker in Spanish (ecd0b233,
dead at 53s) and switched a whole call to Spanish on one garbled token
("Aynı." — 3c07d83a). The prompt already forbids both; it is instruction-as-
suggestion again.

The rule requires **two** conditions, and the second is the whole point:
the agent's line is Spanish, AND the caller produced a positively foreign
script or letter (Cyrillic, CJK, Arabic, or a Latin-extended letter Spanish
does not use). "The caller has not demonstrably spoken Spanish" is NOT a safe
trigger on its own — transcription garbles Spanish into English-looking ASCII
constantly. Call 88d2c270's caller opened with "Bon tardis", a mangled "buenas
tardes", and switching to Spanish there was correct. Plain-ASCII nonsense is
deliberately left to the model, which has the audio; we only have the
transcript. The rule never pushes a call *into* Spanish.

## Kill switch

`DIRECTOR_AGENTS` (comma-separated agent slugs, empty = off everywhere) gates
the director per agent — `directorAgents()` / `directorEnabledFor()`. Env change
plus restart, no deploy. Reach for it before debugging a live regression; note
it takes the loop guards down with the disclosure rules, and the loop guards are
the half with the strongest evidence behind them (call afb1e688).

## Reviewing it

`tool_timeline->'director'` on `call_logs` carries `{count, topics, actions[],
maxEnforcement}` per call. To see whether the director is helping or hurting:

```sql
select a->>'code' as code, a->>'enforcement' as enforcement, count(*)
from public.call_logs cl
cross join lateral jsonb_array_elements(
  coalesce(cl.tool_timeline->'director'->'actions','[]'::jsonb)) a
where cl.agent_used = 'azul-scheduling'
group by 1,2 order by 3 desc;
```

Watch the share of calls touched. 85–91% (08-03/08-04) is not a supervisor
catching rare defects; it is a second author on every call.
