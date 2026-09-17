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
`[x]` the runtime lanes' re-asks — v50, `sharedPatientTools.ts` + `theSecondMissEndsTheIdentityAsk.test.ts`; 7 mutations, 7 caught (see the W2 section below).**

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
`[-]` (c) left by your rule on outliers — re-measured 04:48: 2 of 942 calls since 09-14 spoke two different ticket numbers (the earlier 7 of 305 counted callback numbers too). Under one percent either way.**

**Codex round 3 (04:42) on (b):** both ramp sites v40 changed set `CONFIRM_CALLBACK` before
checking whether the number could be spoken, so with *anonymous* in the ledger the ten
digits the caller then gave were parsed as a yes/no and dropped. An unspeakable number
now moves the ramp to `COLLECT_CALLBACK`; three behavioural tests on the real ramp; 2
mutations, 2 caught.

**Codex round 2 (04:07) on (a):** the P2 that the timeout/contention directives sit in
`message` is declined with a control — on this hand-built agent `message` is the
model-facing channel, and over 30 days / 1,338 substantive no-ivr calls the apology
branch's instruction text was read aloud 0 times while its quoted line was spoken 37.
The real half is fixed: the prompt's own rules said `api_timeout → apologise and
end`, contradicting the tool's *call once more* on the same result; the carve-out now
sits BEFORE the rule in both places the prompt describes a failed tool, asserted on
the built prompt by position. 3 mutations, 3 caught.

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
**Measured and left, by your rule on outliers:** the PCP line's *"I wasn't able
to look that up without a date of birth"* spoken while the lookup had just
succeeded — 1 of 598 substantive PCP calls over 09-14..16, improvised by the
model (the sentence is in no prompt or tool). Under one percent; not chased.

---

### W5 — Ticketing app: the name-only consolidation arm.
**`[x]` BUILT AND PUSHED on the ticketing-app branch (`11db8480`); 25 tests green
there, type-check unchanged (22 pre-existing errors, identical with the change
stashed); **PR #279 (draft)** — https://github.com/wfabian31773/ticketing-app/pull/279.
See decision 2 below.**

13 tickets on 2026-09-16 outside PCP carried two or more unrelated callers.
The arm doing it matches on **first+last name, same department, 24 hours, with
no phone check at all.** PCP Support was exempted by #273; nothing else was.

---

### W6 — The two backlog items he named at 03:00: clean logging in the Observatory, and the cost.
**`[x]` BOTH SHIPPED — v44 (logging) and v45 (cost), one PR. 16 mutations, 16 caught.**

**`[x]` AND A THIRD, FOUND AT 05:35 IN THE HUB'S POSTGRES LOGS — v52, the cost write
was rejected at PARSE for thirteen days.** `operator is not unique: unknown + unknown`,
3,749 times in 24 hours: the cost-preserving UPDATE from #268 (commit `8a226a6`,
2026-09-04) rendered its unreconciled total as `$4 + $5`, two untyped parameters,
which Postgres cannot add. Every per-call cost write carrying both components failed;
the reconciler's one-sided writes went through, which is why it looked partial.
`twilio_cost_cents` written on 544/544 completed calls on 09-01 → 104/502 on 09-04 →
175/808 on 09-16; **4,295 of 5,486 completed calls since 09-04 have no Twilio price**,
and every cost total on the Observatory since then is provider-only on 78% of calls.
The 5-minute Twilio-cost sweep fetched each price from Twilio and lost it to the same
error every cycle — that sweep is the 3,749. Fix: the bound values carry the column's
type (`typedCents`, `server/preservedCostSet.ts`); red on the live Hub with `PREPARE`
(two fresh params refused, `::integer` accepted, `WHERE false` executes nothing);
`preservedCostSet.test.ts` +4, 3 mutations, 3 caught. **The backfill is his call — see
the 5AM block.**

**Codex round 3 (04:42):** the round-1 recording fix had a race of its own — a call the
sync had already snapshotted when the URL landed was sent by neither side. The push now
sends the URL every time and never touches `callDataSynced`; the sync carries it again
and marks the call. `recordingPushIsPartial.test.ts`; 2 mutations, 2 caught.

**Codex round 2 (04:07):** a recording callback that lands before the call row exists
(a setup hangup, or a row open past its 2s deadline) was answered 200 and lost — Twilio
does not retry a 200. It is now parked by CallSid (`parkedRecordings.ts`) and the
teardown persist takes it onto the row, before the write and again after it. With
nothing parked the write never touches `recording_url`. `recordingBeatsTheRow.test.ts`,
8 tests; 6 mutations, 6 caught.

**Operator, 03:00 UTC, with his xAI usage export and a screenshot of xAI's own
call log:** *"I also need you to make sure we have clean logging in the
observatory, just like the xai sample I gave you. as well as the cost. those
are backlogged and I need those done."*

**Logging — measured first: `recording_url` NULL and `call_turns` EMPTY on all
4,564 runtime calls since the cutover.** The page already had the xAI shape
(conversation list, waveform player, per-turn transcript, Call / Raw events /
Evaluation tabs); the runtime simply never wrote a turn or started a recording.
Instrumentation, not a new page. v44: the bridge keeps the moment each line was
written and hands timed turns to `call_turns` after the sweep; a dual-channel
Twilio REST recording starts when the stream starts and posts to the old core's
recording-status handler, which now accepts a CallSid-keyed callback; the call
page puts each tool call at its START between the lines it ran between,
expandable. Nothing on a caller's path. Twilio recording ~$4/day at 1,500
runtime minutes — parity with the old core, not new policy.

**Cost — measured against his CSV: the reconciler is live and matches the
export on every runtime day but one.** 2026-09-12 allocated $37.43 onto ONE
104-second optical call and called it reconciled — the row is corrected, and
the guard that refuses that (`impliedRateIsImplausible`, already in the code
since 09-12) would refuse it today. What was missing was the RECORD: a refusal
lived in a console line. v45: `daily_grok_costs`, one row per day on every
outcome — xAI's voice total, the lines summed and ignored, booked vs estimate,
the refusal reason — served at `/api/analytics/grok-usage`, on the cost
dashboard as "xAI reported vs booked", and the call page's cost badge says
**reconciled** or **estimated**. The allocation itself is untouched.

**Tests:** `transcriptLog.turns` (5), `callRecording` (4), `recordingStatusTarget`
(6), `runtimeTurns` (6), `voiceRuntime` (+3, at the runtime — failure mode 10),
`client/src/lib/transcriptTimeline` (11), `grokDaySummary` (11).
**Numbers:** runtime calls with a recording — 0 of 4,564, target ~all; rows in
`daily_grok_costs` — 0, target one per day from the first nightly run.
**Guards:** filing rate per lane and barely-heard rate must not move; the
cost-preservation trio must still read 0 at the OpenAI rate.
**Codex round 1 (03:35 UTC), three P1s, all real, all taken and mutation-checked
(7/7):** the recording push no longer marks the call synced (it would have
starved every runtime ticket of its transcript and duration); the CallSid
recording callback now requires Twilio's signature; a failed rerun of the cost
reconciler can no longer overwrite a measured day row.

---

### W7 — A success loop is a loop (task #140).
**`[x]` SHIPPED as v46. 12 new assertions across the ceiling and the bridge; 10 mutations, 10 caught.**

**Measured first, every substantive runtime call since 09-10 (1,945):** the most
times one tool returned the SAME successful answer on one call is ≤4 on 97.6%,
5–9 on 30 calls (23 filed — legitimate retries), never 10, and **≥11 on 17
calls, 16 with no ticket** — `lookup_patient` ×35, `check_open_tickets` ×35,
`resolve_location` ×35, identical outcome every time. The ceiling counted
failures only, so it could not see one of them; your ruling that a loop is a
mistake is what settles the direction.

**Fix:** `identicalSuccesses: 10` — the eleventh identical call is not
dispatched and the model gets the tenth's answer back with `fix` telling it to
speak; `perToolSuccesses: 20` as the varied-arguments backstop, refusing with
the instruction and no spoken line; argument keys ignore case and spacing.
`record_pcp_intake`'s loops are v33's, untouched.
**Number:** calls where one tool succeeds 11+ times with the same arguments —
17 since 09-10, target 0. **Guard:** filing rate per lane must not fall; the
5–9 band must still file.

---

### W8 — The after-hours line reads a phone-matched patient's appointment to whoever is calling (S-08, task #142).
**`[x]` SHIPPED as v47. 10 tests on the real agent; 7 mutations, 7 caught.**

**Measured first, no-ivr over nine days (365 substantive calls):** the agent
read an appointment on 81, and on **44 of those it did so before any identity
question** — "I just wanna know my appointment" answered with the date, time,
office and doctor of whoever the schedule matched to the calling number. The
three calls I flagged on 09-16 are that shape; the prompt already said "disclose
nothing on the strength of this match" and "after identity confirmed", and the
details were sitting in the prompt anyway. A sentence in front of text the
model can see is not a gate.

**Fix:** on a phone match the prompt gets a redacted section — first name only,
"this is a candidate", and the way back: confirm the name, then date of birth,
then `lookup_schedule(first_name, last_name, date_of_birth)`, read it from the
tool result. And the tool's phone-only path now returns the candidate and no
details, so one tool call cannot fetch back what the prompt withheld. Phase 4's
own identity standard; no new rule. A name+DOB match keeps the full details.
**Cost:** the patient answers two questions before hearing their appointment.
**Number:** appointment read before any identity ask — 44 of 365, target 0.
**Guard:** appointments still read AFTER confirmation (37 in the same window)
must not vanish; no-ivr tickets per substantive call must not fall.
**Seen, not fixed:** the pcp call I flagged (`8a7924d9b0`) is the professional
line's designed disclosure (`phiDisclosureAllowed`); its defect is the false
line "I wasn't able to look that up without a date of birth" spoken while the
lookup had just succeeded. Different shape.

---

### W9 — The grader is missing a third of the fleet, and it is rising daily (task #139).
**`[x]` SHIPPED as v49. 10 new tests across four files; 8 mutations, 8 caught.
#112's CI flake fix rides in the same commit.**

**Measured first, 2026-09-16:** the runtime never graded its own calls —
nothing under `src/runtime/` imported the grader — so every runtime call waited
on the five-minute backfill, five rows per cycle, newest first: 60 an hour
against 90–98 substantive calls an hour at peak. Hangup-to-grade averaged 3.5
minutes at 15:00 UTC and **161–203 minutes from 16:00 to 18:00**; the fleet
watch reads `agent_outcome` and alarmed on a third of the fleet reading NULL.
And the queue was starved by its own head: two empty-transcript rows (1-second
calls) that nothing ever stamped, three rows in backoff still holding their
slots — five rows, zero attempts per cycle, and **87 calls from 09-15 with
`grader_results` and no outcome** sitting behind them. Third finding:
`dead_air` was `status = 'failed'` unconditionally, and the silence watchdog
fires after a whole conversation too — **58 real conversations on 09-14 (avg
131s, 5.9 caller lines) and 18 on 09-15** were recorded failed, so never graded
and never synced to their tickets.

**Fix, three parts:** (1) `runtimeGrading.ts` — the runtime grades at teardown,
after the row and after the sweep, never awaited, with the old core's own
>200-character threshold; (2) the backfill reads a window six times its budget,
stamps an empty transcript so it leaves the queue, lets a row in backoff cost
no slot, and spends its budget on attempts; (3) `statusFor(outcome, transcript)`
— dead_air is failed only when no `CALLER:` line exists. A graded call leaves
the backfill by `gradedAt`, so nothing is graded twice.
**Number:** runtime calls with `agent_outcome` NULL an hour after hangup — a
third of the fleet at peak, target ~0; the 87 stranded 09-15 rows should drain
on the first cycles after the deploy.
**Guard:** ONE grader call per substantive call; calls with no caller line must
still read `failed`.
**#112, same commit:** `voiceRuntime.test.ts`'s three fixed 40ms sleeps (red in
CI twice) now `waitFor` the condition they were sleeping for, bounded at 2s.

---

### W10 — The model goes silent after a filing refusal (task #146, found 07:00 while running the #51 corpus).
**`[x]` SHIPPED as v55 — the gate, and the instrument. 13 new tests across three
files; 6 mutations, 6 caught.**

**Measured first.** Runtime lanes, substantive, no ticket, `dead_air`, a `file_*`
refusal as the last tool event and the pre-tool filler (*"Let me get this logged
for you — one moment"*) as the last audible line: **26 · 25 · 42 · 9 · 15 a day
on 09-10/11/14/15/16** — the largest lost-request class on the runtime that
nothing had a name for. Per call on 09-16: the refusal answered in 6–18 ms
(13 date-of-birth, 2 surgeon), the caller silent because they had just been
told "one moment", the 30 s watchdog firing 37–67 s later. The refusal's spoken
question was never heard.

**Three controls, and what each ruled out.** The explicit follow-up path is not
dead — the ticket readback follows the filler DIRECTLY 305 times on two days.
It is not a rejected `response.create` — `provider_failure` is 0 on 09-16. It is
not an invisible barge-in — `interruption_count` never exceeds the transcript's
`[interrupted]` marks, and 9 of the 12 uncut silent calls had zero.

**What the code had.** `handleToolCall` assumed a function-call event always
arrives inside an open response and waited for that response's `done` before
requesting the follow-up; an event arriving after its `done` waited forever.
Whether the wire ever does that is NOT established from data — nothing
recorded it — so the fix is the one that is harmless if the hypothesis is
wrong (ask the wire whether the response is still open; wait only then), and
the other half is the instrument: one PHI-free `call_events` row per call that
owed a follow-up, with `toolCallsAfterDone` and `lastUnanswered`. Tomorrow's
SQL decides, and the pack has the query.

**What it does not do.** No prompt change, no retry, no nudge. If
`toolCallsAfterDone` reads 0 tomorrow while `lastUnanswered` stays high, the
next link to look at is the queued follow-up a barge-in discards
(`cancelResponse` clears `pendingSays`), and that is a separate change with its
own number.

**Number:** refusal-then-silence dead-air calls per day — 15 on 09-16, target 0.
**Guards:** filing rate per lane must not fall; `dead_air` must fall, not move
to `caller_hangup`; `provider_failure` must not rise.

**Beside it, #51 change 2 is withdrawn on its corpus** — 18 of the 23 refusal
calls with no ticket already ended their refusal turn on a question; the one
that did not was a four-times loop. The 23 are named on the task.

### W11 — The agent hangs up on its own question (task #147, found 08:00 reading the residual "other" bucket).

**`[x]` SHIPPED as v56.** Measured first: PCP calls ended by `terminate_call`
whose last agent line was a question or "one moment" — 17 · 32 · 38 on
09-14/15/16, 18 of the 38 with no ticket; the appointment-lookup-then-hangup
shape with the answer never spoken, 9 a day. The mechanism is in the code, not
a hypothesis: `record_automated_resolution` returned bare success, the
disposition made `terminate_call` legal, and nothing asked whether the model had
SAID anything. The bridge now refuses an end-call tool while a tool answer is
unvoiced (bounded at three holds), and the tool carries the instruction to speak
the answer. 8 tests, 7 mutations caught. The number to read after the
republish: PCP agent-ended calls whose last agent line is a question — target 0;
and `hangupsHeld` on the `follow_up_summary` rows, which is how often the guard
fired. The guard: PCP `dead_air` and `max_duration` must not rise.

## NOT DOING TONIGHT, AND WHY

- **`[-]` The emergency lexicon.** Which phrases count as a surgical emergency is
  a clinical decision and mine to leave alone. The half that needs no ruling —
  the agent narrating its own rule aloud — is folded into W4.
- **`[-]` Anything needing a production after-measurement.** v37 and v38 have
  never served a call (merged 18:51 and 20:16 UTC on 09-16; the v37 signature is
  still absent from live traffic at 23:00). Until a deploy lands, an
  after-number cannot exist.

---

## FOR 5AM — THREE STEPS, IN THIS ORDER

1. **Merge PR #321** — https://github.com/wfabian31773/openai-realtime-api-voice-assistant-Remix/pull/321
   (v39–v56, ready for review). Codex has reviewed it EIGHTEEN times: round 1
   (03:35) three P1s on the observatory/cost ship, round 2 (04:07) two P2s, round
   3 (04:42) two P2s, round 4 (05:16/05:30 on `1b82a86`) three P2s — two taken on
   `25b023b` (a parked recording and a turn buffer survive a failed write; the
   teardown upsert is retried), one declined on the measurement (an identity from
   a lookup that finishes after hangup: 3 of 1,553 calls) — round 5 (06:03 on
   `25b023b`) two P2s taken on `bf0da0f`, round 6 (06:31 on `fef236b`) a P1 on v54
   and a P2 on v53 — both the wrong-patient hazard one rung down from where the
   guards looked, both taken on `0142526` — and **round 7 (06:52 on `0142526`) two
   P2s: a recording callback that could park its URL AFTER the teardown had already
   peeked (the callback now parks before it looks), and grading with no atomic claim
   (the backfill could grade a call the teardown was already grading — the claim is
   now the `gradedAt` stamp, taken before the LLM is asked), both taken on
   `655a794`**, and **round 8 (07:05 on `655a794`) one P2 on that claim — a process
   dying between the claim and the grade left the row claimed forever; the claim
   now carries a marker and a ten-minute lease, so an abandoned one is taken
   again — taken on `bffeaec` together with v55**, and **round 9 (07:21 and
   07:23 on `bffeaec`) a P1 on v55 and two P2s: two late tool calls from one
   response could each earn a follow-up — the #227 round-14/17 unsolicited-reply
   race back through the late door — so the bridge now holds the follow-up for a
   250 ms window after the last late event; the follow-up summary's `call_events`
   buffer was deleted on the very flush failure it existed to survive, and is now
   retried and kept for the reaper; and the grading lease was shorter than the
   SDK's own retry window with no owner on the claim — the client is bounded to
   90 s × 2 and the claim carries a token that both the completion and the
   release must present — all three taken on `9cbbed0`**, and **round 10
   (07:52 on `9cbbed0`) two P2s on earlier ships: the call page's "reconciled"
   badge keyed on the estimate flag, which token-priced OpenAI calls also clear
   (now keyed on the reconciliation stamp, with a third state, "calculated"),
   and a recording push to an already-synced row with no retry when it fails
   (the sync is re-opened) — both taken on the v56 commit**, and **round 11
   (08:16 on `84aabf5`) three P2s: a response completion that carried no audio
   counted as the words and unlocked the v56 hangup hold (the line count now
   advances only on words the caller heard); the round-10 reopen decided on a
   pre-push snapshot a sweep in flight could make stale (the sync's own
   mark-done is now conditional on the row still holding the recording the
   payload carried); and the reopen left the retry count at a value the
   selector excludes (reset with it — 0 of 5,904 synced rows in 14 days carried
   it) — all three taken on `f927ffd`**, and **round 12 (08:39 on `f927ffd`)
   three P2s, one of them load-bearing for v56's own headline: an end-call in
   the SAME response as a lookup or a filing was decided before its sibling
   had answered (it now waits for its siblings, then holds); a transcript delta
   opened an utterance with zero audio bytes and read as words (audio, not
   text, now counts); and the teardown grade could land AFTER the five-minute
   sync had snapshotted the row — measured, not an outlier: 291 of 383
   agent-filed tickets on 09-14, 280 of 368, 296 of 387 carry no quality score
   or outcome while every call row has one — so the grade's write re-opens the
   sync and the sync's mark-done refuses a row whose grade landed mid-flight —
   all three taken on `2dcf68a`**, and **round 13 (08:58 on `2dcf68a`) one
   P2 on the round-12 wait: `terminate_call` FIRST in a multi-tool response
   found `pendingSiblings` empty and skipped the wait — an end-call now waits
   for its batch boundary (the response's done, or the late-batch window,
   which is armed at the late event's arrival for that reason) as well as
   the siblings it has seen — taken on `8fee09a`**, and **round 14 (09:25 on
   `2dcf68a`) a P1 and a P2 on the v45 day table: the preservation decision
   was a read separate from the write, so two replicas could interleave and a
   failed run still overwrite a reconciled row (the read-decide-write is now
   one transaction under a per-day advisory lock); and a first-attempt xAI
   failure wrote 0 calls / $0.00 as if measured (the day is now read for the
   summary, and a day nobody could read is NULL — a dash on the dashboard,
   never a zero) — both taken on `3c7d7c5`** — every one with a test and a
   mutation check, every thread resolved. **Round 15 (09:44, on `87164da`): one
   P2 — the post-call sync's two failure writes stored a snapshotted
   `retries + 1` that could clobber the grade or recording writer's reset to 0
   and strand the row at 3, ineligible; both now add one in the database.
   Measured first: 0 rows at 3 and 4 at 2 in 14 days — latent, taken as one
   expression in the write that branch already makes.** Beside it **v57**,
   task #75's after-number, finally taken: the surgery unassigned exit fired
   on 57 calls and on NONE of the 46 lost to the surgeon gate over
   09-08..09-16 — on every lost call that reached a third POST the attempts
   were 1–100 ms apart, one model response, and a counter noted after each
   refusal read 0 on all three. The ask is now claimed before the POST and
   settled after it; sequential rules unchanged; 7 mutations, 7 caught.
   **Round 16 (10:11, on `68a783b`): two P2s, both on those two changes and
   both taken — the sync still stamped GAVE UP and reported exhaustion from
   the snapshot (now a CASE in the same statement, read back with RETURNING),
   and v57's in-flight count could flag the third of a batch whose first two
   were 503s or another field's refusal (a claim now waits for the attempts
   ahead of it and reads confirmed refusals only; 6 mutations, 6 caught).**
   **Round 17 (10:26, on `5429bf9`): one P2 on that wait, taken on `34d3ecc` —
   one 20 s deadline for the whole queue where each predecessor may take 15 s;
   now one bounded wait per predecessor, re-armed on each settle (3 mutations,
   3 caught).** **Round 18 (10:38, on `34d3ecc`): one P2 on that, taken on
   `8a11864` — every waiter started its own bound on arrival, so a predecessor
   past the bound (the create path can legitimately take ~21.5 s) released all
   of them together; claims are now queued and released one at a time, and the
   floor is 25 s, above the longest legitimate attempt (3 mutations, 3
   caught).** A NINETEENTH pass is requested on that head.
   **Read that nineteenth pass before merging** — the v27/v28/v31 rows in CLAUDE.md
   record what happens when a draft is marked ready and merged in the same minute.

2. **Pull and republish.** `/voice/health` must read the v57 marker below.
3. **Merge ticketing-app PR #279** — https://github.com/wfabian31773/ticketing-app/pull/279
   — commit `11db8480` (the name-only consolidation arm, W5). Its *Tests* and
   *Build* checks are green; *Type check* is red with the 22 errors that are
   red on `main` too (the latest `main` run, 02:29, concluded failure the same
   way). Marked ready for review at 04:15 so Codex sees it before you do; it
   needs nothing from the Remix side. **Codex completed its review of `11db848`
   at 04:11 with no findings** (its summary comment on the PR; no threads) — the
   greenlight is there.

**ONE QUESTION FOR YOU, with my recommendation (task #138).** `unclassified_call`
is now the model's default: on 09-16, **57 of 104** PCP Support agent tickets
carried it, and — verified in SQL via `pcp_failure_information`, which the sweep
stamps `call_not_classified` — **all 57 came from the model, zero from the
sweep.** Your 09-15 ruling ("anything we don't classify we log as a new slug")
was about the SWEEP; adding the slug to the shared list handed the MODEL an "I
don't know" option inside its own tool, and it takes it on half the calls.
Nothing is lost (PCP filing rate 40 → 53 → 51% over the three days), but the
records and scheduling routes key on the stated purpose, so those calls never
reach dept 16 or 9, and the slug no longer means "a human must route this".
**Recommendation: take `unclassified_call` OUT of the model-facing enum and keep
it for the sweep only.** The landing place already exists — a call the model
never classifies is filed by the teardown sweep as unclassified with the caller's
own words (v31). Cost: on those calls the ticket number is not read back
mid-call. Alternative: leave it and accept that the slug mostly means "the
model declined". Yes/no is enough; it is a one-line change with a test either
way, and I will not make it without your answer.

**One more thing that is yours alone: the xAI management key pasted into an
earlier session's transcript still has to be rotated.** Console → Settings →
Management Keys; then set the new `XAI_MANAGEMENT_KEY` on Replit.

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
| **v44** (PR #321) | every runtime call gets a recording, timed turns, and tool calls placed where they ran on the Observatory's call page | 0 of 4,564 runtime calls had a recording or a turn record; the page you asked for existed and had nothing to show |
| **v45** (PR #321) | one `daily_grok_costs` row per day — xAI reported vs booked, refusals included — on the cost dashboard, and the call page says reconciled or estimated | 2026-09-12 booked $37.43 onto one 104-second call and nothing recorded that the day was wrong |
| **v46** (PR #321) | the tool ceiling stops a tool that keeps succeeding with the same arguments — the eleventh identical call gets the tenth's answer back | 17 calls since 09-10 looped one tool 11–35 times, 16 with no ticket; nothing could see them |
| **v47** (PR #321) | the after-hours line stops reading a phone-matched patient's appointment before anyone confirms who is calling | 44 of 365 no-ivr calls in nine days had the date, time, office and doctor read out before any identity question |
| **v48** (PR #321) | `found` and `candidate_count` reach the tool timeline — an instrument, no behaviour change | the W1 date-of-birth fix was reverted because the ambiguous-lookup branch could not be counted; after a day on this build it can be |
| **v49** (PR #321) | the runtime grades its own calls at teardown, the backfill cannot be starved by its own head, a dead_air ending after a real conversation is `completed` — and (round 12) the grade re-opens the ticket sync, so the quality score, sentiment and outcome reach the ticket | a third of the fleet read `agent_outcome` NULL at peak on 2026-09-16 (grades lagging 161–203 min); 87 calls from 09-15 stranded behind two empty rows; 58 real conversations on 09-14 recorded `failed` and never graded or synced |
| **v50** (PR #321) | the second identity miss ends the ask — `lookup_patient` counts misses per call, coaches one shaped re-ask, then says stop and file | 35 runtime calls on 09-16 asked for a date of birth 2+ times, 13 asked 3+, tech's almost all cold callers; 13–16 calls a day missed 3+ times and were never found, 7–10 of them with no ticket |
| **v51** (PR #321) | a CERTAIN identity the tools established reaches the call row — `patient_found`, `patient_name`, `patient_dob` — never a phone candidate | NULL on 2,471 of 2,471 runtime calls in seven days; the Observatory's identity columns have been dark on every lane since the cutover (task #57's runtime half was done on a runtime that no longer exists) |
| **v52** (PR #321) | the per-call cost UPDATE types its two bound components, so Postgres stops refusing it at PARSE and `twilio_cost_cents` is written again | rejected 3,749 times in the 24h to 05:40 (`operator is not unique: unknown + unknown`, since `8a226a6` on 09-04); Twilio price on 5–25% of completed calls against 100% before; 4,295 calls since 09-04 carry a provider-only total |
| **v53** (PR #321) | no-ivr's `create_ticket` writes a CERTAIN identity (name + date of birth matched) onto the call row, reading the transport's `callLogId` at write time; the factory-time phone-candidate write is gone | `patient_found` on 0 of 297 substantive no-ivr calls in seven days — the writer read a getter before it was backfilled, and would have written a phone candidate as an identity |
| **v54** (PR #321) | when a phone carries several people and the caller affirmed a first name, `lookup_patient` narrows to that person, re-resolves them and carries them as CERTAIN — the filing tool inherits the chart date instead of asking | all 26 recognised-caller DOB refusals on 09-16 read `carry = no_entry`: the phone rung found several people and remembered nobody, and the affirmed name never reached the tool. This is W1, measured and fixed |
| **v55** (PR #321) | the follow-up after a tool no longer waits for a `response.done` that has already passed — the bridge asks the wire whether the carrying response is still open — and every call that owed a follow-up writes a PHI-free `follow_up_summary` row to `call_events` | 9–42 runtime calls a day since 09-10 ended in dead air with a filing refusal answered in milliseconds and the pre-tool filler as the last audible line (15 on 09-16); three controls ruled out a dead follow-up path, a rejected `response.create` and an invisible barge-in. This is W10 — the mechanism is a hypothesis the instrument settles tomorrow. Codex round 9 added the late-batch window (two late tool calls from one response are one follow-up, not two) and made the summary row survive a failed flush |
| **v56** (PR #321) | an unvoiced tool answer cannot end the call — the bridge holds `terminate_call` while the model has a tool result it has not put into words (three holds, then it lets go), and `record_automated_resolution` tells the model to say the appointment it found | 38 of the 61 PCP calls the agent ended on 09-16 ended on the agent's OWN QUESTION (17 · 32 · 38 over three days), 18 with no ticket; on 9 a day the clinic's appointment lookup succeeded and the answer was never spoken before the hangup. This is W11 |

### How to check the republish actually took, in ten seconds

Do not take my word or yours for it — the marker and the behaviour both say so.

```
GET /voice/health   ->   voice-runtime-v57-the-surgeon-ask-is-claimed-before-the-post-20260917
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

### The Hub database — three findings at 05:30, two of them ours

**1. The Hub Postgres CRASHED at 05:27–05:30 UTC and came back at 05:30:33** (`database
system was interrupted; last known up at 05:27:32`, a fresh postmaster and a fresh
pgbouncer — a platform-level restart, no OOM line, no `terminating` line). Every
statistics counter reset with it. Not ours to fix; **check the project's compute and
restart history in the Supabase dashboard.** Beside it, since **2026-09-10 17:00 UTC**
Supabase's own `postgres_exporter` has been timing out about 80 times an hour (1,938
in the last 24h) on a 20-second read of `pg_stat_statements` — a query that should take
milliseconds. That is the platform's metrics collector, and it is a symptom of the
instance being IO-starved, not a cause we can remove from here.

**2. OURS — the cost write, fixed as v52 (above).** What is NOT fixed by the code:
**4,295 completed calls since 09-04 have no Twilio price**, and the sweep only looks
back four hours, so they stay that way until an admin recalculation runs — about 4,300
Twilio price fetches. Recommendation: run it after close today, in batches; the SET
clause defends every reconciled row so it cannot touch an invoice. **Your call on
timing.**

**3. OURS — `lookup_patient` timeouts are BACK (task #68), and the four 5-minute sweeps
were each seq-scanning `call_logs`.** Timeouts: 0 on every day 09-03..09-08, then 1 · 5 ·
**55** · 91 · 26 · 39 on 09-09/10/11/14/15/16 — 7–18% of lookups by lane, records on the
OLD core included (17.6%), worst at the 15:00 opening hour. Mostly transient: of 108
affected calls since 09-14, 91 found the patient on a later lookup; **17 never did, 9
of those still filed**. The onset matches the exporter storm (09-10 17:00), not the
Schedule mirror's 20–97-second INSERT batches (09-11 had none in business hours).
What we contributed: `ticketingSyncService`'s stale-call reaper, Twilio-cost retry,
sync and insights sweeps each read all 28,479 pages of `call_logs` every five minutes
— **11.7–26 seconds each when the cache is cold, in the log** — because the table has
no index on `status`, `end_time` or the pending flags. Partial indexes were created
tonight (`CONCURRENTLY`, reversible with `DROP INDEX`, no behaviour change — the
2026-09-12 PersonID precedent); the list and the before/after plans are in
`docs/observatory/AFTER-MEASUREMENTS-20260917.md`. After-number for #68: lookup
timeouts per day, 39 on 09-16, target back to the 0 of 09-03..09-08.

**4. OURS — three quarters of agent-filed tickets carry no grade, and the fix is
forward-looking (Codex round 12, 08:39).** The teardown grade lands seconds to
minutes after the row; the five-minute sync snapshots the row first, sends nulls
for quality score, sentiment and outcome, and marks the call done — and nothing
ever re-opened it. Support Center, tickets with a synced transcript: **291 of 383
on 09-14, 280 of 368 on 09-15, 296 of 387 on 09-16 have no `quality_score` and no
`agent_outcome`** while every one of their call rows on the Hub has both. PR #321
closes it from the first sync after the republish (the grade's write re-opens the
sync; the sync refuses to mark a row whose grade landed mid-flight). **What the
code does NOT do is go back:** the 814 rows since 09-14 that were graded after
their sync stamp (636 with a ticket number on the row) stay ungraded on the
ticket until something re-opens them. One statement does it, the sweep drains it
at 20 rows per five minutes (~3.5 hours), each POST is the same idempotent
`update-call-data` payload with the grade on it, and it works on the build that
is live now — the payload reads the grade off the row. **Recommendation: run it
after the republish, off-peak; your call on timing.**

```sql
-- Hub. Re-open the sync on every call graded after its sync stamp since 09-14.
UPDATE call_logs SET call_data_synced = false, ticketing_sync_retries = 0
WHERE created_at >= '2026-09-14' AND duration >= 30 AND status = 'completed'
  AND call_data_synced = true AND quality_score IS NOT NULL
  AND graded_at > ticketing_synced_at;   -- 814 rows at 08:57 UTC
```

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

**2. Ticket consolidation outside PCP — BUILT, PUSHED and OPEN AS PR #279 on
the ticketing app (`11db8480`).** The name arm has no
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

**05:00 addendum (task #73):** the root tsconfig never included `client/`, so a type error in the Observatory's pages passed CI unseen. The client typechecks clean today (0 errors), so CI now runs `tsc -p client/tsconfig.json` as a second step — it starts green and can only go red on a real error. And the after-numbers for v37–v49 are now a runnable pack, every query executed tonight against the live databases with its before-value beside it: `docs/observatory/AFTER-MEASUREMENTS-20260917.md`.

No vitest config existed, so a bare run collected the compiled suite under
`dist/`: **36 files, 113 tests, all failing with ENOENT** on paths that only
exist in `src/`. The cost was not the red — it was that the red meant nothing.
With `dist` excluded: **232 files / 4,454 tests, all green.** That is the
baseline every number below is measured against.

An earlier draft of the config also pinned `include` and silently dropped 17
files / 226 tests under `server/` and `client/` — the same failure pointed the
other way. Only `exclude` is set.

## W1 `[-]` — I wrote the fix, then reverted it. This is the entry to read.

**UPDATE 07:55 — `[x]` MEASURED AND FIXED AS v54, and it was a different mechanism from the
one I reverted.** With v25's `carry` instrument live on 09-16: DOB refusals on recognised
callers 50 (09-14) → 26 (09-16), **all 26 `no_entry`**, 20 of 26 on phone-only lookups,
0 of 26 with a match followed by a miss — so NOT the `forgetIfSameName` wipe I had
written against. The phone rung found SEVERAL people on the number, returned the newest
as a guess, and remembered nobody; the greeting's affirmed first name never reached the
tool. v54 narrows the candidates by that name and carries the one hit as certain.
6 tests, 4 mutations caught. The reverted change stays reverted.

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

**What would settle it — SHIPPED as v48:** `toolTimeline`'s outcome allow-list
carried `matched_by` and `identity_is_certain` but not `candidate_count` or
`found`. Both are on it now (1 mutation, 1 caught), so after one day on the
new build this is answerable from `tool_timeline` rather than argued: how many
of the refusals behind a matched lookup are the ambiguous branch. The fix
itself stays reverted until that number exists.

## W2 `[x]` on no-ivr (v41) · `[x]` on the runtime lanes (v50, 05:09)

**05:09 — the runtime half is SHIPPED as v50, and my earlier recommendation to
wait for the v25–v28 after-arm was wrong for tech.** Measured 2026-09-16: of the
calls asking for a date of birth 2+ times, tech's 16 were 15 COLD callers and 1
recognised; surgery's 16 split 8/8. The recognised-caller fixes never reach a
cold caller. And the loop is not the filing tool (refused once at most,
`dobShape` `(none)`) — it is `lookup_patient`, called 2.5–6.5 times per such call,
whose own miss message sent the model back to ask every time. v50 counts identity
misses per call inside that tool: the phone-first pass is free, the first miss
on a name or date of birth coaches ONE shaped re-ask (spell the surname; month,
day, year), the second says stop and file. **The trade, measured first:** per
day ~250 lookups hit first try, 9–16 on the second, 7–10 only on the third or
later (most of those survive the bound); against 13–16 calls a day that missed
3+ times and were never found, 7–10 of which left no ticket. A lost request
outweighs a lost match. `LOOKUP_MISS_LIMIT = 2` is the dial — say the word and it
is 3. Number: runtime calls asking DOB 3+ times, 13 on 09-16 → 0. Guard: filing
rate per lane must not fall.

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

**And the recommendation, which is the reason it is not built tonight:** the
runtime's speech re-asks were measured on a build WITHOUT v25–v28 — the chart
date-of-birth inherit, the recognised caller no longer asked for a surname or a
date we hold, the ask script agreeing with the block. Those four exist to
remove the re-ask at its source and have never served a call. Building a
counter on top of them before their after-number exists is a fix on an
unmeasured population — the thing this operation is trying to stop doing. Take
the after-arm the first business day on v48; the counter is next only if the
re-asks survive it.

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
