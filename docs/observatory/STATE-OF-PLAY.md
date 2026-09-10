# State of Play — Azul Vision voice agents

**Companion to `/CLAUDE.md`. Read both at the start of every session.**

Last updated: **2026-09-09 17:40 UTC** (section 11). Earlier: **2026-08-11 01:15 UTC** (Wayne: *"go through this entire
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

---

# 2026-09-04 — the instruments, after Wayne said the Observatory was wrong

He was right, and it was one missing column.

## The Observatory had stopped counting three of the four queue lanes

Measured over every call since 09-01:

| pipeline | calls | rows carrying `agent_id` |
|---|---|---|
| old core (SIP) | 1,315 | 1,315 (100%) |
| grok runtime | 239 | **0** |

The runtime opened its `call_logs` row with the lane slug and nothing else.
Five reports join `agents` on the uuid — the Observatory scorecard, the
Observatory today view, the cost analytics (`routes.ts:2281`), the quality
and sentiment analytics (`routes.ts:2463`), and `storage.ts:523`. So at
15:24:58 on 09-03, the moment optical cut over, it stopped existing in all
five. **Not wrong, ABSENT** — and an absent lane is indistinguishable from a
quiet one, which is why nothing looked broken.

`shared/schema.ts:549` had anticipated exactly this in a comment — *"even if
agentId is null"* — but nothing implemented the fallback.

Fixed at the source rather than by teaching five call sites a second join:
`src/runtime/agentIdentity.ts`, one cached lookup per lane per process. A
miss is deliberately **not** cached, so a lane whose agents row is added
later is picked up without a redeploy and its marker keeps printing until it
is. **259 existing rows were backfilled** from the slug they already carried
(every slug matched exactly one agent; reversal snapshot in
`call_logs_agent_id_backfill_20260904`), so the cutover day is visible again.

The Observatory also had **no concept of `voice_provider` anywhere** — server
or client — so the biggest thing that has ever happened to these agents was
invisible on the one screen built to watch them. Each card now names its
pipeline and warns *"mixed pipelines — do not read these as one population"*
on a lane that cut over mid-day.

Left alone, deliberately: 98 rows with a NULL `agent_used` (Nov–Jan), 14
`greeter`, 5 `claude-as`. No current lane among them.

## The Grok cost was never a measurement

All 241 Grok rows carry `cost_is_estimated = true` and `cost_reconciled_at`
NULL. Both columns have existed since the schema was written and had never
been used on any row, either pipeline. The price is
`Math.ceil(duration * 8/60)` from a constant nobody had checked against a
bill.

| | |
|---|---|
| summed seconds | 25,259 (421 min) |
| exact at the published $0.08/min | $33.68 |
| stored | $34.86 |
| overstatement from `Math.ceil` alone | **$1.18 = 3.5%** |

Zero rows deviated from the formula, so the bias is the rounding, applied in
the same direction 241 times.

Wayne's method is the right one and it is now built: xAI run a **management
API** (`management-api.x.ai`, a separate credential from `XAI_API_KEY`) with
`POST /v1/billing/teams/{team}/usage` for spend per day and
`GET .../postpaid/invoice/preview` for `unitPrice` and `numUnits`. A flat
per-minute rate means a day's authoritative total can be split across that
day's calls by seconds — an allocation that **sums to what xAI actually
charged**, and that absorbs anything we are not counting. xAI bill
`$0.004 / text input` separately from the audio minute and we never have.

`invoice/preview` is the sharper instrument of the two, because `numUnits` is
how many units **they** counted, which is the only way to find out whether
they bill the duration Twilio reports.

**It is dormant until `XAI_MANAGEMENT_KEY` and `XAI_TEAM_ID` exist.** It says
so once at boot and does not schedule.

## Also shipped today

- **The date-of-birth gate stops being terminal** (`src/tools/dobEscape.ts`).
  Ask once with the coaching wording, then file anyway marked `unavailable`
  (never given) or `unmatched` (given, unreadable). This is the same ruling
  Wayne gave for optical's office on 09-01, and the cutover day measured both
  side by side: the location gate **had** that escape and recovered 9 of 11;
  the date-of-birth gate did not and recovered **0 of 23**.
  The status goes at the top of the description, not in the birth columns —
  those are `varchar(2)/(2)/(4)` in the ticketing app and the word does not
  fit. A dedicated ticket field is the proper fix and is proposed, not built.

## Open, and Wayne's to settle

1. **The two xAI credentials.** `XAI_MANAGEMENT_KEY` (Console → Settings →
   Management Keys — NOT the inference key) and `XAI_TEAM_ID`
   (console.x.ai/team/default/settings/team). One reconciliation run then
   answers whether $0.08/min is the real rate and whether the text-input
   charge is material.
2. Everything still open from 09-03 below, unchanged: "no name, no ticket";
   pre-context → `patients_master`; records on the old core; Turkish months;
   #53 medical-safety wording.
3. **Records stays untouched** — HHS corrective action plan work.

---

## PCP and records on the runtime — what is actually left (2026-09-04)

Measured through `realLanes.test.ts`, the one harness that touches the real
agent tree, with a transfer injected so pcp could be examined in the
condition it would actually run in — which nobody had ever done, because pcp
has spent its whole life on the refused side of that gate.

**Both lanes bind cleanly today.** No skipped tools, no `strict` on any
schema, no stringified prompt closure, a Grok voice rather than the
registry's `sage`, and the knowledge pack correctly prefixed.

| | pcp | records |
|---|---|---|
| tools resolved | 8, none skipped | 6, none skipped |
| output guardrails carried | **3** | **0** |
| prompt, total chars | 18,360 | 16,035 |
| the lane's own share | **~2,260 tokens** | ~1,680 tokens |
| what refuses it today | no transfer injected | nothing — it is served |

### records

**It is already servable and always was.** The only reason it is on the old
core is that nothing has pointed it at the runtime. Nothing needs building.

The thing to correct in this document's own earlier note: records is not
"missing every ruling shipped to the runtime lanes". Its #265 wording landed
in `recordsAgent.ts` at 21:04 UTC on 09-03 and the violation was observed at
23:54 — **nearly three hours later, because the commit is on
`claude/determined-brown-o5qsft` and has never been deployed.** `agent_prompts`
is not read by the call path, so the prompt is the file, and the file is
right. The split that actually matters:

- **Prompt- and tool-level rulings** — the #265 wording, lead-the-ask, the
  date-of-birth escape, `resolve_location` — records gets all of these on
  merge and pull, **on the old core, with no cutover.**
- **Runtime-level** — greeting-already-played, the VAD threshold, the tool
  ceiling, the teardown sweep, `agent_id`, Grok cost — records gets **none**
  of these until it moves.

**Its one real gap is that it carries zero output guardrails**, on either
pipeline (#53). So does optical, surgery and tech. See below.

### pcp

Everything is built. Two things are not settled, and neither is code:

1. **The warm transfer has never been proven on a live call** (#30, six test
   calls with Wayne, never run). Transfer is the entire point of this lane.
   It is unit-tested through a fake Twilio and mounted on the runtime, and
   that is not the same claim.
2. **`PCP_HUMAN_AGENT_NUMBER` must be set** or the lane answers, sounds
   healthy, and fails every transfer at `resolveHandoffDestination`. This is
   now reported per lane at boot and on `/voice/health` rather than
   discovered on a call.

And one measurement worth acting on before it takes traffic: at **~2,260
tokens** its prompt is a third larger than the trimmed queue lanes, and it
has never been trimmed for Grok. The standing note is *"Grok requires minimal
prompting, we should not be near our ceilings."*

#### The pcp prompt, measured section by section (2026-09-04)

Built the net before touching anything: `src/agents/pcpPromptRulings.test.ts`,
the pcp equivalent of `queuePromptRulings.test.ts`, which pcp never had —
because pcp spent its whole life refused by the runtime, so nobody measured
it. **23 rulings, matched on meaning rather than phrasing**, each traced to a
standing instruction or to a dated incident already recorded in `pcpAgent.ts`.
It is green against the prompt as it stands today, which is the only way to
tell a trim from a regression later.

Then the coverage runs the other way — delete each section and see which
rulings stop holding:

| section | ~tokens | unique rulings lost if deleted |
|---|---|---|
| `## FIRST, ALWAYS: WHAT IS THIS CALL ABOUT?` | 391 | 4 |
| `# TWO THINGS ABOUT THE LAST THIRTY SECONDS` | 287 | 2 |
| `# IF A PATIENT REACHES YOU, TAKE THEIR REQUEST` | 261 | 2 |
| `# WHEN A TOOL SAYS NO` | 249 | 2 |
| `# ONE QUESTION. THEN STOP TALKING.` | 226 | 2 |
| `# CONNECTING SOMEONE TO A PERSON` | 167 | 3 |
| `# HOW YOU SPEAK` | 130 | 2 |
| `## HOW YOU KNOW WHAT TO ASK` | 121 | **0** |
| `# SAFETY` | 94 | 2 |
| `# THE DIRECTOR DECIDES, NOT YOU` | 71 | **0** |
| `# MEDICAL RECORDS` | 68 | 1 |
| `# WHAT YOU DO` | 49 | **0** |

**THE FINDING: the pcp prompt is dense, not fat.** Twenty-three rulings in
2,260 tokens. Only three sections carry no unique ruling and together they are
241 tokens — and two of those three are the SAME instruction stated twice
(*"ask only the next question `record_pcp_intake` gives you"*), which is the
one honest redundancy in the file. Even they are not pure duplicates:
`# THE DIRECTOR DECIDES` alone says the director also decides whether a
transfer is available, and `## HOW YOU KNOW` alone carries the four-step loop
and *"you do not have the list"* — the #201 lesson, where showing the model
the intake order stopped it inventing a sequence and started it reciting one.

So a trim that gets pcp near the queue lanes' 1,500–1,800 means **dropping
rulings, not prose**, and which ones is Wayne's call, not mine. The three
zero-ruling sections are named in the test file with the reason each is kept,
and a NEW section carrying no ruling now fails rather than joining them
quietly.

The ceiling is pinned at **2,300 — where the prompt already is.** It asserts
one thing today: that pcp does not grow while nobody is looking. Lowering it
is the point of the trim.

### The guardrail gap, with a number on it at last

The four queue lanes carry **no output guardrails on either pipeline**. Before
proposing the existing `medicalSafetyGuardrails` for them, they were dry-run
over **400 real queue calls / 2,704 agent lines**:

- **One** trip in the whole corpus, and it was **wrong** — the agent reading
  the caller's own words back ("you mentioned you have questions about your
  recovery from cataract surgery"). In enforce mode that line is cut
  mid-sentence.
- With the exclusion added for it: **zero** trips.

So the cost of switching them on is now measured at nothing, and the same
pattern was misfiring on no-ivr, after-hours and azul-scheduling the whole
time. **Turning them on for the queue lanes is still Wayne's call** — #53
says the clinical language is his, and the generic pair may not be what he
wants for records in particular.

---

## 11. Why queue calls do not file — the 2026-09-08 taxonomy (written 09-09)

Wayne, 2026-09-09, after reading the overnight report: *"How can eight people
not get a ticket? … Why are these tickets not being filed, man? I need to
know why."* And then, on the answer: *"There was a patient on the phone that
gave their date of birth digit by digit four times, and we fucked that up."*

**Everything in this section is a count with its denominator and window.
Where a cause is not established, it says so.** The full tables live in
`/CLAUDE.md` under "WHY QUEUE CALLS DO NOT FILE"; this is the narrative and
the decisions.

### The shape of the loss

One full business day (2026-09-08), queue lanes, `duration >= 30`:
**446 substantive calls, 255 filed, 191 produced no ticket.**

The two dominant causes are a filing gate refusing (62) and the caller never
being properly transcribed (77 with 0 or 1 caller lines). Below those: 26
calls where tools ran and a filing tool was never called at all, 14 with no
tool events, and 12 where the filing tool returned a ticket number that no
ticket carries — **that last group is not established as lost**, it may be the
known call-attribution defect.

### The date-of-birth gate, root-caused

**75 calls hit it, 53 filed nothing.** The chain, each link measured:

1. **The model sent no `date_of_birth` argument on 75 of 75.** `dobShape` is
   `(none)` on every refusal event. The parser was never asked a question.
2. **51 of the 75 callers had already given a date** — a 19xx year or a month
   name in their own transcribed lines. A lower bound; it counts two signals.
3. **42 of the 75 end with that refusal as the last tool event.** The model
   does not try again.
4. So the "ask once then file anyway" escape (`dobEscape.ts`, built 09-04 to
   Wayne's ruling) **cannot fire on those 42** — it needs a second attempt
   that never comes. It was built for a retry loop; this failure is the
   opposite shape.

**Why the model omits the field is NOT established.** Checked and ruled out:
the `fix` channel does reach the model (`agentBinding.dispatch` stringifies
the whole result), and the schema is passed through unchanged with
`strict: false`. `date_of_birth` is deliberately not in `required`.

### The runtime made this gate worse, and there is a same-day control

Share of substantive calls refused for `date_of_birth`, optical+surgery+tech:
old core ran **3.2%–8.7%** over 08-28..09-02 and **1.6%** on 09-03 before the
cutover; the runtime read **12.4%** the same day after it, then **14.8%**
(09-04) and **18.3%** (09-08). Same lanes, same callers, same tools.
**This is the before-number for the `docs/BACKEND_HANDOFF.md` rule.**

### A second, independent defect on the same call

`normalizeDobParts` refused `"0 1 0 4 58"` — five numeric groups is neither
three nor four, so the rule that correctly refuses a phone number refused a
birthday. That is what the caller on `CA4475d6f1b265c4c6824ff0f241d159f9`
said, twice, in a 329-second call that filed nothing. A Spanish caller on
`CAdc9f9667694dd95382985ad5f86f57b4` was lost the same day to
`"Cero tres veintidos del cincuenta"`.

**Fixed** by `readDigitStringDate`, which runs only after the existing reader
refuses and therefore cannot change any answer it already gives. Phone numbers
and digits inside a sentence are still refused. **Spelled-out digits in either
language are still refused and are not fixed.**

**Both defects were live on that one call.** Even if the model had sent the
field, the parser would have refused it.

### The runaway-loop check went blind the moment the ceiling shipped

`toolCeiling.ts` refuses at `dispatches >= 40`, so a call can reach 40 and
never exceed it. The check published as its proof looked for `> 40`. Measured
09-09 over all grok rows: `> 40` = **1** (the pre-ceiling 118-dispatch optical
call), `= 40` = **5**, between 25 and 39 = **0**. The zero in the middle is
what makes it unambiguous — 40 is the ceiling being hit, not a value calls
drift to. Two of the five were on 09-08. Corrected to `>= 40` in `/CLAUDE.md`
and `docs/PULL-CHECK.md`. **What each of those five loops actually was has not
been established.**

### A measurement trap worth keeping

Surgery's hourly barely-heard rate on 2026-09-08 ran from **0% to 42.9%**
across nine business hours. Any single hour above the 25% watch threshold is
inside that spread. Do not report an hour of it as a spike.

### Open, and NOT decided here

- The transcript fallback — reading the date from what the caller actually
  said instead of waiting for the model to relay it — **is not built.** It is
  where the 53 actually go. `transcriptLog.ts` holds the caller lines in
  memory and only `mediaStreamBridge.ts` can see them.
- **Wayne's question, unanswered:** when a ticket files without a date of
  birth, does it carry `DATE OF BIRTH UNMATCHED` at the top of the description
  (already built), or route to a named person to verify first?
- Whether the 77 barely-heard calls are dead air or lost callers.
- Whether the 12 ticket-number-without-a-ticket calls exist under another SID.

---

# 2026-09-09 — the date-of-birth gate, and the half of it nobody had built

## The measurement this rests on

2026-09-08, one full business day, queue lanes (optical/surgery/tech/records/
pcp), calls >= 30s: **446 substantive, 255 filed, 191 produced no ticket.** The
single biggest cause is the date-of-birth gate: **75 calls hit it, 53 filed
nothing.**

The chain, all measured:

1. In **51 of the 75** the caller's own transcribed words contain a birth year
   or a month name. They answered.
2. **The model called the filing tool with no `date_of_birth` argument. 75 of
   75.** `dobShape` reads `(none)` on every refusal, across surgery, tech and
   optical.
3. Nothing to parse, no verified record to fall back on, so `decideDobEscape`
   returns `askAgain: true` on the FIRST refusal.
4. **In 42 of the 75 that refusal is the last tool call of the call.** The model
   never retries, so the "ask once then file anyway" escape (`dobEscape.ts`,
   the 2026-09-04 ruling) never gets its second attempt. **It is unreachable in
   the majority of cases.**

Share of substantive queue calls refused for `date_of_birth`, optical + surgery
+ tech — the baseline any "after" number has to beat:

```
old core 08-28..09-02   3.2% - 8.7%
old core 09-03          1.6%   (same day, pre-cutover)
grok     09-03         12.4%   (same day, post-cutover)
grok     09-04         14.8%
grok     09-08         18.3%   75 calls, 53 filed nothing
```

## What shipped

**Two independent defects, and only the second one can move that number.**

### 1. The parser could not read a birthday said one digit at a time

Probed against the real calls:

```
"0 1 0 4 58"                        REFUSED   CA4475d6f1b265c4c6824ff0f241d159f9, said 4x
"Cero tres veintidos del cincuenta" REFUSED   CAdc9f9667694dd95382985ad5f86f57b4, Spanish
"01 04 58" / "January 4th, 1958"    parse fine
```

`readDateFromAnything` assembles a date out of three numeric groups or four. A
caller spelling their birthday out produces **five**, which is neither, so it
fell through to the branch whose job is refusing phone numbers.
`readDigitStringDate` re-reads the digits as one continuous string, and runs
only after the existing reader has already refused — so by construction it
changes no answer the parser gives today.

Mutation-checked rather than asserted: the every-token-is-digits guard is
load-bearing (removing it fails three tests, two of them pre-existing — a
sentence's digits joined together fabricate a real, in-range, wrong birthday);
the 6-or-8 length check **earns nothing today** and the comment says so.

### 2. Nothing carried the caller's answer to the filing tools — this is the half that matters

`src/runtime/transcriptLog.ts` held the caller's lines in memory the whole
time. Only the bridge could see them. Every fix before this one depended on the
model relaying what the caller said, and on 75 of 75 refusals the model did not.

`src/tools/spokenDob.ts` bridges that gap: the bridge posts the record as it
grows (`mediaStreamBridge.ts`, on caller transcript), and the four filing tools
read the answer back by CallSid as a THIRD source in the `if (!parts)` chain —
after the model's argument and after `verifiedDobFor`, never replacing either.

**The guard is adjacency, and it is the whole design.** Filing a wrong birthday
is worse than filing none, and callers on these lines say surgery dates and
appointment dates constantly — `valid()` cannot tell those from a birthday. So
a date counts only when the caller said it while ANSWERING a request for one:
inside the turn following an agent line that *opens a window*, ending at the
next thing the agent says. Same TTL, ceiling, recency eviction and sentinel
rule as `gateAttempts.ts` and `verifiedIdentity.ts`.

**Which agent lines open a window is the discriminator** (Codex P1b on #275,
fixed in #280 rather than by first-vs-last date inside a window). A line
opens one only when it REQUESTS the date or REQUESTS confirmation of it — a
born-when phrase, a request/confirm cue (`may I have`, `is that`, `starting
with the month`, `need your date of birth`, `except your date of birth`), a
question mark whose question itself is about the date of birth, or a re-ask
follow-through (`mis-heard` / `once more`) on the same agent line even when
that cue sits in the next sentence. "I have your date of birth, thank you.
Anything else?" mentions the subject and then changes topic; it does not
open a window, so a later surgery date in the reply cannot become the
birthday. "I have January 4th 1958 — is that your date of birth?" still
opens one, so a real correction is captured.

**#280 over-narrowed the ask.** After republish, 3 of 13 live re-asks
stopped opening a window: "I just need your date of birth to get this
logged." (CAe3de7ada), "I have everything except your date of birth."
(CA74811ee4), and "the date of birth may have been mis-heard. Could you
give it to me once more?" (CAa6a32e9c). Those are asks. The P1b
acknowledgement is not. The extra cues are the ones that separate them.

**Same-turn "sorry I meant" replaces the first date** (P1c). First-date-
within still blocks "and my surgery is September 12th". It does not block
"January 4th 1958" / "Sorry, I meant January 5th 1958" — that later date
is the one the caller is standing on.

**A later empty window does not clear the date; a refused attempt does**
(Codex P1a). "Yes that is correct" yields no date and leaves the earlier
value standing. "No, zero three twenty two of fifty" is an attempted date
the parser refuses (`dobShape` / month word / two-plus spoken number words,
and `readDobQuietly` returned nothing). That clears the answer, and
`noteSpokenDob` deletes the cache entry — `if (!iso) return` used to leave
the rejected value for the four filing tools to write.

Every guard was mutation-checked against a scratch copy: dropping adjacency
fails 3, letting the window run past the next agent line fails 1, taking the
first answer instead of the last fails 1, using the announcing parser instead
of the quiet one fails 1, severing the bridge post fails 2, and severing the
third source fails one test in each of the four lanes.

`readDobQuietly` exists because the speculative reader must not touch the
instruments: `[DOB] refused a date of birth in the shape …` is the documented
live counter this whole finding rests on, and Grok re-emits a caller turn up to
five times, so an announcing parser would bury the real refusal count under
guesses no tool ever made.

## What this does NOT close

- **Spelled-out digits still refuse**, in both languages: `zero one zero four
  five eight`, `cero tres veintidos del cincuenta`. That cost a Spanish caller
  their request on 09-08 and it is unchanged.
- **The DOB question is recognised in English and Spanish only.** The runtime's
  own language table also carries Tagalog, Korean, Armenian, Farsi,
  Vietnamese, Russian and Arabic. A caller asked in any of those gets no window
  opened at all — the same known gap as the month table, needing the same
  evidence first: which phrasings actually arrive, in real transcripts.
- **The other no-ticket buckets are untouched**: 77 calls where the caller was
  transcribed 0 or 1 times (barely-heard is still ~2x the old core after the
  VAD drop to 0.6, and optical went the wrong way, 8.5% -> 21.5%), and 26 calls
  where tools ran and a filing tool was never attempted at all.
- **No production number yet.** BACKEND_HANDOFF §0 is explicit that green tests
  have never prevented one of these regressions. The control is
  `[DOB] refused … (none)` falling; the two new markers only prove the paths
  are live. Nothing here has been measured against a real call.

## Open, and Wayne's to settle

- **Unanswered from 09-08, and still blocking nothing but worth an answer:**
  when we file without a date of birth, does the ticket say
  `DATE OF BIRTH UNMATCHED` at the top of the description (already built), or
  route to a named person to verify first?
- **A test-fixture question.** The regression tests for both halves carry
  literal spoken dates, because that is what pins the parser. The standing PHI
  rule says dates of birth never go into git. The existing suite has done this
  since it was written (and one commit on the merged branch scrubbed a name and
  a number from a fixture while leaving dates), so the precedent is dates stay
  and identifiers go — but it is his rule and it should be his call, not one
  inherited from a file.
