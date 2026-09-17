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
**`[-]` WRITTEN, THEN REVERTED. Read why — it is the most important entry here.**

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
**`[x]` THE WORST LANE IS FIXED — v41, `noIvrAgent.ts` + `noIvrDobEscape.test.ts`.
`[~]` the runtime lanes' SPEECH re-asks are still open (see the W2 section below).**

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
**`[x]` SHIPPED as v39. 7 assertions, 5 mutations, 5 caught.**

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
**`[x]` (a) SHIPPED as v42 — diagnosed from the timeline, not the note; 7 mutations, 7 caught.
`[x]` (b) SHIPPED as v40 — 7 assertions, 4 mutations, 4 caught.
`[x]` the narrated emergency rule (below) SHIPPED as v43 — 5 mutations, 5 caught.
`[ ]` (c) remains, and it is last.**

**(a) The SUCCESS branch speaks the failure line — and it was not the success
branch.** `11e362485f`, no-ivr: the model fired `create_ticket` TWICE,
overlapping. Attempt A (9.3s) filed VA-60434; attempt B lost the per-call lock,
waited a fixed 3s, found no ticket number written back yet, and returned
"Concurrent ticket creation in progress" 0.4s BEFORE A's success. The handler
mapped that to the "technical issue… end the call" apology. **`7074e29c0c` is
the same shape by a different road, and my note on it was WRONG:** the client
timed out at 15s while the server finished the insert — VA-60429 exists;
`call_logs.ticket_number` is NULL only because write-back runs on a success the
client sees. Corrected on disk. Fix: the duplicate now polls for the in-flight
attempt's number (10s, not 3s); a contention refusal that survives says "wait,
nothing failed"; a timeout is retried once against the app's idempotency key.
**(b) An empty value spoken.** *"The number ending in ."* (pcp, three times in
one call) and *"the number ending in \"mous\""* (no-ivr, `8d536d6646`).
**(c) A wrong identifier read aloud then corrected** — 7 of 305 calls that spoke
a number. Lower value than I first said; it is last.

---

### W5 — Ticketing app: the name-only consolidation arm.
**`[x]` BUILT AND PUSHED on the ticketing-app branch (`11db8480`); 25 tests green
there, type-check unchanged (22 pre-existing errors, identical with the change
stashed); PR opens when GitHub's rate limit lifts. See decision 2 below.**

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

## FOR 5AM — ONE INSTRUCTION

**Pull and republish. Then merge the ticketing-app branch.**

The ticketing-app half is commit `11db8480` on its `claude/determined-brown-o5qsft`
branch (the name-only consolidation arm, W5). GitHub's API was rate-limited all
night, so if no PR exists for that branch when you read this, open one from it —
the commit message is the PR body.

The deployment is running a build older than v37. Everything below is already
merged or is in PR #321 waiting for you.

### What the republish turns on

| | what it does | what it is worth |
|---|---|---|
| **v37** | the PCP intake stops asking for a title and an email BEFORE filing | **31 lost PCP requests on 2026-09-16 — the single biggest killer in the fleet** |
| **v38** | a tool call is persisted when it finishes, not by a 2h in-memory reaper | PCP's `tool_call_count` was NULL on 90.9% of calls; nothing could be measured |
| **v39** (PR #321) | the four queue lanes say the call is recorded | **401 calls/day recorded with no disclosure, in a two-party-consent state** |
| **v40** (PR #321) | no more *"the number ending in ."* or *"ending in \"mous\""* | 6 call sites |
| **v41** (PR #321) | the after-hours line asks for a date of birth ONCE, then files with it marked unavailable/unmatched | no-ivr asked 3+ times on 11 calls on 2026-09-16, one of them FIFTEEN times |
| **v42** (PR #321) | a filed ticket is never spoken as a failure — a duplicate attempt waits for the real one, a timeout is retried once | 2 callers on 2026-09-16 told *"technical issue"* while their ticket sat in the queue |
| **v43** (PR #321) | the surgery agent stops reading its own emergency rule aloud | *"These are the words we treat as a surgical emergency"* — spoken to a patient |

### How to check the republish actually took, in ten seconds

Do not take my word or yours for it — the marker and the behaviour both say so.

```
GET /voice/health   ->   voice-runtime-v43-the-tool-does-not-narrate-its-rule-20260917
```

and, from the database, the v37 signature disappearing from live traffic:

```sql
-- If v37 is live this goes to ~0 on pcp.
SELECT to_char(created_at AT TIME ZONE 'UTC','MM-DD HH24') AS hr,
       count(*) FILTER (WHERE duration>=30) AS subst,
       count(*) FILTER (WHERE duration>=30 AND transcript ILIKE '%email address%') AS email_ask
FROM call_logs WHERE agent_used='pcp' AND created_at >= now() - interval '12 hours'
GROUP BY 1 ORDER BY 1;
```

**This is the check I should have run yesterday before telling you to
republish.** It is why I could tell you tonight that v37 merged at 18:51 UTC and
still never served a call.

---

## THE DECISIONS — TWO OF THREE WERE SETTLED BY EVIDENCE OVERNIGHT

You said not to wait. Where the evidence answered the question, I did not.
Only decision 3 is still yours. Nothing here blocks the republish.

**1. The date-of-birth loop on the after-hours line — SETTLED BY THE LOGS,
SHIPPED as v41.** The worry was that the after-hours ticket API might reject a
payload with no date of birth. `voice_agent_api_logs`, 14 days: **347 of 347
accepted no-ivr POSTs carried a `patientDOB`, the B2B path already sends the
literal `'Unknown'`, and the 10 rejections were for `patientFullName` and
`surgeon` — never the date.** So no-ivr's `create_ticket` now asks once and
files with the date marked UNAVAILABLE/UNMATCHED, the queue lanes' 2026-09-04
escape. Red-then-green on the real agent; 6 mutations, 5 caught, the sixth the
console marker by design. Nothing was invented: the placeholder is a value the
API has accepted on every POST.

**2. Ticket consolidation outside PCP — BUILT AND PUSHED to the ticketing-app
branch (`11db8480`), PR pending GitHub's rate limit.** The name arm has no
phone in it at all, so it is the same defect on every lane your PCP ruling
named. Measured first: **30 consolidations in 30 days on the patient lanes
where the phone did NOT match the parent — tech 12, surgery 11, optical 5,
records 2** — the name arm alone did them, about 6% of consolidations. Removed
from all three copies (the live filing path, the preview API, the admin
collapse) with a test that reads all three so it cannot return in one. **The
phone arm is untouched.** Cost: a patient ringing back from a different number
within a day gets a second ticket instead of a note on the first — ten seconds
for a staffer, against a cross-patient merge that mixes two people's PHI.

**3. The emergency word list.** One surgery call said "detached retina" inside
an ordinary scheduling question and got a 911 warning. Another described
post-op flashes and a halo — the classic warning sign — and got nothing.
**Which way do you want it to err?** Purely clinical, so it is yours. The
half that is mine — the agent reading its own rule out loud — is already on the
list to fix.

---

## WHAT I DID NOT DO, AND WHY — read this before anything else

**I wrote a fix for the date-of-birth carry, then reverted it.** It would have
kept a patient's date of birth after the lookup came back ambiguous about a
shared name. A test was already pinning that behaviour, with its reason written
out, and it is the same wrong-date-of-birth hazard three separate builds name as
their guard. I also could not measure how many calls it would actually help,
because the two branches are indistinguishable in the data we record.

Trading a known hazard for an unmeasurable gain is the thing you told me to
stop doing. So it is not in the PR — the reasoning is under W1 above, along with
the one-line telemetry change that would make it answerable with data instead of
an argument.


---

# WHAT HAPPENED, ITEM BY ITEM

## W0 `[x]` — `npm test` could not be trusted, so nothing else could be

No vitest config existed, so a bare run collected the compiled suite under
`dist/`: **36 files, 113 tests, all failing with ENOENT** on paths that only
exist in `src/`. The cost was not the red — it was that the red meant nothing.
With `dist` excluded: **232 files / 4,454 tests, all green.** That is the
baseline every number below is measured against.

An earlier draft of the config also pinned `include` and silently dropped 17
files / 226 tests under `server/` and `client/` — the same failure pointed the
other way. Only `exclude` is set.

## W1 `[-]` — I wrote the fix, then reverted it. This is the entry to read.

`carry = no_entry` on 55 of 61 date-of-birth refusals means `verifiedIdentity`
held nothing for the call, and on 33 of those `lookup_patient` HAD matched
somebody. Tracing it found the mechanism: on an ambiguous same-name lookup,
`sharedPatientTools.ts:425` calls `forgetIfSameName`, which **deletes the whole
entry** — including a date of birth pre-context had already written.

I changed it to DEMOTE (`certain: false`) instead of delete. Both readers that
can do damage gate on `certain`; the DOB readers deliberately do not. It looked
right, the suite went green but for one test — and that test was the point:

> *"the date of birth goes with it: the name guard cannot separate people who
> share a name, which is exactly the case that got here."*

**That is the wrong-DOB hazard v26, v27 and v28 each name as their guard**, and
an ambiguous lookup is genuine contrary evidence about identity. Then the
decisive fact: the subagent trace established that the ambiguous branch and the
plain not-found branch are **byte-identical in `tool_timeline`** — so I cannot
measure how many of those 33 calls are actually this branch.

Shipping a safety-relevant change on an unmeasurable population is the exact
thing this operation is trying to stop doing. Reverted.

**What would settle it:** `toolTimeline`'s outcome allow-list carries
`matched_by` and `identity_is_certain` but not `candidate_count` or `found`.
Adding `found` makes the two branches separable, and then this is answerable
with a day of data rather than an argument.

## W2 `[x]` on no-ivr (v41) · `[~]` on the runtime lanes

**SHIPPED, 02:20 UTC:** no-ivr's `create_ticket` now calls `decideDobEscape`,
keyed on the call SID — asks once, then files with `patientDOB: 'Unknown'` and
`DATE OF BIRTH UNAVAILABLE/UNMATCHED` in `additionalDetails` (NOT at the head
of `reasonForCalling`, because the `Request Type:` header must stay the first
line). The secondary name+DOB lookup is skipped on the escape path so a partial
parse cannot feed it. Red-then-green offline on the real agent; 6 mutations,
5 caught, the sixth the console marker by design. **The blocker below was
settled by `voice_agent_api_logs`, not by a ruling:** 347 of 347 accepted
no-ivr POSTs carried a `patientDOB`, the B2B path already sends `'Unknown'`,
and the 10 rejections in 14 days were `patientFullName`/`surgeon` — never the
date. So the placeholder is a value the API has accepted all along.

**What it does not fix:** the 18 surgery / 18 tech / 7 optical re-asks happen
in SPEECH (the tool path there is already bounded), and no runtime lane has an
ask counter. That needs a runtime-owned counter over `classifyAsk` — the
`conversationLoopGuard` shape, but BINDING (a tool result the model must
answer, not a nudge). Not built tonight: it is a new runtime component on the
lanes carrying the day volume and needs its own before/after.

The recon that led here, kept because it is what makes the above safe:

- `conversationLoopGuard` already counts asks per topic per call and uses
  `classifyAsk` — **the same function the grader used to produce the 73 / 30 /
  15 figures.** It is the only pipeline-agnostic counter in the repo.
- It is wired on the OLD CORE ONLY. **Nothing under `src/runtime/` imports it**,
  so the four queue lanes and pcp have no ask counter at all.
- It did not stop the 15-ask call because **it only injects a system message**,
  and `src/director/director.ts:11-13` records exactly that: *"The existing
  conversationLoopGuard DID fire its directive on the third ask. The model
  ignored it and asked four more times."* Each intervention also fires at most
  once per topic per call, so a call gets one nudge at 3, one at 5, and nothing
  at 6…15.
- The escalating layer that would BIND (`inject` → `author` → `force_exit`)
  exists and is dark: `.replit:87` sets `DIRECTOR_AGENTS = ""`.
- On the queue lanes the TOOL path is already bounded — `decideDobEscape`
  allows exactly one re-ask per (call, tool). **So those 18 surgery / 18 tech /
  7 optical re-asks are happening in SPEECH, not through a tool**, which is why
  no tool-side counter sees them.
- `decideDobEscape` IS unbounded in one case: a sentinel or missing CallSid
  makes `gateRefusalsSoFar` return 0 forever, so it answers `askAgain: true`
  every time. That is CLAUDE.md's open "11 of 72 optical calls never reached the
  CallSid-keyed escape".
- no-ivr — the worst lane, 19 of 20 — is on the old core and its `create_ticket`
  is hand-built: `noIvrAgent.ts:1148-1154` returns a date-of-birth validation
  failure with **no counter, no key and no escape**, so it can return it on
  every invocation for the life of the call. That is the 15-ask loop.

**The worry that held it overnight — that the after-hours ticket API might
reject a DOB-less payload, the 2026-09-14 shape pointed at the busiest
overnight lane — is answered above by the API's own logs, and the fix shipped.**

## W3 `[x]` and W4(b) `[x]` — shipped, see PR #321

## W5 `[x]` — the name-only arm is gone from all three copies in the ticketing app

`lib/services/ticket-consolidation.ts` (live filing), `app/api/tickets/check-duplicate/route.ts`
(preview) and `lib/services/retroactive-consolidation.ts` (admin collapse) each
carried it; the admin pair predicate is now `ticketsAreTheSameRequest`, pure and
tested. `consolidation-matches-on-phone-only.test.ts` reads all three sources.
The measurement and the cost are under decision 2 above.

---

# THE PER-LANE DEATH MAP (S-03), which I did instead of forcing a third fix

**The question that produced every PCP win — "where did the call die, by LAST
QUESTION ASKED" — had never been asked of the other five lanes.** Now it has.
Calls with no ticket, caller spoke at least twice, 2026-09-16:

| lane | died on | calls |
|---|---|---|
| **pcp** | **email** | **31** |
| pcp | other · date of birth · opening | 22 · 4 · 2 |
| **surgery** | **date of birth** | **12** |
| surgery | surgeon · other · opening · last name | 5 · 5 · 4 · 3 |
| **tech** | other | 10 |
| tech | **date of birth** | **9** |
| tech | last name · closing | 3 · 2 |
| **optical** | **which office** | **6** |
| optical | date of birth · last name | 5 · 2 |
| **no-ivr** | **which office** | **6** |
| records | other · date of birth | 4 · 2 |

**Read across it and the fleet has four killers, not twenty:**

| | calls |
|---|---|
| the pcp email question | **31 — already fixed by v37, merged, never deployed** |
| date of birth | **32**, across five lanes |
| which office | **12**, optical and no-ivr |
| last name | 8 |
| surgeon | 5 |

So after the republish lands v37, **the single biggest remaining killer in the
fleet is the date-of-birth ask, at 32 calls across five lanes** — and W2 above
is the reason it keeps happening. That is the ranked work list for tomorrow,
derived from the calls rather than from a category.
