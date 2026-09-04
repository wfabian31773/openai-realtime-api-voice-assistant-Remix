# State of Play — Azul Vision voice agents

**Companion to `/CLAUDE.md`. Read both at the start of every session.**

Last updated: **2026-08-11 01:15 UTC** (Wayne: *"go through this entire
conversation… and log and create an MD file… and force every time that you read
that"*).

This is the running record. When something is decided, measured, built or
broken — write it here. The cost of not having this file was three days of
re-deriving facts and re-asking questions Wayne had already answered.

---

## 1. Where things actually stand

### Production

The **answering service is up and carrying the practice.** 579 calls on Aug 10,
its biggest day of the week. Quality has been flat all week — 2.82 → 2.80 →
2.73 — meaning **nothing built over the weekend has changed what a caller
experiences.** All of that work went into a parallel pipeline on a test number.

`no-ivr` is also up (~30–50/day) and produces the best transcripts in the
system. Wayne supplied one as the quality benchmark (§6).

### Off

**PCP** and **San Diego (azul-scheduling)** are off — together about **290
calls/day** that are now being absorbed by voicemail, staff, or going unanswered.
This is the largest single change of the week.

- **PCP**: Wayne's decision, **and I recommended it** — it was step 1 of my own
  plan ("PCP off — 1 minute, highest risk removed"). Driver: transfer failures
  he saw Friday, complaints from surgery centers, and it is a medical-facing
  line. *"I just cannot see the disasters that I was seeing on Friday on that
  line. I can't put our organization in a position like that."*
- **San Diego**: Gate B replay showed it **books 8 of the 21** appointments the
  old core booked. Not ready. I advised leaving it where it was; Wayne took it
  off.

### The Claude pipeline

`claude-as` on a test number. **Unproven — zero clean end-to-end calls.** The
extraction works and the latency is there; the plumbing keeps producing new
defects. Every test call so far either ran stale code or hit a bug.

---

## 2. What the weekend actually produced

Honest ledger, because Wayne asked for one.

**Real:**
1. A genuine production data bug found and fixed — a **cancelled appointment
   four months in the future was reported as the patient's last visit**. Affects
   every line, every caller who asks about appointments. Root cause: `buildContext`
   filed everything that was not upcoming as *past*, so a future `Removed` row
   sorted to the top and became `lastVisitDate`.
2. **Proof that the LLM extracts identity with no parser** — the thing Wayne
   spent fifteen minutes arguing for. `lookup_schedule` fired with
   `{"first_name":"Wayne","last_name":"Fabian","date_of_birth":"03/17/1973"}`
   from *"Yes. It's Wayne Fabian."* and *"It's 03/17/1973."*
3. **Latency measured**: Haiku ~791ms first token — viable for voice.
4. An offline replay harness (`replayRealCalls.test.ts`) so failing calls are
   reproduced without a phone.

**Not real:** a working replacement pipeline. It is not close to carrying calls.

**Why the return is thin** — my failures, not ambiguity in the ask:
- Wayne asked for a **pipeline swap**; I built a **new agent**. Days lost.
- I patched symptoms instead of finding causes, repeatedly, after being told.
- I made Wayne the test harness — findings came one live phone call at a time
  over six hours instead of minutes against recorded calls.
- I lost context and re-asked settled questions (see §5).

---

## 3. Timeline of the hard-won findings

**Transport / plumbing**
- The old core's **ear, brain and mouth are one OpenAI SIP session** — this is
  why STT could not simply be swapped, and why the standalone line exists.
- Agent improvising ("hiccups", Russian, reciting its own instructions) →
  root cause was an **in-conversation `response.create`**; fixed with
  `conversation:'none'`, `input:[]`. An earlier "fix" (mouthpiece rules in
  per-response instructions) made it worse — the model read them to patients.
- **OpenAI STT fabricated fiction that patients heard** → caller audio removed
  from the OpenAI session entirely.
- Every question asked twice → `is_final` vs `speech_final` on Deepgram.
- `clear` was deleting agent lines → removed, then reintroduced on Deepgram's
  trigger with a 400ms floor.

**Extraction / verification**
- `findNameIn("Yeah. It's Wayne Fabian.")` returned `{first:"It's", last:"Wayne"}`
  and the mirror was searched for surname "Wayne". This is what finally settled
  the parser argument.
- Ticket DOB `73/03/2017` — an unanchored m/d/y regex matched the tail of an
  ISO date. ISO is handled first now.
- `uuid = text` operator error would have told a patient with 43 appointments
  they had none. Needs `::uuid`.
- **Caller-ID pre-context** is why the old core recognises callers. My line put
  *every* caller on the stranger path — that was the regression Wayne kept
  pointing at.

**The Claude brain (2026-08-10 → 08-11)**
- `400 messages.20: tool_use ids were found without tool_result blocks` — the
  API rejects the **whole history**, so one malformed turn killed every later
  turn of the call. 31 seconds of silence. Fixed with rollback + atomic
  push + `repairHistory()` + a whole-turn timeout.
- The mouth drained **one line per round trip**, making a five-sentence answer
  five sequential TTS calls. That was the lag.
- Barge-in cleared Twilio's buffer but **not our queue**, so an interrupted
  answer kept playing.
- `splitForSpeech` split on `"Dr."`, cutting doctors' names in half.
- The model emitted **markdown** into speech (`**Dr. Dwayne Logan**`), which
  also defeated the `Dr.` guard because `**Dr.` has no whitespace before it.
  Markdown is now stripped in the pipeline (the agent's prompt is off-limits).

**Patient lookup was a sequential scan — the whole time (2026-08-11)**

Found while checking why Wayne still heard "December 30". The filter fix was
correct and deployed; the log that proved it also showed `patient_found = false`
on every one of his twelve calls. That was the real defect:

| lookup | plan before | after |
|---|---|---|
| by phone | Parallel Seq Scan, **7,038 ms** | BitmapOr index scan, **3.5 ms** |
| by name + DOB | Parallel Seq Scan, **2,235 ms** | Index Scan, **8.5 ms** |

`Schedule` is 965,838 rows / 1,747 MB. `CONTEXT_LOOKUP_TIMEOUT_MS` is 2,000 ms,
so the by-phone lookup lost that race on essentially every call and silently
returned "patient not found". **0 of 1,054 inbound calls were identified by
phone on 2026-08-10 and 08-11**; even the good days before that were 4–5%.

Three causes, all now closed:

1. **The name lookups never used the indexes they were written for.**
   `Schedule_PatientLastName_lower_idx` and `..._PatientFirstName_lower_idx` are
   on `lower(col) text_pattern_ops`. The code used Drizzle's `ilike`, which
   emits `col ILIKE 'x%'` — Postgres cannot answer that from a `lower()`
   expression index, so **neither index had ever been used, once**. Fixed by
   writing the predicate the way the index is built (`nameStartsWith()`).
2. **The 20-row window was taken before cancelled rows were discarded**, so a
   run of cancellations could push a patient's last real visit out of it.
   2,315 patients have >20 rows. Raised to 60 (`LOOKUP_ROW_LIMIT`).
3. **No index existed on `PatientCellPhone` / `PatientHomePhone`.** Added
   `idx_schedule_cellphone` and `idx_schedule_homephone`, both
   `CREATE INDEX CONCURRENTLY`, on Wayne's go, 2026-08-11. Both valid, 13 MB each.

Shipped in PR **#164** (`e663d3c`).

**The lesson — the fourth measurement trap.** A `false` in a log column can mean
"never written", not "measured false". `patient_found` is only written when the
*phone* stage succeeds; a later name+DOB match never updates it. The zero was
still real, but the two facts had to be separated before it meant anything.
Companions to snapshot-vs-history, zero-means-not-instrumented, floor-vs-total.

---

## 4. Deploy verification — a failed pull looks exactly like a failed fix

**2026-08-11 00:34:19 UTC**: GitHub REST rate limit on Wayne's account
(user 133284521). His Replit pull failed. He called at **00:36:52**. The call
ran pre-fix code and I analysed it as if the fix had been live.

**Rule going forward:** before drawing any conclusion from a call, confirm a log
line that exists *only* in the new build. Current marker:

```
[ScheduleLookup] N row(s) as of YYYY-MM-DD -> N past visit(s), N upcoming;
  last visit YYYY-MM-DD; N not counted (cancelled, no-show, or cancelled-future)
```

If it is absent, **the code is not live and the call proves nothing.** Ship a
marker with anything whose effect is hard to see.

---

## 5. The context failures, recorded so they stop

- **2026-08-11 ~01:00** — Asked Wayne why PCP and San Diego were off. **I had
  told him to turn PCP off**, as step 1 of my own written plan. He had explained
  San Diego. Both were already settled.
- **2026-08-11 ~01:00** — Proposed building an offline replay harness. I had
  built one at **21:45 the same evening** (`src/core/replayRealCalls.test.ts`)
  and told him about it in detail.

Wayne: *"You're the one that told me to shut those two lines down, and now
you're asking me why? It's because you have no memory and no context of anything
that's going on. That's the problem. We keep repeating the same things over."*

He is right. This file and `/CLAUDE.md` are the remedy. **Read before proposing.**

---

## 6. The quality benchmark

Wayne supplied this `no-ivr` call as "perfect to the letter". Grade work against
it.

> AGENT: Thank you for calling Azul Vision. Our offices are currently closed. If this is a medical emergency, please hang up and dial 911. Otherwise, I'm happy to help — how may I assist you?
> CALLER: I'd like to cancel our appointment on Wednesday.
> AGENT: Sure, you'd like to cancel your appointment on Wednesday. Let's confirm your details. Am I speaking with Van? I'd also need your last name and your date of birth.
> CALLER: The, the last name N G U Y E N.
> CALLER: And the first name V-A-N.
> AGENT: Thank you. And what is your date of birth, starting with the month, then the day, and then the year?
> CALLER: January 1st, 1959.
> AGENT: Got it, January 1st, 1959. Now, is the number ending in 4254 the best one to reach you?
> CALLER: Um, yeah, the this, the phone number. I like to cancel the appointment on Wednesday at 10 a.m.
> AGENT: Understood. You'd like to cancel your appointment on Wednesday at 10 AM. How would you prefer we contact you once this is processed—by phone, text, or email?
> CALLER: Um, text makes it better.
> AGENT: Thanks for letting me know. All right, I have Van Nguyen, date of birth January 1st, 1959, callback 818-614-4254, you prefer text, and you need to cancel the appointment on Wednesday at 10 AM with Dr. Agatha Sleboda at West Hills. I'll pass this along. Give me one moment while I get this submitted for you.
> AGENT: Your request has been submitted. Our team will follow up by text. Anything else I can help you with?
> CALLER: No, thanks.
> AGENT: Great, have a good day!

**What makes it good:**
1. Knew who was calling before a name was given (caller-ID pre-context).
2. Resolved the appointment from the book — caller said "Wednesday at 10 a.m.",
   agent returned "Dr. Agatha Sleboda at West Hills".
3. **Read the whole record back once** before submitting, rather than
   re-interrogating.
4. Covered the wait ("give me one moment"), then confirmed the ticket and the
   follow-up channel.
5. Never claimed to cancel anything — "I'll pass this along". Capability
   boundary held.

**Note:** this is the `no-ivr` agent. The Claude brain is built on
`answeringServiceAgent` — different prompt, different tools. Some of what makes
this transcript good is the prompt, not the pipeline, and cannot be closed by
pipeline work. **Open question for Wayne (§7).**

---

## 7. Open items

**Waiting on a Replit republish** (merged to `main`, not yet live)
- **#164** `e663d3c` — the lookup fix above. The two database indexes are
  already live and helping; the code half needs the deploy.
- Everything earlier on this branch is merged: #161 `6cf0a69`, #162 `58090cf`,
  #163 `f898345`.

**Decisions Wayne owes (do not guess these)**
- What is the real deadline now that Monday has passed?
- Should the Claude brain point at `no-ivr` instead of `answering-service`, or
  are the gaps in §6 answering-service prompt work?
- Priority order: ship the schedule fix to production, restore PCP/SD, or finish
  the pipeline?

**Known-unfixed**
- Spurious barge-in: fired 617ms into a greeting before the caller spoke. Now
  that barge-in drops the queue, a false trigger mid-answer would cut a caller
  off. Needs tuning **with Wayne watching** — it is a judgement call.
- `openai socket closed MID-CALL … 1005` at teardown. Cosmetic on a normal
  hangup; worth a look once the loud things are quiet.
- `lookup_schedule` classified a records request as "Clinical Tech Support"
  (VA-50433) and the ticketing service warned `Location "Loma Linda Surgery
  Center LLC" not found in system`. That is `classify_request` inside the real
  agent — **do not change it without Wayne's say-so.**
- **One phone number can carry two different patients, and the lookup blends
  them.** `lookupByPhone` hands every matching row to `buildContext` without
  grouping by person; `patientName` comes from `appointments[0]`, so whoever
  owns the newest row decides whose name the agent uses. Wayne's own number
  carries him (1973-03-17, 43 rows) and a `John Doe` test record
  (1980-01-01, 1 row). Needs a group-by-person step and, when more than one
  person matches, a refusal that asks for a date of birth rather than a guess.
- `p0Hardening.test.ts` fails to import without `DATABASE_URL` (pre-existing).
- Task #9: SD Gate B replay — export corpus, replay, fix, report.

**Test suite:** 836 passing, 65 files, 1 pre-existing failure. `npm run build`
clean. Note: running `npm run build` in-tree creates `dist/` with compiled test
files that vitest will also run — **delete `dist/` afterwards** or the suite
reports phantom failures.

---

## 8. The queue lines — 2026-08-12 / 08-13

Three queue agents built and shipped: **Optical** (dept 1), **Surgery
Coordination** (dept 2), **Clinical Tech Support** (dept 3). The pattern, the
operator rulings behind it, and the taxonomy method are in
**`.agents/memory/queue-agents.md`** — read that before building the next one.

### The day's real cost: one bug, most of a day

A tool that worked in the library, in tests, and over HTTP could not be called by
an agent. `toZod` in `realtimeAdapter.ts` made every property `.nullable()` but
never `.optional()`, so all 15 of `file_surgery_ticket`'s landed in `required`;
under `strict: true` the SDK rejected the model's 13-key call **before `execute`
ran** — no HTTP request, no log line, no timeline event.

**Three wrong root causes stated out loud before the right one.** What found it
was a control, and Wayne supplied it: *"the optical agent can call a tool and
create a ticket, why can't the surgery agent?"* Optical worked. Same library,
same adapter, same process, different field count.

Full write-up: **`.agents/memory/realtime-tool-schemas.md`**. Proof it works:
**VA-51121**.

### Cross-queue routing

Wayne, 08-13: *"we can't just tell the patient call back, call the wrong
extension… anything that's schedule related should go to the HVA hub"*, then
*"cross queue routing should be for all agents"*, then *"surgery is an exception
to that hva hub rule."*

`src/tools/queueRouting.ts`, wired into all three queue filing tools **and** the
shared `createTicketTool` guard (answering-service, no-IVR, no-IVR v2). Merged as
**#184**.

### The lock on the after-hours path

`submitSimplifiedTicket` released its 60-second lock on success only, so the
retry a failure invites hit the lock that failure left behind — four create
attempts on one call at 23:38, no ticket. **This is the line that carries the
night**: Wayne, 08-13, *"all overnight volume is on the no ivr agent which i use
as the after hours agent."* Fixed in **#185**.
Details: **`.agents/memory/ticket-creation-lock.md`**.

### Still open from this stretch

- **Rotate `VOICE_TOOL_API_KEY`.** It was pasted in plaintext and used for
  production curls. Wayne, 08-13: *"I will rotate the key once we are done with
  these agents and testing but keep reminding me."* **Keep reminding him.**
- **Prove `file_tech_ticket` over HTTP** before the Clinical Tech Support number
  goes live — a plain refill (expect dept 3 / reason 155 / high), "my glasses
  broke" (expect Optical), "schedule an eye exam" (expect HVA Hub / 146).
- **Close test tickets** VA-51047, VA-51058, VA-51121.
- **Clear the six test records' phone in NextGen.** I declined to delete them
  from `patients_master`: it is a live mirror (14,182 rows re-synced in 7 days)
  and the rows would come back. The fix is upstream.
- Department 3 receives real optical and appointment traffic today — cross-queue
  routing addresses it going forward, not the backlog.
- *"Prescription never reached the pharmacy"* (167 in 90 days) has **no reason
  code**. Needs one.
- `config/answeringServiceTicketing.ts` fallbacks are stale, and
  `validDepartments = [1,2,3,11,12]` is wrong — it omits the HVA Hub (9).

---

## 9. The 2026-08-24 logging blackout — zeros that were not zeros (written 08-27)

Wayne, 08-26: four "Live now" calls at 52 hours, and every Hub agent card at
0 calls / — quality while SAGE showed 339. Both symptoms were ONE event.

**Measured chain (do not re-derive):**

- Supabase Operations Hub Postgres **restarted 2026-08-24 20:19:49 UTC**
  (pg_cron / pg_net / postgres_exporter backends all date from that second).
- Last `call_logs` row ever written: **20:17:17** (last `call_turns` 20:18:23).
  Zero rows on Aug 25–26 across every line — while OpenAI's Costs API billed a
  **normal $174.26 realtime day on Aug 25** (weekdays run $150–190). Calls were
  answered and billed; nothing was recorded. Quality monitoring was blind.
- The four stale rows are the calls in flight at the restart (tech CA4227…,
  optical CA25ce… + CA2ca6…, surgery CA813e…, 20:12–20:17). Their terminal
  updates died with the voice process's DB layer, and every repair mechanism
  (60s DB reconciler, lifecycle coordinator, dead-air bookkeeping) lives in
  that same process. The dashboard process recovered (its 06:00 UTC cost cron
  kept writing) but only swept stale rows at boot, and it had not rebooted.
- **No merge caused this.** Last code on main was Aug 21 (#223); it ran fine
  Aug 22–24. Nothing from the Aug-26 session was ever merged (#225 closed
  unmerged).

**Fixes (branch claude/dr-screening-discovery-3qo5r1):** keep-alive now
escalates to a pool rebuild after 3 consecutive failed pings (`recyclePool` in
`server/db.ts`, decision in `server/services/dbSelfHeal.logic.ts`); a
stale-call sweeper runs in the DASHBOARD process at boot + every 5 min closing
rows past a measured 30-min ceiling from Twilio truth, marking
`call_disposition='stale_reaped'`, never inventing durations, never touching a
call Twilio says is live (`server/services/staleCallSweeper.ts` + tested logic
file); Live panels stop rendering rows older than 30 min; the command center
shows an amber "logging is DOWN" banner when the newest call_logs row is >2h
old, so all-zero cards can never again pass as quiet lines.

**Deploy markers** (grep after republish):
`[DB KEEP-ALIVE] self-heal armed (build 2026-08-27)` and
`[StaleCallSweeper] armed (build 2026-08-27)`.

---

## 10. The 2026-08-31 filing outage and the week's work order (written 09-01)

### What happened

The n8n Cloud account hit its **monthly execution cap at 20:16 UTC on
2026-08-31**. The gateway refused every create-ticket **at the webhook, before
any node ran**, and answered HTTP 200 with a body that is not JSON. Every queue
line saw `Invalid JSON response from ticketing API: 200`; optical failed a step
earlier, at `/lookup`, and so presented as a different defect.

**Measured, not inferred:** 286 filing attempts rejected. 185 consecutive queue
calls filed nothing, from 20:15:45 to 23:54:54. 43 optical callers were told
their real office does not exist — Mission Hills, Downey, Glendale, Santa Ana,
the whole map — because nothing was being looked up. One call ran 19 tool calls
over 8 minutes with a patient on the line.

It was found hours later because **staff told Wayne**. Nothing watched the
ticket path: R1–R12 in `02-diagnosis-rules.md` do not cover it, which is the
queue lines' entire job.

**Recovery:** `TICKETING_SYSTEM_URL` flipped to the app directly
(`https://ticketing-app--fabianwayne1.replit.app`), verified by traffic rather
than by reading the secret. 107 distinct requests reconstructed from
transcripts; 82 filed, 67 new tickets; 24 optical reconstructions still
unfiled; 25 correctly refused, 24 of those for a missing surgeon.

**A cost I caused during recovery:** 77 patients received a welcome SMS,
because I fired 82 POSTs without checking the blast radius first.

### The work order

Wayne, 2026-09-01: *"let's kill standalone and core, two pipelines only … fix
compliance, request lost, silence, and the other live now bugs and then stop
there."*

All of it is on `claude/determined-brown-o5qsft` / PR #244, which carries the
full detail per commit. In short:

- **Two pipelines.** `src/core/` and `src/standalone/` deleted. Casualty:
  `replayRealCalls.test.ts`, the instrument standing instruction 8 names. No
  replacement yet — outstanding.
- **Compliance.** The database may word the no-IVR greeting; it may no longer
  drop the recording disclosure or the 911 line. Lunch closure (12–1) added.
  7am is after-hours by routing and was already right.
- **Silence.** Overflow legs now carry a status callback and register with the
  SIP conference lifecycle. 34 of 3,203 overflow calls had sat in >600s of
  terminal silence against 0 of 927 on no-IVR.
- **Request lost.** The four queue tools now persist a refused payload verbatim
  to the existing outbox before returning; the outbox re-sends queue payloads
  without re-validating them; retry window 15 min → ~3.5 h.
- **The alarm.** `ticketFilingHealth.ts`, wired to systemAlertService every 5
  minutes and to a red banner on the command center. Would have caught 08-31 at
  **20:23:06**.

### What the measuring turned up that nobody had asked about

- **The model was overwriting the CallSid.** 130 surgery POSTs carried the
  literal string `"unknown"`, while every one of the 2,926 queue calls had a
  real CA-prefixed SID on its `call_logs` row. The adapter merged the model's
  arguments over the injected context. No SID means no idempotency key: no
  duplicate protection, no post-call enrichment, no outbox key.
- **20% of queue POSTs are refused with HTTP 400** — 664 in 14 days, 602 of
  them *"Missing required information: surgeon"* across 181 surgery calls, at
  3.3 identical doomed attempts per call. That is what `retryable: true` on
  every failure buys. It would also have poisoned the new outbox.
- **`getValidatedTicketIds` rewrote ten live departments to the medication
  queue.** Not firing at volume — only two callers reach it — but it is why the
  queue tools could not be routed through the outbox.
- **`lookup_patient` times out on 13–17% of queue calls** (6s budget, 475
  events). First tool every queue call runs. Unfixed.
- **Ticket write-back is NOT broken.** It was on the list as if it were;
  97–98% on every clean day. The apparent gap was the 08-25/08-26 blackout and
  my own recovery run showing up on the wrong side of midnight.

### Open, and Wayne's to settle

1. **Optical with no resolved office** — unassigned at high priority (what
   surgery does with a missing surgeon), or routed to a default office? 62 of
   the 107 requests lost to a gate in 14 days are exactly this.
2. **May a request be filed with a name and a phone but no date of birth?**
   23 more turn on it.
3. **records went live on 2026-08-31** (4 calls, then 27) and nothing in the
   repo says who pointed the number.
4. **answering-service took zero calls on 09-01** through 13:22 PT, after 38
   the day before and a steady 18–58 every weekday. Weekends are zero for it;
   this was not a weekend.

---

# 2026-09-03 — the runtime cutover, and the first day of real evidence

Three queue lanes moved off the OpenAI SIP core onto the Grok Media Streams
runtime: optical 15:24:58, surgery 19:43:57, tech 19:51:10 UTC. Records stayed
on the old core and is therefore a same-day control, which is the only reason
any of the numbers below can be trusted.

## The headline: it is a wash, and that is the right result

| lane | old core | Grok runtime |
|---|---|---|
| tech | 49/73 = 67.1% | 46/66 = **69.7%** |
| surgery | 22/44 = 50.0% | 18/32 = **56.3%** |
| optical | (no arm — cut over at 15:24) | 28/56 = **50.0%** |
| records | 14/29 = 48.3% | *did not move* |

Neither difference is significant at these n. **A pipeline swap that changes
nothing about outcomes is a successful pipeline swap** — the ear, brain and
mouth were replaced end to end and the patients could not tell. What the
runtime buys is not a better number today; it is that everything below is now
fixable by us rather than by a vendor.

Two real differences, on the same calls: turn detection is better (tech callers
say 353 characters against 333, in fewer transcript lines, at identical
duration), and the agent talks in about twice as many short lines.

## The finding that mattered

**A refusal the model cannot diagnose is a refusal it repeats.**

| gate hit | calls | still filed |
|---|---|---|
| `date_of_birth` | 23 | **0** |
| optical `location` | 11 | 9 |

Two refusals in one codebase. One survivable, one terminal, and the difference
is not severity — it is whether anything the caller says can clear the gate. It
could not: the model was omitting `date_of_birth` from the tool call entirely,
heard "I did not catch that date of birth", said that to the caller, the caller
repeated the date, and the model resent the same argument-less payload. An
unwinnable loop, dressed as a caller problem.

Most of the day was spent fixing the parser — separators, whole sentences,
two-digit centuries, Spanish months. Every one of those was a real bug. **None
of them was this one.** What settled it was `dobShape`: a PHI-free shape of what
actually arrived (digits → `#`, letters → `a`), which read `"(none)"` on five
refusals out of five within twenty minutes of going live.

## Where the day's requests went

53 substantive queue calls produced no ticket; 2 correctly so. The other 51:
23 the date-of-birth gate, 12 asked for a human and hung up, 7 where no tool
ever ran, 9 other. The date-of-birth calls average 2m49 — the longest in the
set. Those callers gave everything asked of them and were failed at the end.

## Identity is the root cause under most of it

Caller-ID pre-context produced a usable name on **zero of 143** substantive
queue calls, so nobody heard "Am I speaking with…?" all day. Of 132 distinct
callers, **2** are in `si_persons` — the 3,774-row table pre-context reads — and
**100** are in `patients_master`, which has 915,843. `lookup_patient` separately
reads the Operations Hub appointment book rather than the mirror.

That single fact explains the shape of the losses: a certain identity match is
what lets the filing handler fall back to a verified date of birth, so calls
with one mostly filed and calls without one mostly did not.

## Shipped, and needing a pull before any of it counts

- `MissingFields.fix` — a channel that tells the model what IT got wrong,
  separate from `message`, which is what the agent says.
- The teardown request sweep, wired into `voiceRuntime` after the call_logs
  write. **It recovers only 6 of the 53 losses**; 47 skip on "no name, no
  ticket", because the calls that get lost are exactly the calls where
  identification failed.
- "Lead the ask" — the operator's ruling, in the tool schemas so all four lanes
  move together: last name, then "your date of birth, starting with the month,
  then the day, then the year".
- Greeting-already-played, appended by the runtime rather than the prompts.
- Records trimmed 1,907 → 1,679 tokens, with ceilings added for optical and
  records, which had never had one.

## Open, and Wayne's to settle

1. **"No name, no ticket" costs 47 of 53 recoveries.** The ruling was about what
   identity goes on a swept ticket. The calls it blocks are the ones where we
   never identified anyone — which is the whole population the sweep exists for.
2. **Point pre-context at `patients_master` instead of `si_persons`** (2 → 100
   of 132 callers), and `lookup_patient` at the mirror before the schedule. Both
   are ticket-path changes and need a before/after number. Caveat that must
   travel with them: 75 of those 100 numbers resolve to more than one person, so
   this buys a name to CONFIRM, never an identity.
3. **Records is still on the old core** and visibly missing the rulings shipped
   to the runtime lanes — it used the "someone will become available" wording
   #265 forbids, at 23:54.
4. **Turkish months** — one evidenced call, and the table's own rule is evidence
   first. Add now on one call, or wait?
5. **#53 medical-safety wording** for optical and records. Needs clinical
   language from Wayne; not to be invented.
