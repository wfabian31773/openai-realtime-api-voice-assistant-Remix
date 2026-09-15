# WHY THE DATE-OF-BIRTH GATE STILL FIRES ON A RECORD WE ARE HOLDING

**Measured 2026-09-15 over 2026-09-14, the first full weekday with all seven
lanes live. Diagnosis only — no fix in this commit.** Wayne asked the question
this file answers: *"how is it possible that we're passing null on date of
birth when we're locked on to a verified patient record?"*

There are **two different bugs**, they need different fixes, and one of them is
a line of code that discards the field on purpose.

---

## THE POPULATION — every date-of-birth refusal on the runtime that day

94 calls hit a `date_of_birth` refusal (tech 49 · optical 24 · surgery 20 ·
pcp 1), 14.6% of 644 substantive runtime calls. 33 filed anyway through the
`verifiedDobFor` fallback; **61 ended with no ticket.**

Split by what `lookup_patient` had actually established, read off
`tool_timeline` (reliable for refusals — CLAUDE.md):

| what the lookup returned | calls | |
|---|---|---|
| **phone match, `identity_is_certain: true`** | **32** | stored the record, refused anyway — **BUG B** |
| phone match, `identity_is_certain: false` | 24 | **the date of birth is dropped on purpose — BUG A** |
| **matched by `name_and_dob`, certain** | **5** | matched them *using* the birthday, then refused for it |
| name-only, not certain | 3 | |
| lookup ran, no `matched_by` recorded | 28 | not established; probably misses/timeouts |
| no `lookup_patient` event at all | 2 | |

`dobShape` reads `(none)` on **93 of 93** recorded refusal events — the MODEL
sent no `date_of_birth` argument on any of them. That is unchanged from 75 of
75 on 2026-09-08. So every one of these calls depended entirely on the carry.

**51 of the 94 are calls where the agent had already addressed the caller by
name from their own record** — the greeting said "am I speaking with…" /
"I have you as…". That is the headline number: the record was in hand and the
gate refused anyway. It IS improving (45 of 61 = 73.8% on 2026-09-11 before
#290; 51 of 94 = 54.3% now) and it is not closed.

---

## BUG A — we throw the date of birth away on purpose (24 calls)

Two lines, in two files.

`src/services/scheduleLookupService.ts:941` and `:976` — the person-base rung:

```ts
identityUnconfirmed: matchedBy === 'phone',
```

`src/tools/sharedPatientTools.ts:401` — the carry:

```ts
...(resolved.identityUnconfirmed ? {} : { dateOfBirth: resolved.patientData?.dateOfBirth }),
```

So a caller-ID match through the **person base** stores the name, stores
`certain: false`, and **deliberately does not store the date of birth**.
`verifiedDobFor` then answers `undefined` and the gate refuses.

**This was written on purpose and the reasoning is sound in isolation** — it is
the Codex P1 on `1d775a4`: a phone number is a candidate to confirm, not an
identity, so it must not auto-fill a birthday onto a ticket. Standing
instruction 6 and RULE ZERO step 2 both say the same thing.

**IT IS NOT A REGRESSION.** Before the person-base rung (v10) existed these
calls reached `emptyContext()` and found nobody at all, so nothing was taken
away. It is an unfinished feature, not a break.

### The hole: the caller's confirmation is never recorded

The greeting has **already asked** "Am I speaking with <name>?" and the caller
has **already answered**. That answer is the validation RULE ZERO step 2
requires — the thing that turns a candidate into a match. **Nothing in the code
ever reads it.** There is no path from the caller saying "yes" to
`rememberVerifiedIdentity` being called again with `certain: true`.

So the record sits one confirmed word away from being usable and never gets
promoted. That is the clamp Wayne has been describing and it does not exist.

**What counts as confirmation is a PROCEDURAL question and is the operator's**
(standing instruction 1). Do not invent it. The candidates, for him to rule on:

- the caller answers the greeting affirmatively;
- the caller states a name matching the record;
- the model calls a tool saying so (a `confirm_identity` tool exists nowhere
  today);
- nothing — a phone match is never enough, and the correct fix is instead to
  ASK for the date of birth once, early, in the funnel (RULE ZERO 2b).

The last of those is a real option and should not be dismissed: it needs no
new identity machinery at all.

---

## BUG B — we stored it and the read refused anyway (32 calls)

These reported `identity_is_certain: true`, which means `identityUnconfirmed`
was false, which means line 401 **did** store
`resolved.patientData?.dateOfBirth`. And the filing tool still refused.

Two candidates were tested and **both are dead**:

| candidate | test | result |
|---|---|---|
| the matched record has no date of birth | `Schedule."PatientDateOfBirth"`, 1% TABLESAMPLE | **0 null, 0 blank of 10,438 — 100% populated** |
| a later ambiguous lookup cleared the entry (`forgetIfSameName`) | count lookups per call | **30 of 32 had only certain lookups; at most 2 explained** |

**That leaves ONE surviving hypothesis: the read guard.**

`src/tools/verifiedIdentity.ts` — `verifiedDobFor`:

```ts
if (norm(firstName) !== norm(entry.firstName) || norm(lastName) !== norm(entry.lastName)) {
  return undefined;
}
```

`entry.firstName` / `entry.lastName` come from the **record**.
`firstName` / `lastName` are the **model's tool arguments**. They must match
exactly (case- and whitespace-insensitively, nothing more).

A model that omits `date_of_birth` on 93 of 93 attempts is not one to trust
with a verbatim surname. Any of these opens the jaw: a nickname for a legal
name, a transcribed spelling, a hyphenated or two-part surname split
differently, a missing `last_name` argument, a maiden name (2.4% of person_ids
are spelled more than one way across their own rows — CLAUDE.md).

**NOT PROVEN, and it cannot be proven from what is persisted today.** The
timeline records neither the model's name arguments nor whether the carry
fired. That is the instrument gap below. It is the only candidate left
standing, not a measurement.

---

## THE `name_and_dob` FIVE

Five calls matched by **name AND date of birth** — the caller gave a birthday,
the lookup used it to find them — and the filing tool then refused for want of
a date of birth. Whatever the cause, any fix has to close this: the field was
on the call, in the model's hands, used successfully by another tool.

---

## THE INSTRUMENT GAP — this is what to build first

`dobShape` was built to answer "did the model send it, or did the parser refuse
it?" and it did. It now answers `(none)` every time and **the trail stops
there.** Nothing records:

- whether `verifiedDobFor` was consulted;
- whether an entry existed for the call;
- whether it held a date of birth;
- whether the name guard rejected it, and on which side.

One PHI-free enum on the refusal event settles Bug B in a day of traffic:

```
carry: 'fired' | 'no_entry' | 'entry_without_dob' | 'name_mismatch' | 'bad_call_sid'
```

`name_mismatch` is the discriminating value. If it dominates, the fix is at the
read guard. If `entry_without_dob` dominates, Bug A is wider than measured and
something else is dropping the field too.

**Build the instrument before the fix.** CLAUDE.md failure mode 8: *before
quoting a rate, find the control that proves the measure.* Every fix below Bug
A is currently a guess.

---

## WHAT IS NOT ESTABLISHED

Stated plainly so nobody promotes it by repetition:

- **Why the model omits `date_of_birth`.** 93 of 93, unchanged since 09-08.
  The field is in the schema with a description telling it to send it,
  deliberately absent from `required`, and `strict: false`. The `fix` channel
  demonstrably reaches the model. Cause unknown.
- **Whether the name guard is actually firing.** Sole surviving hypothesis for
  Bug B, zero direct evidence.
- **The 28 "no `matched_by`" calls.** Not investigated.
- **Which table `sage_precontext` reads.** Still unsettled (CLAUDE.md), and it
  matters here because `matchedRecord` reads `dobOnFile` from that payload and
  nothing verifies the service sends it. 299 of 309 recognised greetings name
  ONE token (a first name), which is *consistent with* a payload carrying no
  `lastNameOnFile` — and `rememberVerifiedIdentity` stores NOTHING without both
  names. That is suggestive and no more: the prompt may simply be telling the
  agent to use a first name. **Not tested.**

---

## BEFORE-NUMBERS, for `docs/BACKEND_HANDOFF.md`

Any fix here is a ticket-path change. 2026-09-14, runtime lanes:

| | |
|---|---|
| substantive runtime calls | 644 |
| date-of-birth refusals | **94 (14.6%)** |
| … on a caller already addressed from their record | **51** |
| … that filed anyway | 33 |
| **… that ended with NO ticket** | **61** |
| `dobShape = (none)` share of recorded events | **93 of 93** |

The guard: tickets filed with a date of birth that is not the patient's must
not appear. A carry that fills the wrong birthday is worse than a gate that
refuses, and the name guard — whatever else it is doing — is the only thing
standing between the two today.
