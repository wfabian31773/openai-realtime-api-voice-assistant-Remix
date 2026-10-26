# THE DATE-OF-BIRTH CARRY

Diagnosis is PR #307 (2026-09-15, over 2026-09-14). The instrument was
#308 / v25. **Wayne rejected instrument-only** — the professional line
cannot leave ticket-create failing (agent says filed, staff never sees
it) for 100–200 calls. #308 does not fix tickets. The fix is v26.

---

## WHAT SHIPPED (v26)

Marker: `voice-runtime-v26-chart-dob-inherit-20260915`.

1. **Bug A — stop-erase.** `rememberVerifiedIdentity` **merges** when it
   is the same person. Empty must not overwrite a full date of birth
   already stored. Same person = both `personId`s exist and agree, OR we
   cannot prove by id and the names agree. Different `personId` replaces
   the whole row (father then son). Certainty never downgrades.
2. **Person-base write no longer strips the date.** A unique
   `identityUnconfirmed` hit that returned a chart date stores it.
   `certain` stays `false`. We do not invent a date.
3. **Inherit on file.** Already the path: model argument →
   `verifiedDobFor` (name match, **not** `certain: true`) → spoken →
   escape. When first+last match, chart `patientBirthMonth` / `Day` /
   `Year` go on the create payload even if the model omitted
   `date_of_birth`. Ticketing already accepts omitted birth fields; we
   do **not** require DOB on create-ticket.
4. **Bug B — name guard.** `nameKey` (NFD, strip marks, hyphen /
   apostrophe / period → space) is the shared comparison for
   `verifiedDobFor`, `dobCarry`, `usualOfficeFor`, `forgetIfSameName`,
   and the merge. `Garcia-Lopez` / `Garcia Lopez` and `José` / `Jose`
   inherit. **Residual, not guessed:** nicknames (Bill/William),
   maiden-vs-married surnames, fully different transcriptions. Those
   still read `carry: name_mismatch` after deploy.
5. **`carry` enum** from #308 rides along. Telemetry with the fix, not
   instead of it.

**Do not promote `certain: false` → `true`.** The name guard is the
confirmation. A caller who says "no, that's my father" is not filed
under that name.

---

# WHY THE DATE-OF-BIRTH GATE STILL FIRES ON A RECORD WE ARE HOLDING

**Measured 2026-09-15 over 2026-09-14, the first full weekday with all seven
lanes live. Diagnosis — the mechanism below is what v26 changes.** Wayne asked
the question this file answers: *"how is it possible that we're passing null on
date of birth when we're locked on to a verified patient record?"*

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

## BUG A — the person-base lookup ERASES the date pre-context stored (24 calls)

**Found by Cursor (SPEC, 2026-09-15). I had this as a passive omission and it
is an active erasure — the stronger and more damning version.** Three links:

`src/services/scheduleLookupService.ts:941` and `:976` — the person-base rung
flags a caller-ID hit:

```ts
identityUnconfirmed: matchedBy === 'phone',
```

`src/tools/sharedPatientTools.ts` — the carry then stripped the date
(removed in v26):

```ts
...(resolved.identityUnconfirmed ? {} : { dateOfBirth: resolved.patientData?.dateOfBirth }),
```

`src/tools/verifiedIdentity.ts` — and the downgrade guard did not protect the
entry v11 already wrote (replaced by a merge in v26):

```ts
if (existing && existing.certain && !certain && provablySamePerson && ...) return;
verified.delete(callSid);
verified.set(callSid, { ... });
```

**`existing.certain` must be TRUE for the guard to fire, and v11's pre-context
write is `certain: false` with no `personId`.** So the guard never fired, the
entry was deleted and replaced, and the replacement carried no date of birth.

Sequence on a real call:

1. Pre-context matches → `rememberVerifiedIdentity` stores name + `dobOnFile`,
   `certain: false`, no `personId`. **The date is in the map.**
2. `lookup_patient` runs, the appointment book misses, the person-base rung
   hits on phone → `identityUnconfirmed: true` → the strip drops the date →
   `rememberVerifiedIdentity` with name + `personId`, no date.
3. The guard sees `existing.certain === false`, declines to protect, and
   replaces. **The date is gone.**
4. `file_*_ticket` asks `verifiedDobFor` and gets `undefined`. The gate refuses
   for a field the process held ninety seconds earlier.

**THE CODE COMMENT BESIDE THE STRIP WAS FALSE after v11.** It read: *"It
declines to add an unsafe shortcut; it does not take a working one away."*
That was true when written — the person-base rung was new, and those callers
previously reached `emptyContext()`. **Once v11 landed, there WAS a working
one to take away, and this took it.** Two PRs, each correct alone, wrong
together.

This is the exact population RULE ZERO exists for: phone match on
`patients_master`, appointment-book miss, join holds the whole record.

Cursor's position, which shipped: don't promote at all — the name guard on
`verifiedDobFor` IS the confirmation, because a caller who says "no, that's
my father" is not filed under that name. Bug A's fix is **stop erasing**,
not **start promoting**.

---

## BUG B — we stored it and the read refused anyway (32 calls)

**THE ERASURE ABOVE DOES NOT EXPLAIN THESE.** These 32 reported
`identity_is_certain: true`, which means `identityUnconfirmed` was false,
which means they came from the APPOINTMENT BOOK rung, where the date **was**
stored. 18 of the 32 ran exactly one lookup and it was certain; only 2 ever
saw an uncertain one. So the date was in the map at filing time and the read
still refused.

The surviving hypothesis is the read guard: exact first+last after trim +
case-fold. A hyphenated surname, an accent, a curly apostrophe would miss.

**v26's safe read-path fix:** `nameKey` — NFD + strip combining marks,
hyphen / apostrophe / period → space. That is the SPEC's own example
(`Garcia-Lopez` vs `Garcia Lopez`) and the 2.4% self-disagreement on
`person_id` rows. Father/son with different first names still fail.

**Residual after v26, not guessed:** nicknames, maiden vs married surnames,
fully different transcriptions. `carry: name_mismatch` still measures that
residue. Do not loosen the guard to first-name-only.

The `name_and_dob` five (matched using a birthday, then refused for it) are
a separate miss if the model then files under a different spelling; inherit
closes them only when the ticket name matches the stored name.

---

## THE INSTRUMENT (folded into v26)

`outcome.carry` on a `date_of_birth` refusal:

```
carry: 'fired' | 'no_entry' | 'entry_without_dob' | 'name_mismatch' | 'bad_call_sid'
```

Wayne overrode "build the instrument before the fix." The enum ships **with**
the fix so a day of traffic can still split residual Bug B from everything
else. #308 alone is not the next ship.

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
