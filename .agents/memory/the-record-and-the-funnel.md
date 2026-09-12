# The record and the funnel — RULE ZERO

**Wayne, 2026-09-12. Binding. Supersedes every other document in this repo and
every prompt.** `CLAUDE.md` opens with the short form; this is the working
detail. If anything anywhere contradicts these two rules, the other thing is
wrong.

> *"This has to be binding. Like, this is my fucking rule. You don't go against
> this rule. This must be done, like, ironclad. Like, do not break. Forbidden."*

---

## Rule 1 — if we have a match, the joined record IS the record

> *"We always always use — we always match on patient pre-context if we get a
> match, right, on patient master. We validate. We go to join. That's our
> record. That's the entire record. That solves every fucking problem that
> we've had, every single one that we've been having. Wrong date of birth,
> wrong this, wrong that. No location, no surgeon, no this, no that. That
> solves every single thing. You have a complete record of the patient. It's so
> much easier to find."*

**MATCH → VALIDATE → JOIN → CARRY.** No branch in it.

| step | what it means | where it lives |
|---|---|---|
| MATCH | caller-ID pre-context against `patients_master`, every call, every lane, first | `patientVerification.findByPhone`; runtime pre-context via `sage_precontext` |
| VALIDATE | a phone number is a candidate to CONFIRM, never an identity — several people share one and we never pick | `verifyPatient` / `findByPhone` report `ambiguous` + a count |
| JOIN | `Schedule."PersonID" = person_id::uuid` the moment a match is established | `ScheduleLookupService.lookupByPersonId`, `byPerson()` |
| CARRY | forward for the rest of the call, into every tool, onto the ticket | **the open gap — see below** |

**The joined record is the SOURCE OF TRUTH for that call.** Where it disagrees
with a model argument, a transcript guess, a CNAM lookup or a parser, the
record wins.

### What Rule 1 forbids once the record is in hand

- **Asking for the date of birth.** We have it.
- **Refusing to file for a missing `date_of_birth` / `location` / `surgeon` /
  office.** We have them. A gate refusing on a field the record holds is a bug
  in the gate, not a missing answer from the caller.
- **Looking anybody up by name or phone STRINGS** when we hold their
  `person_id`.
- **Treating the appointment book as the person base.** `patients_master` says
  who somebody is. `Schedule` says what happened to them. Two tables, one key.

### Why he is confident it dissolves the gate losses

Every large loss in `CLAUDE.md` is a field the record already holds — 75
date-of-birth refusals in a day, 21 optical `location`, 14 surgery `surgeon`.
The join is not a fix for each of them; it removes the question. Measured
2026-09-12 on the 64 callers the book had just reported no record of:

| | |
|---|---|
| **have a full record on the join** | **52 (81%)** |
| have an office on file | 51, across 27 offices |
| have an appointment already booked | 19 |

The book was not missing their appointments. It searches by phone and name
strings, and those drift — including against themselves: 2.4% of multi-row
`person_id`s spell their own owner more than one way across their own rows.

---

## Rule 2 — when we cannot find them, funnel the caller into the answer

> *"To solve the edge cases is not so much about the coding. You can't solve for
> every single edge case, because you can't anticipate what the caller is gonna
> say — unless you guide the caller into what to say."*

This is the standing answer to every "the model sent nothing / the parser
refused the shape" defect in this repo. **Stop parsing whatever arrives; ask
the question that produces the shape you need.**

### 2a — new or existing, asked FIRST, closing the branch

> *"Are you a new patient or an existing patient? I'm a new patient — now I know
> I don't need to look for you anymore. Now I know you're not gonna be there.
> I'm not gonna need to find appointments. I'm an existing patient — now I know
> I need to find you."*

| answer | what it settles |
|---|---|
| **new** | **Stop looking.** No lookup, no appointment search, no "we have no record of you." A miss is EXPECTED — not a failure to report, retry or gate on. |
| **existing** | **Find them, and keep going until you do.** A miss is a real problem, and 2b is how it gets solved. |

One question removes a whole population from the found-nobody bucket, and
turns the rest into a bucket where a miss actually means something.

**Do not ask it when Rule 1 already answered it.** A caller recognised from
their number is existing by definition; asking anyway tells them we do not know
who they are while we are looking at their chart. `callFactsLedger.ts:138`
already says this and it stays true.

### 2b — one field per question, format named inside the question

> *"If I need date of birth, I'm not gonna say 'name, date of birth'. No. I'm
> gonna say: what's your first and last name? … Now your date of birth, starting
> with the month, the day, and then the year."*

```
"What's your first and last name?"
"And your date of birth, starting with the month, then the day, then the year."
```

Never two fields in one breath. The format goes INSIDE the question, so the
answer arrives already in it.

This is also why the DOB parser kept refusing real answers (`0 1 0 4 58`,
`Cero tres veintidos del cincuenta`). Widening the parser chases shapes
forever; naming the format in the question produces one shape.

### 2c — the general form, which is the whole point

> *"Everything else that we need, we create a funnel towards — in the
> questioning — towards that answer in the way that we need it. And then we
> carry that forward. That's it. That's everything in a nutshell."*

**For every field: shape the QUESTION so the answer arrives in the format the
field requires, then carry it forward so it is never asked twice.** Not a regex
over whatever came back. Not a fallback chain. The question.

Note how 2c meets standing instruction 3 — *"why are you trying to determine
what a first name is? You'll never get it to work like that"* — rather than
contradicting it. Extraction stays the model's job. What the funnel controls is
the INPUT the model is extracting from.

---

## Compliance, measured 2026-09-12 — a written rule is not a followed rule

| | state |
|---|---|
| 1 · match `patients_master` by phone | **PARTIAL** — `findByPhone` wired into `lookupPatient`'s LAST rung only (#292). Runtime pre-context reads `sage_precontext` over HTTP and **which table that hits is UNSETTLED**. 0 of 382 substantive calls on 2026-09-03 greeted anyone by name, either pipeline. |
| 1 · validate before trusting | **YES** — both readers refuse to choose between two people. |
| 1 · join on `PersonID` | **BUILT, NOT DEPLOYED** — `lookupByPersonId` (#292); index `idx_schedule_personid_apptdate` is live in the Hub. |
| 1 · **carry forward into every tool and ticket** | **NO — the largest open gap.** The gates still refuse on `date_of_birth`, `location` and `surgeon` for callers whose record holds all three. |
| 2a · ask new-or-existing | **MISSING FROM EVERY QUEUE LANE.** Zero hits in `opticalAgent`, `surgeryAgent`, `techAgent`, `recordsAgent`. It exists as `rampEngine.ts:60` (`classify: 'Are you calling for a new patient or an existing patient?'`) and `rampEngine` is imported by exactly ONE file — `voiceAgentRoutes.ts`, the OLD CORE. The runtime lanes take the volume and do not ask it. **Wayne asked whether we still had it. We do not, where it counts.** |
| 2b · DOB in month/day/year parts | **YES, all four lanes** — `opticalAgent.ts:193`, `surgeryAgent.ts:203`, `techAgent.ts:189`, `recordsAgent.ts:192`, plus no-ivr and answering-service. |
| 2b · never two fields in one breath | **NO** — records asked for first and last name in one breath, 2026-09-03. |

**Do not report any row of this table from memory. Re-check it.** The 2a row
was established by grep, not assumption, precisely because the operator's own
recollection ("we had it before, I don't know if we have it now") turned out to
be right in a way nobody had verified.

---

## How this interacts with the rest of the rulebook

- **Instruction 6** (verify against the mirror, carry the match forward,
  associate it on the ticket) is Rule 1 stated earlier and less completely.
  Rule 1 is the binding form.
- **Instruction 14** (one source of truth, the Console) is Rule 1's first step.
  Rule 1 adds what happens AFTER the match: validate, join, carry.
- **Instruction 12** (confirm the callback number BEFORE filing) is Rule 2c
  applied to one field.
- **`docs/BACKEND_HANDOFF.md`** still applies to every ticket-path change made
  in service of these rules. Rule Zero says what to build; it does not license
  merging without the before-and-after production number.
