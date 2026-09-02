# 04 — Agent Inventory

**One page: what every agent is, which number reaches it, whether it is live, and what it can and cannot do.**

Survey date **2026-09-01**. Traffic window **2026-08-18 → 2026-09-01** (14 days), Operations Hub
`pslzngjciiifowemrzza`, table `call_logs`. "Yesterday" = **2026-08-31**. All clock times converted to
America/Los_Angeles; `call_logs.start_time` is stored UTC.

> **Superseded in part, 2026-09-01 (later the same day).** `src/core/` and
> `src/standalone/` were deleted — the two unreachable voice pipelines this
> survey identified. Two live paths remain: the OpenAI SIP path
> (`src/voiceAgentRoutes.ts`) and the Grok runtime (`src/runtime/`). Every
> `src/core/…` or `src/standalone/…` path and line number below is historical
> and no longer resolves.

Three things claim to know what is live, and they do not agree:

| Source | What it is |
|---|---|
| **CODE** | `src/config/agents.ts` — `AgentRegistry`, `enabled`, `twilioNumbers` |
| **DB** | Operations Hub `public.agents` — `status`, `twilio_phone_number`, `welcome_greeting` |
| **TRAFFIC** | `call_logs.agent_used` / `dialed_number` — what actually happened |

Where they disagree, the disagreement is recorded rather than resolved. §7 collects all of them.

---

## 1. Roster at a glance

Fifteen registry entries across fourteen agent files (`dev-no-ivr` and `no-ivr-v2` share one factory).

| # | slug | file | registered | agentType | config `twilioNumbers` | 14-day calls | verdict |
|---|---|---|---|---|---|---|---|
| 1 | `tech` | `src/agents/techAgent.ts` | yes | inbound | **`[]` (empty)** | **1,325** | LIVE |
| 2 | `surgery` | `src/agents/surgeryAgent.ts` | yes | inbound | **`[]` (empty)** | **943** | LIVE |
| 3 | `no-ivr` | `src/agents/noIvrAgent.ts` | yes | inbound | **`[]` (empty)** | **873** | LIVE |
| 4 | `optical` | `src/agents/opticalAgent.ts` | yes | inbound | **`[]` (empty)** | **637** | LIVE |
| 5 | `answering-service` | `src/agents/answeringServiceAgent.ts` | yes | inbound | `['+19094135645']` | **293** | LIVE |
| 6 | `pcp` | `src/agents/pcpAgent.ts` | yes | inbound | **`[]` (empty)** | **19** | LIVE (thin) |
| 7 | `records` | `src/agents/recordsAgent.ts` | yes | inbound | **`[]` (empty)** | **5** | LIVE (thin, no number of its own) |
| 8 | `azul-scheduling` | `src/agents/azulSchedulingAgent.ts` | yes | inbound | `[]` | **0** | DARK — last call 2026-08-17 |
| 9 | `after-hours` | `src/agents/afterHoursAgent.ts` | yes | inbound | `[]` | **0** | DARK — last call 2026-08-12 |
| 10 | `dev-no-ivr` | `src/agents/noIvrAgentV2.ts` | yes | inbound | `[]` | **0** | never took a call |
| 11 | `no-ivr-v2` | `src/agents/noIvrAgentV2.ts` | yes | inbound | `[]` | **0** | never took a call |
| 12 | `runtime-proof` | `src/agents/runtimeProofAgent.ts` | yes | inbound | `[]` | **0** | never took a call |
| 13 | `drs-scheduler` | `src/agents/drsSchedulerAgent.ts` | yes | **outbound** | — | **0** | never appears in `call_logs` |
| 14 | `appointment-confirmation` | `src/agents/appointmentConfirmationAgent.ts` | yes | **outbound** | — | **0** | last call 2026-05-05 |
| 15 | `fantasy-football` | `src/agents/fantasyFootballAgent.ts` | yes | **outbound** | — | **0** | never appears in `call_logs` |
| — | `databaseAgent` | `src/agents/databaseAgent.ts` | **no** | — | — | — | fallback builder, not a registry entry |
| — | `azulHandoffLadder` | `src/agents/azulHandoffLadder.ts` | **no** | — | — | — | helper module, not an agent |

**`src/config/agents.ts` declares exactly one phone number for the whole fleet** (line 93,
`answering-service`). Every other entry ships `twilioNumbers: []`. Six numbers took calls in the
last 14 days. Number → agent resolution therefore does **not** come from
`AgentRegistry.getAgentFactoryByNumber` (`src/config/agents.ts:259`) in production — it comes from
which **webhook path** the Twilio number is pointed at (§6).

---

## 2. Per-agent detail

Legend for tool provenance:
**[R]** = shared registry (`registerTool` in `src/tools/*`, resolved by
`realtimeToolsFor`, `src/tools/realtimeAdapter.ts`).
**[I]** = declared inline in the agent file with `tool()` / `recordedTool()`.

---

### 2.1 `tech` — Clinical Tech Support

| | |
|---|---|
| File / config | `src/agents/techAgent.ts:52` (`techAgentConfig`), factory `:255` |
| Registered | `src/config/agents.ts:140`, `enabled: true`, `inbound` |
| Config numbers | `[]` |
| **Production number** | **`+17604376683`** — 1 distinct number, 1,325 calls |
| Yesterday | **183 calls** — largest queue in the practice |
| Hours observed | 08:01–17:04 PT; 1,324 of 1,325 inside 08:00–16:59 PT |
| Version | config `1.0.0` = production `1.0.0` |
| **Department** | **3** (`TECH_DEPARTMENT_ID`, `src/tools/techTaxonomy.ts:63`) |
| Redirect targets | Optical 1, Surgery 2, HVA Hub 9 via `detectCrossQueue` (`src/tools/queueRouting.ts`) |
| Guardrails | none declared on the agent; session-level `medicalSafetyGuardrails` only |
| Pipelines | old core SIP **and** Grok runtime (uniform factory, not transfer-capable) |
| Tickets | 909 of 1,325 calls carried a ticket number; avg duration 152s |

**Tools (5)** — `techAgent.ts:72`:

| tool | source | file:line |
|---|---|---|
| `lookup_patient` | **[R]** | `src/tools/sharedPatientTools.ts:65` |
| `resolve_location` | **[R]** | `src/tools/sharedPatientTools.ts:212` |
| `check_open_tickets` | **[R]** | `src/tools/sharedPatientTools.ts:326` |
| `classify_tech_request` | **[R]** | `src/tools/techTools.ts:35` |
| `file_tech_ticket` | **[R]** | `src/tools/techTools.ts:85` |

**Transfer: NO — no transfer tool at all.** Standing instruction 9, deliberate. The factory's first
parameter is `_handoffToHuman: undefined` and is accepted-and-ignored (`techAgent.ts:255`); the SIP
transport passes no handoff on this branch. `AGENT_CAPABILITIES.tech` declares
`canTransfer: false, transferTool: null` (`src/config/agentCapabilities.ts:92`). Production: **0 of
1,325 calls transferred.**

**What the prompt promises the caller:**

> "I'm not able to transfer you, but I can take this down and have the clinical team call you back."
> — `techAgent.ts:182`

> "You do not tell anyone whether to take a medication, whether to stop one, how much to use, what
> to use instead, or what their symptoms mean." — `techAgent.ts:187`

> "If they are out of, or nearly out of, glaucoma medication, treat it as pressing… Take the request
> straight away and tell them you are marking it urgent." — `techAgent.ts:194`

> "The filing tool routes it to the right team and tells you which in `routed_to`. Use THAT name when
> you say what happens next, never one you guessed at." — `techAgent.ts:176`

**Prompt vs code:**

- `routed_to` is present **only when a cross-queue redirect fired** (`src/tools/techTools.ts:300`:
  `...(redirect ? { routed_to: … } : {})`). On the ordinary path the tool returns
  `` `Filed as ${ticketNumber}. Read the ticket number back to the caller.` `` and no team name. The
  prompt reads as though `routed_to` is always there.
- `lookup_patient` — the first tool this agent calls — resolves through
  `scheduleLookupService` (`src/tools/sharedPatientTools.ts:113`), i.e. the Operations Hub
  appointment book, **not** `patients_master`. Standing instruction 14 is not satisfied on this path;
  `src/services/patientVerification.ts` (the mirror reader) is not wired into the shared queue tool.

---

### 2.2 `surgery` — Surgery Coordination

| | |
|---|---|
| File / config | `src/agents/surgeryAgent.ts:77`, factory `:354` |
| Registered | `src/config/agents.ts:123`, `enabled: true`, `inbound` |
| Config numbers | `[]` |
| **Production number** | **`+15625611218`** — 943 calls |
| Yesterday | **138 calls** |
| Hours observed | 08:01–17:00 PT |
| Version | config `1.0.0` = production `1.0.0` |
| **Department** | **2** (`SURGERY_DEPARTMENT_ID`, `src/tools/surgeryTaxonomy.ts:64`) |
| Guardrails | none on the agent; session-level `medicalSafetyGuardrails` only |
| Pipelines | old core SIP **and** Grok runtime |
| Tickets | 359 of 943; avg duration 139s |

**Tools (5)** — `surgeryAgent.ts:97`: `lookup_patient` **[R]**, `resolve_location` **[R]**,
`check_open_tickets` **[R]**, `classify_surgery_request` **[R]** (`src/tools/surgeryTools.ts:35`),
`file_surgery_ticket` **[R]** (`src/tools/surgeryTools.ts:99`).

**Transfer: NO — no transfer tool at all.** Deliberate (`surgeryAgent.ts:13`).
`AGENT_CAPABILITIES.surgery` = `canTransfer: false` (`agentCapabilities.ts:96`). Production: 0 of 943.

**What the prompt promises:**

> "I'm not able to transfer you, but I can take this down and have the surgery coordinator call you
> back." — `surgeryAgent.ts:202`

> "A curtain or shadow across their vision, a sudden shower of floaters or flashes, vision lost in
> part of an eye, or severe pain after surgery: tell them to seek emergency care or call 911 now"
> — `surgeryAgent.ts:208`

> "Never say 'wrong number', 'wrong extension', 'wrong department', or 'you'll need to call' — they
> rang us, and that is enough." — `surgeryAgent.ts:192-193`

**Prompt vs code:** same `routed_to` gap as tech (`src/tools/surgeryTools.ts:526`). Same
`lookup_patient` / standing-instruction-14 gap.

---

### 2.3 `no-ivr` — the after-hours line

| | |
|---|---|
| File / config | `src/agents/noIvrAgent.ts:1671`, factory `:813` |
| Registered | `src/config/agents.ts:37`, `enabled: true`, `inbound` |
| Config numbers | `[]` |
| **Production number** | **`+16263821543`** — 873 calls |
| Yesterday | **38 calls** |
| Hours observed | **00:00–23:43 PT — 24 hours.** 277 of 873 (32%) landed inside 08:00–16:59 PT |
| Version | config `1.20.0` = production `1.20.0` |
| Department | after-hours ticketing; **two conflicting constants** — `AFTER_HOURS_DEPARTMENT_ID = 3` (`src/config/afterHoursTicketing.ts:1`) vs `AFTER_HOURS_DEPARTMENT_ID = 8` (`src/tools/afterHoursTaxonomy.ts:94`) |
| Guardrails | `agent.outputGuardrails = medicalSafetyGuardrails` (`noIvrAgent.ts:1658`) **and** session-level |
| Pipelines | old core SIP; Grok runtime **only if a handoff is injected** (`TRANSFER_CAPABLE_LANES`, `src/runtime/laneRegistry.ts:118`) |
| Tickets | 250 of 873; **28 transfers** — the only agent in the fleet with any; avg duration 94s |

**Tools (6)** — all **[I]**, `noIvrAgent.ts:1648`:

| tool | file:line |
|---|---|
| `lookup_schedule` | `noIvrAgent.ts:938` |
| `check_open_tickets` | `noIvrAgent.ts:1000` |
| `emit_decision` | `noIvrAgent.ts:1055` |
| `create_ticket` | `noIvrAgent.ts:1099` |
| `escalate_to_human` | `noIvrAgent.ts:1423` |
| `terminate_call` | `noIvrAgent.ts:1346` |

**Transfer: YES.** Mechanism: `escalate_to_human` → `await handoffToHuman()` (`noIvrAgent.ts:1575`),
the Twilio conference redirect wired by the transport. Duplicate escalations are refused
(`:1522`) and `terminate_call` is refused once escalation has fired (`:1378`).
`AGENT_CAPABILITIES['no-ivr']` = `canTransfer: true, transferTool: 'escalate_to_human'`
(`agentCapabilities.ts:114`).

**What the prompt/greeting promises:**

Code greeting, `noIvrAgent.ts:1681`:

> "Thank you for calling Azul Vision, all of our offices are currently closed, you have reached the
> after hours call service. If this is a medical emergency, please dial 911. **All calls are being
> recorded for quality assurance purposes**, how can I help you?"

DB greeting (`agents.welcome_greeting`, slug `no-ivr`), which **outranks** the code string
(`src/services/greetingResolver.ts:1`, applied at `src/voiceAgentRoutes.ts:4414`):

> "Thank you for calling Azul Vision. Our offices are currently closed. If this is a medical
> emergency, please hang up and dial 911. Otherwise, I'm happy to help — how may I assist you?"

**Prompt vs code — two contradictions on the busiest 24-hour line:**

1. **The recording disclosure is in the code greeting and absent from the DB greeting that
   overrides it.** The TwiML for this route sets `record="record-from-start"`
   (`src/voiceAgentRoutes.ts:5918`), so every call is recorded. 873 calls in 14 days.
2. **"Our offices are currently closed" is spoken to daytime callers.** 277 of 873 calls (32%)
   arrived between 08:00 and 16:59 PT.

---

### 2.4 `optical` — Optical queue

| | |
|---|---|
| File / config | `src/agents/opticalAgent.ts:62`, factory `:249` |
| Registered | `src/config/agents.ts:107`, `enabled: true`, `inbound` |
| Config numbers | `[]` |
| **Production numbers** | **`+18186193692`** (635 calls, old core) and **`+17602923017`** (2 calls, `voice_provider = 'grok'`) |
| Yesterday | **93 calls** (91 + 2 Grok) |
| Hours observed | 04:59–16:59 PT |
| Version | config `1.0.0` = production `1.0.0` |
| **Department** | **1** (`OPTICAL_DEPARTMENT_ID`, `src/tools/opticalTaxonomy.ts:33`) |
| Guardrails | none on the agent; session-level only on SIP — **none at all on the Grok runtime** (§5) |
| Pipelines | **both, and it is the only agent proven on both**: 635 old core + 2 Grok |
| Tickets | 285 of 637; avg duration 148s |

**Tools (5)** — `opticalAgent.ts:83`: `lookup_patient` **[R]**, `resolve_location` **[R]**,
`check_open_tickets` **[R]**, `classify_optical_request` **[R]** (`src/tools/opticalTools.ts:24`),
`file_optical_ticket` **[R]** (`src/tools/opticalTools.ts:72`). Injected context `queue: 'optical'`
(`opticalAgent.ts:273`) — not a schema field, so the model cannot set or blank it.

**Transfer: NO — no transfer tool at all.** `createOpticalAgent(_handoffToHuman: undefined, …)`
(`opticalAgent.ts:249`); the transport calls `agentFactory(undefined, opticalMeta)`
(`src/voiceAgentRoutes.ts:2785`). Production: 0 of 637.

**What the prompt promises:**

> "I'm not able to transfer you, but I can take this down and have the optical team at your office
> call you back." — `opticalAgent.ts:181`

> "If they want to book, change or cancel an appointment, take the request in their own words and
> file it — the tool routes it to our scheduling hub." — `opticalAgent.ts:187`

> "NEVER ask a patient which city one of our offices is in — they came to us, we know where we are."
> — `opticalAgent.ts:206`

> "THE NUMBER COMES BEFORE THE TICKET… Ask, hear the answer, THEN file." — `opticalAgent.ts:218`

**Prompt vs code:**

- The office-city ban and the tool refusal text **agree**: `resolve_location`'s refusal is
  `` "I'm not finding an office by that name — which of our offices do you usually visit?" ``
  (`src/tools/sharedPatientTools.ts:275`), which asks which office, never which city. The tool
  carries a comment saying so at `:273`.
- Same `routed_to`-only-on-redirect gap (`src/tools/opticalTools.ts:403`).
- **The greeting the caller hears is not the greeting in the agent's config.** Three strings exist:
  agent config `"…assisting other patients…"` (`opticalAgent.ts:74`), route literal
  `"…assisting other **customers**…"` (`src/voiceAgentRoutes.ts:6263`), and the DB
  `welcome_greeting`, which wins. DB text matches the agent config, not the route literal.

---

### 2.5 `answering-service` — practice-wide overflow

| | |
|---|---|
| File / config | `src/agents/answeringServiceAgent.ts:191`, factory `:599` |
| Registered | `src/config/agents.ts:88`, `enabled: true`, `inbound` |
| Config numbers | **`['+19094135645']`** — the only number in the whole config |
| **Production number** | **`+19094135645`** — 293 calls (and `records` answered 5 calls on the same number, §7) |
| Yesterday | **38 calls** |
| Hours observed | 05:10–21:17 PT |
| Version | config `3.7.0` = production `3.7.0` |
| **Department** | routed by `classify_request` into 1 / 2 / 3 / 11 / 12 (`src/config/answeringServiceTicketing.ts:1`); `DEFAULT_TICKET` = dept 3, type 8, reason 212 (`:19`) |
| Guardrails | none on the agent; session-level `medicalSafetyGuardrails` only |
| Pipelines | old core SIP **and** Grok runtime (uniform factory, not transfer-capable) |
| Tickets | 110 of 293; avg duration 162s |

**Tools (5)** — all **[I]**, `answeringServiceAgent.ts:1283`: `lookup_schedule` (`:732`),
`check_open_tickets` (`:859`), `classify_request` (`:917`), `create_ticket` (`:952`),
`terminate_call` (`:1225`).

**Transfer: NO — no transfer tool at all.** The factory takes `handoffToHuman: () => Promise<void>`
(`:600`) and the transport passes one (`src/voiceAgentRoutes.ts:2729`), but the parameter is
**never referenced anywhere else in the file** — declared and dead.
`agentCapabilities.ts:79` records exactly this. Production: 0 of 293 transferred.

**What the prompt promises:**

> "You CANNOT transfer a call. There is no handoff in this system." — `answeringServiceAgent.ts:513`

> "I'm not able to transfer you to someone — I'm not a person and I can't connect calls. What I can
> do is put in a request right now and have a team member call you back." — `:515`

> "NEVER say a person will 'be with you', 'be right with you', or is 'coming' — nobody is coming to
> this call." — `:521`

> "⚠️ TICKET BEFORE CONFIRM: You MUST call `create_ticket` and receive `success=true` BEFORE saying
> 'I've passed your message'." — `:526`

**Prompt vs code — the greeting contradicts the prompt.** The DB `welcome_greeting` for
`answering-service`, which is what actually plays, ends:

> "…All of our team members are currently assisting other patients — I can help you right now.
> **How may I direct your call?**"

"Direct your call" is an offer to route the caller. The prompt six lines into the same session says
"You CANNOT transfer a call. There is no handoff in this system." The agent has no transfer tool.
293 calls in 14 days opened on that sentence.

---

### 2.6 `pcp` — professional-caller line

| | |
|---|---|
| File / config | `src/agents/pcpAgent.ts:31`, factory `:469` |
| Registered | `src/config/agents.ts:206`, `enabled: true`, `inbound` |
| Config numbers | `[]` |
| **Production number** | **`+16269000771`** — 19 calls |
| Yesterday | **3 calls** |
| Hours observed | 10:54–16:54 PT |
| Version | config `1.0.0` = production `1.0.0` |
| Department | **no numbered department** — its own contract, `src/pcp/pcpTicketing.ts:113` (`submitPcpTicket`) |
| Guardrails | `agent.outputGuardrails = pcpSafetyGuardrails` (`pcpAgent.ts:1044`) — **the only agent with its own set**, and it does not run on the old core (§5) |
| Pipelines | old core SIP; Grok runtime only if a handoff is injected (`RUNTIME_TRANSFER_READY_LANES`, `laneRegistry.ts:141`) |
| Tickets | 11 of 19; **0 transfers**; avg duration 175s |

**Tools (8)** — all **[I]**, `pcpAgent.ts:1042`:

| tool | file:line |
|---|---|
| `record_pcp_intake` | `pcpAgent.ts:513` |
| `get_public_practice_information` | `:554` |
| `lookup_patient_appointments` | `:568` |
| `create_pcp_task` | `:603` |
| `record_automated_resolution` | `:849` |
| `handoff_to_pcp` | `:870` |
| `handle_patient_medical_records_request` | `:962` |
| `terminate_call` | `:1014` |

**Transfer: YES, for professionals only.** `handoff_to_pcp` files a durable ticket **before** it
dials, then calls `handoffCallback()` and records `CONNECTED` / `FAILED` on the same ticket
(`pcpAgent.ts:929`). Gates, in order: `pcpDirector.next(callId).handoffEligible`
(`src/pcp/director.ts:339`), which is
`eligibleByAsk || (!isPatient && purpose && disposition === 'HAND_OFF' && !missing && !handoffFailed)`;
`eligibleByAsk` itself carries `!isPatient` via `askedForAPerson` (`director.ts:293`). Not eligible
does **not** drop the request — it files a `CREATE_TASK` fallback (`pcpAgent.ts:893`).

**What the prompt promises:**

> "You cannot transfer a patient — this queue is staffed to speak with clinics. Say so plainly: 'I'm
> not able to put you through from this line, but I'll take this down and the right team will call
> you back.'" — `pcpAgent.ts:254`

> "`handoff_to_pcp` — it files the request BEFORE dialling, so nothing is lost if nobody picks up."
> — `:284`

> "Never promise HOW they are being reached. One person, several, or a queue is a…" — `:287`

Greeting, `pcpAgentConfig.greeting` (`:48`), matching the DB row exactly:

> "Thank you for calling Azul Vision PCP Support. How can I help you today?"

The file records at `:36` that the previous greeting ("This line is for healthcare professionals")
contradicted the prompt's own patient path and was changed on 2026-08-14.

**Prompt vs code:** the patient-transfer ban **is** enforced in code (`director.ts:293`, `:339`) —
prompt and code agree. The looser statement is the tool description itself: `handoff_to_pcp`'s
description ("dial the configured PCP human queue") names no caller-type restriction, so the model
sees an unrestricted transfer tool and the refusal arrives only at execution.

---

### 2.7 `records` — Medical Records

| | |
|---|---|
| File / config | `src/agents/recordsAgent.ts:47`, factory `:273` |
| Registered | `src/config/agents.ts:158`, `enabled: true`, `inbound` |
| Config numbers | `[]` |
| **Production numbers** | **none of its own.** 5 of its 6 lifetime calls arrived on **`+19094135645`** — the answering-service number. The 6th (2026-08-13) arrived on `+16266353027` |
| Yesterday | **4 calls** |
| Hours observed | 16:04–17:16 PT |
| Version | config `1.0.0` = production `1.0.0` |
| **Department** | **16** (`MEDICAL_RECORDS_DEPARTMENT_ID`, `src/tools/medicalRecordsTaxonomy.ts:60`) |
| Guardrails | none on the agent; session-level only |
| Pipelines | old core SIP and Grok runtime |
| Tickets | 1 of 5; avg duration 108s |

**Tools (5)** — `recordsAgent.ts:66`: `lookup_patient` **[R]**, `resolve_location` **[R]**,
`check_open_tickets` **[R]**, `classify_records_request` **[R]**
(`src/tools/medicalRecordsTools.ts:39`), `file_records_ticket` **[R]** (`:92`).

**Transfer: NO — no transfer tool at all.**

**What the prompt promises:**

> "I'm not able to transfer you, but I can take this down and have the records team call you back."
> — `recordsAgent.ts:209`

> "Remember the caller may not be the patient. Take the PATIENT's name and date of birth for the
> record, and the CALLER's details separately." — `:219`

**Prompt vs code:** department 16 is a **home** department only — `queueRouting.ts:59` states nothing
redirects into Medical Records, while the records agent's own prompt tells it to take appointment,
glasses, medication and surgery requests and let the filing tool route them out
(`recordsAgent.ts:197-201`). Outbound redirect works; there is no inbound path, so a records request
taken on any other queue stays on that queue.

---

### 2.8 `azul-scheduling` — San Diego NextGen pilot

| | |
|---|---|
| File / config | `src/agents/azulSchedulingAgent.ts:939`, factory `:951` |
| Registered | `src/config/agents.ts:193`, **`enabled: true`** | 
| Config numbers | `[]` |
| DB `twilio_phone_number` | **`+17608402754`** — a number that appears in no config file and in no `call_logs` row, ever |
| **Production** | **0 calls in 14 days.** Last call **2026-08-17 12:12**. 760 lifetime |
| Version | config `2.28.0` (`AZUL_AGENT_VERSION`, `:55`) — **never observed in production**; no `azul-scheduling` row in the 14-day window to compare |
| Guardrails | `agent.outputGuardrails = medicalSafetyGuardrails` (`:1957`) plus session-level |
| Pipelines | old core SIP **only**. The Grok runtime refuses it by name: `transfer_to_office` reads `officeTransferCallbacks`, a per-call side channel only `voiceAgentRoutes` registers (`src/runtime/laneRegistry.ts:127`) |

**Tools (21)** — all **[I]**, `azulSchedulingAgent.ts:1930`: `sage_decision` (`:1072`),
`sage_patient_context` (`:1084`), `sage_availability` (`:1092`), `sage_book` (`:1146`),
`sage_reschedule` (`:1165`), `sage_confirm_appointment` (`:1183`), `sage_handoff` (`:1195`),
`transfer_to_office` (`:1442`), `sage_new_patient_intake` (`:1113`), `verify_patient_identity`
(`:1724`), `get_patient_appointments` (`:1800`), `get_appointment_details` (`:1810`),
`cancel_appointment` (`:1822`), `lookup_location` (`:1836`), `list_locations` (`:1846`),
`lookup_provider` (`:1854`), `get_provider_locations` (`:1864`), `sage_info` (`:1689`),
`sage_insurance_check` (`:1700`), `sage_practice` (`:1711`), `terminate_call` (`:1876`).

**Transfer: YES, two mechanisms.** `sage_handoff` (`:1195`) — the declared transfer in
`AGENT_CAPABILITIES` (`agentCapabilities.ts:136`) — and `transfer_to_office` (`:1442`), the ordinary
cold-transfer path that dials the office through `officeTransferCallbacks`. The capability table
names only the first.

Greeting: config `"Thanks for calling Azul Vision, this is the automated scheduling assistant. How
can I help you today?"` (`:945`) vs DB `"Thank you for calling Azul Vision. This is Sky, your
scheduling assistant. May I have your first and last name to get started?"` The DB one wins and
introduces a persona name ("Sky") that appears in no source file.

---

### 2.9 `after-hours` — legacy triage slug

| | |
|---|---|
| File | `src/agents/afterHoursAgent.ts`, factory `:217` |
| Registered | `src/config/agents.ts:75`, `enabled: true`, `inbound`. **No `version`, no `voice`, no `language`, no `greeting`** — the entry's own comment says the voice runtime refuses this lane |
| Config numbers | `[]` |
| DB `status` | **`inactive`** — the only inbound row in `public.agents` that is not `active` |
| **Production** | **0 calls in 14 days.** Last call **2026-08-12**. 15 lifetime |
| Department | conflicting: 3 (`afterHoursTicketing.ts:1`) vs 8 (`afterHoursTaxonomy.ts:94`) |
| Guardrails | **exports** `medicalSafetyGuardrails` (`:525`) but **does not attach them to the agent**. Session-level only |
| Pipelines | old core SIP only. Grok runtime refuses it by name — non-uniform factory `createAfterHoursAgent(handoff, recordPatientInfoCallback, metadata)` (`src/runtime/laneRegistry.ts:86`) |

**Tools (3)** — all **[I]**, `afterHoursAgent.ts:521`: `create_after_hours_ticket` (`:342`),
`transfer_to_human` (`:271`), `terminate_call` (`:459`).

**Transfer: the agent file has a `transfer_to_human` tool** (`:271`) with an auto-ticket safety net
(`:277`) — **but `AGENT_CAPABILITIES['after-hours']` declares `canTransfer: false, transferTool: null`**
(`agentCapabilities.ts:88`). That table's own note reads: *"Legacy slug, 4 calls ever. NOT the
after-hours line — that is no-ivr."* The production count is 15, not 4.

Greeting `WELCOME_GREETING` (`:51`) carries the recording disclosure; the DB row for `after-hours`
does not ("Thank you for calling Azul Vision after-hours line. I'm here to help route your call.
May I have your name and phone number?").

---

### 2.10 `dev-no-ivr` and `no-ivr-v2` — one file, two slugs

| | |
|---|---|
| File / config | `src/agents/noIvrAgentV2.ts:601`, factory `:75` |
| Registered | `dev-no-ivr` at `src/config/agents.ts:51`; `no-ivr-v2` at `:63`. **Both `enabled: true`, both `inbound`, both point at `createNoIvrAgentV2`** |
| Versions | `dev-no-ivr` hardcodes `'2.0.0-workflow'` (`agents.ts:59`); `no-ivr-v2` reads `noIvrAgentV2Config.version` = `'2.0.0'` (`noIvrAgentV2.ts:606`) — **one factory, two version strings** |
| Config numbers | `[]` both |
| DB | **neither slug exists in `public.agents`** |
| **Production** | **0 calls, ever.** Neither slug appears in `call_logs` |
| Route | `dev-no-ivr` has one: `POST /api/voice/dev-no-ivr` (`voiceAgentRoutes.ts:6004`). **`no-ivr-v2` has none** and is absent from `validAgentSlugs` (`:2297`) — unreachable on the old core |
| Guardrails | `agent.outputGuardrails = medicalSafetyGuardrails` (`noIvrAgentV2.ts:586`) |
| Pipelines | Grok runtime only if a handoff is injected; SIP for `dev-no-ivr` only |

**Tools (7)** — all **[I]**, `noIvrAgentV2.ts:575`: `classify_intent` (`:165`), `update_slot`
(`:209`), `lookup_schedule` (`:256`), `check_open_tickets` (`:318`), `log_decision` (`:370`),
`create_ticket` (`:398`), `escalate_to_human` (`:524`).

**Transfer: YES** — `escalate_to_human` → `await handoffToHuman()` (`:565`), returning
`"Call transferred to on-call provider."` unconditionally on `success: true`.

---

### 2.11 `runtime-proof` — the operator's proving lane

| | |
|---|---|
| File / config | `src/agents/runtimeProofAgent.ts:33`, factory `:109` |
| Registered | `src/config/agents.ts:175`, `enabled: true`, `inbound` |
| Config numbers | `[]` |
| DB | **no row in `public.agents`** |
| **Production** | **0 calls, ever** |
| Route | **none on the old core.** Absent from `validAgentSlugs` (`voiceAgentRoutes.ts:2297`) and from `validInboundAgents` (`:5353`). Reachable only at `POST /voice/runtime-proof` on the Grok runtime (`src/runtime/voiceRuntime.ts:428`) |
| Guardrails | **none declared** — and the Grok runtime runs only what the agent declares (§5), so this lane runs with zero guardrails |
| Pipelines | Grok runtime only, and only when a transfer is configured |

**Tools (14)** — all **[R]**, `runtimeProofAgent.ts:46`: `lookup_patient`, `resolve_location`,
`check_open_tickets`, `classify_optical_request`, `file_optical_ticket`, `classify_surgery_request`,
`file_surgery_ticket`, `classify_tech_request`, `file_tech_ticket`, `classify_records_request`,
`file_records_ticket`, `lookup_schedule` (`src/tools/generalServiceTools.ts:33`), `classify_request`
(`:84`), `create_ticket` (`:154`), `request_human_handoff` (`src/tools/handoffBroker.ts:48`).

**Transfer: YES** — `request_human_handoff` resolves a per-call callback registered by the factory
(`runtimeProofAgent.ts:115`). **`runtime-proof` has no entry in `AGENT_CAPABILITIES`**, so
`capabilitiesOf('runtime-proof')` returns `UNKNOWN_AGENT` with `canTransfer: false`
(`agentCapabilities.ts:155`) — the fleet's capability table says this agent cannot transfer while it
holds a transfer tool.

Prompt (`:84`):

> "Real tools, real systems: everything you file or transfer actually happens, so treat every call
> as a real patient call."

> "Never tell a caller they are being transferred unless the tool reported success." — `:101`

---

### 2.12 Outbound agents

| slug | file | tools | transfer | production |
|---|---|---|---|---|
| `drs-scheduler` | `drsSchedulerAgent.ts:86` | **[I]** `lookup_patient` (`:105`), `mark_contact_completed` (`:124`) | `handoffCallback` is a factory parameter; **no transfer tool declared** | never appears in `call_logs` |
| `appointment-confirmation` | `appointmentConfirmationAgent.ts:93` | **[I]** `get_appointment` (`:185`), `confirm_appointment` (`:203`), `reschedule_request` (`:221`), `cancel_appointment` (`:243`), `mark_confirmed` (`:262`), `mark_voicemail` (`:306`) | **none**; `canTransfer: false` (`agentCapabilities.ts:108`) | 67 lifetime, last **2026-05-05** |
| `fantasy-football` | `fantasyFootballAgent.ts:146` | **[I]** `getPlayerInfo` (`:162`), `getPlayerStats` (`:200`), `comparePlayers` (`:275`), `getTopPlayers` (`:368`) | none | never appears in `call_logs` |

All three carry `agentType: 'outbound'` and are refused by the Grok runtime twice over — once for
`agentType` (`laneRegistry.ts:163`) and once as non-uniform factories (`:86–93`). None has a DB
`status` of `active`. `appointment-confirmation` holds DB `twilio_phone_number` `+19093108277`;
`drs-scheduler` holds `+19513562485`. Neither number appears in `call_logs`.

---

### 2.13 `databaseAgent` — not an agent, a fallback builder

`src/agents/databaseAgent.ts:6`. Not registered. Called only from `voiceAgentRoutes.ts:3073` when a
dialled slug is **not** in `AgentRegistry`: it reads `agents.system_prompt` from the DB and builds a
`RealtimeAgent` with two inline tools — `transfer_to_human` (`:22`, only when a `handoffCallback`
was supplied) and `end_call` (`:40`). No guardrails, no ticket tool, no capability-table entry.
This is the path a mis-typed or newly-added slug lands on. The `demo` slug (17 lifetime calls, last
2026-08-09) is the only slug observed reaching it.

---

## 3. THE ROUTING TABLE

Dialled number → agent → department, sorted by **yesterday's** (2026-08-31) call volume.

| dialled number | agent | department | pipeline | yesterday | 14 days | in config `twilioNumbers`? | in DB `agents.twilio_phone_number`? |
|---|---|---|---|---:|---:|---|---|
| `+17604376683` | `tech` | 3 Clinical Tech Support | old core SIP | **183** | 1,325 | **NO** | **NO** |
| `+15625611218` | `surgery` | 2 Surgery Coordination | old core SIP | **138** | 943 | **NO** | **NO** |
| `+18186193692` | `optical` | 1 Optical | old core SIP | **91** | 635 | **NO** | **NO** |
| `+16263821543` | `no-ivr` | 3 / 8 (conflicting) | old core SIP | **38** | 873 | **NO** | yes |
| `+19094135645` | `answering-service` | 1/2/3/11/12 by classifier | old core SIP | **38** | 293 | **yes** (`agents.ts:93`) | no |
| `+19094135645` | **`records`** | **16 Medical Records** | old core SIP | **4** | 5 | — | — |
| `+16269000771` | `pcp` | own PCP contract | old core SIP | **3** | 19 | **NO** | yes |
| `+17602923017` | `optical` | 1 Optical | **Grok runtime** | **2** | 2 | **NO** | **NO** |

### 3a. Numbers in config or DB that received no calls

| number | claimed by | source | calls, 14 days | calls, ever |
|---|---|---|---:|---:|
| `+17608402754` | `azul-scheduling` | DB `agents.twilio_phone_number` | 0 | **0 — never appears in `call_logs`** |
| `+16265482660` | `demo` | DB `agents.twilio_phone_number` | 0 | 17 (`demo`, last 2026-08-09) |
| `+19093108277` | `appointment-confirmation` | DB | 0 | 67, last 2026-05-05 |
| `+19513562485` | `drs-scheduler` | DB | 0 | 0 |

### 3b. Dialled numbers in `call_logs` that map to no config entry

**Six of the seven live numbers.** `+19094135645` is the only dialled number present in
`src/config/agents.ts`. Every other production number — `+17604376683`, `+15625611218`,
`+18186193692`, `+16263821543`, `+16269000771`, `+17602923017` — is absent from the config, so
`getAgentFactoryByNumber` (`agents.ts:259`) would fall through its loop and return the **`no-ivr`
default** (`:266`) for all of them. Production does not use that function; routing comes from the
webhook path (§6). The default is the failure mode if anything ever does call it.

Also absent from the stale `phone_endpoints` table (last synced **2026-02-16**): every one of
`+17604376683`, `+15625611218`, `+18186193692`, `+17602923017` is present as a row but with
`voice_webhook_url: null` and `friendly_name: "Azul Vision SMS"`. `+16269000771`'s row points at a
`janeway.replit.dev` dev host. `phone_endpoints` and `twilio-inventory.md` (generated 2026-02-06)
both predate every queue line and describe none of them.

### 3c. Numbers observed once, outside any configuration

| number | agent | when | note |
|---|---|---|---|
| `+16266353027` | `records` | 2026-08-13 | `phone_endpoints` row exists, `friendly_name: "Azul Vision SMS"`, `voice_webhook_url: null` |

---

## 4. THE DEAD AGENTS

Agent files with no live traffic and no route of their own.

| agent / file | last call | route | DB row | classification |
|---|---|---|---|---|
| `no-ivr-v2` (`noIvrAgentV2.ts`) | **never** | **none** — not in `validAgentSlugs` (`voiceAgentRoutes.ts:2297`), no `/api/voice/no-ivr-v2` | absent | **Superseded / unreachable.** Second registry alias for the same factory `dev-no-ivr` already exposes, with a different version string. Reachable only via the Grok runtime, which refuses it without an injected handoff. |
| `dev-no-ivr` (`noIvrAgentV2.ts`) | **never** | `POST /api/voice/dev-no-ivr` | absent | **Test fixture.** Has a route and a slug; no number has ever been pointed at it. |
| `runtime-proof` (`runtimeProofAgent.ts`) | **never** | Grok runtime `/voice/runtime-proof` only | absent | **Test fixture, by design** — `runtimeProofAgent.ts:16`: "Nothing routes here until a Twilio number is pointed at `/voice/runtime-proof`." Also missing from `AGENT_CAPABILITIES`. |
| `after-hours` (`afterHoursAgent.ts`) | **2026-08-12**, 15 lifetime | `POST /api/voice/incoming-call` IVR paths | present, **`status: inactive`** | **Superseded.** `agentCapabilities.ts:85` states it plainly: *"NOT the after-hours line — that is `no-ivr`."* Its `WELCOME_GREETING` (`:51`) is still imported and used elsewhere (`voiceAgentRoutes.ts:21`), so the file is not dead code even though the lane is. |
| `azul-scheduling` (`azulSchedulingAgent.ts`) | **2026-08-17**, 760 lifetime | `POST /api/voice/azul-scheduling` (`:6471`) | present, `status: active`, number `+17608402754` | **Dark, not abandoned.** Largest agent file in the repo (110 KB, 21 tools), `enabled: true` in config, `active` in the DB, holds a number that has never received a call. Refused outright by the Grok runtime. |
| `drs-scheduler` (`drsSchedulerAgent.ts`) | **never** in `call_logs` | outbound campaign scheduler | present, `status: inactive` | **Abandoned / dormant outbound.** |
| `fantasy-football` (`fantasyFootballAgent.ts`) | **never** | outbound only | present, `status: inactive`, DB row last touched **2026-01-14** | **Abandoned.** Not an eye-care agent; four Sleeper-API tools. |
| `appointment-confirmation` (`appointmentConfirmationAgent.ts`) | **2026-05-05**, 67 lifetime | `POST /api/voice/appointment-confirmation` (`:6612`) | present, `status: inactive`, number `+19093108277` | **Dormant outbound.** Nearly four months idle. |
| `databaseAgent.ts` | n/a | fallback only | n/a | **Not an agent** — DB-prompt builder for unregistered slugs. |

Two orphan tool modules sit under `src/agents/tools/` and are imported by **no agent**:
`createTicketTool.ts` (`:168`, exports `createTicketTool`) and `documentTicketTool.ts` (`:21`).
Every agent that files tickets declares its own `create_ticket` inline or pulls
`file_*_ticket` from the shared registry.

Historic `agent_used` values in `call_logs` with no corresponding file today: `greeter` (14 calls,
last 2026-01-01), `claude-as` (5 rows, all with `start_time` null — never connected), `demo`
(17 calls, last 2026-08-09), and 306 rows with `agent_used` null (last 2026-01-12).

---

## 5. GUARDRAILS, BY LAYER

The Agents SDK ignores agent-level `outputGuardrails` for realtime sessions. On the old core, the
**session** object is what carries them:

```
src/voiceAgentRoutes.ts:817    outputGuardrails: medicalSafetyGuardrails,
src/voiceAgentRoutes.ts:3152   new RealtimeSession(sessionAgent, { ...sessionOptions, … })
```

`sessionOptions` is spread into **every** session, for every slug. On the Grok runtime the opposite
is true: `agentBinding.ts:239` reads `agent.outputGuardrails` and `mediaStreamBridge.ts:757` runs
only those.

| agent | declares (agent level) | runs on old core SIP | runs on Grok runtime |
|---|---|---|---|
| `no-ivr` | `medicalSafetyGuardrails` (`:1658`) | `medicalSafetyGuardrails` (session) | `medicalSafetyGuardrails` |
| `no-ivr-v2` / `dev-no-ivr` | `medicalSafetyGuardrails` (`:586`) | same | `medicalSafetyGuardrails` |
| `azul-scheduling` | `medicalSafetyGuardrails` (`:1957`) | same | lane refused |
| **`pcp`** | **`pcpSafetyGuardrails`** (`:1044`) | **`medicalSafetyGuardrails` — its own three rules do not run** | `pcpSafetyGuardrails` |
| `answering-service` | none | `medicalSafetyGuardrails` (session) | **none** |
| `optical` | none | `medicalSafetyGuardrails` (session) | **none** |
| `surgery` | none | `medicalSafetyGuardrails` (session) | **none** |
| `tech` | none | `medicalSafetyGuardrails` (session) | **none** |
| `records` | none | `medicalSafetyGuardrails` (session) | **none** |
| `runtime-proof` | none | no route | **none** |
| `after-hours` | none (exports them at `:525`, never attaches) | `medicalSafetyGuardrails` (session) | lane refused |

Two consequences visible in production: `pcp`'s "No diagnosis / No medication advice / No unverified
record disclosure" (`src/guardrails/pcpSafety.ts:16`) has never run on a real call, and the two
Grok-runtime `optical` calls on `+17602923017` ran with **no output guardrail of any kind** — the
same agent runs guarded on `+18186193692`.

---

## 6. PIPELINES

Three transports exist. Which one a call takes is decided by the webhook the number points at.

**A. Old core SIP** — `src/voiceAgentRoutes.ts`. Twilio → conference → SIP →
`sip.api.openai.com`. All 3,196 non-Grok calls in the window. Per-slug webhooks:

| path | slug stamped | line |
|---|---|---|
| `/api/voice/answering-service` | `answering-service` | `:6248` (`registerOverflowLine`) |
| `/api/voice/optical` | `optical` | `:6258` |
| `/api/voice/surgery` | `surgery` | `:6270` |
| `/api/voice/tech` | `tech` | `:6281` |
| `/api/voice/records` | `records` | `:6293` |
| `/api/voice/no-ivr` | `no-ivr` | `:5827` |
| `/api/voice/dev-no-ivr` | `dev-no-ivr` | `:6004` |
| `/api/voice/pcp` | `pcp` | `:6410` |
| `/api/voice/azul-scheduling` | `azul-scheduling` | `:6471` |
| `/api/voice/demo` | `demo` | `:6309` |
| `/api/voice/appointment-confirmation` | `appointment-confirmation` | `:6612` |
| `/api/voice/incoming-call` + `/api/voice/ivr-selection` | IVR fan-out | `:5686`, `:6765` |

All of them emit `record="record-from-start"` (`:5660`, `:5772`, `:5918`, `:6064`, `:6196`, `:6367`,
`:6446`, `:6558`, `:6718`, `:6914`, `:7028`, `:8297`).

**B. Grok runtime** — `src/runtime/voiceRuntime.ts:428`, `POST /voice/:slug` + a Twilio Media
Streams websocket. It builds **no registry of its own**; it reads `src/config/agents.ts`
(`laneRegistry.ts:11`). 2 calls, `optical`, `+17602923017`, 2026-08-31.

Servability, from `laneSupportStatus` (`laneRegistry.ts:160`):

| lane | Grok runtime | why |
|---|---|---|
| `answering-service`, `optical`, `surgery`, `tech`, `records` | **servable now** | uniform factory, not transfer-capable |
| `no-ivr`, `no-ivr-v2`, `dev-no-ivr`, `pcp`, `runtime-proof` | servable **only if a handoff is injected** | `TRANSFER_CAPABLE_LANES` ∩ `RUNTIME_TRANSFER_READY_LANES` (`:118`, `:141`) |
| `azul-scheduling` | **refused** | transfer-capable but its `transfer_to_office` side channel is unwired here (`:127`) |
| `after-hours` | **refused** | non-uniform factory `(handoff, recordPatientInfoCallback, metadata)` (`:86`) |
| `drs-scheduler`, `appointment-confirmation`, `fantasy-football` | **refused** | outbound (`:163`) and non-uniform (`:88–93`) |

**C. New core line modules** — `src/core/router.ts`. Env-gated and **off by default**:
`NEW_CORE_LINES` (`:29`) and `TICKET_AGENT_LINES` (`:37`) both default to empty strings.
`BUILT_LINES` (`:249`) = `answering-service, pcp, no-ivr, after-hours, azul-scheduling`. The `demo`
slug is a ticket-agent line unconditionally (`:49`). No production call in the window carried
telemetry from this path.

---

## 7. CONFIG vs PRODUCTION — every disagreement

| # | Claim | Source | Production says |
|---|---|---|---|
| 1 | `twilioNumbers: []` for `tech`, `surgery`, `optical`, `records`, `pcp`, `no-ivr` | `src/config/agents.ts:112, 128, 146, 164, 198, 212, 43` | Those slugs answered **3,802 calls** in 14 days on six real numbers. The config knows one number out of seven. |
| 2 | Comments: *"twilioNumbers stays empty until the number is bought"* for optical, surgery, tech, records | `agents.ts:105, 122, 139, 157` | All four numbers exist and are live. Optical alone has two. |
| 3 | Comment: *"Point the … number's Twilio voice webhook here. Until that number exists the route is harmless: nothing dials it."* | `voiceAgentRoutes.ts:6256, 6267, 6291` | Those three routes carried **2,905 calls** in 14 days. |
| 4 | `CLAUDE.md` line-status table: **pcp OFF** | `CLAUDE.md` | `pcp` took **19 calls**, most recent 2026-08-31 23:29. Live, low volume, 0 transfers. |
| 5 | `CLAUDE.md`: **azul-scheduling OFF** | `CLAUDE.md` | Agrees — 0 calls in 14 days, last 2026-08-17. But config still has `enabled: true` and the DB row is `status: active` with a number attached. |
| 6 | `CLAUDE.md`: **tech "Built, number pending"** | `CLAUDE.md` | `tech` is the **highest-volume agent in the fleet** — 1,325 calls, 183 yesterday, on `+17604376683`. |
| 7 | `CLAUDE.md`: **records not listed at all** | `CLAUDE.md` | `records` took 5 calls in the window, 4 of them yesterday. |
| 8 | `CLAUDE.md`: **answering-service is the biggest line (579/day)** | `CLAUDE.md` | 293 calls in 14 days — **~21/day**. Volume moved to the queue lines. |
| 9 | `records` has its own number | implied by `agents.ts:157` and by having its own slug and route | **It has none.** 5 of 6 lifetime calls arrived on `+19094135645`, the answering-service number. The same dialled number resolved to two different agents on 2026-08-31. |
| 10 | DB `agents.twilio_phone_number` = `+17608402754` for `azul-scheduling` | Operations Hub `agents` | That number has **never appeared in `call_logs`**. |
| 11 | `phone_endpoints` is the number registry | table exists in the Hub | Last synced **2026-02-16**. Every queue number is present with `voice_webhook_url: null`. `+16269000771` (live pcp) points at a `janeway.replit.dev` dev host. |
| 12 | `twilio-inventory.md` | repo root, generated 2026-02-06 | Lists 12 numbers. Contains none of `+17604376683`, `+15625611218`, `+18186193692`, `+17602923017`, `+16269000771`. |
| 13 | `no-ivr` greeting discloses recording | `noIvrAgent.ts:1681` | The DB `welcome_greeting`, which **overrides** it (`greetingResolver.ts:1`, applied `voiceAgentRoutes.ts:4414`), **omits the recording sentence**. The route records from start (`:5918`). 873 calls. |
| 14 | `no-ivr` is the after-hours line — "all of our offices are currently closed" | `noIvrAgent.ts:1681`, standing instruction 13 | **277 of 873 calls (32%) arrived 08:00–16:59 PT.** It runs 24 hours: earliest 00:00:19 PT, latest 23:43:41 PT. |
| 15 | `answering-service` prompt: *"You CANNOT transfer a call. There is no handoff in this system."* | `answeringServiceAgent.ts:513` | Its DB greeting — the first thing 293 callers heard — ends **"How may I direct your call?"** |
| 16 | `optical` route greeting says "assisting other **customers**" | `voiceAgentRoutes.ts:6263` | Agent config and DB both say "assisting other **patients**" (`opticalAgent.ts:76`). Three strings, DB wins. |
| 17 | `azul-scheduling` greeting is "the automated scheduling assistant" | `azulSchedulingAgent.ts:945` | DB greeting introduces a persona: **"This is Sky, your scheduling assistant."** "Sky" appears in no source file. |
| 18 | `after-hours` `canTransfer: false, transferTool: null` | `agentCapabilities.ts:88` | The agent declares a working `transfer_to_human` tool at `afterHoursAgent.ts:271`. The same note says "4 calls ever"; `call_logs` has **15**. |
| 19 | `runtime-proof` capability | absent from `AGENT_CAPABILITIES` | It holds `request_human_handoff` (`runtimeProofAgent.ts:65`). `capabilitiesOf` returns `UNKNOWN_AGENT` → `canTransfer: false` (`agentCapabilities.ts:155`). |
| 20 | `azul-scheduling` `transferTool: 'sage_handoff'` | `agentCapabilities.ts:136` | It has **two** transfer tools: `sage_handoff` (`:1195`) and `transfer_to_office` (`:1442`). Only one is declared. |
| 21 | One `AFTER_HOURS_DEPARTMENT_ID` | — | Two constants, two values: **3** (`src/config/afterHoursTicketing.ts:1`) and **8** (`src/tools/afterHoursTaxonomy.ts:94`). |
| 22 | Two `ANSWERING_SERVICE_DEPARTMENTS` maps | — | `answeringServiceTicketing.ts:1` has 5 keys (adds RESEARCH 11, CEC_NETWORKING 12); `afterHoursTicketing.ts:3` has 3 and renames two of them. |
| 23 | `dev-no-ivr` version `'2.0.0-workflow'` | `agents.ts:59` | Same factory registered as `no-ivr-v2` reports `'2.0.0'` (`noIvrAgentV2.ts:606`). |
| 24 | `pcp` guardrails are `pcpSafetyGuardrails` | `pcpAgent.ts:1044` | On the old core the session applies `medicalSafetyGuardrails` to every agent (`voiceAgentRoutes.ts:817`, `:3152`). The PCP set has never run on a live call. |
| 25 | Standing instruction 14 — one source of truth, `patients_master` | `CLAUDE.md` | `lookup_patient`, the first tool `optical`, `surgery`, `tech` and `records` call, still resolves through `scheduleLookupService` (`src/tools/sharedPatientTools.ts:113`) — the Operations Hub appointment book. `src/services/patientVerification.ts` is not wired into the shared queue tool. |
| 26 | `getAgentFactoryByNumber` resolves a number to an agent | `agents.ts:259` | With one number in the whole config, it returns the **`no-ivr` default** (`:266`) for six of seven live numbers. Production does not call it; nothing prevents a caller from doing so. |
| 27 | `runtime-proof` and `no-ivr-v2` are registered inbound agents | `agents.ts:175`, `:63` | Neither appears in `validAgentSlugs` (`voiceAgentRoutes.ts:2297`) nor in `validInboundAgents` (`:5353`). Both are unreachable on the old core. |
| 28 | `public.agents` is the agent roster | Hub DB | It holds 13 rows. It is **missing** `dev-no-ivr`, `no-ivr-v2`, `runtime-proof`; it **adds** `demo`, which is in no registry. |
| 29 | The fleet took calls every business day | implied by every daily average | **2026-08-25 (Tue) and 2026-08-26 (Wed) have zero rows fleet-wide** — no agent, no number, not even `no-ivr`, which logged on both weekends either side. Neighbouring weekdays logged 373 and 411. Any "14-day average" in this document is over 12 days of data. |

---

## Appendix — 14-day traffic, verbatim

Query window `now() - interval '14 days'`, run 2026-09-01.

| agent_used | calls | distinct dialled | first call | last call | transferred | with ticket | avg s |
|---|---:|---:|---|---|---:|---:|---:|
| `tech` | 1,325 | 1 | 2026-08-18 15:11:13 | 2026-08-31 23:53:46 | 0 | 909 | 152 |
| `surgery` | 943 | 1 | 2026-08-18 15:06:01 | 2026-08-31 23:54:54 | 0 | 359 | 139 |
| `no-ivr` | 873 | 1 | 2026-08-18 12:30:30 | 2026-09-01 09:54:01 | **28** | 250 | 94 |
| `optical` | 637 | 2 | 2026-08-18 15:04:12 | 2026-08-31 23:42:06 | 0 | 285 | 148 |
| `answering-service` | 293 | 1 | 2026-08-18 15:47:48 | 2026-08-31 22:58:48 | 0 | 110 | 162 |
| `pcp` | 19 | 1 | 2026-08-18 19:25:34 | 2026-08-31 23:29:26 | 0 | 11 | 175 |
| `records` | 5 | 1 | 2026-08-31 23:04:59 | 2026-09-01 00:16:48 | 0 | 1 | 108 |

Timestamps UTC. No other `agent_used` value appears in the window.

### Daily totals, whole fleet

| day | dow | tech | surgery | optical | no-ivr | answering-service | pcp | records | **all** |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-18 | Tue | 192 | 130 | 91 | 27 | 43 | 1 | – | **537** |
| 2026-08-19 | Wed | 184 | 120 | 98 | 82 | 24 | – | – | **508** |
| 2026-08-20 | Thu | 173 | 98 | 80 | 84 | 55 | 2 | – | **492** |
| 2026-08-21 | Fri | 167 | 113 | 95 | 64 | 40 | 2 | – | **481** |
| 2026-08-22 | Sat | 1 | – | – | 155 | – | – | – | **156** |
| 2026-08-23 | Sun | – | 1 | – | 59 | – | – | – | **60** |
| 2026-08-24 | Mon | 126 | 108 | 58 | 63 | 18 | – | – | **373** |
| **2026-08-25** | **Tue** | – | – | – | – | – | – | – | **0** |
| **2026-08-26** | **Wed** | – | – | – | – | – | – | – | **0** |
| 2026-08-27 | Thu | 156 | 122 | 67 | 28 | 32 | 6 | – | **411** |
| 2026-08-28 | Fri | 143 | 113 | 55 | 68 | 43 | 5 | – | **427** |
| 2026-08-29 | Sat | – | – | – | 120 | – | – | – | **120** |
| 2026-08-30 | Sun | – | – | – | 36 | – | – | – | **36** |
| 2026-08-31 | Mon | 183 | 138 | 93 | 38 | 38 | 3 | 4 | **497** |
| 2026-09-01 | Tue | – | – | – | 49 | – | – | 1 | **50** (partial day) |

**Two consecutive business days log nothing at all.** 2026-08-25 (Tue) and 2026-08-26 (Wed) have
**zero rows fleet-wide** — no agent, no number, not even `no-ivr`, which logged traffic on every
other day in the window including both weekends. Neighbouring Mondays and Thursdays logged 373 and
411. Whether the lines were down or the logging was, `call_logs` cannot say; anything computed as a
14-day average is computed over 12 days of data.
