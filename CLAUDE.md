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
    | phone → patient; powers `sage_precontext` | `si_persons` | 3,731 |

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
      `fetchAzulPrecontext` → the `sage_precontext` HTTP tool. That is Console
      data (`si_persons`) but over the network and bounded at 1.5s, and every
      failure is normalized to `null`, so the agent asks cold for several
      different reasons. The RETURN VALUE is indistinguishable; the logs are
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
| **pcp** | **OFF** in Twilio | — | — | — | Wayne's decision, Aug 10. Do not ask why. |
| **azul-scheduling** (San Diego) | **OFF** | — | — | — | Gate B replay books 8 of 21. Not ready. Do not ask why. |
| **answering-service** | old core | — | — | — | — |

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
    `si_locations`, `si_persons` (phone→patient, powers `sage_precontext`),
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

**THE AUTHORITY: a call filed a new ticket iff its `call_sid` appears on a
`VA-` ticket in the Support Center (`vsmcxhxeirkoobmjcrbn`).**

```sql
-- the control that makes the join trustworthy. Re-run it before trusting it.
SELECT count(*), count(call_sid) FROM tickets
WHERE created_at::date = '<day>' AND ticket_number LIKE 'VA-%';
-- 2026-09-03: 196 of 196 carry a real CA-prefixed sid. T- tickets are staff.
```

**THREE WAYS TO GET THIS WRONG, all of which I did:**

1. **`tool_timeline` DROPS ABOUT 35% OF SUCCESSFUL FILINGS.** On 2026-09-03,
   100 substantive queue calls read a real VA number to the caller and the
   timeline recorded 65. Three consecutive calls (VA-57425, VA-57428,
   VA-57429) had a real ticket and NO filing event in the timeline at all.
   That is #77, and it is live on the runtime, not historical.
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
- **Pre-context produced a usable name on ZERO of 143 substantive queue calls.**
  Of 132 distinct callers: **2** are in `si_persons` (3,774 rows — the table
  pre-context reads) and **100** are in `patients_master` (915,843). Of those
  100, only 25 resolve to exactly ONE person; 75 resolve to several (average
  2.2). So pointing pre-context at the mirror is worth 2 → 100, but it buys a
  name to CONFIRM, never an identity.
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

**The method, which is Wayne's:** a flat per-minute rate means cost is
proportional to duration and nothing else, so a day's authoritative total
splits across that day's calls by their seconds. That is not an estimate —
it **sums to what xAI actually charged**, and it absorbs any component we are
not counting. Built in `src/services/grokCostAllocation.ts` (largest
remainder: no cent invented, none lost, deterministic), `xaiBilling.ts` and
`grokCostReconciler.ts`.

**It is DORMANT until `XAI_MANAGEMENT_KEY` and `XAI_TEAM_ID` are set.** It
says so once at boot and does not schedule — a reconciler that writes a wrong
number is worse than one that writes nothing, because "estimated" is honest
and a reconciled number is believed.

```sql
-- 241 of 241 today. Any number here is calls still priced from a constant.
SELECT count(*) FROM call_logs
 WHERE voice_provider = 'grok' AND cost_reconciled_at IS NULL;
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
