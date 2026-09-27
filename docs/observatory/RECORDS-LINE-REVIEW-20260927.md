# The records line, end to end — the review that comes before anything is built on it

> **Measured 2026-09-27.** Window: records-lane calls 2026-09-08 → 2026-09-25,
> fourteen business days, `duration >= 30`. Every stage below is **the same
> population, joined by call SID** across the Operations Hub (`call_logs`) and
> the Support Center (`tickets`, `mr_cases`, `mr_case_transitions`,
> `mr_audit_events`). No patient name, date of birth or phone number appears
> here; calls are named by SID. Cue-based counts say so and are lower bounds.

## 0. The operator's statement, and the verdict

> *"…the tickets from the old core records line don't even make it into medical
> records — it isn't even logged there, right now, lost in limbo. We need a
> complete review of this process before we build on top of it. There's a CAP
> on these records."* — 2026-09-27

**Two things are true at once, and the second is the one that matters.**

1. **What reaches a ticket does reach Medical Records.** Every dept-16 ticket
   the records line filed in the window has an `mr_case` — 196 of 196 — and so
   does every one since the CAP effective date, 232 of 232. The case is created
   inline by `create-ticket` the instant the ticket is (median 0.0 minutes).
   The compliance record is not being dropped between the ticket and the
   module.
2. **43% of the line's substantive calls never produce a ticket anywhere.**
   178 of 417. Cross-checked by SID against the Support Center: **0** of the
   178 have a ticket under any department, any agent, any status. Of them,
   **66 are complete conversations where the agent ran tools and then filed
   nothing**, 36 more are conversations where it ran no tool at all, and 76
   are callers we barely heard. On the old core **nothing catches any of
   them** — no teardown sweep, no ceiling, none of the machinery the four
   runtime lanes have had since 09-03.

So "lost in limbo" is right, and it is upstream of where I first looked: the
requests are lost *before* they become tickets. And the second-largest leak is
downstream of the ticket: **31 of the line's 196 cases have never been opened
by anyone**, the oldest for twelve days, on a fifteen-day clock.

**The plan in `ticketing-app/medical-records/discovery/17-the-agent-sends-the-form.md`
is paused until this is acted on**, and its corpus numbers are corrected in § 7.

---

## 1. The funnel — one population, stage by stage

| stage | count | share of substantive |
|---|---|---|
| records-lane calls, `duration >= 30` | **417** | 100% |
| … the agent FILED (ticket number written on the call row) | **239** | 57% |
| … distinct tickets those 239 calls produced | 212 | 27 callbacks were consolidated onto an existing ticket — the app's designed behaviour, ruled on 2026-09-03 |
| … of the 212, landed in **Medical Records (dept 16)** | **196** | |
| … redirected to another department by `detectCrossQueue` (HVA 5 · Optical 5 · Tech 3 · Surgery 2) | 16 | correct if the request really was theirs; not checked here |
| … dept-16 tickets with an `mr_case` | **196 of 196** | |
| … cases on the statutory clock (patient / representative) | 65 | 33% of the line's cases |
| … case **completed** | 90 | |
| … case **closed without fulfilling** (misrouted, unreachable, duplicate, no records) | 52 | |
| … case still **`received` — never opened** | **31** | |
| … case in `awaiting_authorization` | 18 | the step doc 17 is about |
| … other working states | 5 | |
| **… produced NO ticket anywhere** | **178** | **43%** |

### The 178, by what the call's own tool timeline says

| shape | calls | ≥ 90 s | what is known (aggregate) |
|---|---|---|---|
| **A. tools ran, filing never called** | **45** | 27 | `lookup_patient` ran on all; `classify_records_request` on 2; `check_open_tickets` on 7. Caller asked for a person on 10. Avg 109 s. |
| **B. filing refused, never succeeded** | **21** | 20 | refused for **name** on 11 (`first_name`+`last_name` 9, `first_name` 2), for **`date_range` / `deliver_to`** on 5, for `date_of_birth` on 1. Caller asked for a person on 13. Avg 159 s. |
| **C. a conversation, no tool ever ran** | **36** | — | 3+ caller lines; the agent asked for a name or date of birth on 22; **17 asked for a person; 15 said records/chart/notes/results**. Avg 89 s. |
| **D. barely heard, no tool** | **76** | — | ≤ 2 caller lines; even so 15 asked for a person and 11 mentioned records. Avg 59 s. The W3 population. |

**A + B are 66 requests the agent had in its hands and dropped — 16% of the
line.** C is another 36 it never picked up. D is the barely-heard rate this
file already documents for the queue lanes, now measured on records: 18%.

### It is not a bad fortnight

| day | substantive | filed | tools ran, no ticket | conversation, no tools | barely heard |
|---|---|---|---|---|---|
| 09-21 | 25 | 16 | 4 | 1 | 4 |
| 09-22 | 23 | 15 | 3 | 2 | 3 |
| 09-23 | 38 | 19 | 9 | 3 | 7 |
| 09-24 | 20 | 12 | 5 | 1 | 2 |
| **09-25** | **43** | **16** | **9** | **6** | **12** |

Thursday 09-25: forty-three people rang the records line and stayed on for
half a minute or more; sixteen left a ticket.

### Controls, so the shapes are trusted

- **The timeline records tools when they run.** All 239 filed calls carry tool
  events; 0 filed calls have an empty timeline. So "no tool events" on A–D is
  not the instrument dropping writes — a lost-write residue on the old core
  cannot be excluded, but nothing points at it.
- **"Never filed" means never filed.** The 178 SIDs were looked up in
  `tickets` directly: 0 rows, so this is not the write-back gap (`call_logs.
  ticket_number` NULL while a ticket exists) that CLAUDE.md warns about.
- **Filing is not failing at the app.** 416 `create-ticket` POSTs from the
  line in the window, 13 refused with HTTP 400 — all 13 are `office` /
  `surgeon` gates on tickets `detectCrossQueue` redirected to Optical or
  Surgery. None is a records ticket.

---

## 2. Why the OLD CORE loses them, mechanism by mechanism

Records is the one queue lane still on the OpenAI SIP core (CLAUDE.md line
status). Every mechanism below exists on the runtime and not there.

| leak | what would catch it on the runtime | on the old core |
|---|---|---|
| **A** — the model identifies the patient and never files | the teardown **request sweep** (`src/runtime/requestSweep.ts` → `sweepRunner.ts`), wired in `voiceRuntime.ts` — files from the transcript when a request was made and no filing tool succeeded. It recovers only 6 of 53 there (the "no name, no ticket" rule), but it is a floor | **nothing.** `voiceAgentRoutes.ts` has two sweeps, azul's and PCP's, both gated to their own lanes for the 2026-07-30 reason. No fleet sweep, by design |
| **B** — refused for a **name** | none anywhere — `first_name`/`last_name` are `required` and have no escape; this is the open "no name, no ticket" question (CLAUDE.md, 47 of 53) | same |
| **B** — refused for **`deliver_to` / `date_range`** | the on-clock exit `on_clock_ask_exhausted` exists in the tool but is **opt-in and PCP-only by design** (operator, 2026-09-13); the records lane's gate refuses | same — and this is the 2026-08-13 *"hard gate the records to require the appropriate fields"* ruling, applied to a PATIENT's own request, ending with no request logged at all |
| **B** — refused for date of birth | `decideDobEscape`: ask once, then file with UNAVAILABLE | same (shared tool) — and only 1 of 21, so it is working |
| **C** — a conversation with no tool at all | the **lookup-miss bound** (v50), the **unvoiced-answer hangup hold** (v56), the **silence ladder** (v68/v72), the follow-up gate (v55) — all shaping the model back onto the tools | none. And the recognised-caller pre-context reached the greeting on 0 of these |
| **D** — barely heard | `RUNTIME_VAD_THRESHOLD`, the caller-audio meter (v64) that says whether frames arrived | neither applies to this pipeline |
| a loop | the tool ceiling (v46) | none |

**Moving the lane to the runtime is not a nice-to-have on this evidence; it is
the single largest lever on the line.** It is also the decision already open
(the "no-ivr and records to the new core" question). The before-arm is this
document.

---

## 3. Downstream — what happens to the 196 that arrive

| | |
|---|---|
| ticket → case | inline, 196 of 196, median 0.0 min |
| case → first opened (`received → intake_review`) | **median 29.1 hours**, fleet-wide over the window |
| the line's cases still in `received` today | **31** — median 3.6 days sitting, oldest **12 days** |
| voice cases in `received`, all lanes | 55, of which **22 are on the statutory clock**; earliest due **2026-10-05** |
| cases that reached `awaiting_authorization` and left it | median **5.3 days** in that state; 18 of 47 left by cancellation |
| on-clock cases completed late / open past due | **0 / 0** — the clock is being met by closing, not by fulfilling (52 of 196 closed unfulfilled) |

**Nothing assigns or announces a new voice case.** Every case lands with
`assigned_team = records_retrieval`, `state = received`, and waits for a person
to open it. One screen does show it and one does not, and the first draft of
this paragraph had them the wrong way round: **`/medical-records/today`, the
six-lane worklist (`MrWorklistClient`), puts a `received` case under "New —
needs triage"**; **the landing page at `/medical-records`, the command board
(`MrCommandClient`), does not** — its three owner-approved lanes are *decide*
(unconfirmed classification), *field* (a fulfilled case short a CAP value) and
*ready*, pinned by `command-parity.test.ts`, and a fresh voice case whose
review status is `not_required` is in none of them. It is counted in the
"elsewhere" line under the board, not shown as a card. If the landing page is
the screen the operator looked at, a new voice request is literally not there.

**Measured 2026-09-27 in the Support Center, the three switches that would make
a case somebody's the moment it lands are all off for department 16:**
`departments.notifications_enabled = false`, **0** rows in
`department_notification_recipients`, and **0** active `auto_assignment_rules`.
Every other configuration a new case could trigger is downstream of those.

**Ticket-side lane attribution is broken and it bit this review.** Of the 307
agent-filed dept-16 tickets in the window, **126 carry an `agents`-table UUID in
`agent_used`** instead of a lane slug — pcp 99, records 10, tech 10, surgery 6,
optical 1. **CORRECTED LATER THE SAME DAY:** the first draft blamed the PCP
lane's medical-records route (v15/v16). The route was innocent — every filing
tool CREATES the ticket with the slug. The writer is the voice repo's post-call
sync, `server/services/ticketingSyncService.ts`, which posted
`agentUsed: call.agentId || "unknown"` to `update-call-data`, and that route
writes whatever arrives onto `tickets.agent_used`. Same line, two branches:
the uuid where the row had an `agent_id`, the literal `unknown` where it did
not (the 91 rows CLAUDE.md records on 2026-09-03). Fixed on #333 (v73): the
sync sends `call.agentUsed`, the lane slug, and omits the field when the row
has none. CLAUDE.md already says never to attribute by that column; § 7
records how I did anyway.

---

## 4. The CAP reading

The records module's own SOP note (`records-signal.ts`): *"SOP §4.2 requires
EVERY access request to be logged with a due date on day one — an unlogged
request is exactly the failure the CAP exists to prevent."*

- **A + B + C = 102 conversations in fourteen business days that were never
  logged**, so no clock ever started on them and no report will ever count
  them. Among the line's cases that WERE logged, 33% are on the clock; applied
  to the 102 that is **roughly 34 patient access requests — about 2.4 per
  business day — with no case, no due date, and no trace outside a call
  transcript.** An estimate, and the only kind available: an unlogged request
  has no requester type.
- **22 on-clock voice cases are logged and unopened**, with the earliest due
  in eight days. Not a breach today; a breach the current pace produces.

---

## 5. What to do, in order — recommendation

**APPROVED IN FULL BY THE OPERATOR, 2026-09-27:** *"go ahead and flip records
to the runtime and the other 5 points you made."* Status of each point is
recorded beneath it.

1. **Move the records lane to the runtime.** A Twilio webhook repoint (standing
   instruction 11), the operator's to make. It brings the sweep, the ceiling,
   the lookup bound, the hangup hold and the silence ladder to the lane that
   loses 43% of its calls. Before-arm: § 1. Guard: filing rate must rise, not
   fall; barely-heard must not rise.

   **HOW TO FLIP IT — the operator performs this; nothing in either repo can.**
   In the Twilio console, Phone Numbers → the records line's number (the one
   whose Voice Configuration URL currently ends in `/api/voice/incoming-call`,
   the OLD CORE's webhook). Change *A call comes in* to:

   ```
   https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app/voice/records
   ```

   method **HTTP POST**. Nothing else on the number changes. `records` is
   already registered in `src/runtime/laneRegistry.ts`, and `/voice/health` on
   that host lists it among the lanes. **Deploy v73 first** (this is the build
   with the name exit, § 5.2), then flip. **Verification is one call:** the
   first records call after the flip writes a `call_logs` row with
   `voice_provider = 'grok'`; before it, every records row has NULL there.
   **Revert is the same field set back** to the old URL. The ticketing app's
   #320 must be live before v73 takes a call (§ 5.2).

2. **Give the name refusal an exit** — file with `NOT CAPTURED` the way the
   date of birth already does. **Policy:** the "no name, no ticket" question has
   been open since 2026-09-03 and this line is the clearest cost of it (11 of
   21 refusals, every one a real conversation).

   **SHIPPED on #333 (v73) and #320.** The tool takes the name from the CERTAIN
   identity `lookup_patient` established on the call, otherwise asks ONCE, one
   field at a time, and the next invocation files without a name and with a
   staff note (`callData.transcript`, never the description). The teardown
   sweep does the same on this lane only. **Ship order: #320 (the app) first** —
   its create-ticket schema had `min(1)` on both names, so a nameless payload
   against the deployed app is HTTP 400. Twelve mutations, twelve caught; the
   CLAUDE.md v72 row has the list.

3. **Stop the on-clock gate ending a patient's request with nothing.** Either
   allow the `on_clock_ask_exhausted` exit on the records lane after one ask,
   or move destination and dates onto the form (doc 17, decision 2). **Policy:**
   it is the operator's 2026-08-13 gate.

   **SHIPPED on #333 (v73), the first way:** the gate still asks once; the next
   invocation on the same call files with `Send to: NOT CAPTURED` / `Dates
   needed: NOT CAPTURED` in the PCP exit's words. The PCP flag is untouched.

4. **Make a new voice case somebody's, the moment it lands** — an owner or a
   notification, and a card on the landing board. Which person or rota is the
   department's call; that nothing happens for 29 hours is the finding.

   **CONFIGURATION, NOT CODE — for the operator, in the ticketing app's admin
   UI** (§ 3 has the measurement): (a) turn ON `notifications_enabled` for
   Medical Records (department 16); (b) add at least one row to
   `department_notification_recipients` for it — WHO is his call; (c)
   optionally one active `auto_assignment_rules` row for department 16 so a
   new case has an owner and not just a team. **ONE DESIGN QUESTION, his:**
   whether the landing command board (`/medical-records`) gains a fourth lane
   for `received` voice cases. Its three lanes are owner-approved and pinned by
   `command-parity.test.ts`, so that is a design change and not a bug fix; the
   `/today` worklist already shows them. Recommendation: do (a) and (b) today,
   and decide the lane once the flipped lane has a week of cases.

5. **Fix the UUID stamping.** **SHIPPED on #333 (v73)** — and it was in the
   voice repo's post-call sync, not the PCP route (§ 3, corrected). The 126
   existing rows are NOT rewritten by this; a snapshot-backed backfill from
   `call_logs.agent_used` by call SID is one statement and is offered, not run.

6. **Then** the form-at-call-time plan (doc 17), on a lane that files.
   **Not started as of v73** — doc 17 in the ticketing app carries the plan
   with a PAUSED preface until points 1–3 are live and measured.

---

## 6. The corpus — SIDs by shape (RULE THREE)

The words live in `call_logs` and on disk; only the SIDs and the shape live
here. The acceptance test for whatever ships is: A must file, B must file, C
must produce a tool call and a filing, D is the barely-heard measurement.

**A. tools ran, filing never called (45):**
CA03aa564cba1544099d329ac4decac7ff CA096c79a7f45fa5e14732043c0f298ded
CA0daeb67c1960212b1ce6b5b451162fe8 CA1640afd4ed13ed1e2b001ae7cd5250a1
CA1d8ef2c25817f875c1c61e56984f1dfb CA1db8498a2ca33b47d33466fbfa90eb9b
CA29fd47ca0294100d43c2563fc3afb8b7 CA2ba738869c1d7b029331bfdbdc9012d8
CA2f5ca3ba936458ad045baa2586faf190 CA36de31947e933871c1bfa0e8fde4409d
CA373c6d427c117a64b74ddbd2ed968d70 CA3ba50e9879828d866b0c5401b7965481
CA4503eedfd4e82e759901314b4230597c CA46620dc4a919127e8722aab76d2dd187
CA4a326ca076110145ae594a9df3b3e346 CA4c95b8a88196855ef6cb7162daf86e92
CA4ee194938e20718ff834ad2ba0be3b6a CA529d129d92d57f3f0add902741b2514c
CA599c1411890ba7993ed02c58c47c895f CA5c5cd9ced0c5b99328eb7580ae61afe0
CA6697d82e0608a98d2f80c7c99d6d124d CA68899705a43ed3b399be767851a56b4c
CA76543abc1e973abe590f9d99d4361dd6 CA875ba6c0606668a8cc5732f02482449a
CA8fa94821e0456d9d097410b8241a3ec6 CA92f1c4a59411b6cea0162e02fa561309
CA98285c0131cb983d7cd6bca07ca493f7 CA9ae0345ed0eb773a6e88b0bf497da908
CA9c4518def8707c600f5d7749124b42e9 CA9dd604548e6044f99f4e879a61adf4f8
CAb182becfe95dc4d0f3364d19b668ade8 CAb3851e08738050e7f873e2fa87ff07d7
CAb8829cf876ac4d85803057d5dd93ac5a CAba0e831a2db2b161e599e05a34a230d0
CAbaf7be14b3746ed835bac083a232be82 CAbc3efac1507778a79082cf1edf380b1a
CAc0457220e21fa611e3e61705aeee5afd CAcf7c993e76814eaf01d3592e44975c02
CAd4c1033e810d14a31875a325e6f4eda4 CAde9ce80c6db83aceefcf308863530625
CAee4495ce7bff5a9b789065238bc8dbee CAf1eb45c4b283288dc61b9a400676d841
CAf3b66a91d53fb31a1b6df26442f6dee1 CAf4bb2bc178012b2a3f40343091370ba4
CAf553d43c7901930e05bc2275c593bd0e

**B. filing refused, never succeeded (21)** — `[fields refused]`:
CA0c7222fa881270f3dbaa1a487c8ccf79 [name] CA0e222c321a303dcead697a63a3eb2a18 [name]
CA192e28a616d249d1c799576353159ae9 [name] CA25ea980b34debe9691b869e54116d3a0 [date_range+deliver_to]
CA3082f9a62b8f43368c1e2ea964e4081f [name] CA352906e63c3b8c1f6406aa6b954642a8 [name]
CA4ce319e0ab7ac2e67bcd4469db26db4c [name] CA4f1434e70dd2e84c05d4ce894c401d16 [name]
CA696c9d9fbca7e902013c917f592dc67d [date_of_birth] CA70d99eb21f43865a447546abbada4532 [name]
CA824a338969c2fce8667b00cf71f556a1 [date_range+deliver_to+first_name] CA8ab393cd721ca8c45ce4b0bb96af15da [date_range]
CA94966cb98772ab4a9431b4da68a3b1cd [date_range+deliver_to] CAa888f8fd0c54416f6df057bd6da9b31a [name]
CAaf0a6f09d509785b78201030d8e465ed [date_range+deliver_to] CAbdd345eddb63fbeb38ab03d7e204604f [name+request_description]
CAcba573e898d1cd2d9ed56aa6817026f3 [first_name] CAebf678af01ffc78fcff94275c3757057 [name]
CAf53c0ba08888a1d8ed40f02bf77e5347 [name] CAf93934cbf9d832a336e31aff3da6e1cf [name]
CAfbfe139f6431389daaa20384353db301 [name]

**C. a conversation, no tool ever ran (36):**
CA008cf731dce5a259a6c540055c429373 CA0224cc7f63343396b1d514f62cccd022
CA047cf0d91f0b492217b267ee9606d5b6 CA0cc5a07c9508d6075007e4334f8226b7
CA0fc945e9ea71b54147e9b6f90121e2ce CA23b1ff6c17fe737ecf50cfb61ecf5340
CA27f975b7c6f397f7b26cf08144d38bb6 CA2dec9668095ab95913b93a68fe3de1cf
CA2ed098d67f632759d565aeec5df780a4 CA3f7b80ff8a50da3652e54af3e348f870
CA48ad1cb82ea787972efddc077b744413 CA48da3c9deeaa47b594eb4fdb8ff322bc
CA4ae89e393ba74fc19e6a1728495af55c CA4d0f94032e552063a9a8fd0a033290b0
CA604878e62f3871fd06beb56ba23c4f62 CA699859627b2b76c885454b3bf319d307
CA8115929a1ff89bc6167f0b27ff21f811 CA842875468fd338be9eab8d75d06c298b
CA911e1743860ef0e678031977d467805d CA97f05eb8a99ceb7d7ff9bd923b50049f
CA9a300f51bba9a2fb5662738d0543c884 CA9fdaf1ff46810c571c49c169e912fc42
CAa300ecafd1c24de2fe75435883edd186 CAaeff4e1b31f52e03ab1d73290251e8a6
CAb25ed1bff68555972a2c91965d888e82 CAb4205f7150d775c09656bc737c31b079
CAba41cdf4e45670fd453678a235531238 CAc22b0e0b6ae6f8a9571578208e05650d
CAc3be135b85b6ba915d6d67817c93157d CAcf5bda9b4248bfc9113874c7c901379b
CAd6e016a0a028617110fc33c158d598f4 CAdf411cc46fc4f6704343c7d6efd59850
CAe3e690a1f9aadc9d6d67e4e279d1a3cb CAf6e57876d61edd1cd0e49e22418e2b8f
CAfc78b084e656b7ea997193fdd29d67fe CAfea4d104225b4452b1f573db54ece9ce

**D. barely heard, no tool (76):**
CA03344705859ca433a1295c688261f5e9 CA0609524c3471b95eb1938bff74875ee3
CA09d18cae00e007fb62f4d63b7726655b CA0ae742162660d9103e589a9399786e3a
CA0d09b6ca8e8343ccd8f3052bbe43d4ca CA0d97eb1a49583f42c107d540f402f109
CA111d0cb5addf8777a9413e4fdd968e8e CA11b40eeb53f640c7acfd5645efbaaeb1
CA13a25cad40200c9c9feb17cbc2a264fa CA1458d265ca33b3e74ceb05c738ef7358
CA1b2117515d9c2f0394155e00fac6ffd2 CA1b9b046239540255cb6cb7ad941fa4ef
CA1c3210abae60e423c63a70f7116da117 CA205858717764f56b499d24de87b0fef1
CA27ceff603234f0ee3417bca11fc2c972 CA288d3d0fda1cba1430ff86a42779b99d
CA3093ab703514cbac2503a15374641d98 CA3135005251ca261af14505dd6c77b0cf
CA3431c418cffcae2c2a0282731204bfbc CA346f0d5f9d91e3e584d63bd62e4fb6bf
CA38c53086d78eb30c43086086e9e84bde CA3de809ffb7039aabfece95f15bf9031a
CA44a21e46a4e67d435b98eee01e276f23 CA470fe66ae74691522d5c6c4e745a91ac
CA48f3b9af20db04f369687cc07f819b93 CA4baec6409c28bf51a59efa742ccb91b2
CA60f335122cb7eb60f0299485a46d470f CA61dfcd59fc9a569815711dd1c27a0552
CA6207f5ff3acff0e83a7c523d8321b9e2 CA68303614dea809e8d22677e6ad437dc6
CA71d2faa1d914f8be92c4b6353db2db39 CA75e7ffdeeca4abcdbfd99b7338465639
CA78480f4cba1e92ccce285e10e8e6c178 CA78c485d2ce5f4eeb17a9d3502fa9303c
CA7a7f8591015a2317117203abd9b63b63 CA7d3a2200a8363254b484d9242e10dfed
CA7fac2ba34115dfb254886fbf7fcc5caf CA865a5f2e094af1ce981e66a8909294b4
CA87e8147922d1c2e15156530a42964c7e CA884ddee4ef6ec759ec53a2a9c5517d06
CA89b64cfd1754ea5038136439d2a1beb3 CA90b1552008ed228bfe80219d58bffe53
CA9177e85ee3cf8f44d036bf010b2128f9 CA928bd3fabd99e0b1e3ae3a739155bd03
CA945cb10d03e9d7afac29613b5f05a2be CA95d66f8a45156fc0c58534259baa6da8
CA960771fd83a51061a7bc5a666b543606 CA9d6fa645c04d2d9c8f49e8b9261e8229
CA9de1d3ee56ed5e0c6a7521adad49d08d CA9e1f15690ec0993cc9911ca1c21a0990
CA9e7748c35030e70cb44bd2db6e3ae01a CAa636a9b572166bc0e34239108dc7de5d
CAac395aeed8607040569bb99b0610a7ff CAae8892aea8fc051c0dae4a8c3226ea94
CAb47e7d0db928f3137d62c23facda400d CAb783ce3748299b798f1f082aca6c5a42
CAbd2701d11604f95a862783a990696ade CAc1c87884102a007384859f7346eef1a8
CAc8134c98fdf6a230888c64176b034f0f CAcc40af6766398401b7169a4034345149
CAcfad2e58947743a2a32e4fcddd869eeb CAdac4d711df9e420e2b965b6471bd17f4
CAdc5145dbcb06c9cdf12112e0dbc3ef4e CAdc5ba1eddfc072f8a701cb1c11d4210d
CAe07827e7def32015f6802a2d116d6f7a CAe8377331efcc016d7291aad50de4e7d8
CAe8fc4a1640c6079fbc7dccf0d83cbd3a CAea3583c6da4bc911a29cfe97f4728704
CAeb5b95999c2e85c7a9462dceeeb24389 CAefcca8b126609d9f011c2e0c414ec970
CAf1de26fd68af01c07a38a11e6c26ad69 CAf3263163315c1863cdfa2d0d412cb6e7
CAf3efeac2ac40e1483e40d8e46e243fba CAf7284bcdfbf507f9475129a274cf897e
CAf8f31be3a72b04e9bf36730286a9d534 CAfdf5198aa36ee9bc7f544cdd095f411e

---

## 7. Four measurement traps this review walked into, recorded because they recur

1. **"The records agent filed 307 tickets."** It filed 195. The 307 is every
   agent filing into department 16 — the records line, the PCP lane's records
   route (99, stamped with PCP's agents-table UUID), and cross-queue redirects.
   Doc 17's corpus (§ 2a, "98 form-eligible") was built on the 307 and is
   corrected there. **Attribute a call to a lane from `call_logs`, join to
   tickets by SID; never by the ticket's `agent_used`** — CLAUDE.md said so and
   I used it anyway.
2. **`regexp_split_to_array(transcript, '\bCALLER:')` returned 0 caller lines
   on every call**, including 239 that read a ticket number aloud. The
   transcripts are `CALLER:`/`AGENT:` but the pattern was case-sensitive in a
   query beside case-insensitive ones. A rate of 100% "never heard" is the
   instrument, not the fleet — check the impossible number before the
   plausible ones.
3. **`tool_timeline::text LIKE '%file_records_ticket%'`** matched the
   registered-tool list, not the events, and classified 133 calls as "filing
   refused" that had never filed. Shapes A–D read the `events` array.
4. **`agent:… follow up with you`** matched the greeting on 74 of 76 calls. A
   regex that fires on the greeting measures the greeting.

### Reproducing § 1

```sql
-- Hub: the funnel's first two stages and the four shapes
WITH c AS (
  SELECT call_sid, duration, ticket_number, coalesce(tool_timeline->'events','[]'::jsonb) AS ev,
         (SELECT count(*) FROM regexp_matches(coalesce(transcript,''), '(?im)^\s*caller:', 'g')) AS caller_lines
  FROM call_logs WHERE agent_used='records' AND created_at >= '2026-09-08' AND created_at < '2026-09-26' AND duration >= 30
), s AS (
  SELECT *, (SELECT count(*) FROM jsonb_array_elements(ev) e) AS events,
            (SELECT count(*) FROM jsonb_array_elements(ev) e WHERE e->>'tool'='file_records_ticket') AS file_events
  FROM c)
SELECT CASE WHEN ticket_number IS NOT NULL THEN 'filed'
            WHEN events = 0 AND caller_lines >= 3 THEN 'C conversation, no tools'
            WHEN events = 0 THEN 'D barely heard'
            WHEN file_events = 0 THEN 'A tools ran, never filed'
            ELSE 'B filing refused' END AS shape, count(*)
FROM s GROUP BY 1 ORDER BY 1;

-- Support Center: the ticket numbers off those call rows, looked up here (paste the list)
SELECT t.department_id, count(*) AS tickets, count(m.id) AS cases,
       count(*) FILTER (WHERE m.state = 'received') AS never_opened
FROM tickets t LEFT JOIN mr_cases m ON m.ticket_id = t.id
WHERE t.ticket_number IN (/* the 212 */) GROUP BY 1;
```
