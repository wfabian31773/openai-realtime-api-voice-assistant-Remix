# THE WORKSHEET — night of 2026-09-16 into 2026-09-17

**Operator, 2026-09-17:** *"create a worksheet that you need to trickle down and
do all of the work... I wanna wake up in the morning and be super confident that
all I need to do is either pull this or merge that... don't skip anything, don't
miss anything, create like a checklist and I want to see that everything is
checked off."*

**Every item ships with a test that goes RED without the fix.** Standing
instruction 8. No item is ticked on the strength of reading the code.

**Status key:** `[ ]` not started · `[~]` in progress · `[x]` done, test green,
mutation-checked · `[!]` blocked, reason stated · `[-]` deliberately not doing,
reason stated.

---

## THE RULING THAT CAME IN TONIGHT, APPLIED TO EVERYTHING BELOW

**"No name, no ticket" STANDS.** Operator, 2026-09-17: *"how do you action a
ticket that doesn't have a name or information... if a person doesn't want to
take the time to sit on the phone and generate the ticket then that's on them...
if they hang up, what are you going to generate a ticket about?"*

So: **a caller who volunteers nothing and hangs up is not a defect and is not on
this worksheet.** The recommendation to file placeholder-name tickets is
withdrawn and will not be raised again. What IS a defect is narrower and is what
this worksheet contains: **something that was supposed to happen and did not.**

---

## THE WORK, IN ORDER

### W1 — The record is matched and never carried. RULE ZERO step 5.
**`[ ]`**

**Evidence, 2026-09-16, measured:** 61 date-of-birth refusal events.
`carry = "no_entry"` on **55** of them — `verifiedIdentity` held nothing for the
call. And on **33** of those calls `lookup_patient` had already MATCHED somebody
(`matched_by` set). So the match happened and the chart never reached the gate.

**Why every previous fix missed:** the ladder in `file_*_ticket` is model
argument → chart (`verifiedDobFor`) → transcript (`spokenDobFor`) → file-anyway
escape. All three fallbacks are merged and live. **They are all downstream of an
entry that was never written.** Patching the gate again is the wrong layer, and
is what we did on 09-14 and 09-15.

**This is RULE ZERO step 5 verbatim:** *"CARRY IT FORWARD AUTOMATICALLY, for the
rest of the call, into every tool and onto the ticket."*

**Fix:** to be written from the recon trace — the write must happen wherever the
match is established, not only on the narrow branch that currently does it.
**Test:** a match is made, no `date_of_birth` argument is sent, and the ticket
files carrying the chart date. Mutation: remove the write → red.
**Number:** `carry = no_entry` on refusals where `lookup_patient` matched — 33 on
2026-09-16, target 0.
**Guard:** tickets carrying a date of birth that is not the patient's must stay 0.

---

### W2 — Nothing stops a lane asking the same question over and over.
**`[ ]`**

**Evidence, 2026-09-16, measured in SQL:** the agent asked for a date of birth
**2+ times on 73 calls**, 3+ times on 30, and **25 of those left no ticket.**

| lane | asked 2+ | asked 3+ | worst | 2+ and no ticket |
|---|---|---|---|---|
| **no-ivr** | **19 of the 20 that asked at all** | 11 | **15** | 4 |
| surgery | 18 | 10 | 4 | 11 |
| tech | 18 | 4 | 3 | 5 |
| records | 10 | 3 | 4 | 1 |
| optical | 7 | 2 | 3 | 3 |
| pcp | 1 | 0 | 2 | 1 |

**The operator named this in his own words on 2026-09-16:** *"one that asks
somebody something seven times, like that shouldn't be possible, right?"* We
built the bound — `MAX_ASKS_PER_FIELD` in the PCP director, v33 — **and it is
PCP-only and not deployed.** The worst lane in the fleet is the one with no
director at all.

**Nothing existing can catch it:** `toolCeiling` counts FAILURES and every one
of these asks belongs to a SUCCEEDING tool call. `dobEscape` bounds the refusal,
not the question.

**Fix:** a per-field, per-call ask bound reachable by the four queue lanes and
no-ivr, not a second copy of the PCP one.
**Test:** the 15-ask call reproduced from its real shape, bounded at N.
**Number:** calls asking one field 3+ times — 30 on 2026-09-16, target 0.
**Guard:** tickets filed per substantive call must not FALL — a form that asks
less must not file less.

---

### W3 — 401 calls a day recorded with no disclosure.
**`[ ]`**

**Evidence:** of 667 substantive calls on 2026-09-16, the 401 on optical,
surgery, tech and records carried no recording disclosure. California is
two-party consent; this is a healthcare practice. Task #79, open since before
the cutover.

**The machinery already exists** and this is close to mechanical:
`MANDATORY_GREETING_COPY` (`greetingPersonalisation.ts`) has exactly two keys,
`pcp` and `no-ivr`; `MANDATED_COPY_LANES` is derived from it;
`compliantFallbackGreeting.ts` already fails a lane that has mandatory copy and
no compliant fallback.

**The clause is `noIvrAgent`'s, verbatim** — *"All calls are being recorded for
quality assurance purposes"* — operator-approved, already live on two lanes.
**Deliberately NOT copied:** the 911 sentence and "our offices are currently
closed"; those belong to the after-hours line, and adding a clinical-safety
instruction to a business-hours queue would be inventing a rule.

**Test:** the existing lane-table test, extended to the four lanes.
**Guard:** the token ceilings — the greeting grows, so any ratchet that goes red
gets read, not raised blindly.

---

### W4 — Three spoken lines that are false.
**`[ ]`**

**(a) The SUCCESS branch speaks the failure line.** `11e362485f`, no-ivr: the
ticket filed as VA-60434 and the agent said *"I'm sorry, I'm experiencing a
technical issue on my end right now."* The caller was 20 minutes late for an
8:00 appointment. On the other one, `7074e29c0c`, the filing genuinely failed
and nothing was recovered.
**(b) An empty value spoken.** *"The number ending in ."* (pcp, three times in
one call) and *"the number ending in \"mous\""* (no-ivr, `8d536d6646`).
**(c) A wrong identifier read aloud then corrected** — 7 of 305 calls that spoke
a number. Lower value than I first said; it is last.

---

### W5 — Ticketing app: the name-only consolidation arm.
**`[!]` different repo — confirm reachability before promising it**

13 tickets on 2026-09-16 outside PCP carried two or more unrelated callers.
The arm doing it matches on **first+last name, same department, 24 hours, with
no phone check at all.** PCP Support was exempted by #273; nothing else was.

---

## NOT DOING TONIGHT, AND WHY

- **`[-]` The emergency lexicon.** Which phrases count as a surgical emergency is
  a clinical decision and mine to leave alone. The half that needs no ruling —
  the agent narrating its own rule aloud — is folded into W4.
- **`[-]` Anything needing a production after-measurement.** v37 and v38 have
  never served a call (merged 18:51 and 20:16 UTC on 09-16; the v37 signature is
  still absent from live traffic at 23:00). Until a deploy lands, an
  after-number cannot exist.

---

## FOR 5AM

Filled in as items complete. One instruction, not a discussion.
