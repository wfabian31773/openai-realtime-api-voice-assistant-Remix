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

Volumes re-measured from `call_logs` on **2026-09-01 20:25 UTC**; the
decisions are Wayne's and are unchanged. Update this table whenever it
changes, and re-measure rather than copying the numbers forward.

| Line | State | Volume (7d avg) | Who decided | Why |
|---|---|---|---|---|
| **tech** (queue) | **LIVE** — the busiest line in the fleet | **85.6/day**, 1,330 in 14d, 69% file a ticket | Wayne, Aug 13 | Clinical Tech Support, dept 3. It is the medication queue. *(This row said "Built, number pending" until 2026-09-01. It has been live and carrying more calls than anything else for weeks.)* |
| **surgery** (queue) | **LIVE** | 64.7/day, 945 in 14d, **37% file a ticket** | Wayne, Aug 12 | Dept 2. The low filing rate is not mystery: 181 calls in 14 days were refused by the ticketing app for a missing surgeon. See #48. |
| **no-ivr** | **LIVE** — also the after-hours agent | 52.4/day, 874 in 14d | — | Wayne's quality benchmark; produces the best transcripts. Carries all overnight and weekend volume (standing instruction 13). |
| **optical** (queue) | **LIVE** | 37.1/day, 632 in 14d, 45% file a ticket | Wayne, Aug 12 | Forwarded optical overflow. *"Optical works like a charm."* Dept 1. |
| **answering-service** | **LIVE**, old core (`/api/voice/answering-service`) | 16.1/day, 272 in 14d — **but zero so far on 2026-09-01** | — | Was 579 calls on Aug 10 and 491 on Aug 12, then 18–58/day on weekdays and 0 at weekends. **The zero today is not the weekend pattern and it is not explained here — ask Wayne, do not guess.** |
| **records** (queue) | **LIVE — new since 2026-08-31** | 4.4/day, 31 in 14d and **all 31 in the last two days** | — | Dept 16, Medical Records. It was not taking calls when this table was last written. |
| **pcp** | **OFF** in Twilio | 18 in 14d, last one 2026-08-31 | Wayne decided, **I recommended it and sequenced it as step 1** | Transfer failures seen Friday; complaints from surgery centers; medical-facing. *"I just cannot see the disasters I was seeing on Friday on that line."* Was ~200 calls/day. The trickle is consistent with direct dials, not with the line being back. |
| **azul-scheduling** (San Diego) | **OFF** | **zero calls in 14 days** | Wayne, Aug 10–11 | Gate B replay: **books 8 of 21** the old core booked. Not ready. Was ~80 calls/day. |
| **claude-as** | Test number only | — | — | The Claude pipeline. **Unproven — zero clean end-to-end calls.** |

**Queue lines take no calls after hours** — Nextiva routes everything to the
after-hours agent. See standing instruction 13.

**Do not ask Wayne why PCP or San Diego are off. It is written above.**

**A measurement trap in this table's own source:** `call_logs` has ZERO rows
fleet-wide on 2026-08-25 and 2026-08-26, so any "14-day" figure is really over
twelve days. The daily counts above are unaffected; averages computed by
dividing by 14 are not.

---

## What already exists — do NOT rebuild these

| Thing | Where | What it does |
|---|---|---|
| Mirror verification | `src/services/patientVerification.ts` | Verifies against `patients_master`; refuses to guess between two people. |
| Per-call carries between tools | `src/tools/verifiedIdentity.ts`, `src/tools/resolvedContext.ts` | The model does NOT reliably pass one of its own tool's results into the next tool's arguments. These hold it server-side for the length of one call: the verified date of birth, and the resolved office. Keyed on a REAL CallSid — a sentinel key would file one caller's request against another's. Both fill a GAP only; what the caller said always wins. The office is OPTICAL ONLY and only on the SECOND filing attempt, after its gate has asked — see BACKEND_HANDOFF §3 before widening either. |
| Appointment answers | `src/services/appointmentAnswers.ts` | `Schedule.PersonID` join; excludes `Removed`. |
| Replay tables | Operations Hub | `new_core_replay_summary`, `new_core_replay_index`, `ticket_agent_config` |

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
- **The model is not a courier between its own tool calls.** 2026-09-02, optical
  `CA747908b5d46b7ed25cffe733fb792738`: `file_optical_ticket` refused for a
  missing office → `resolve_location` returned `verified: true` → the very next
  `file_optical_ticket` went out with no office and the request dead-lettered.
  `location` and `surgeon` are MODEL arguments. `resolvedContext.ts` carries the
  office server-side; the surgeon is NOT carried yet (#48).
  **`verified` is not `usable`:** `resolve_location` sets `verified: true` on any
  Console directory hit and computes `usable_for_this_queue` separately, so a
  surgery centre spoken to optical is verified and unusable. Only `usable` ones
  are stored. **Surgery gets no office carry** — it does not gate on location,
  and `resolveWith` ANDs a location into every provider lookup, which would
  narrow the surgeon ladder on the queue that most needs it.
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
8. **Accepting a constraint as immovable.** I treated "the API has no way to
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
