# The after-hours line to the runtime — the review that comes before the repoint

**Written 2026-09-27, 23:10–23:50 UTC, on the operator's *"start the review"*.
Every number below was measured in the hour before it was written, from
`call_logs` (Hub), `tickets` and `voice_agent_api_logs` (Support Center), the
live `/voice/health` payload, and the lane built by `resolveLane("no-ivr")` in
this checkout. Re-measure before quoting any of it as current. No patient name,
date of birth, phone number or email appears in this document; calls are named
by `call_sid`.**

`no-ivr` is the after-hours agent. Standing instruction 13 routes every
overnight and weekend call to it through Nextiva enterprise routing, and it is
the one lane that escalates to the operator directly. It is also, since the
records repoint on 2026-09-27, **the last lane on the OpenAI SIP core with any
volume** — over the fourteen days measured here the old core served
`no-ivr` 1,010 calls, `records` 363 (moved this afternoon) and nothing else
above one call. Moving this lane empties that pipeline.

---

## 0. The operator's question, and the verdict

> *"Where do we stand on the no ivr agent moving over to the runtime."* —
> 2026-09-27, followed by *"start the review."*

**Where it stands: the runtime already registers, builds and reports this lane
as servable with its transfer armed, and nothing has ever pointed a phone
number at it.** `/voice/health` at 23:10 UTC reads `no-ivr: servable: true,
transferWarning: null`, `transferDestinations.clinical: true`, marker
`v73`. `resolveLane("no-ivr")` in this checkout builds the PRODUCTION factory
(`createNoIvrAgent`) with all six of its tools and none skipped. Every fix the
lane has taken since 2026-09-16 — v41 (the date-of-birth ask bounded to one),
v42 (a filed ticket is never spoken as a failure), v47 (a phone match is a
candidate), v53 (the record reaches the call row) and v74 (an email preference
is a question) — lives in that factory, so all of it rides across unchanged.

**The verdict: move it, in the order in § 6, with two things done first and
three things watched after.** The first thing done first is the operator's:
three test calls on the runtime lane from the dev number, because the warm
transfer that this lane depends on for a true emergency **has never once run
live on this pipeline** (§ 5a). The second is a small code change I recommend
and have not built: the language-switch tool the four queue lanes carry and
this lane does not, for the one caller in ten who speaks Spanish (§ 5c).
Neither is a reason to wait beyond the test calls.

**What the move is NOT: a fix for this lane's filing rate.** 56% of
substantive after-hours calls end with a ticket and 44% do not, and § 2 shows
that the two largest holes — the caller we never hear (99) and the caller who
hangs up mid-intake before any tool runs (81) — are ones the runtime leaves
open too. What the runtime brings this lane is the same set of things it
brought the other five: a greeting the transport plays on every call by
construction, a silence ladder that ends an open line instead of letting it sit
for a minute, a recording and timed turns, a tool ceiling, telemetry the
Observatory can read, and a cost per minute that on the reconciled days of the
last week ran at about half the old core's. The filing follow-ups this lane
needs (§ 4) become buildable on the runtime because its teardown has a place to
put them; the old core has none.

---

## 1. Where the calls fall — the window, and the hour to repoint in

Fourteen days, 2026-09-13 through 09-26, all `no-ivr` rows:

| | |
|---|---|
| calls | **1,010** |
| substantive (`duration >= 30`) | **617** |
| substantive seconds | 91,224 (25.3 h) |
| average substantive duration | 148 s |
| average caller lines per substantive call | 8.4 |

**Weekday hours (UTC), 10 business days.** Hour 0 (5 pm Pacific, the queues
just closed) carries 214 calls and hour 14 (7 am Pacific, the hour before they
open) carries 193; together they are 40% of the fortnight. **Hours 15 through
22 carry 19 calls in ten weekdays, hours 19 to 22 carry none.** That is the
daily handover this file already records for this lane, and it is the repoint
window:

> **Repoint on a weekday between 09:00 and 15:00 Pacific (16:00–22:00 UTC).**
> Not before 8 am Pacific — hour 14 UTC is the second-busiest of the day — and
> done by 3 pm so the first evening peak at 5 pm arrives on a lane that has
> already taken a test call.

Weekends are the other population: 09-19 (a Saturday) took 135 calls and 09-26
took 148, spread across every daytime hour. **Do not read the all-days hour
table as the idle window** — I did, first, and it showed 308 daytime calls
that were all Saturdays and Sundays (§ 8).

---

## 2. The funnel — one population, stage by stage

| stage | calls | of substantive |
|---|---|---|
| substantive | 617 | |
| **filed** — ticket on the call row, or in the Support Center by SID | **346** | **56.1%** |
| **did not file** | **271** | **43.9%** |

**The call row is a faithful measure on this lane.** Of the 273 substantive
calls with no `ticket_number` on their row, exactly **2** carry a ticket of any
provenance in the Support Center (both agent-filed, both in the
tools-ran bucket below). The other 271 have none — no agent filing, no staff
ticket, no unknown-provenance row. This is unlike the queue lanes, where the
row misses about 3% to write-back gaps; here the two writers agree on 271 of
273, so `call_logs.ticket_number` can be used for the after-arm without the
Support Center join.

**The 273, by what the call was:**

| shape | calls | avg s | what it is |
|---|---|---|---|
| **caller never transcribed** | **99** | 67 | zero `CALLER:` lines. The ring-back control (W3, 2026-09-23) put this lane's real-person share at 9.2% — mostly dead air, a floor not a share |
| caller transcribed once | 29 | 59 | one line, then nothing |
| **a conversation, and no tool ever ran** | **81** | 93 | 2+ caller lines, `tool_timeline` empty, `tool_call_count` NULL on all 81 |
| a conversation, tools ran, nothing filed | 60 | 174 | 4 hit a `create_ticket` refusal; 56 ran `lookup_schedule`/`check_open_tickets` and never reached a filing tool; 2 of the 60 DID file (the cross-check) |
| transferred to a human, no ticket | 4 | 127 | the old core's transfer path; a ticket is not required on it |

### The 81 tool-less conversations, by the agent's last line

Shapes only — the agent's final line classified, no caller text read:

| the agent's last line was… | calls | avg s | avg caller lines |
|---|---|---|---|
| a question (not name, DOB or callback) | 30 | 105 | 5.5 |
| an hours / location / address answer | 19 | 67 | 3.6 |
| a statement | 15 | 101 | 7.3 |
| asking for a date of birth | 9 | 86 | 4.4 |
| a closing | 4 | 56 | 3.8 |
| "anything else?" | 2 | 63 | 2.0 |
| asking for a name / a callback | 2 | — | — |

About **25 of the 81 are correctly ticketless** — hours and locations answered,
a call that closed. The other **~55 are callers who hung up while the agent was
still asking**, which is the exact population a teardown sweep files from the
transcript on the queue lanes (`requestSweep.ts`). **Neither pipeline sweeps
this lane today** — `DEPARTMENT_BY_SLUG` names optical, surgery, tech and
records, and the old core's only teardown filer is `sweepPcpUnfiledCall`. § 4
has the follow-up.

### The ticket API is not where the loss is

`/api/voice-agent/submit-ticket`, the after-hours endpoint, over the same
fourteen days: **343 accepted, 8 refused (HTTP 400), 1 refused for a missing
API key.** The eight refusals are a name the app could not parse and two
surgeon-name shapes on surgery requests taken after hours. That is 2.3% of
POSTs; the queue lanes' `create-ticket` was refusing 20% on 2026-09-01. Whatever
the runtime changes about this lane, it is not rescuing requests from an API.

### Current state of the lane, last 7 days (09-20..09-26, 319 substantive), on the build live since v73

| | count | share |
|---|---|---|
| asked for a date of birth 2+ times (agent lines that ASK, not mention) | 91 | 28.5% |
| asked 3+ times | 43 | 13.5% — worst 5 |
| said *"experiencing a technical issue"* | 0 | (the v74 corpus call is 09-27, outside the window) |
| a Spanish cue on the caller's side | 33 | **10.3%** |
| zero caller lines | 47 | **14.7%**, avg 68 s, 53 min of open line a week |
| `patient_found = true` on the row (v53) | 56 | 17.6% |
| `caller_name` set (Twilio CNAM, not a patient match) | 262 | 82% |
| recording on the row | 317 | 99.4% |
| graded (`agent_outcome`) | 319 | 100% |
| the recording disclosure PRESENT IN THE TRANSCRIPT | 217 | **68%** |
| the 911 direction present in the transcript | 228 | 71% |

The last two rows are presence in the TRANSCRIPT, not proof of what was
spoken: the old core's greeting is spoken by the model on a `response.create`
with a delivery check, and the transcript may simply not carry it. What they do
establish is that today nothing can PROVE the disclosure was said on a third of
after-hours calls. On the runtime the transport plays the greeting as audio
before the model's first turn and writes it to the transcript log
(`mediaStreamBridge.ts`, `greetingLine` at 1333, amended at 1663), so that share reads ~100% by construction — a
guard number for the after-arm.

**The date-of-birth re-asks are speech, not tool.** v41 bounded the
`create_ticket` refusal to one per call and it holds (no tool-path loop in the
window). The 43 calls asked three or more times in SPEECH — the agent asks, the
caller answers, `lookup_schedule` misses, the agent asks again. The queue lanes
got a bound on exactly this in v50 (`LOOKUP_MISS_LIMIT` in `lookup_patient`);
this lane's own `lookup_schedule` has none. **The move does not change this**
(§ 4).

---

## 3. What the move changes for a caller — each row says how it is known

The same factory, the same six tools, the same prompt, the same ticket endpoint.
What changes is the pipeline under it. Checked in this checkout unless the row
says otherwise:

| | old core today | runtime | how known |
|---|---|---|---|
| **greeting** | the MODEL speaks it on a forced `response.create`; in the transcript on 68% of calls | the TRANSPORT plays it as audio before the model's first turn; `chooseGreeting` prefers the `agents.welcome_greeting` row (182 chars) if it carries the closed-office notice, the 911 direction and the disclosure, else the registry's; logged to the transcript | `voiceRuntime.ts`, `greetingPersonalisation.ts` (`MANDATORY_GREETING_COPY['no-ivr']` — three sentences, each with a negation check), bridge `greetingLine` 1333 |
| **pre-context** | `sage_precontext` over HTTP, no-ivr in `PRECONTEXT_SLUGS` | fetched for every lane, 1.5 s deadline, spread into the factory's `metadata.precontext`; the agent's own block (`pc?.matched && pc.firstName`) renders the same | `voiceRuntime.ts:920,1017`; `noIvrAgent.ts:269` |
| **phone lookup at factory time** | `scheduleLookupService.lookupByPhone` + caller memory, bounded | identical — it is inside the factory | `noIvrAgent.ts:898–` |
| **v47 (phone match is a candidate), v41, v42, v53, v74** | live | identical — all inside the factory or `submitSimplifiedTicket` | this review's premise; the marker table |
| **turn detection** | OpenAI server VAD | Grok VAD at `RUNTIME_VAD_THRESHOLD` 0.6; measured on the queue lanes: barely-heard halved on surgery and tech, callers say more in fewer lines | CLAUDE.md, W3 |
| **a caller who never speaks** | nothing detects it; 47 a week sit an average 68 s, two queue-lane calls hit the 602 s ceiling | the silence ladder (v68): three prompts 12 s apart, then `caller_silent`; **a caller who HAS been heard is never cut** (v72, operator ruling 2026-09-26) | `silenceLadder.test.ts`; the v68/v72 rows |
| **dead air after a tool** | — | 30 s watchdog; v55/v56 hold the hangup while a tool answer is unvoiced | bridge |
| **a tool called in a loop** | no ceiling | 3 identical failures / 6 per tool / 10 identical successes / 20 per tool / 40 per call | `toolCeiling.ts` |
| **`terminate_call`** | POSTs OpenAI's SIP hangup endpoint, `ok`, `markCallConcluded` | the same POST answers **404** (the call id is not an OpenAI call); `guardsAllowedTermination` reads the numeric status as guards-passed and the bridge hangs up anyway. `markCallConcluded` is skipped — it exists only for the old core's SIP recovery. One wasted authenticated HTTP call per tool hangup; 159 in the fortnight. **The #147 shape, already open on PCP** | `noIvrAgent.ts:1653`, `mediaStreamBridge.ts:164` |
| **escalation to a human** | `escalate_to_human` → conference participant dial to `HUMAN_AGENT_NUMBER` (the operator), keypress accept | `warmTransfer.ts`: the caller KEEPS the agent, the operator's phone is dialled with a briefing and a press prompt (45 s), and only a keypress moves the caller into the conference; decline / no answer / error → the tool throws, the agent files a ticket. **Never run live on this runtime** — every runtime transfer to date is PCP's BLIND path | § 5a; `call_logs` where `voice_provider='grok'` |
| **the agent's tools** | 6 | the same 6 — `lookup_schedule`, `check_open_tickets`, `emit_decision`, `create_ticket`, `escalate_to_human`, `terminate_call`. **No `set_spoken_language`** | `resolveLane` in this checkout |
| **output guardrails** (`medicalSafetyGuardrails`) | honoured by the SDK | carried verbatim by `agentBinding` | `agentBinding.ts:94–103,239` |
| **voice** | `sage` (OpenAI) | `eve` (the runtime default), per-lane override `XAI_VOICE_NAME` — **which voice is the operator's call** | `laneRegistry.ts:331` |
| **recording** | conference `record-from-start`, 99.4% of rows | REST recording started at the stream's first frame, dual channel, same handler; 681 of 682 runtime rows on 09-22 | v44 row |
| **timed turns / `call_turns`** | `turnLog` | `persistRuntimeTurns` | v44 row |
| **grading** | at teardown | at teardown (v49) plus the backfill | v49 row |
| **identity on the row** | v53 writes it from `create_ticket` on a confirmed name + date of birth | v53 works unchanged (`callLogId` is a getter the runtime backfills, `voiceRuntime.ts:1008`); v51 adds the teardown write for a CERTAIN identity | v51/v53 rows |
| **telemetry** | `agent_id` 100%; `total_turns`, `interruption_count` on the old core's scale | `voice_provider='grok'`, `runtime_outcome`, `tool_call_count` on every call, `follow_up_summary` / `identity_summary` / `caller_audio_summary` rows; `agent_id` via `agentIdentity` — the `agents` row for slug `no-ivr` exists and is active | `agents` table read 23:15 UTC |
| **the Observatory** | old-core card | the card names the pipeline and warns *"mixed pipelines"* on the cutover day — expected, not a fault | `pipelineSplit.ts` |
| **a teardown sweep** | none for this lane | **none for this lane** — `decideSweep` returns `not-a-queue-lane` | § 4 |

### Cost, on the same seconds

Seven days, 09-20 through 09-26, 500 `no-ivr` calls, 852 minutes, every row
carrying both cost columns (v52 is live):

| | per week |
|---|---|
| OpenAI (token-priced, `openai_cost_cents`) | **$100.79** |
| Twilio | $7.49 |
| **total booked, old core** | **$108.28** |
| the same 852 minutes at the runtime's reconciled rate | **$52 – $61** (6.1 – 7.2 ¢/min on the five reconciled days 09-21..09-25) |
| + Twilio, unchanged | $7.49 |
| + Twilio REST recording at ~0.25 ¢/min | ~$2.13 |
| **runtime, projected** | **~$62 – $71** |

**Read the caveats before repeating the saving.** The runtime's rate is
xAI-reported day spend divided by OUR recorded minutes, which this file already
records is a ratio and not xAI's unit price; it read 11.75 ¢/min on 09-18 and
6.1 on 09-22, and why it moved is not established. Text-API spend is excluded
(about a tenth of the day on 09-03). And a per-call minimum, if that is what
the gap ever was, moves with call-duration mix — after-hours calls are longer
(148 s) than the queue lanes' (112–132 s), so this lane would be on the
favourable side of that. Honest form: **on the last week's reconciled rate the
move saves roughly $40 a week on this lane, and the first reconciled after-hours
day is what turns that into a number.** The 2026-09-26 `daily_grok_costs` row
reads $10.36 of voice spend against 0 runtime calls and is not usable for a
rate (§ 8).

---

## 4. What the move does NOT change — and becomes buildable because of it

1. **The ~55 mid-intake hangups a fortnight file nothing on either pipeline.**
   The runtime has a teardown sweep and it declines this lane by table; the old
   core has no hook at all. On the runtime this is one lane entry plus the
   after-hours payload shape (`submitSimplifiedTicket`, not `create-ticket`),
   with the `saidMoreThanTheirOwnIdentity` admission and the v73 identity-only
   window already written. Its guard is the azul 2026-07-28 shape — swept
   tickets a staffer closes as junk must not rise. **Follow-up, after the move
   has a week of data, not before.**
2. **The speech re-ask on the date of birth** (43 calls a week at 3+, worst 5).
   `lookup_schedule` gets the `LOOKUP_MISS_LIMIT` shape v50 gave
   `lookup_patient`: first miss coaches one shaped re-ask, second miss says
   stop and file. Same on both pipelines; the runtime makes the count SQL-able
   through the timeline allow-list. **Follow-up.**
3. **`terminate_call`'s 404.** Harmless; #147.
4. **Spanish.** One caller in ten. See § 5c — this is the one I recommend doing
   BEFORE the repoint.
5. **The 99 never-heard callers.** The runtime does not hear them either; what
   changes is that the silence ladder ends the line at about 48 s instead of
   68 s average and records `caller_silent`, and the v64 caller-audio meter
   finally says whether frames arrived carrying speech. That is the instrument
   the optical zero-line question has been waiting on; this lane, at 14.7%,
   gets it for free.

---

## 5. Risks, each with the control that bounds it

### 5a. The warm transfer has never run live on this runtime

Every transfer `call_logs` has ever recorded on a `grok` row is PCP's BLIND
path (`method: "blind"`, every one of them). `warmTransfer.ts` — the
briefing, the keypress, the conference redirect on accept, the throw on
anything else — has unit tests and no production call. This lane used
`escalate_to_human` on 28 calls in the fortnight (33 events; the escalation
gate refused 12) and 21 calls reached a human. **A true emergency at 2 am is
the one call this lane exists for, and it must not be the first time the code
path runs.**

**Control: the operator's own phone.** `HUMAN_AGENT_NUMBER` is the `clinical`
destination and `/voice/health` says it is set. A test call that says the words
the prompt lists as an emergency will dial him; he presses a key; the caller
(his second phone) should land in the conference with him. Then a second test
where he DECLINES or lets it ring out: the tool must throw, the agent must say
so and file a ticket rather than promising a connection that did not happen
(the 2026-08-04 shape `handoff-silent-failures.md` exists for). **While the
operator's phone rings the caller hears the agent's *"Stay on the line"* and
then nothing — up to 45 s.** The `HOLD_LADDER` exists only in the scheduling
agent; that silence is a known gap and not a defect of the move.

### 5b. The prompt is three times the largest lane already on Grok

Built in this checkout by `resolveLane("no-ivr")`:

| lane | total chars | own share (minus the 9,317-char knowledge pack) | ≈ tokens (own) |
|---|---|---|---|
| tech | 15,691 | 6,374 | ~1,600 |
| records | 16,738 | 7,421 | ~1,900 |
| pcp | 18,919 | 9,602 | ~2,400 |
| **no-ivr** | **37,795** | **28,478** | **~7,100** |

v18 trimmed this prompt 23.8% for Grok without changing a rule and said
plainly it does not reach the operator's 1,600-token ceiling, and that getting
there means deleting capability — his call, not a trim's. Nothing on this
runtime has served a prompt this size. **What it costs is not known:** first-
turn latency (the greeting is unaffected — the transport plays it), adherence
to the rules deep in the prompt, and whether xAI imposes a hard ceiling on
`session.update` instructions at all (PCP's 18,919 chars work; this is twice
that).

**Control: the test calls, then the first evening.** The first test call
answers the hard-ceiling question in one second. The after-arm's median caller
lines per call and time from first caller line to first agent reply answer the
latency one. **The capability cut, if the data says one is needed, is the
operator's decision (standing instruction 1) and a `docs/BACKEND_HANDOFF.md`
change — recommended AFTER a week on the runtime, not before, because trimming
against a guess is how a rule gets deleted for a problem that was not there.**

### 5c. One caller in ten speaks Spanish, and this lane has no language tool

33 of 319 substantive calls last week carried a Spanish cue on the caller's
side. The four queue lanes carry `set_spoken_language` (`techAgent.ts:98`),
which retargets Grok's STT hint to `es-MX` and tells the model to follow the
caller. `no-ivr` builds its tools by hand and does not carry it — the runtime
would serve this lane with the STT hint pinned to `en` and the prompt's own
*"handle language detection/switching"* line doing all the work.

**Bounded, and measured before this was written:** `languageTools.ts` records
that Grok transcribes Spanish accurately with the hint still set to `en`, and
that Spanish queue calls filed at 67% against 51% for everything else in the
fortnight before the tool existed — so this is a capability gap, not a
bleeding wound. Grok hears the audio; the model can answer in Spanish from the
prompt. What is lost is the regional STT hint the operator asked for on
2026-09-05 and the mid-call switch for a caller who opens in English.

**Recommendation: add the tool to this lane before the repoint.** It is a
hand-built tool definition beside the other six, calling the same
`normalizeSpokenLanguage`, and the bridge already acts on any tool of that name
(`DEFAULT_LANGUAGE_TOOL_NAMES`). On the old core it is inert — no transport
step exists there — so it can ship ahead of the move without changing what
callers hear today. **Not built here**; this is a review. Say the word and it
is a small PR with the queue lanes' existing test shape.

### 5d. The last old-core control disappears

After this move the OpenAI SIP core serves no lane with volume. Every
cross-pipeline comparison this file has leaned on — the same-day A/B of
2026-09-03, `records` as the control for the VAD change, the
`interruption_count` and `total_turns` traps — ends. **That is a cost to
measurement, not to callers**, and it is the same trade already made five
times. The transcript-based instruments (`[interrupted]` marks, `CALLER:`
lines) are what survive, and they are what the after-arm uses.

### 5e. The silence ladder on a lane where one caller in seven is never heard

47 of 319 substantive calls a week have zero caller lines. On the runtime each
becomes three spoken prompts and a `caller_silent` cut at about 48 s. If those
are dead lines (the ring-back control says ~91% are), that is strictly better
than 68 s of open line. If some are real callers we did not hear, the ladder
tells them three times that we cannot hear them and hangs up — **and v72's
stand-down means that can only happen to a caller who was NEVER transcribed**,
so the exposure is the same population the old core already loses in silence.
The v64 meter (`caller_audio_summary`: `voiced` against `silent_line`) is the
instrument that finally splits them, and this lane is where the answer matters
most.

### 5f. The evening peak lands an hour after a mid-afternoon repoint

Hour 0 UTC carries ~21 calls a weekday on this lane. A repoint at 3 pm Pacific
puts the first real load two hours later. **Control: the test calls are done
before the repoint, and I watch the first evening's rows as they land** — the
runtime's `[voice-runtime]` boot line and `/voice/health` say which build is
serving, and a `voice_provider = 'grok'` row with `agent_used = 'no-ivr'` is
the first proof a live caller reached it.

---

## 6. What to do, in order — recommendation

**Everything here is a URL change on a process that is already running both
pipelines. No deploy is needed for the move itself; the rollback is the same
URL change in reverse.**

1. **(mine, before the repoint)** Add `set_spoken_language` to the no-ivr tool
   list (§ 5c). One PR, the queue lanes' test shape, inert on the old core.
   Ship it and republish so the test calls exercise the lane that will go live.
   **Skippable if the operator would rather move first** — it is a 10% quality
   improvement, not a safety property.

2. **(the operator's — three test calls.)** Point a spare number — the old
   core has a `/api/voice/dev-no-ivr` route, so a dev number may already exist
   — at

   ```
   https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app/voice/no-ivr
   ```

   **Not `/voice/dev-no-ivr`.** On the runtime that slug builds the V2
   workflow agent (`createNoIvrAgentV2`), not the production factory; the
   production after-hours agent exists on this runtime under `no-ivr` only.
   Read `/voice/health` first and confirm `no-ivr` reads `servable: true`.
   Then:

   | call | say | what must happen |
   |---|---|---|
   | ordinary | a routine request with a name and a date of birth, ask to be called back | greeting plays at once (closed notice, 911, disclosure); the agent files; a `VA-` number is read back; the call ends cleanly on `terminate_call` |
   | emergency, accepted | an emergency shape from the prompt's list | `escalate_to_human` fires; the operator's phone rings with the briefing; he presses a key; the caller lands with him |
   | emergency, declined | the same, then let it ring out or decline | the tool throws; the agent says it could not connect and takes the request; a ticket files; no *"connecting you now"* over a dial that failed |

   Optional fourth: open in Spanish. The row for it in the after-arm is § 7's
   Spanish line.

   Each test call is proven by its own `call_logs` row: `voice_provider =
   'grok'`, `agent_used = 'no-ivr'`, a `runtime_outcome`, and — on the two
   transfers — `transfer_outcome` carrying `method: "warm"`, which no row in
   the table has ever held.

3. **(the operator's — the repoint.)** Point the live after-hours number at
   the same URL, on a weekday between 09:00 and 15:00 Pacific (§ 1). The
   number is the one on the `agents` row for slug `no-ivr`, and the change is
   in the Twilio console under that number's voice webhook — which today reads
   `…/api/voice/no-ivr`. **Rollback is pointing it back.**

4. **(mine — the first evening and the first week.)** The after-arm in § 7,
   read at 24 hours and at 7 days, reported in the daily sweep. A watch is
   armed for the first evening the moment step 3 is confirmed.

5. **(the operator's, later — the prompt.)** After a week of data, the
   § 5b question: leave the prompt, trim packaging again, or cut capability
   toward the 1,600-token ceiling. Recommended answer today: **leave it**,
   because nothing yet says it costs anything, and the data will.

6. **(mine, after the move has data.)** The two filing follow-ups in § 4 — the
   after-hours teardown sweep (~55 requests a fortnight) and the
   `lookup_schedule` miss bound (43 calls a week asked three or more times).
   Each measured on the runtime's own instruments before it is built.

---

## 7. The after-arm — the numbers, and the guards that outrank them

All per substantive call (`duration >= 30`), `agent_used = 'no-ivr'`,
`voice_provider = 'grok'`, against the fourteen-day before-arm in § 2:

| number | before (old core) | expected | reads from |
|---|---|---|---|
| **filed (ticket on the row)** | **56.1%** (346 / 617) | **must not fall** — the move fixes no filing defect, so flat is the pass | `ticket_number IS NOT NULL` |
| the recording disclosure in the transcript | 68% | ~100% | transcript `AGENT:` first line |
| zero-caller-line calls | 14.7% | about the same COUNT, now ending `caller_silent` at ~48 s instead of `completed` at 68 s | `runtime_outcome`, `CALLER:` count |
| `caller_silent` on a call WITH a caller line | — | **0** (v72) | `runtime_outcome` + transcript |
| warm transfers attempted / accepted / declined | 21 reached a human in 14 days; the old core records no outcome | every attempt carries `transfer_outcome.method = 'warm'`; `transferred_to_human` true ONLY on an accept | `call_logs.transfer_outcome` |
| `escalate_to_human` events per substantive call | 33 / 617 | **must not rise** — a runtime that dials more is a prompt being obeyed differently, not a win | `tool_timeline` |
| the agent said *"experiencing a technical issue"* | 0 / 319 last week | 0 | transcript |
| Spanish-cue calls that filed | measure at 24 h | not below the English share | transcript + row |
| date-of-birth asked 3+ times | 13.5% | unchanged until § 4 item 2 — a fall here would be surprising and should be checked, not celebrated | transcript |
| `tool_call_count` NULL | NULL on every call where no tool ran (all 99 never-heard and all 81 tool-less conversations) | NULL only where no tool ran; `tool_timeline` present on every tool call (v38) | `call_logs` |
| `patient_found` on a row whose only match was the PHONE | 0 | **stays 0** (v47, v51's accessor, v53's `identity.unique` guard) | `call_logs` |
| cost per minute | 12.7 ¢ booked (OpenAI + Twilio, 852 min last week) | ~7–8.5 ¢ once the first after-hours day reconciles | `daily_grok_costs`, `call_logs` |
| first-turn latency (first caller line → first agent reply) | not measured on the old core | measure, compare to pcp's on the same days | `call_turns` (v44) |
| `dead_air` outcomes | — | low; a rise means the 30 s watchdog is biting a slow after-hours caller | `runtime_outcome` |

**The guards outrank the numbers.** A filing rate that rises while
`escalate_to_human` also rises is not a win; a `caller_silent` on a call with
a caller line is a v72 regression whatever else improved; a `patient_found` on
a phone-only match is a wrong patient on a ticket.

---

## 8. Measurement traps this review walked into, recorded because they recur

1. **The idle window read from all seven days.** Hours 15–23 UTC showed 308
   calls over the fortnight, which contradicted this file's *"hours 15–23
   carry ZERO"*. Both were right: the 308 are Saturdays and Sundays, when this
   lane takes the whole day. Weekday-only, those hours carry 19 calls in ten
   days. **Split by weekday before naming a quiet hour on a lane that owns
   weekends.**
2. **"Date of birth" mentioned is not "date of birth" asked.** Counting agent
   lines that CONTAIN the phrase read 137 calls at 2+ and 81 at 3+; counting
   lines that ASK (may I / what is / could you / confirm … date of birth) read
   91 and 43. The first number includes the confirmation *"I have your date of
   birth"* and the format coaching. The second is the one in § 2.
3. **The Support Center join by SID timed out at 60 s** when it also touched
   `voice_agent_api_logs` through a JSON path on 273 SIDs. Split into the
   `tickets` join alone (fast) and the endpoint aggregate by date (fast). A
   query that needs both is two queries.
4. **`daily_grok_costs` for 2026-09-26 reads $10.36 of xAI voice spend against
   0 runtime calls** (a Saturday; the reconciler's own row says *"no
   runtime-served calls on this day"*). Whether that is xAI's day boundary or
   the operator's test call landing on the wrong side of midnight is not
   established; the row is excluded from the rate in § 3. The five weekday
   rows it sits beside agree with each other within a cent a minute.
5. **`dev-no-ivr` is not the dev version of the production agent.** On both
   pipelines that slug resolves to `createNoIvrAgentV2`. A test call to
   `/voice/dev-no-ivr` would have exercised a different agent and proven
   nothing about the lane being moved. The production factory is registered
   under `no-ivr` alone, so the test lane IS the live lane, reached from a
   different number.
6. **The disclosure's presence in a transcript is not proof it was spoken, and
   its absence is not proof it was not.** On the old core the greeting is a
   model turn under a delivery check; the transcript is a second-hand record of
   it. The runtime writes the greeting it PLAYED, so only there does the
   transcript column become a compliance instrument.

### Reproducing § 2

```sql
-- Hub. The funnel and the loss taxonomy, one row.
WITH c AS (
  SELECT call_sid, duration, ticket_number, transferred_to_human,
         (SELECT count(*) FROM regexp_matches(coalesce(transcript,''), '(^|\n)CALLER:', 'g')) AS caller_lines,
         (SELECT count(*) FROM jsonb_array_elements(coalesce(tool_timeline->'events','[]'::jsonb)) e) AS tool_events,
         (SELECT count(*) FROM jsonb_array_elements(coalesce(tool_timeline->'events','[]'::jsonb)) e
            WHERE e->>'tool' = 'create_ticket' AND e->'outcome'->>'success' = 'false') AS create_ticket_refused
  FROM call_logs
  WHERE agent_used = 'no-ivr' AND created_at >= '2026-09-13' AND created_at < '2026-09-27'
)
SELECT count(*) FILTER (WHERE duration >= 30) AS substantive,
       count(*) FILTER (WHERE duration >= 30 AND ticket_number IS NOT NULL) AS filed_on_row,
       count(*) FILTER (WHERE duration >= 30 AND ticket_number IS NULL AND caller_lines = 0) AS zero_caller,
       count(*) FILTER (WHERE duration >= 30 AND ticket_number IS NULL AND caller_lines = 1) AS one_caller,
       count(*) FILTER (WHERE duration >= 30 AND ticket_number IS NULL AND caller_lines >= 2 AND tool_events = 0
                          AND NOT coalesce(transferred_to_human,false)) AS conv_no_tools,
       count(*) FILTER (WHERE duration >= 30 AND ticket_number IS NULL AND caller_lines >= 2 AND tool_events > 0
                          AND NOT coalesce(transferred_to_human,false)) AS conv_tools,
       count(*) FILTER (WHERE duration >= 30 AND ticket_number IS NULL AND caller_lines >= 2 AND transferred_to_human) AS transferred_no_ticket
FROM c;
-- Then, Support Center: SELECT count(*) FROM tickets WHERE call_sid IN (<the 273>) — answered 2.
```

---

## 9. The corpus — SIDs by shape (RULE THREE)

The 273 substantive `no-ivr` calls of 2026-09-13..09-26 with no ticket on
their row. Transcripts stay on disk and in `call_logs`; only the SIDs are here.

**Caller never transcribed (99):**
CAcc3a9b1956364c18b7a9fa2ad80de830 CAd6cbf1cc72098add81d5a18475a4fe55 CA64ed084f1e7306707d6fde82f9ab9036 CA3a433fcf78c93bcff735ba2038220e8a CA283d76e047006603a880a714c338af77 CA3f5f3e60d9f9dd350a024161ae317d06 CA35ca2d966ce6ca16faffcea7fe46cd29 CAad6e84d25233aa6d1d7a4a24670b9195 CA00461824e733c092c0d9486bcfde8758 CA702ea8ccdbc3be4c001a43d5ed251ceb CAbd85c293253aa4c81a9c64ca7bba2b80 CAafee4ee69df3d29f3f2b11b655b18bc2 CA037b93df0010b6480966d30590dbeaf2 CA77c531353c8aa6cd8a5d302029e0c8ee CA1f030bf80d7a852a23ea66f260a16be8 CA3c02236b1ed2c7c847b1496ed6a33e7f CA523d28b719a99fa3871ba82f948d4c56 CA38972258dd3950bd7fd564e52f948f07 CAa73ca86b6e16096788c7a55a5c297cd7 CAdd4dd03fb64e1bba7b2958a120d017b1 CAd91e1a79ad031e672048355029667e13 CAc000c6b7942ab386f74814379a939532 CAf1fcc77798c8aa5d1b5d9302110f5020 CA24ff373d1492ae7c21dd681acab932b7 CAcb7b3c96d437f080e91948956b769bd0 CAa0977ce2e70f115f0fd57272836e5710 CAed03b722ef81cbfb5d5b6f46ddc77f37 CA309a26662755e0df3b61db9d164fbb14 CAf82fae39881316736ae8e6ba48f5daed CA84a4a03a5a3f73913d5e782dfe0831c3 CA3f4c8908b9049c71d66a2c03871fc3bf CAbeb9824fc7761ef2013401c780aedc2a CAac6e6ef8b9e1e5114b7fa1de355b1744 CAc0cf8a93c825de7891a2ad0646c05e05 CA5e221913ba0138fafa2d863d3018ea6e CA283ba0333712f7c32123a43a267cb26c CA603e1ce1786e6911727ca1d1cb44fa7e CAc74ae7802de5eebf80573a28c66d7795 CAc13606880e8d7aef68a7ac5ddf143d78 CAb898669329b517f958b6d4064ef94d9b CAd934eb92f721dc8d3177619e78ef35b0 CA7f4d33f4a585b0c3e05eaf47d857d00b CAf1c540e1f9161f8639de854f9e1bbdfa CA556feb17a8529aff50fc7c4dbd050240 CA42faec40c78ec6bf2a46350d94978bc2 CA5d5305d9ca320462fde16a413138fd88 CA504ceaf5368f7e8b06d4f438fbd33607 CA816e580a36dfd353c9497a50c5071dac CA193f3d584ac7a65c799abe4e9d146078 CA63c49942daef121124e6254de0975bb7 CA0f96e5a654580989fc38cb9eed1354dd CA32c132ef6905de5481e3c81879174209 CA040ed37ff7d3d355031eb52ba9ae828a CA838e244d5953bd2ec3b258f4057ac475 CA77eef3b872d9bf9766f0365ceff6e67f CAaea95a35a5383ccf3d3d323eeeef4fdb CAefe956d455091e70fe2042522bbae301 CAa4a34e344802c8e8c96a2ba2e91c08db CAfc177815f075a9ce680a92fcb64c0742 CA699ccfc515c768620abc1cf65fdd5732 CA5361f79f5f72cf81119fd4c2c1ecbf93 CA8ae097b7322efe3afa8351aec4720f4f CAb5b538ca28858ad6d00d36b5d0556559 CAa9c9b5b80886b8f42b59245f977fae44 CAa4e2dd2dac178f2cb37dfe5c8aa7916d CA55b6bc1c9b2fdfd40df19a5f33db5490 CA8e22179730647a2ac6b4e60a9d39daac CA58ee76b268145760e3248444e4917ef5 CA4c74c052b7b664da6e7829782bb2e9c2 CA5331c9dc6a0df5b9c2a77440e56d6834 CA8f1acf9fb141a0a89ed9142daa13fa3c CAefe65c36df0e78f7152d88693d68f757 CAda92175849fbb535ad7fb56a85806c50 CAf03f1f37864220f6a4c424d6522edb1f CAb74f887644101adcd493f240c1c51a1e CAf279d7a398ce4fc8718983ab31b05691 CAbbb3d5adf40c08b505ba6fcb6d8bc8b3 CAe0db0a389b45d53b4b25719150b82c94 CA65802ca18fcfbde9c31433f3049be1e6 CA2e4d4a409373e6e49ccd6608226cabb2 CA86e6fcec81d9253fb07303eeace58728 CAc005b114a46ec5cc85eb6823e1e77baf CAe94786e83f21e3e8d38c50302ab23763 CA90bee343a8842585c3decbc01640ede7 CAe803f4f00efffe37f36b5d12373fc542 CA342f1c6fa66108cab06a5e241a8d22e6 CAc4ea93bbbd3bab8221bcef78351579a6 CAc7ff06a5116981a9c38fd7c50628ff66 CAd8805622c0e1551f1c59914154fce24b CAc81ec5555f0cfdd59409290446199beb CAf66cb8792221cc02ae601daf8317767c CA164528731d3254321bd82573f46e5fa9 CAa084d1500b29ab69c88cf1d3a5173dbe CA08078f1dccbe82cb452374bb5388e8d8 CAa6c057a5f4324e5e3158aab27034c4c3 CA0593ccdd78fd0facbae910f9c746343d CA445ff38a0c74ed48afa7d44366ee5d80 CA83c3179cfd2605cd84e0d209a854f930 CAafab63ef814f9782528b064b42218029

**Caller transcribed once (29):**
CA4c297420ceaaa3e6626e86cc09ff71a7 CAde60ca30d007cd4c8ac6eb76aa31a715 CAc225dad9eea1e52e9face96dc34d0e3a CA7d992d45181ba23b53c354f7b96e7f38 CA28d139b49dad06c682bf5b0c64304083 CA6bb0835da90f043c2f62007193b72398 CA35b9bc0312f4add0dd16347ca95b92dc CA740fd8447ca34ec833f6bf0c1a00523a CA0f264f6f348ba414b4c2a1a9ae9029c9 CA86ee77ba1e34af5285685a214faf492b CA82b0560cec66c40abd5cbc921a206a91 CAb14fd9e9ae37dc4fee3730d0685956d0 CAe5e75fcd76e0bb75307edcd5e8024dca CA2b8d8fdaaccfcf3bcaca221596f79230 CAe266d8e30cc5b2cdfbc78040ae04f804 CA020f47e7f513e5c5e9bc7e48c0d16b93 CA9ecac6a797a2deb340810ecd3f1910f9 CAd6a87f360d2a86c3226601083f19c824 CAdb67385a38771a0f706d6447b3a78d20 CA7f93570c41088a9eeefcbdf149859a8a CA7ea55eb8f534bf0e4a94143168951b34 CA2830e684d243888e36c3fcce23f7c77e CA30bf9e04e15449ebeb209a63f4b5e8c8 CA69ec3f0d43ca56bf580cd04f36cdf5e4 CA4146dcbfb6ab4ab8e9b21c95dd317a7b CA246cf41c29692db180b8eb90170ff017 CA668fabfa53becbecc6dfd9bb7bd373e1 CAd614eed8f14ca1ca039f5af4b2cae0cd CA1a55ff4c93137ae59e19b335ce0e8ff9

**A conversation, no tool ever ran (81) — the sweep's population:**
CA306dc1e4a8424eba62a3e9538b9745c9 CA65c5c28202336fc970298e1d218a5067 CA1fbbd67b4afc1ea4a45fc98182b4f47a CAfe8aec6b0788a1eb364afaf95ec5a8ba CA7b6be27114a2de31c746d500744de01a CAf32abbcccaabb804be8733b558808041 CA4dc162f95498141051851005c3aeeff5 CA077ef021a7ab3eda290348844a03c99e CAe49768f7e5c3775cf57dd441a570df15 CAad445d3e82653bcaf6edd9f1f6186e18 CA68e2642c5085dd38da5213033388f775 CA9c958ec129287217e3123a5b6b67aef6 CAb59b037f56475ff27e98b9be962df1a3 CAace5a4abd62c842a1dbc1705fc612ea6 CA51c2c303b7e990eb63945f0e08f54175 CA3ae604127b4a25cba1f8508c00359ec8 CAba956349ddfb4ed2ccc05d18236607ec CA2b013176ce67955e8006dd1ae6f1f72c CA4772d42487c7639ef128eff2a49af9cd CAf391534083c0eb6ef810b0654781c32e CAef813f3b76320f6a6311f70ba37612f3 CA60c45e50316bc089e272aa299adff719 CA2e64934b789db58c65e70541949b3d4a CA7651348a3538ff1a647f074ca7c09687 CAc24269ff9c853ac6d91638e79a3e2db5 CA486292d5b5beabf54a7d63f06d1b7513 CA0145f1eaf11bb86e36ab5743543b4e67 CA5c5687087568c7be1f85b9bff47525ac CA159b120a66d2b2843fd7586e2c4bed0d CA796aea19cc808b09d1cad2866212a33a CA13be98d136158930c006a6a10acba63f CA62ab55553cc652fd234895d2372286e1 CAd4b65a1f713f1faed456f6c64d978bea CA6ddaa7d7ade2564625cbda2083fb4207 CA7f92eef24d6d3cc94553ce143da0142d CA2472d4118afacbd4d5b3036119c0c941 CA4449159ac3fb40424a861f930c871fa2 CAc2497adddbb7eb9efd03fa90d16b5e82 CA7e4bd9d51b312d815c9568bccf88be52 CA196f96cc9f04622b1e3292c3c321bef3 CA999109b5cffe7451f528783018e3bbb2 CA1e8262437455a19d1b1810f64c766d33 CA865e0f2e8ed1af2e25992a3d78132d5e CAe976f4002a6d840feab347ecd3f163bd CAec540386bf413d60dc84c3f494a2752a CA38f9e8d184d7507cb4c541de6cbc0429 CAc4328362c58c9c4db482e03a24cfa5cc CA72b0d88cad04a022f48cb90cd78f64d4 CA643d5f5044f5d018482cf340071b6683 CA09ce15c4888614e4f0f822584a4a69d4 CA3545dd9f2237cf40930bc8481394e82c CAeb84d1e166e2776d37eb8afd4360105b CA160e05ea22a18189dd010c0fab1397e9 CA07ff00d5e261de2de0b5278807ace6bb CA3fff05f8d54b1a2797662a81303e2e0d CA3d417ea22f9f3c2b9ddaac1034717bca CA0e958b0944c999eaec8789b18e669b27 CAe876bbbf1f89a600c76145fced95e34d CAca47709e24e31336c1b8c117b475b37f CA2e52d32670acf3f0ddcaa6bbc0baef25 CAf3c6bb0a900c517b5ffffcad7af762ae CAadc83d28eb18a151f0a017f9435c2c7c CAbf0dc5ebf1521d2b4aa4f8f222446399 CAeb7143b84ec5639e6b28b7df3ec45f65 CA4a604115f209414198c965842d9bfa6d CAe0a03a36410834ce1bace67980f67906 CA6a7b15b7e05c41f4a54c633717cb9680 CAcfde9393a117bb2901442d5c33e0f512 CA956c16e9a5742440dfc0b7241741c89c CAa1b127d5b725329f1b815875ba654f55 CAf52ad6eb9ad1e9c630a91d993f3bb83b CA0c214d5dc7c911c036a53ebd1a29ce7c CAf752eb1353fdd943ba3ba8f196b45622 CAe38980883913ac1d096625bb4e34f7f2 CA63f31b6883155aa2b273c53a9f83bcf6 CAd55b24ab073bf1b35e0b019864adc54e CA335af837b197edce698279dbdb8922e3 CA9f712523214a76be161d4a154a36a4ea CA7006a4b53b0ff79dd63ae79a0b18919f CAd2b3e9d0a216d3cb0aa101ede11b852f CA9276248be0e52e356dddf1c689aa3ec0

**A conversation, tools ran, nothing filed (60; two of these DID file in the Support Center):**
CAf075812601e0bf65857d35c0d8c466d5 CAb8f03819e3ea8898e90c953196eae243 CA6bbd5f0b03cfa06a73d618bf5d94eeca CAe1a1530f55ed5815294aadea76f9f56a CA5eea5ceb0055b10e30f35f2d7010b956 CA33471326e47fe8bb306b93659bb57f5d CA160a2d880cc927d470d7a20d9e1cb30c CAb58425b6b7eea8f1dfd8823bb8ca4cc6 CA9820cf5380b4b290be6d737118f208fa CA44e458f7ee92cd7f0b4c982164bed991 CA6b4bdb2d2cff91a8d7257ef05b83c480 CA656a9f3fc078ecfa3eae9cd40a877dfb CAa20fd9e90ea2ea441e36caf40864d0c8 CAc7d9b1aae58742d9abf7818068cc815e CAec9fb12849a14ecd0d5c54f9048fefde CA1d23e963737c0f124274a0ff36321e75 CAb0addcfaa301fa8b81ba9e9d73e9aec7 CA13d552e3db6ade35ed3e57037c270a76 CA48e366c17eb7028fd4d9c1cd02ce174d CAe70f7426c568ed675bec34fd098b2431 CA1ba3f240da99148c4e43ebbc34dc392d CAcce50ac5b7a22e5e5325794484892fb0 CA6021139fcc51a7d707c93c2515d07742 CA96afee360c3ff9ccb34c58fb807089a3 CA8e16052559f2e1f27c5c748493ce7315 CA199e33a6fe0a9cc662156ebcf60deff6 CA94252eecdf4ad31cef663cfbafcb22d3 CA4adf6a1a3b45a076b20f750250c5de3c CA7f9a34ffe5756d9d40960ebae292d7a7 CA3f487d50f195fe407ce7b35f31eb397f CA7b5e31a94b5e6cb310cd5391222ab0ec CA96ca56695d70e073f7fbfff1157cbcee CAebc2886f550e7ed8753bb5e07a57a56e CA5a7140580e70eb702bdf553148715163 CAe95ab18ec6dbb808046aa022b99501fc CA8169019b3735201e8416297db355f32b CA4e4d2dde45d603c9680a74dfa3fcb1f2 CAa70c4df35cc4f8dc47f7b0ed7bdc474f CAe4c5737c6b38b6bd9a30a293f33f85cc CA2b100a47687d2eb190d9f1617df6c262 CA5c5eace53a3d9fe9b4a7f57505953f2c CA87d3f4e67da1d0fa074a3e2c22ed3701 CAa24c6b455ef8a87020eefff0e13f4b07 CA180029ac6f4697c4bac2e86b8c5883c6 CAcdd5a4da9f124b0e590006924e2cf504 CA07fb95c8686336c9e5b13b1729cb82b7 CA8928a3acd6b6ba06d59fc314a75cd46f CAb41738bc5d821c5df20ec8bbd06777c4 CAa7abd16df160e96801e5ebaec0be758c CA8b9a374d81810f650871abe9ba608930 CA9e7e6871d6f7ff169f3878f467884bf9 CA1ca8d36387b9d02d1168d5c099f9b8f1 CA0b8a1e6c81e5ebdcd87536bf92842399 CA66a42369e2241a89046e7f86e10a75f5 CA52ef36b5db8698a6d7787e21b5e5f8d4 CA3b453eb73c39eb36334d51e97991c734 CA73a0ff726d66ffd09b73c47074e29c0c CAca0e2dc470cfd51aa052a552f0b26f7b CA1bb480173f8cb66e49c3363fcb080e2c CAd2482bb3bf87c448ab4f3e0989a2c719

**Transferred to a human, no ticket (4):**
CA468e64563e7e8d39af28db2f9c3caa31 CA61df1c53330bc9d70a80b1319c5d269b CAf875df1ee19caf8bce9effd52150678b CA0afa4eae6b434d90f9d1068af68ea723
