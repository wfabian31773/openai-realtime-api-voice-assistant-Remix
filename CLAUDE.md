# READ THIS BEFORE YOU DO ANYTHING

You are working with **Wayne** on the Azul Vision voice agents. Southern
California eye-care practice. Real patients call these numbers.

This file exists because of a specific, repeated failure: **losing the context
of what was already decided and already built, and then re-proposing it.**
Two examples from 2026-08-10 alone —

- I told Wayne to take the PCP line offline (my own plan, step 1). An hour
  later I asked him why PCP was offline.
- I built `src/core/replayRealCalls.test.ts` at 21:45. At 01:00 I proposed
  building a replay harness, as if it did not exist.

That is the thing that is driving him crazy. It is not a code problem.
**Read this file and `docs/observatory/STATE-OF-PLAY.md` at the start of every
session, and re-read before proposing any plan.** If you are about to say "I
don't know why X" or "we should build Y" — check here first. It is probably
written down.

## Before touching the ticket path, read `docs/BACKEND_HANDOFF.md`

Written 2026-08-20 after a week that made surgery routing WORSE — provider fill
on department 2 went from ~98% to 49% across three merged PRs that all passed
their tests. That document holds the traced architecture, the real API contract
(which is wider than our TypeScript interfaces — three things were requested
from another team that already existed), the measured state of each queue, the
operator's standing rulings, and a list of changes that were tried and made
things worse.

The single rule it exists to enforce: **do not merge a change to the ticket path
without measuring the production number it is meant to move, before and after.**
Green tests did not prevent any of the regressions listed there.

---

## Wayne's standing instructions — these do not expire

1. **"If you don't know something, don't fill in the gaps. Ask me. And if I
   don't know, then I'll take your recommendation. But other than that, if
   it's procedural stuff, you need to ask me."**
   Procedural/domain questions go to him. Do not invent business rules.

2. **"Same exact agent, different voice pipeline. Nothing in the agent changes
   but the voice pipeline."**
   The ask has always been to swap the *pipeline* under the existing
   answering-service agent. It is NOT to write a new agent. I did that anyway
   and burned days on it. Do not do it again.

3. **"Why are you trying to determine what a first name is? You'll never ever
   get it to work like that."**
   Extraction is the LLM's job, not a regex's. This was proven correct: the
   model pulls `first_name: "Wayne", last_name: "Fabian",
   date_of_birth: "03/17/1973"` out of ordinary speech with no parser.

4. **"I don't want you to use Vapi, I want to create my own without using
   their platform."**

5. **"On the side without touching the real agents."**
   `answeringServiceAgent.ts` and the other production agents are off-limits
   unless he says otherwise. Pipeline changes go in `src/standalone/`.

6. **Verify against the mirror.** Patients verify against `patients_master`
   (the Eye Care Patient Console), not the appointment book. Carry the match
   forward as context and associate it on the ticket for staff.

7. **Capability boundary.** The answering service cannot transfer calls or
   schedule appointments. It must say so plainly and file a ticket.

8. **Stop making him the test harness.** A failing call goes into
   `replayRealCalls.test.ts` *before* any code changes. Show red-then-green
   offline. Do not ask him to dial to find out whether a guess was right.
   *(2026-09-01: `src/core/replayRealCalls.test.ts` was deleted along with the
   `src/core/` pipeline it replayed. The instrument this instruction names no
   longer exists and no replacement has been built — that is outstanding.)*

9. **"There is no handoff for any of the answering service agents, only for
   PCP, Scheduling SD. All other agents politely state they are unable to
   handoff and can only create a request for a callback."** (2026-08-12)
   Those agents get **no transfer tool at all** — not a disabled one. A tool the
   agent cannot see is a promise it cannot make.

10. **Nobody is told to call back.** (2026-08-13) *"We can't just tell the
    patient call back, call the wrong extension."* Queues are forwarded; a
    caller who pressed the wrong option gets their request taken and routed.
    Schedule-related goes to the **HVA Hub from every queue — except a surgery
    date**: *"surgery is an exception to that hva hub rule."*

11. **Route by queue.** Each queue gets its own number, webhook and slug. Do not
    multiplex queues onto one agent behind a mode flag.

12. **Confirm the callback number BEFORE filing, not after.** Correcting it
    afterwards means a second ticket and a patient who was told the wrong thing.

13. **After hours, everything goes to the after-hours agent** via Nextiva
    enterprise routing, and it escalates to Wayne directly. *"It's impossible to
    reach that line after hours."* Do not build after-hours behaviour into a
    queue agent. **All overnight volume is on the no-IVR agent**, which Wayne
    uses as the after-hours agent (2026-08-13).

14. **One source of truth: the Eye Care Patient Console.** (2026-08-31)
    *"Any scheduling or pre-context or anything of that nature, verification,
    should run to the Eye Care Patient Console's patient summary or patients
    table, and there's a mirror also in there that holds the schedule as well.
    So we should use those two tables. Same thing for providers or anything
    like that of that nature. All of that information is in the console.
    That's where we should — one source of truth."*

    Applies to **the runtime agents and 5Star**. Read the Console project
    `kbbmywvasbsxnbblrhot`, not the Operations Hub's own copies:

    | what you need | table | rows |
    |---|---|---|
    | who a person is | `patients_master` | 915,843 |
    | the schedule mirror | `si_appointment_facts` | 908,995 |
    | providers | `si_providers` | 77 |
    | locations | `si_locations` | 105 |
    | phone → patient (whether IT or `patients_master` powers `sage_precontext` is UNSETTLED — see below) | `si_persons` | 3,731 |

    **What violates this today — do not assume it is already done:**

    - `lookup_patient`, the FIRST tool optical, surgery, tech and records call,
      goes to `scheduleLookupService`, which imports `{ schedule }` from the
      Operations Hub — the appointment book. A real patient with no
      appointment inside the schedule window cannot verify, and the failure
      looks random from outside.
    - `src/services/patientVerification.ts` already reads `patients_master`
      correctly and was written for exactly this bug. Its only two wirings
      were `src/core/router.ts` and the standalone demo line, and both trees
      were deleted on 2026-09-01 — so today it is wired into **nothing**, and
      still never into the shared queue tool.

      **DO NOT DELETE IT AS DEAD CODE.** It is the correct implementation of
      this instruction and the only one in the repo; it has no importers
      because the two callers it had were dead pipelines, not because it is
      wrong. Where mirror verification should be wired on the live path is
      an open question for Wayne.
    - Caller-ID pre-context on the runtime goes through
      `fetchAzulPrecontext` → the `sage_precontext` HTTP tool. It is Console
      data over the network, bounded at 1.5s, and every failure is normalized
      to `null`, so the agent asks cold for several different reasons.
      **WHICH Console table it reads is UNSETTLED:** `voiceRuntime.ts:715`
      says `si_persons`, `voiceAgentRoutes.ts:2481` says `patients_master` and
      cites the service's `sage-tools.ts`, and the Console's only phone→person
      RPCs all read `patients_master`. Do not quote either as fact — see the
      pre-context entry under the 2026-09-03 measurements. The RETURN VALUE is indistinguishable; the logs are
      not — `callEyecareTool` writes `[AZUL-SCHED]` lines naming an unset key,
      an HTTP status, or a fetch/abort, and 401/403 go through
      `noteAuthFailure`. The one genuinely silent mode is a lookup that
      succeeds after the 1.5s deadline: nothing logs that, the call just
      proceeds without pre-context.

    `lookup_patient` is not only verification — it also returns the offices
    and providers a patient was actually seen at, which is how optical
    resolves which office they mean. So the shape is mirror-first for
    identity, then the schedule for history. Not one replacing the other.

---

## Line status — check this before saying anything about what is on or off

**2026-09-03 was the runtime cutover.** Three queue lanes moved off the OpenAI
SIP core onto the Grok Media Streams runtime, each at its own moment, and each
one is a same-day A/B you can still measure. `voice_provider = 'grok'` is the
discriminator; a NULL there is the old core.

| Line | Pipeline | Cutover (UTC) | Calls 09-03 | Filed (substantive) | Notes |
|---|---|---|---|---|---|
| **optical** | **Grok runtime** | 15:24:58 | 84 | 28/56 = **50.0%** | First lane over. Only 2 old-core calls that day, so it has NO same-day before-arm. |
| **surgery** | **Grok runtime** | 19:43:57 | 55 | 18/32 = **56.3%** | Before: 22/44 = 50.0% on the old core, same day. |
| **tech** | **Grok runtime** | 19:51:10 | 100 | 46/66 = **69.7%** | Before: 49/73 = 67.1% on the old core, same day. Busiest lane. |
| **records** | **STILL OLD CORE** | — | 38 | 14/29 = 48.3% | The same-day CONTROL, and the reason the comparison is trustworthy. It also means records is missing every ruling shipped to the runtime lanes — on 2026-09-03 23:54 it said "all of our agents are currently busy… as soon as they become available", which #265 forbids, and asked for first and last name in one breath. |
| **no-ivr** | old core | — | — | — | After-hours agent. All overnight and weekend volume (standing instruction 13). Queue lanes take nothing after 00:00 UTC / 5pm Pacific. |
| **pcp** | **Grok runtime — BACK ON 2026-09-04 ~16:00 UTC** | 2026-09-04 ~16:00 | 3 test calls | — | Wayne switched it over himself and made three test calls. It had been OFF since Aug 10 (his decision — do not ask why it *was* off). **TWO-DAY PEAK, not a steady-state rate:** it ran 08-06 and 08-07 at **216 and 203 calls**, then was switched off — so no average exists for it. Like-for-like on BUSIEST DAY: pcp 216 · tech 214 · surgery 161 · optical 119. An earlier version compared that peak against the other lanes' 15-16 day AVERAGES (165/107/79) and concluded pcp beat surgery+optical combined; that mixed two different windows and is withdrawn (Codex, PR #272). Peak-for-peak it is the busiest lane by a nose, on two days of evidence — its typical full-volume traffic is UNMEASURED. **A live defect is open on it: see below.** |
| **azul-scheduling** (San Diego) | **OFF** | — | — | — | Gate B replay books 8 of 21. Not ready. Do not ask why. |
| **answering-service** | old core | — | — | — | — |

### PCP LIVE DEFECT — the agent promises a transfer and does not make one

Found in Wayne's own test calls, 2026-09-04 16:11 (`CAa37f1a422d120c200d2038c1314a32aa`).
A caller from a surgery center asked for a representative. The agent said:

> "Give me one moment while I connect you with our PCP team — I'll stay right
> here with you."

Then `transferred_to_human = false`, `transfer_outcome` NULL,
`runtime_outcome = agent_ended`. It filed PCP-57486 ("Service inquiry", noting
the intake was incomplete) and ended the call. **No transfer was attempted.**

**WHAT THIS DOES AND DOES NOT ESTABLISH.** The defect is the BROKEN PROMISE,
and that stands whichever way the open question below is settled: the agent
said it would connect the caller and then did not, and it did not say
otherwise either. Nothing here establishes that this call was *required* to
transfer — an earlier version of this section said it "MUST transfer", which
silently resolved the operator's still-open question (entity + asks + the
matter is ticketable) in one direction, inside the same section that marks it
open. It was in fact recorded as a service inquiry and it DID file a ticket,
which is what the "ticketable → ticket it" half of the rule asks for. The
wrong part is the sentence spoken to the caller, not necessarily the routing.
(Codex, PR #272.)

**Scope: one observed call.** It proves the failure mode exists on this lane;
it does not establish how often it happens. The runtime has three test calls
in total. An earlier version said "at 200+ calls/day … every entity that asks
for a person gets a promise and a dial tone" — both halves were unearned: the
volume was extrapolated from two peak days, and "every" from a single call.

**There IS a measured history for the shape, on the OLD core.** Over PCP's two
full days (2026-08-06/07), of 67 substantive calls whose `agent_outcome` was
`escalated`: **8 reached a human, 20 filed a ticket, and 47 produced NEITHER.**
So "the agent decides it cannot handle the call, then does nothing" is a
long-standing and concentrated loss on this lane, not something the pipeline
change introduced. That is evidence the shape recurs; it is NOT evidence that
those 47 should have been transferred — under the rule below most of them
should have been TICKETED.

**THESE ARE TWO DIFFERENT DEFECTS. Do not merge them.** An earlier version of
this paragraph ended "what is wrong in both is ending with neither", which is
false of the live call: **it DID file PCP-57486.** Its ticket path worked.

| | what failed |
|---|---|
| the live 2026-09-04 call | **the spoken promise** — said it would connect, then did not, and did not say otherwise. Filed a ticket. |
| the 47 historical calls | **neither a transfer NOR a ticket** — the request left no trace at all. |

They may share a cause and they may not. Sending follow-up work toward
missing-ticket handling on the basis of the live call would be chasing the
wrong defect, since that call's ticket filed. (Codex, PR #272.)

**The mechanism is present in the tree** — `warmTransfer.ts`,
`transferTwilioOps.ts`, the accept webhook mounted at `voiceRuntime.ts:448`,
and `pcp` in `RUNTIME_TRANSFER_READY_LANES`. **Do not read that as ruling out
"the feature was unreachable on this call":** `laneSupportStatus` refuses a
transfer-capable lane outright when no handoff is injected for the deployment,
and whether one was injected here was NOT checked. **Not root-caused, and the
search is not narrowed.**

**WAYNE'S PCP TRANSFER RULE (2026-09-04), replacing "anyone who asks goes through":**

- Default is to take the request and file the ticket. **Never auto-transfer.**
- Transfer only when BOTH: the caller **asks** for a representative, AND the
  caller is an **entity** — doctor's office, medical group, surgery center,
  insurance — **not a patient**.
- Ticketable → ticket it. Not ticketable → let it through on request.
- **OPEN:** an entity asks for a rep about something that IS ticketable — does
  the ask win or the ticket win? Not yet answered. Do not assume.
- The entity test is the model's read of what the caller SAYS. There is no
  verification behind it.

**Also observed on those calls, not yet fixed:** the agent asks "What is your
role?" and then "What is your professional relationship to this patient?" and
gets the same answer twice; it asked seven questions before reaching the
patient even when the caller opened with name and purpose; no callback number
was captured on either ticket (standing instruction 12); and no recording
disclosure was spoken. Wayne also wants the voice changed — which voice is his
call, unanswered.

**THE HEADLINE OF THE CUTOVER: filing rate is FLAT.** tech +2.6 points, surgery
+6.3 — neither is significant at these n. The runtime matches the old core. It
is not better and it is not worse, and anyone claiming either without a control
is reading noise.

**What DID change, measured on the same calls:**

- **Turn detection is better.** tech callers said MORE (353 vs 333 characters)
  in FEWER transcript lines (6.0 vs 7.7) at the SAME duration (128s). Less
  fragmentation, no lost speech. `call_logs.total_turns` fell 16.1 → 9.7 and
  is counting something else — do not quote it.
- **The agent speaks in about twice as many short lines** (tech 7.4 → 9.3,
  surgery 4.8 → 8.2). Not yet judged good or bad.

## What already exists — do NOT rebuild these

| Thing | Where | What it does |
|---|---|---|
| Mirror verification | `src/services/patientVerification.ts` | Verifies against `patients_master`; refuses to guess between two people. |
| Appointment answers | `src/services/appointmentAnswers.ts` | `Schedule.PersonID` join; excludes `Removed`. |
| Replay tables | Operations Hub | `new_core_replay_summary`, `new_core_replay_index`, `ticket_agent_config` |
| Date-of-birth parsing | `src/tools/dobParts.ts` | Reads a date out of a whole spoken sentence, English + Spanish months, two-digit centuries. **Turkish is a known, evidenced gap.** Also exports `dobShape` — the PHI-free shape of what arrived, which is the only way to tell "the model sent nothing" from "the parser refused it". |
| The teardown request sweep | `src/runtime/requestSweep.ts` (decides) + `sweepRunner.ts` (files) | If the caller made a request and no filing tool succeeded, files it from the transcript at teardown. Wired in `voiceRuntime.ts` AFTER the call_logs write. Recovers only 6 of 53 today — see the open question about "no name, no ticket". |
| Mid-call language switching | `src/tools/languageTools.ts` + the bridge's transport step | `set_spoken_language`; result to the model BEFORE the wire changes. Proven live 2026-09-03 on a Turkish caller. |
| Repeated-failure ceiling | `src/runtime/toolCeiling.ts` | Stops a tool loop. **Keys on IDENTICAL arguments**, so a model that varies them gets more than 3 bites — observed 4–6. Its stops are INVISIBLE in `tool_timeline` (it short-circuits before dispatch, so `wrapWithTelemetry` never runs); console-only, uncountable from SQL. |
| Grok cost from the bill | `src/services/grokCostAllocation.ts` + `xaiBilling.ts` + `grokCostReconciler.ts` | Splits xAI's authoritative daily total across the day's calls by seconds. **Dormant without `XAI_MANAGEMENT_KEY` / `XAI_TEAM_ID`.** |
| The runtime's agents-table id | `src/runtime/agentIdentity.ts` | slug → `agents.id`, cached per lane. Without it every runtime call is absent from five per-agent reports. |
| Pipeline label on a card | `client/src/lib/pipelineSplit.ts` | Says which stack served a lane's calls, and warns on a mid-day cutover. |
| "Greeting already played" | `src/runtime/greetingAlreadyPlayed.ts` | Appended by the RUNTIME, not the prompts — the transport is what plays the greeting, and tech has 16 tokens of ceiling headroom. |

---

## Architecture facts that cost hours to learn

- **The old core's ear, brain and mouth are ONE OpenAI SIP session.**
  Twilio → conference → SIP → `sip.api.openai.com`. Audio never touches our
  servers. This is why STT cannot be swapped without changing the transport —
  that fact is the whole reason the standalone line exists.
- **Caller-ID pre-context is why the old core "knows who is calling."** It
  looks the number up *before answering*, so the agent says "Am I speaking
  with…?" — confirm, not ask. Wayne's number resolves to **eight** records in
  the mirror, so a phone match is a **candidate to confirm, never an identity**.
- Twilio `<Connect><Stream>` **replaces** the call (socket close = hangup);
  `<Start><Stream>` forks audio and the call continues.
- Twilio `mark` events are the **only** ground truth that audio actually played
  to a caller. `clear` discards Twilio's buffered audio.
- Deepgram: `is_final` (settled words) ≠ `speech_final` (caller stopped) ≠
  `UtteranceEnd`. Accumulate until `speech_final`/`UtteranceEnd` or every
  question gets asked twice.
- Anthropic: **every `tool_use` must be answered by a `tool_result` in the very
  next message.** If not, the API rejects the *whole history*, so one malformed
  turn kills every later turn of the call.
- Supabase projects:
  - **Operations Hub** `pslzngjciiifowemrzza` — `call_logs`, `Schedule`, `ticket_agent_config`
  - **Patient-Console** `kbbmywvasbsxnbblrhot` — the source of truth
    (standing instruction 14). `patients_master` (915,843 persons),
    `si_appointment_facts` (908,995 — the schedule mirror), `si_providers`,
    `si_locations`, `si_persons` (phone→patient; whether it or
    `patients_master` powers `sage_precontext` is UNSETTLED),
    plus the scheduling-intelligence tables (`si_slot_rules`,
    `si_eligibility_matrix`, `open_slots_snapshot`).
  - The Hub keeps its OWN `Schedule` copy and several services still read it.
    That is the appointment book, not the person base, and it is the reason
    verification has been the hardest part of every line — see instruction 14.
  - `Schedule.PersonID` (uuid) ↔ `patients_master.person_id`; `uuid = text`
    needs an explicit `::uuid` cast.

---

## HOW TO MEASURE WHETHER A CALL FILED — read this before quoting any rate

I got this wrong for a whole afternoon on 2026-09-03 and reported filing rates
understated by about a third. The instrument, not the fleet, was the problem.

**THE AUTHORITY — THREE BUCKETS WITH PRECEDENCE, AND AN UNKNOWN THAT IS
REPORTED RATHER THAN ASSUMED. Never a ticket prefix.**

1. `created_by_id IS NOT NULL` → **STAFF.** A named human made it. This wins
   over `agent_used`, and the direction was CHECKED rather than assumed.

   The worry was the reverse case: if staff can re-own a ticket the agent
   created, a human creator would be stamped on a genuine agent filing and
   this precedence would silently reclassify real filings as staff. **Read all
   of the both-fields rows: every one is staff prose** — "Pt ci", "PT C/I",
   "hello team", "sx", Spanish-speaker notes — and their `agent_used` values
   are mostly bare UUIDs rather than lane slugs. They are staff tickets
   carrying a stray value, not agent filings re-owned. **A human creator is
   positive evidence; a set `agent_used` is not.**
2. else `agent_used IS NOT NULL` → **AGENT FILING.**
3. else → **UNKNOWN, and it must be reported as unknown.** NULL is not proof
   of a non-filing. Calls sit in this bucket (count: see the census); folding
   them into the denominator as "did not file" understates the rate by
   assumption.

**AND THE `call_sid` MUST PASS THE CANONICAL VALIDATOR — `~* '^CA[0-9a-f]{32}$'`,
the SQL form of `isTwilioCallSid` (`src/tools/callSid.ts`).** `LIKE 'CA%'` is
NOT enough: `CAunknown` passes it and recreates the very problem. How many
junk rows it admits today is a fact about today, not about the rule (count:
see the census — Codex, PR #272). `call_sid IS
NOT NULL` is not enough: ticket rows carry sentinels ("unknown", "latest",
"none", bare uuids) across far fewer distinct values than rows (counts: see
the census), so `count(DISTINCT call_sid)` both invents calls that never
happened and collapses unrelated tickets into them. This file already documented that 14% of POSTs
once carried no usable CallSid — I wrote a rule on `IS NOT NULL` directly
beneath that knowledge. (Codex, PR #272; see also
`docs/BACKEND_HANDOFF.md`.)

**CLASSIFY THE CALL, NOT THE ROW.** The precedence above decides who made ONE
TICKET. A filing rate is per CALL, and a call can carry several tickets, so the
rows must be folded to one verdict per `call_sid` BEFORE anything is counted.
Classifying each row and then taking `count(DISTINCT call_sid)` inside each
group puts a call with both an agent filing and a staff ticket in TWO buckets,
and the buckets stop being exclusive without saying so (Codex, PR #272).

**AND THE TWO PRECEDENCES ARE DIFFERENT ORDERS. THIS IS THE PART TO READ
TWICE.** They look like a contradiction and are not, because they answer
different questions:

| | question | order | why |
|---|---|---|---|
| **row** | who made THIS ticket? | staff > agent > UNKNOWN | a named human creator is positive evidence; a set `agent_used` is not |
| **call** | did the AGENT file for this call? | **agent > UNKNOWN > staff** | see below |

The call order is not the row order inverted, which is what an earlier version
of this paragraph said and what the query below did (Codex, PR #272 round 2).
Three steps, and each earns its place:

1. **`agent` first** — one proven agent filing settles the call, whatever staff
   added afterwards.
2. **`UNKNOWN` SECOND, ABOVE `staff`** — a row with neither field set **may be
   an agent filing**. `staff` is a *proven negative*, and it only earns that
   when EVERY row on the call is a proven staff ticket. One unproven row means
   the call's provenance is not settled, and folding it into `staff`
   understates the filing rate by exactly the assumption bucket 3 exists to
   prevent.
3. **`staff` last** — every row proven human.

```sql
-- The filing test. Three buckets, canonical SIDs only, ONE verdict per call,
-- and bucket 3 never vanishes into ANOTHER bucket. No prefix filter, ever.
WITH per_call AS (
  SELECT call_sid,
         bool_or(created_by_id IS NULL AND agent_used IS NOT NULL) AS any_agent,
         bool_or(created_by_id IS NULL AND agent_used IS NULL)     AS any_unknown,
         bool_or(created_by_id IS NOT NULL)                        AS any_staff
  FROM tickets
  WHERE call_sid ~* '^CA[0-9a-f]{32}$'  -- NOT `IS NOT NULL`, NOT `LIKE 'CA%'`.
    -- THE CALL'S DAY, NOT THE TICKET'S. See below; the COALESCE is required.
    AND coalesce(call_start_time, created_at)::date = '<day>'
  GROUP BY call_sid
)
SELECT CASE WHEN any_agent   THEN 'agent'
            WHEN any_unknown THEN 'UNKNOWN'   -- NEVER below 'staff'. See above.
            ELSE 'staff' END AS provenance,   -- only when every row is proven
       count(*)              AS calls
FROM per_call GROUP BY 1;
-- `any_staff` is deliberately not read: it is the ELSE. Reintroducing it as a
-- WHEN above UNKNOWN is the round-2 defect.
-- All-time totals live in THE CENSUS above; do not copy them here. The
-- 2026-09-03 day figures are stated ONCE, under "Effect of the change" below.
```

**A FILING RATE IS PER CALL, SO THE DAY MUST COME FROM THE CALL — AND THIS ONE
IS LIVE.** Filtering on the TICKET's `created_at` puts a filing in a different
day's cohort than its call whenever the call crosses midnight or the ticket
outbox retries (up to 12 attempts, backoff 30s → 30m, so a 23:5x call can file
after midnight). The call is then scored a non-filing in its own cohort and the
ticket is added to a cohort whose denominator does not contain it. Measured
2026-09-05 11:11 UTC: **159 of 40,947** canonical-SID tickets land on a
different calendar day from their call (Codex, PR #272 round 4).

**`tickets.call_start_time` is the anchor, and `coalesce` with `created_at` is
NOT optional.** The naive fix — filter on `call_start_time::date` alone — is
WORSE than the bug it fixes, and the 2026-09-03 cohort is the proof:

| 2026-09-03, canonical-SID tickets | |
|---|---|
| by the TICKET's day (what was published) | 199 |
| would correctly LEAVE the cohort (call was another day) | 4 |
| would correctly JOIN it (ticket filed another day) | 2 |
| **have NO `call_start_time` at all — silently dropped by a bare filter** | **8** |
| by the CALL's day, with the coalesce | 189 |

Eight unanchored rows against four correctly moved: dropping them loses twice
what the fix gains, and it loses them the same way bucket 3 exists to prevent —
by assumption. 1,013 canonical-SID tickets carry no `call_start_time` at all.

**AND THE ANCHOR ITSELF HAS A BAD TAIL — do not treat it as exact.** 259
tickets have `created_at` EARLIER than their own `call_start_time`, which
cannot happen; the mean lag reads **-45s** while the median is a sensible
**+111s**, so outliers, not the typical row, drive the mean. Against
`call_end_time` the median is **-35s** — a ticket filed just before hangup,
which is the expected shape. Good enough to bucket a day, not good enough to
time a single call.

**`call_logs.created_at` would be the better anchor** — it is our own record of
the call rather than a value carried on the ticket — but `tickets` lives in the
Support Center (`vsmcxhxeirkoobmjcrbn`) and `call_logs` in the Hub
(`pslzngjciiifowemrzza`), so no single statement can join them. That is why the
ticket's own copy is used here.

**BOTH MIXED-PROVENANCE DEFECTS ARE LATENT, NOT LIVE — measured 2026-09-05
10:50 UTC, all time.** Of 40,931 calls carrying a canonical-SID ticket, every
mixed pair is **0**: agent+staff 0, agent+unknown 0, **staff+unknown 0**. So no
rate this file has ever published was touched by either the row-level
double-count or the UNKNOWN-under-staff fold — re-run under both orderings, the
bucket counts are identical to the call (agent 40,865 · staff 37 · UNKNOWN 29,
0 calls moved).

**The mechanism is live even though neither defect has fired:** 16 calls
already carry more than one ticket. One staff ticket on a call the agent filed
starts the first; one unattributed ticket beside a staff ticket starts the
second. Re-run this beside the census.

```sql
SELECT count(*) FILTER (WHERE any_agent AND any_staff)   AS agent_and_staff,
       count(*) FILTER (WHERE any_agent AND any_unknown) AS agent_and_unknown,
       count(*) FILTER (WHERE any_staff AND any_unknown) AS staff_and_unknown,
       count(*) FILTER (WHERE rows_for_call > 1)         AS calls_with_2plus_tickets
FROM (
  SELECT call_sid, count(*) AS rows_for_call,
         bool_or(created_by_id IS NOT NULL)                        AS any_staff,
         bool_or(created_by_id IS NULL AND agent_used IS NOT NULL) AS any_agent,
         bool_or(created_by_id IS NULL AND agent_used IS NULL)     AS any_unknown
  FROM tickets WHERE call_sid ~* '^CA[0-9a-f]{32}$' GROUP BY call_sid
) c;
```

**On 2026-09-03 the unknown bucket is EMPTY**, so the rates published in this
file are not exposed to it. That is a measured fact about one day, not a
property of the rule — check bucket 3 before quoting any other day.

**This section has now been wrong SIX times, on TWO different axes.** Four
were about WHICH SIGNAL says a call filed — three reached for a naming
convention, the fourth for a single column called complete. Two more were
about HOW THE ROWS ARE FOLDED INTO A CALL, and they only became reachable once
the signal was right. The through-line on both axes is the same: **adopting
one rule as definitive without enumerating how it fails**, which is what every
version of this did, including the one that had already published the table
disproving it. Recorded in full because the pattern matters more than the rule:

1. **`VA-` only.** Silently reports ZERO for a lane filing under another
   prefix. Every PCP ticket went missing this way (count: see the census).
2. **"any ticket, never filter by prefix".** Over-corrected — counts staff
   tickets as agent filings.
3. **"`VA-` + `PCP-`, and the other 72 sid-bearing rows are staff".** I
   established that by the ABSENCE of agent-output text markers. Codex pointed
   out those markers appear on only 45% of KNOWN agent filings, so their
   absence cannot classify anything — and checking the real metadata proved
   the claim false:

<a id="census"></a>
### THE CENSUS — the only place in this file that states these numbers

**Every figure below is as of `2026-09-05 10:42:04 UTC`, canonical SIDs only,
and CLASSIFIED PER CALL** (the row-level query these came from before
2026-09-05 could put one call in two buckets — see the filing test above).
Nothing else in this section restates them; other paragraphs say "see the
census" and stop. That rule exists because eight separate stale copies were
caught in this file, each one fixed in prose while a near-duplicate survived in
a query or a bullet. **If you add a number here, do not repeat it elsewhere —
link to it.**

| | value |
|---|---|
| calls with any ticket | 40,931 |
| **agent-filed** | **40,865** |
| unknown-provenance only | 29 |
| staff-created | 37 |
| the `VA-`/`PCP-` prefix rule would match | 40,858 |
| … **real filings it misses** | **7** |
| … filings it wrongly counts | **0** |
| dropped as sentinel `call_sid` | 217 rows across 61 distinct values |
| admitted by `LIKE 'CA%'` but not by the canonical validator | 1 |

Provenance census on the two prefixes that raised the question. **These are
ROWS, not calls** — this table is what proved the row-level precedence rule,
and per-call folding would hide exactly the both/neither columns it turns on:

| sid-bearing rows | human `created_by_id` | `agent_used` set | both | neither |
|---|---|---|---|---|
| `T-` (37) | **37** | 6 | **6** | 0 |
| `SR-` (36) | **0** | **7** | 0 | **29** |
| `VA-` control (40,664) | 0 | **40,664** | — | 0 |
| `PCP-` control (210) | 0 | **210** | — | 0 |

The `VA-` control read **6,495 rows with 1 neither** when it was written on
2026-09-04. It is 40,664 with 0 now — the row count could never have been
right beside an agent-filed total of 40,717 on the same line, since a lane
cannot file more calls than it has tickets. Whatever narrowed it is not
recoverable from the number alone. **A census row that contradicts another
census row is the cheapest bug in this file to catch and the easiest to
publish; read across the table before quoting down it.**

**THE TIMESTAMP IS NOT DECORATION.** Seven minutes earlier the same query
returned `T-` = 36 rows with **5** both, and the prefix rule's overcount read
**1** before sentinels were excluded. `tickets` is live and a row landed
mid-analysis. **Re-run before quoting; a bare number here is already drifting.**

`T-` is genuinely staff — every row has a named human creator. **`SR-` is
not:** some carry `agent_used`, i.e. they ARE agent filings, and the rest are
unattributed (counts: see the census). So "all 72 are staff tickets" was wrong, and excluding them all
would have dropped real filings.

4. **"`agent_used IS NOT NULL`, full stop".** The table directly above already
   showed why that fails and I published it without reading it that way:
   **`T-` rows have BOTH** a human creator and `agent_used`, so the predicate
   counts staff tickets as agent filings; and **`SR-` rows plus a `VA-` row
   have NEITHER** (counts: see the census), so NULL means unknown provenance,
   not a proven non-filing.
   Fixed by the ROW-level precedence rule at the top — a human creator wins,
   and unknown is a reported bucket rather than silence. (Codex, PR #272.)

**Then twice more, on the folding rather than the signal. Both found by Codex
on PR #272, both LATENT when found (see the mixed-pair control above), and the
second was created by the fix for the first:**

5. **Classifying the ROW and then counting distinct calls.** `CASE` per row
   with `count(DISTINCT call_sid)` inside each group puts a call carrying both
   an agent filing and a staff ticket in TWO buckets, so the buckets stop
   being exclusive without saying so. Fixed by folding rows to one verdict per
   `call_sid` first.
6. **Calling the call-level order "the row order inverted".** It is not. That
   phrasing produced `agent > staff > UNKNOWN`, which buries a call whose only
   unproven row might BE an agent filing underneath a proven staff ticket —
   the exact assumption bucket 3 exists to prevent, reintroduced one line
   below the rule forbidding it. The order is **`agent > UNKNOWN > staff`**.

   **The lesson is narrower than "be careful".** Fixing failure 4 moved the
   question from *which column* to *which row wins*, and I answered the new
   question with a slogan carried over from the old one instead of re-deriving
   it. A fix that changes the shape of a rule invalidates the sentence that
   justified the old shape; re-derive it, do not rephrase it.

**What the prefix rule costs: see [the census](#census).** It misses real
filings and silently scores unknown-provenance calls as non-filings. Two
earlier versions of this paragraph restated those totals inline and both went
stale within the hour — once from the superseded `agent_used IS NOT NULL`
test, once from counting sentinel `call_sid`s. That is why this paragraph now
names no numbers.

**`agent_used` is also immune to the failure that started this:** a new lane
gets a new prefix but still stamps the column, so it cannot silently zero
itself.

**AND NEVER USE ITS VALUE, even where its presence is used.** Presence alone
is not sound either — that is failure 4 above, which the precedence rule fixes.
The value is separately unusable: `agent_used = '<lane>'` is NOT lane attribution — on
2026-09-03 the ticket-side column read `unknown` on **91** rows and a bare uuid
on **3**, and grouping the day by it reported **optical = 1** when optical
actually filed 28. **Attribute a call to a lane with `call_logs.agent_used`,
which is the call's own record; the ticket's copy is for provenance only.** I
nearly wrote a new trap here of exactly the kind this section exists to
prevent.

**Effect of the change on the published 2026-09-03 numbers, re-measured under
the precedence rule, per call, canonical SIDs, anchored on the CALL's day**
(2026-09-05 11:12 UTC). This is the ONLY place the 09-03 day figures are
stated: **agent 196 · staff 1 · UNKNOWN 0 · every mixed pair 0**, against the
old `VA-` rule's **195** — the new rule adds **1** and loses 0, so it strictly
dominates the old one that day.

**Each fix moved these numbers and none moved the conclusion, which is the
point of stating them once.** Anchored on the TICKET's day they read agent 197
· staff 2 · VA- 196; the call anchor takes one off each column and leaves the
+1 delta exactly where it was. The corrected `agent > UNKNOWN > staff`
ordering moved nothing at all. The staff figure also read **1** on 2026-09-04,
went to **2** as a late staff ticket landed, and is **1** again under the call
anchor because that ticket belongs to another day's call — three different
values for one number, all correct for what they measured. The earlier version of this line said +2, which came from the
superseded `agent_used IS NOT NULL` test counting a STAFF ticket as an agent
filing (Codex, PR #272). Which lane the added call belongs to is NOT settled
here, because settling it needs the `call_logs` join rather than the
unreliable ticket column, and that has not been run. One call cannot overturn
the "filing rate is FLAT" headline (tech +2.6 points at n≈66, surgery +6.3 at
n≈32), but the per-lane percentages in the table above were derived under the
old rule and have not been re-derived under this one.

**How the prefix trap was found, kept because the discovery route matters.**
PCP files under `PCP-`, for the entire life of the line back to 2026-08-04
(counts: see the census). The old `LIKE 'VA-%'` rule
missed all of them and concluded the lane files nothing. It surfaced only
because tickets turned up for calls whose `tool_timeline` claimed no tool had
run: **two broken instruments disagreeing is what exposed the first one.** Had
they agreed, the wrong answer would have looked confirmed.

```sql
-- The control, per day. It uses agent_used (provenance), and reports the
-- prefix only so a prefix-shaped surprise is visible rather than silent.
SELECT split_part(ticket_number,'-',1) AS prefix, count(*) AS tickets,
       count(*) FILTER (WHERE created_by_id IS NOT NULL)                    AS staff,
       count(*) FILTER (WHERE created_by_id IS NULL
                          AND agent_used IS NOT NULL)                       AS agent,
       count(*) FILTER (WHERE created_by_id IS NULL AND agent_used IS NULL) AS UNKNOWN
FROM tickets
WHERE call_sid ~* '^CA[0-9a-f]{32}$'
  AND coalesce(call_start_time, created_at)::date = '<day>'   -- the CALL's day
GROUP BY 1 ORDER BY 2 DESC;
-- THIS ONE COUNTS ROWS, NOT CALLS — so it uses the ROW-level precedence (a
-- human creator wins), not the filing test's per-call one (any agent filing
-- wins). Both are correct for what they answer; see the note above the filing
-- test. Do NOT shorten this to `agent_used IS NOT NULL` — staff rows carry
-- BOTH fields (see the census for how many; the count drifts, the rule does
-- not).
-- This control is per-DAY and real-SID only, so its output is a day's shape,
-- NOT the whole-table figures that used to be pasted here (those were produced
-- by a different, unfiltered query and could not be reproduced from this one —
-- Codex, PR #272). For all-time totals see THE CENSUS; do not copy them here.
-- Do NOT reintroduce a prefix filter here. It was wrong three times.
```

**FOUR WAYS TO GET THIS WRONG, all of which I did:**

0. **USING THE TICKET PREFIX AT ALL.** Every variant of this failed: too
   narrow returns a plausible zero (a broken lane, not a broken query); too
   wide counts staff tickets as agent filings; a hand-validated set still
   missed real filings (count: see the census) and needed re-validating
   whenever a lane changed.
   `agent_used` is the provenance field and was in the table the whole time.
   If you find yourself reasoning about ticket-number naming to decide what a
   call did, stop — you are inferring provenance instead of reading it.

1. **`tool_timeline` DROPS ABOUT 35% OF SUCCESSFUL FILINGS.** On 2026-09-03,
   100 substantive queue calls read a real VA number to the caller and the
   timeline recorded 65. Three consecutive calls (VA-57425, VA-57428,
   VA-57429) had a real ticket and NO filing event in the timeline at all.
   That is #77, and it is live on the runtime, not historical.
   **On PCP the drop is 100%, not 35%.** All three runtime calls on
   2026-09-04 recorded ZERO timeline events and NULL `tool_call_count`, and
   two of them filed real tickets (PCP-57486, PCP-57487). Do not read an
   empty timeline as "no tool ran" on any runtime lane, and never on PCP.
   **The timeline IS reliable for refusals** (`outcome.missingFields`) — use it
   for those and nothing else.
2. **The transcript `VA-#####` proxy OVER-counts.** It caught 9 extra calls on
   2026-09-03 — every one a caller ringing to chase an existing request and
   `check_open_tickets` correctly reading it back to them. Three separate calls
   from one number all quote VA-57151. That is the tool working, not a filing.
3. **2.6% of tickets carry a `call_sid` from a LATER call** (5 of 196, average
   49 minutes later, sometimes a different caller entirely). Call attribution
   is being overwritten after the fact — related to #71. Small enough not to
   move a rate, big enough to ruin a single-call forensic.

**And `call_logs.total_turns` counts something that is not transcript turns.**
It fell 16.1 → 9.7 across the tech cutover while the callers actually said
MORE. Count `CALLER:` lines in the transcript instead.

---

## Measured numbers — use these, don't re-derive them

- **Gate B replay** (same corpus, same referee), failure rates:
  answering service 57.5% → 34.6% → **19.1%**; PCP 61.1% → **28.6%**;
  after-hours 36.3% → **25.1%**; **SD not ready (books 8 of 21).**
- Question repetition across lines: 433 calls → 41 → **0** (ticket agent).
- **Haiku TTFT ~791ms** (viable for voice). **Sonnet 1,730ms** (too slow).
- Prompt caching: 10,576 → 94 input tokens, but only ~800ms saved — latency is
  **generation-bound, not prompt-bound.**

**Ticket path, measured 2026-09-01 over the preceding 14 days.** All of these
came from `voice_agent_api_logs` in the Support Center (`vsmcxhxeirkoobmjcrbn`)
or `call_logs` in the Hub. Do not re-derive them; do re-measure before quoting
them as current.

- **20% of queue create-ticket POSTs are refused with HTTP 400** — 664 of
  ~3,200. 602 of those are one message, *"Missing required information:
  surgeon"*, across **181 surgery calls**: 3.3 identical doomed POSTs per call,
  because the tool answered `retryable: true` and the model obliged. Fixed
  2026-09-01; the refusal is now a question.
- **14% of POSTs carried no usable CallSid** ("unknown", "none", "N/A", a uuid)
  while **every one of the 2,926 queue calls had a real CA-prefixed SID on its
  `call_logs` row**. The model was overwriting the injected value. Fixed.
- **With an idempotency key, duplicate filing is 3 calls in 2,086 (0.14%).**
  The key works; the exposure was always the payloads without one.
- **Requests lost to a gate:** 107 calls in 14 days called a filing tool, were
  refused for a missing field, and ended with no ticket. Still missing at the
  hang-up: optical/location **62**, date-of-birth only **23**, callback number
  **2**, no usable identity **20**.
- **Filing-stop detection:** runs of consecutive queue calls with no ticket were
  185 once (the 08-31 outage) and never above 8 otherwise. The alarm fires at 12
  and would have caught 08-31 at **20:23:06**, seven minutes in.
- **`lookup_patient` times out (6s budget) on 13–17% of queue calls** — 475
  events, 314 calls. It is the first tool every queue call runs. Unfixed (#68).
- **Ticket write-back is NOT broken** (it was on the list as if it were):
  187 vs 184, 183 vs 178, 145 vs 139 on clean days — 97–98%.

**The runtime's first full day, 2026-09-03. Measured with the authority above,
over every queue call since each lane's own cutover. Do not re-derive these.**

- **A REFUSAL THE MODEL CANNOT DIAGNOSE IS A REFUSAL IT REPEATS.** This is the
  finding of the day and it generalises past dates of birth:

  | gate hit | calls | still filed |
  |---|---|---|
  | `date_of_birth` | **23** | **0** |
  | optical `location` | 11 | 9 |
  | `resolve_location` called with no argument | 14 | 5 |
  | no gate at all | 121 | 83 |

  Both of the first two are refusals. One killed every call it touched and the
  other was survivable, and the difference is not severity — it is whether the
  CALLER's answer can satisfy it. The model was omitting `date_of_birth`
  entirely, so no answer ever could. Fixed by giving `MissingFields` a `fix`
  channel that tells the model what IT got wrong, separate from `message`,
  which is what the agent SAYS.
- **The model does not send `date_of_birth` unless told to.** `dobShape` was
  `"(none)"` on 5 of 5 observed refusals. Calls filed anyway when
  `lookup_patient` made a CERTAIN match and the handler fell back to the
  verified record — which is exactly why the loss looked random.
- **53 substantive queue calls produced no ticket** (2 of them correctly — they
  were "what time do you close?"). The taxonomy:
  23 the date-of-birth gate · 12 asked for a human then hung up ·
  7 no tool ever ran · 9 other.
- **The teardown sweep as built recovers only 6 of those 53.** 47 skip on
  "no name, no ticket", because the calls that get lost are exactly the calls
  where identification failed. The identity rule selects against the population
  it exists to serve. **Open question for Wayne.**
- **Pre-context produced a usable name on ZERO substantive queue calls — and
  the REASON stated here was wrong.** Re-measured 2026-09-05 over the 186 grok
  queue calls of 2026-09-03 lasting >=30s, 170 distinct caller numbers:

  | where the number was looked for | found (of 170) | resolve to ONE person |
  |---|---|---|
  | `si_persons` (3,774 rows) | **3** | 3 |
  | `patients_master` (915,843), all five phone columns | **135** | **107** |

  The person base HAS these callers. What is withdrawn is the *diagnosis*: the
  earlier entry asserted pre-context reads `si_persons` and concluded the fix
  was to point it at the mirror. **That premise is contradicted inside this
  repo and is NOT settled.** The Console's only phone→person RPCs —
  `pm_find_by_phone`, `pm_find_by_dob`, `pm_find_by_name_dob` — all read
  `patients_master` and none touch `si_persons`; `pm_find_by_phone` returns in
  **13ms** on five index scans, so neither table size nor the 1.5s deadline is
  explained by the database. `voiceAgentRoutes.ts:2481` says `patients_master`
  and cites the service's `sage-tools.ts`; `voiceRuntime.ts:715` says
  `si_persons`. That service is not in this repo, so **which table
  `sage_precontext` actually reads over HTTP is UNKNOWN from here.** Do not
  ship a "point it at the mirror" change until that is established — it may
  already be pointed there.

  **The OUTCOME is not in doubt, and it is not runtime-specific.** On
  2026-09-03, `"am I speaking with"` appears in **0 of 196** old-core and
  **0 of 186** runtime substantive queue transcripts. Nobody was greeted by
  name on either stack, so this is not something the cutover introduced.

  **The one-word diagnostic is already deployed, and it is console-only** —
  no SQL can reach it. `[runtime] pre-context <slug> <sid>:` prints
  `unavailable` (failed, or past the 1.5s deadline) / `no_match` (ran, vouched
  for nobody) / `recognised`. Read that line before theorising; it separates
  all three causes at once.

  A phone match stays a candidate to CONFIRM, never an identity: 28 of the 135
  resolve to 2–3 people (avg 2.18).
- **`call_logs.caller_name` IS NOT A PATIENT MATCH, and the runtime never
  writes it.** Same day: the old core set it on 133 of 196 substantive calls,
  the runtime on **0 of 186**. Of the old core's 133, **123** are `[Lookup] …`
  — Twilio's CNAM, i.e. the name on the phone bill, which
  `azulSchedulingAgent.ts:1053` already documents as the wrong person ("the
  console was showing the phone bill"). **0** carry the verified `✓`. So the
  column measures a telco lookup on one stack and nothing at all on the other.
  Any "callers identified" rate built on it is measuring neither.
- **13 calls played the greeting twice or three times**, averaging 175s against
  a fleet average of 89. Six of the seven worst were a caller asking for
  another language during the opening.
- **Nothing else failed all day.** No timeouts, no transport errors, no
  provider failures. The entire error inventory is the table above.
- **THE VAD THRESHOLD WAS TOO HIGH, and this is the one number that changed
  overnight.** xAI's `threshold` takes 0.1–0.9 and defaults to 0.85; we were
  running the default. "Barely heard" — a call of 30s+ where the caller was
  transcribed at most ONCE — on the two lanes that ran both pipelines:

  | lane | old core | runtime at 0.85 |
  |---|---|---|
  | surgery | 6/46 = 13.0% | 13/40 = **32.5%** |
  | tech | 7/75 = 9.3% | 18/76 = **23.7%** |

  Bimodal, which is what names the cause: when the VAD DOES fire the runtime
  captures MORE than the old core (tech 348 chars vs 324, in fewer longer
  segments). Segments are failing to start, not to finish.
  **Now 0.6, env-tunable via `RUNTIME_VAD_THRESHOLD`, clamped to 0.1–0.9.**
  0.6 is a judgement; "too high" is the measurement. Re-measure both numbers
  together — barely-heard must fall AND interruptions per call must not climb,
  because the opposite failure is the agent stopping for a cough.
- **Grok reports NO token usage.** 0 of 18 calls after the telemetry landed
  carried any, and xAI's Voice Agent docs do not document a `usage` object on
  `response.done`. The old core reports it on 172 of 184 (avg 20,859 cached
  input tokens against 2,545 uncached — the cache does almost all the work).
  So cost-per-call is not comparable between pipelines today, and
  `total_cost_cents` on a grok row is not built from token counts.
  **The route is the bill, not the wire** — see the cost section below.

---

## WHAT A CALL COSTS — and why the Grok number was never a measurement

**Measured 2026-09-04, all 241 Grok rows on disk.** Every one carries
`cost_is_estimated = true` and `cost_reconciled_at` NULL. Those two columns
have existed since the schema was written and until now had never once been
used on any row, either pipeline.

| | |
|---|---|
| summed seconds | 25,259 (421 min) |
| exact at the published $0.08/min | **$33.68** |
| what is actually stored | **$34.86** |
| overstatement from `Math.ceil` alone | **$1.18 = 3.5%** |

Every row matched `Math.ceil(duration * 8/60)` exactly — 0 mismatches — so
the formula is applied consistently. It is the **per-call ceil** that
inflates, in the same direction on every single call. Do not quote a Grok
cost-per-call as a measurement, and do not compare it against the old core's
token-derived cost: one is a bill, the other is a constant times a duration.

**xAI's published rates for `grok-voice-think-fast-2.0`: `$0.08 / min audio`
AND, separately, `$0.004 / text input`.** We have only ever counted the
first. Whether the second is material is not a thing to reason about — it is
a thing the invoice answers.

**THE ROUTE IS xAI'S MANAGEMENT API, which is a different host and a
different credential from the one the runtime already uses.**

```
base     https://management-api.x.ai          (NOT api.x.ai)
auth     Authorization: Bearer <management key>
key      xAI Console -> Settings -> Management Keys   (NOT XAI_API_KEY —
         the inference key cannot read billing)
team     console.x.ai/team/default/settings/team

POST /v1/billing/teams/{team}/usage    -> spend per day (TIME_UNIT_DAY)
GET  /v1/billing/teams/{team}/postpaid/invoice/preview
     -> unitType, unitPrice, numUnits, amount
```

`invoice/preview` is the more interesting one: `unitPrice` is xAI's flat rate
stated by xAI rather than transcribed from a pricing page, and `numUnits` is
**how many units they counted**, which is the only way to learn whether they
bill the duration Twilio reports.

**The method, which is Wayne's:** IF a flat per-minute rate is what we are
charged, cost is proportional to duration and nothing else, so a day's
authoritative total splits across that day's calls by their seconds. Built in
`src/services/grokCostAllocation.ts` (largest remainder: no cent invented,
none lost, deterministic), `xaiBilling.ts` and `grokCostReconciler.ts`.

**READ THAT `IF`.** The DAY'S TOTAL is what xAI reported and the arithmetic
preserves it exactly — no cent invented, none lost. The PER-CALL SHARES are an
apportionment, and they are only each call's true cost if the bill really is
proportional to Twilio seconds. That proportionality is unproven and is the
open question of this whole section. An earlier version of this paragraph said
the split "is not an estimate", which was true of the day and false of the
call, and it sat here contradicting the caveat further down. (Codex, PR #269.)

**It is DORMANT until `XAI_MANAGEMENT_KEY` and `XAI_TEAM_ID` are set.** It
says so once at boot and does not schedule — a reconciler that writes a wrong
number is worse than one that writes nothing, because "estimated" is honest
and a reconciled number is believed.

```sql
-- Was 241 of 241. Now 2 (both 2026-08-31, older than the nightly runner's
-- yesterday-only window). Any number here is calls still priced from a constant.
SELECT count(*) FROM call_logs
 WHERE voice_provider = 'grok' AND cost_reconciled_at IS NULL;
```

## THE RECONCILER RAN: xAI REPORTED $53.55 OF VOICE SPEND, WE HAD BOOKED $34.66

**2026-09-04 09:39 UTC, the first reconciliation ever performed.** Wayne set
`XAI_MANAGEMENT_KEY` / `XAI_TEAM_ID` and republished; the nightly runner
settled 2026-09-03 and wrote 239 rows. `cost_reconciled_at` went from 0 of
86,516 to 239. **Do not re-derive these; re-measure before quoting them.**

| 2026-09-03, 239 runtime calls | |
|---|---|
| seconds WE recorded (the allocation's denominator) | 25,116 (418.6 min) |
| our estimate, `ceil(duration x 8/60)` per call | **$34.66** |
| **xAI-reported Voice spend** (`POST /usage`) | **$53.55** |
| gap | **+$18.89 = +54% on our estimate** |
| spend / OUR minutes | **12.79 c/min** — a RATIO, not xAI's unit price. See below. |

**AND IT IS SPEND, NOT AN INVOICE.** The reconciler calls
`POST /v1/billing/teams/{team}/usage` and nothing else. `invoice/preview` —
the endpoint that returns line items, `unitType`, `unitPrice` and `numUnits` —
**has never been called.** Every "xAI's actual invoice" in an earlier version
of this section, and in PR #269, was this usage total wearing a word it had
not earned: it says what they charged, not what they counted or how. (Codex,
PR #269.)

**THE 3.5% `Math.ceil` OVERSTATEMENT WAS TRUE AND IRRELEVANT.** It compared
our estimate against `duration x published rate`. Both sides of that
comparison were wrong about the bill. The rounding error was worth $1.18;
our estimate being wrong is worth $18.89 on one day. **Note which noun that
is** — the estimate, not the rate. Attributing the $18.89 to the rate is the
claim corrected two sub-sections down, and it crept back into this sentence
after being removed from that one.

### The cause is inside the VOICE LINE, not the text tokens

**I got this wrong first and the correction is the useful part.** From the
usage CSV alone — tokens up 364x on the cutover day, 4,570,953 of them — I
concluded the gap was the separately-billed `$0.004 / text input` component,
because 4.57M x $0.004/1k = $18.28 sits right on the $20.06 gap. **That fit
was a coincidence.** The operator's console screenshot, which splits spend by
API TYPE, killed it in one line:

| API type, Aug 29 – Sep 4 | spend |
|---|---|
| **Voice** | **$104.04** |
| **Text** | **$5.64** |
| Image & Video / Storage | $0.00 |

Text is $5.64 for the WHOLE WEEK. On 2026-09-03 it is $5.35 of $58.90 — about
a tenth. It cannot be a $20 gap.

**The token explosion is real and nearly free**, because prompt caching is
working. The console's own text breakdown, with the rate each line implies:

| | usage | spend | per 1k |
|---|---|---|---|
| prompt text tokens | 1.2M | $2.38 | $0.00198 |
| **cached** prompt text tokens | **3.1M** | $1.53 | **$0.00049** |
| reasoning text tokens | 272.5K | $1.63 | $0.00598 |
| completion text tokens | 15.7K | $0.09 | $0.00573 |

**72% of prompt tokens are served from cache at a quarter of the price**, which
is why the token explosion is real and nearly free: the text lines above come
to about $5 on the week, not $20. **No per-call figure belongs in that
sentence** — an earlier version said "3,275 requests for 239 calls, 13.7 per
call", which is the whole account's request count divided by the voice-call
count, and the section below explains why that division is invalid. It was
removed there and left standing here; see the note under the table.

**So the gap is inside the Voice line, and the careful statement of it is:
xAI-reported voice spend was about 60% above `$0.08 x the duration WE
recorded`.** Both nouns matter — reported spend, our duration. That is all the
arithmetic supports.

**IT IS NOT "WE ARE CHARGED 12.79 c/min".** An earlier version said exactly
that, and it is the same mistake as the token division one section down,
committed a third time: 12.79 is $53.55 divided by OUR 418.6 minutes, and
xAI's unit price is $53.55 divided by THEIR unit count, which we do not have.
The very next sentence already conceded that xAI may count a duration we do
not report — so if that is what happened, 12.79 is not a rate at all, it is
our own denominator wearing a rate's units. Asserting it assigned the whole
discrepancy to the rate card before anything had established that is where it
lives. (Codex, PR #269.)

The three live candidates, none of them ruled out: a stale published rate;
audio tokens billed on top of the minute; or a billed duration longer than
Twilio's — session wall-clock including setup, or a per-call minimum.

**`numUnits` is the number that separates them**, because it is how many units
xAI counted. `GET /v1/billing/teams/{team}/postpaid/invoice/preview` returns
it alongside `unitType` and `unitPrice`, and the console's Breakdown panel has
a `Voice` tab beside the `Text` one that gives the same split the text table
above came from. Either settles it; neither has been opened.

**What this cost me, recorded because it is the recurring failure:** I fitted
a hypothesis to two aggregate numbers, got a 3.4% match, and wrote it into
this file as settled. A per-component breakdown existed the whole time and I
had not asked for it. *Before quoting a rate, find the control that proves
the measure* — the same lesson as the `tool_timeline` filing rates, one
section up.

**AND THERE IS NO PER-CALL TOKEN FIGURE HERE, DELIBERATELY.** An earlier
version of this section divided the day's 3,275 requests and 4.57M tokens by
239 voice calls to get "13.7 requests per call" and a marginal prompt cost.
Both denominators are wrong: those totals are the WHOLE account, voice and
text, and contaminating them that way makes a modelled cost look *closer* to
the reported spend rather than further from it — which is how the original
3.4% "fit"
flattered itself twice over (Codex, PR #269).

What the console actually supports, and nothing beyond it:

- The week's text tokens (1.2M + 272.5K + 3.1M + 15.7K = 4,588,200) account
  for essentially all 4,606,021 tokens on the account. **Voice is billed by
  the minute and contributes no measurable tokens.** So the token column
  describes the text API, not the phone calls, and cannot be divided by a
  call count at all.
- Text is **$5.35 on the day, ~10% of it**, and prompt caching is doing most
  of the work.
- **Voice is $53.55 of reported spend against 418.6 minutes WE recorded, and
  that is the whole question.** Both nouns, every time: what they reported,
  what we measured. xAI's own billed duration is not known.

**So trim prompts for latency and for the ceilings — the reasons that were
always true and never needed a dollar figure.** Anyone wanting the billing
argument for a trim has to get per-call units out of the `Voice` breakdown or
`invoice/preview` first. **The voice line is where the $18.89 was on
2026-09-03** — one measured day, not a daily rate.

**What this changes, scoped to the one day that has been reconciled:** on
2026-09-03 our estimate understated xAI's reported spend by about a third. **That
percentage is NOT known to hold on any other day.** If the gap is a per-call
minimum or a setup component rather than a rate, its size moves with the day's
call-duration mix — a day of many short calls would carry a larger uplift than
a day of few long ones. One day is one day.

**AND NOT EVEN THE DIRECTION IS SAFE.** An earlier version of this paragraph
said the sign generalises even if the magnitude does not. It does not follow.
Our estimate is `ceil(duration x 8/60)` PER CALL, which overstates on every
call, and a per-call minimum on xAI's side also scales with call count — so on
a different mix of calls the two move together and could offset or invert.
Under-booking is established for 2026-09-03 and for no other day. (Codex,
PR #269.)

**On 2026-09-03, average Voice spend per call exceeded our average estimate.**
That is the scoped form, and it is as far as this goes: an earlier version said
"the runtime is materially more expensive per call", which is categorical, and
sat directly below the paragraph withdrawing even the direction. It also spoke
per CALL when the measurement is an aggregate average and the per-call shares
are an apportionment. Whether the runtime is more expensive per *resolved
request* is a different question again and has not been measured.

**WHAT THE ALLOCATION IS PROVEN TO DO, AND WHAT IT IS NOT.** Checked, not
assumed: the voice filter matches only the `grok-voice` series so non-voice
grok spend is excluded; 0 of 239 reconciled rows are still flagged estimated;
0 have a total disagreeing with their parts.

Every one of those checks is about the DAY TOTAL and its bookkeeping. **None
of them establishes that the 239 per-call shares are right.** The split is
proportional to Twilio seconds, which is correct only if the bill is
proportional to Twilio seconds — and that is precisely the open question. If
the gap turns out to be a per-call minimum or a setup component, those pieces
are NOT proportional to duration, so a long call is currently carrying some of
a short call's cost.

So: **the day's total is authoritative, the per-call figures are an
apportionment.** That distinction matters more than it looks, because
`cost_is_estimated = false` on those rows tells every reader they are settled
truth, and per-call and per-lane cost analytics read them as such.
Treat a single call's Grok cost as indicative until `numUnits` establishes what
xAI actually counts. (Codex, PR #269.)

**THE GUARD NOW MATTERS.** It has a live population to defend for the first
time — 239 rows carry a reconciled allocation of xAI-reported spend, which an
estimate must never overwrite. Not an invoiced cost: `invoice/preview` has
never been called.
Everything below this line was written when that number was zero.

---

**THE COST-COLUMN GUARD HAD NEVER FIRED, AND THAT WAS THE POINT.** Measured
2026-09-04 while PR #268 was in review. Rounds 11–13 turned up six findings
and four of them were the same sentence — "an estimate overwrites the
reconciled bill" — so it was worth knowing whether that had ever actually
happened before claiming the fixes mattered:

| control | result |
|---|---|
| rows with `cost_reconciled_at` set, **all time, both pipelines** | **0 of 86,516** |
| Grok rows priced at the correct `ceil(duration * 8/60)` | **241 of 241** |
| Grok rows priced at OpenAI's `ceil(duration * 0.19)` | **0** |

So every one of those defects is **latent, not live**. The reconciler has
never run, so the guard's condition has never been true; and the admin
recalculate button has never been pressed on a Grok row, or the second row
would be under 241. This is the "before" number for
`docs/BACKEND_HANDOFF.md`'s rule — re-run all three after the reconciler is
switched on, and the first one going non-zero is the moment the guard starts
mattering.

```sql
-- Re-run this trio before quoting anything about cost preservation.
SELECT count(*) FILTER (WHERE cost_reconciled_at IS NOT NULL)             AS ever_reconciled,
       count(*) FILTER (WHERE voice_provider = 'grok'
                          AND openai_cost_cents = ceil(duration * 8.0/60)) AS at_grok_rate,
       count(*) FILTER (WHERE voice_provider = 'grok'
                          AND openai_cost_cents = ceil(duration * 0.19)
                          AND openai_cost_cents <> ceil(duration * 8.0/60)) AS at_openai_rate
FROM call_logs WHERE duration IS NOT NULL AND duration > 0;
```

---

## THE OBSERVATORY WAS BLIND TO EVERY RUNTIME CALL — fixed 2026-09-04

Measured over every call since 09-01: **100% of old-core rows carried
`agent_id`; 0 of 239 runtime rows did.** The runtime opened its `call_logs`
row with the lane slug and nothing else, and the slug is not what anything
reads. Five places join `agents` on the uuid — the Observatory scorecard and
today view, the cost analytics (`routes.ts:2281`), the quality and sentiment
analytics (`routes.ts:2463`), and `storage.ts:523`. So at 15:24:58 on 09-03,
the moment optical cut over, it stopped existing in all five. **Not wrong,
ABSENT — and an absent lane looks like a quiet lane.**

- Fixed at the source: `src/runtime/agentIdentity.ts` resolves slug →
  `agents.id`, once per lane per process. A miss is deliberately **not**
  cached, so a lane whose agents row is added later is picked up without a
  redeploy.
- **259 existing rows were backfilled** from the slug they already carried
  (every slug matched exactly one agent). Reversal snapshot kept in
  `call_logs_agent_id_backfill_20260904`. Yesterday's cutover is visible.
- The Observatory also had no concept of `voice_provider`, so the cutover
  itself was invisible on the one screen built to watch these agents. Each
  card now names its pipeline and says **"mixed pipelines — do not read these
  as one population"** on a lane that cut over mid-day.

Still not attributable, and left alone: 98 rows with a NULL `agent_used`
(Nov–Jan), 14 `greeter`, 5 `claude-as`. None are current lanes.

---

## How to tell whether a deploy actually took

Wayne pulls and republishes on Replit. **A failed pull looks exactly like a
failed fix.** On 2026-08-11 a GitHub rate limit at 00:34 UTC made his pull fail;
he called at 00:36 and I spent the next round analyzing stale code.

Before drawing any conclusion from a call, look for a log line that only exists
in the new build. Current marker:

```
[ScheduleLookup] 20 row(s) as of 2026-08-10 -> 3 past visit(s), 0 upcoming;
  last visit 2026-07-13; 17 not counted (cancelled, no-show, or cancelled-future)
```

**ON THE RUNTIME, ASK `/voice/health` — AND THE MARKER NOW CARRIES ITS DATE.**

```
voice-runtime-v3-precontext-diagnosable-20260905
```

Also printed at boot as `[voice-runtime] <marker>`. Anything ending in an
EARLIER date, or with no date at all, is a build older than 2026-09-05 and
nothing measured on it is evidence about current code.

**This exists because the marker failed at the one job it has, on 2026-09-05.**
It read `voice-runtime-v2-transfer-guardrails-tools` from 2026-08-29 straight
through to 2026-09-05, unchanged across every commit between — including
`91498ff` on 08-31, which added the `[runtime] pre-context` diagnostic. Wayne
searched a live deployment for that line, found nothing, and **the marker could
not say whether the build contained it**: the identical string is served either
side of the change. Neither could the rest of the payload — `transferDestinations`
landed 08-30, one day too early to discriminate. The only health field that
dates a build at all is **`lanes`**, added 09-04.

So: the rule "bump it on every ship whose effect is hard to see" was already
written at the top of `src/runtime/readiness.ts` and was not enough on its own.
The date is now in the string, `markerSetOn()` parses it back out, and
`readiness.test.ts` fails if a future bump drops the suffix.

### AN ABSENT RUNTIME LOG LINE USUALLY MEANS NO RUNTIME CALLS

**The build was current all along, and the missing line meant nothing.** Both
halves came out of `call_logs`, which is where this should have started:

- **The build is ≥ 2026-09-04.** 405 grok rows carry an `agent_id` that the
  live process stamped itself — they are NOT in the 259-row backfill snapshot
  `call_logs_agent_id_backfill_20260904` — and `src/runtime/agentIdentity.ts`
  merged 2026-09-04 03:45 UTC. Earliest such call 2026-09-04 15:01:28 UTC. So
  the deployed code is newer than the 08-31 log line by a clear margin.
- **The runtime served ZERO calls that day.** Last grok call
  2026-09-04 23:55:48 UTC. Every one of 2026-09-05's 49 calls was `no-ivr` on
  the OLD CORE, 00:01–06:15 UTC. Nothing ran, so nothing printed.

**AND THAT IS THE NORMAL WEEKEND SHAPE, not an outage.** Queue lanes take
essentially nothing Saturday or Sunday — 08-22: 1 queue call vs 155 no-ivr ·
08-23: 1 vs 59 · 08-29: 0 vs 120 · 08-30: 0 vs 36 · 09-05: 0 vs 49. Standing
instruction 13 routes it all to the after-hours agent, which is old core.

```sql
-- Before concluding a runtime log line is missing, ask whether the runtime
-- ran at all. Substitute the day.
SELECT coalesce(voice_provider,'old-core') AS pipeline, agent_used, count(*),
       min(created_at AT TIME ZONE 'UTC'), max(created_at AT TIME ZONE 'UTC')
FROM call_logs WHERE created_at::date = '<day>' GROUP BY 1,2 ORDER BY 3 DESC;
```

**To read the pre-context diagnostic you need a runtime call first.** On a
weekday the queue lanes open around 15:00 UTC (first grok call was 15:24 on
09-03, 15:01 on 09-04). On a weekend, one test call to a queue number is the
only way to produce one.

**If the marker is absent, the code is not live and the call proves nothing.**
Whenever you ship something whose effect is hard to see, add a marker like this.

Markers added 2026-09-01, all on the branch `claude/determined-brown-o5qsft`
(PR #244). Two print at boot, so they are the fastest way to tell whether a
pull took:

```
[TICKET OUTBOX] Starting retry worker (every 60s; up to 12 attempts,
  backoff 30s → 30m; queue payloads re-sent verbatim)
[ALERT SERVICE] Starting ticket-filing alarm (every 5 minutes)
```

The other three print only when the thing they watch happens, which makes each
of them a live counter as well as a marker:

```
[TOOLS] file_surgery_ticket: kept the call's call_sid over the model's "unknown"
[TICKET FILING] surgery: create-ticket REFUSED the payload (HTTP 400) — ...
[PROMPTS] ✗ REFUSED a write to agent_prompts for "<slug>"
```

One of them needs no log at all: after the deploy, **no create-ticket POST
from a queue agent should carry a `callData.callSid` that does not begin with
`CA`.** Before it, 6–8% of live POSTs did.

Marker added 2026-09-03 on the runtime (`src/runtime/toolCeiling.ts`). It
prints only when a repeated-failure loop is stopped, so it is a live counter
too — and it never carries arguments, because they hold PHI:

```
[TOOL CEILING] file_optical_ticket not dispatched — 3 consecutive failures
  with the same arguments; answering with the tool's own refusal and telling
  the agent to speak to the caller
```

Its no-log check is the one that matters, and it is SQL:

```sql
-- After the deploy this should return nothing. Before it, one optical call
-- on 2026-09-03 returned 118.
SELECT call_sid, tool_call_count FROM call_logs
WHERE voice_provider = 'grok' AND tool_call_count > 40;
```

Markers added 2026-09-03 (late), all on `claude/determined-brown-o5qsft`.
Each prints only when the thing it watches happens, so each is a live counter:

```
[DOB] refused a date of birth in the shape # # ##      <- and "(none)" is the
[DOB] refused a date of birth in the shape (none)         one that matters
[REQUEST SWEEP] tech: recovered request filed as VA-… (CA…)
[REQUEST SWEEP] surgery: a request was made and nobody was identified —
  not filed, needs a callback (CA…)
[TOKENS] usage reported by the provider on this response: <keys>
```

`dobShape` also lands in SQL, which is how the date-of-birth question was
finally settled — the log line is convenience, this is the evidence:

```sql
SELECT e->'args'->>'dobShape', count(*)
FROM call_logs c, LATERAL jsonb_array_elements(c.tool_timeline->'events') e
WHERE e->'args' ? 'dobShape' GROUP BY 1;
-- "(none)" means the MODEL omitted the field. Anything else means the parser.
```

Markers added 2026-09-03 to the ticket-filing alarm
(`server/services/ticketFilingHealth.ts`, `ticketFilingPulse.ts`). The first
prints every five minutes and now names what it did NOT count; the second
prints only when a run reached the threshold and was disconfirmed, so it is a
live counter of false alarms prevented:

```
[ALERT SERVICE] Ticket filing OK — 3 call(s) since the last ticket
  (2 greeting-only hangup(s) not counted), 0 held in the outbox
[ALERT SERVICE] Ticket filing alarm HELD — a run of 12 reached the threshold
  but a ticket was confirmed filed inside it; filing has not stopped
```

The alarm email now carries `greetingOnlySkipped` beside `unfiledRun`, so a
future alert says how much of its run was hangups without anyone re-deriving
it. On 2026-09-03 18:24:56 that ratio was 4 of 12.

---

## My recurring failure modes — check yourself against this list

1. **Building instead of swapping.** He asked for a pipeline swap; I built a
   whole new agent (a state machine). Days lost.
2. **Patching symptoms.** Fix on top of fix on top of fix. He named this
   repeatedly and was right every time.
3. **Making him the test harness.** Changing code and asking him to dial to
   find out if it worked.
4. **Filling gaps instead of asking.** Inventing procedure he never approved.
5. **Losing context and re-asking / re-proposing** what was already decided or
   already built. This file is the fix. Use it.
6. **Declaring success before evidence.** Report what the log actually shows,
   including when it shows nothing.
7. **Theorising instead of diffing.** On 2026-08-12 I stated three wrong root
   causes out loud for one bug. What found it was a *control* — Wayne asking why
   Optical could file a ticket when Surgery could not. Two paths through the same
   code, one working: diff them before theorising. See
   `.agents/memory/realtime-tool-schemas.md`.
8. **Quoting a number without checking the instrument.** 2026-09-03: I
   reported filing rates all afternoon from `tool_timeline`, which silently
   drops a third of successful filings. Every number was understated and I only
   caught it because three consecutive calls read out a ticket number the
   timeline said did not exist. **Before quoting a rate, find the control that
   proves the measure** — see the measurement section above.

9. **Accepting a constraint as immovable.** I treated "the API has no way to
   express *no category*" as the end of the discussion. Wayne: *"why don't you
   just create one?"* Ask whether the constraint can be changed before designing
   around it.

---

## Where to look next

Full running history, decisions and open items:
**`docs/observatory/STATE-OF-PLAY.md`** — read it with this file.

Hard-won specifics, one topic per file, indexed in **`.agents/memory/MEMORY.md`**.
Start there before debugging anything in these areas:

| If you are about to… | Read first |
|---|---|
| debug "the agent won't call the tool" | `realtime-tool-schemas.md` |
| build or change a queue agent | `queue-agents.md` |
| file, route or classify a ticket | `ticketing-api-contract.md` |
| touch ticket creation on the after-hours path | `ticket-creation-lock.md` |
| quote a number at Wayne | `measurement-traps.md` |
