# DR Screening (DRS Outbound Scheduler) — Reference and Environment

**Discovery only. No behavior was changed to produce this document.** Written
2026-08-23 against branch `claude/dr-screening-discovery-3qo5r1` (HEAD
`ba632db4`, equal to `origin/main` at the time of writing — the branch was
current with main, no unmerged commits). This document exists because no
governing reference for the DR screening app existed anywhere in
`docs/observatory/` or `docs/rebuild/` — those trees cover the ticketing/queue
agents and the San Diego scheduling pilot, not this agent. Per `/CLAUDE.md`'s
own rule, treat this file the same way: read it before re-deriving any of the
below, and update it in place rather than writing a second file.

**Scope note, stated up front because it changes several answers below:** the
"DR screening app" is a single outbound agent (`drs-scheduler`) plus a
Playwright-driven Phreesia form-filler. It has **never completed a real call in
production** — `campaigns`, `campaign_contacts`, and `scheduling_workflows` are
all empty (0 rows) in the Operations Hub database at time of writing, and no
test file exercises any part of it. Several files the task listed as reading
material (`scheduleLookupService.ts`, `providerNameCorpus.ts`,
`ticketFieldSanitizers.ts`) turned out, on inspection, to belong to the
*answering-service ticketing/provider-resolution pipeline*, not to this agent —
they reference "DRS" only because `DRS` is also the literal value NextGen
stores in `Schedule.RenderingPhysician` when a screening was done on the DRS
*machine* rather than by a named doctor, and those files exist to strip that
value out before it reaches a ticket. This is noted inline in §1 and §5 and
should not be conflated with the outbound scheduler.

---

## 1. Patient / Gap-list source

**There is no wired gap-list.** Two different things could plausibly serve as
one, and neither is connected to the calling agent:

- **`campaigns` / `campaign_contacts`** (Operations Hub `pslzngjciiifowemrzza`,
  schema `shared/schema.ts:186-284`) — the table the DRS agent's tools
  actually read from (`src/db/agentAdapters.ts:14-43`, `CampaignAdapter.lookupPatient`).
  `campaign_contacts` is explicitly documented in its own schema comment as
  "from CSV upload" (`shared/schema.ts:236`) — there is no query or ETL job in
  this repo that populates it from a clinical source. Both tables are **0 rows**
  in production right now (verified via `mcp__Supabase__list_tables` on
  `pslzngjciiifowemrzza`, 2026-08-23) — no campaign has ever been created.
  Fields: `id`, `campaignId`, `phoneNumber`, `firstName`, `lastName`, `email`,
  `customData` (jsonb), plus appointment-confirmation-shaped fields
  (`appointmentDate`, `appointmentDoctor`, `appointmentLocation`,
  `appointmentType`, `patientDob`), an `outreachStatus` enum (`pending` ...
  `completed`, `shared/schema.ts:219-234`), `attempts`/`maxAttempts`,
  `nextAttemptAt`. No eligibility, no diabetic-specific field, no region field
  beyond whatever a caller puts in `customData`. Duplicate representation:
  nothing prevents two rows for the same phone/person — there is no unique
  constraint beyond the primary key.
- **`HEDIS_CMS131_DiabeticRetinalExam`** (Operations Hub, 30,756 rows, synced —
  has a `synced_at` column). This is the table that actually looks like a real
  DR gap-list: HEDIS measure CMS131 is the "diabetic retinal/eye exam" quality
  measure. Fields include `PatientPartialKey`, `PatientAccount`,
  `PatientLastName`, `PatientFirstName`, `PatientDateOfBirth`, `PatientAge`,
  `LastLocation`, `LastDOS`, `Payer`/`PayerType`/`FinClass`, `HEDIS_Status`,
  `Screening_Pathway`, `ScreeningDate`/`Location`/`Provider`/`CPT`, and
  `DR_Negative`/`DR_Positive`/`DR_Inconclusive` result columns. **It has no
  phone number column at all**, and it is not referenced anywhere in this
  repo's source — confirmed by a repo-wide, case-insensitive grep for `HEDIS`,
  which returns only an unrelated string-matching list in
  `src/tools/medicalRecordsTaxonomy.ts:91` (the word "hedis" as a caller-intent
  cue for records requests) and a one-line mention of the table name in
  `docs/BACKEND_HANDOFF.md:40` (an inventory line, not a usage). Whatever
  process populates `synced_at` on this table is outside this repo.
- **`drs_slots`** (Operations Hub, 0 rows) also exists, schema shaped exactly
  like a synced slot-availability mirror (`slot_date`, `slot_begintime`,
  `location_id`, `resource_id`, `capacity`, `booked_count`, `slot_status`,
  `bookable_ind`, `patient_names`, `patient_ids`), and is likewise never
  referenced in application code (same grep). See §5.

**Conclusion:** the pieces that look like a real gap-list and a real
availability mirror exist in the Operations Hub database, are populated (in
the HEDIS table's case) or shaped for population (`drs_slots`), and are
completely disconnected from the code that places outbound DRS calls. The
agent's actual patient source is a manually-uploaded CSV campaign, which has
never been run.

---

## 2. Eligibility

**No eligibility rule exists in code.** There is no function, table join, or
prompt instruction anywhere in this repo that decides "this patient should be
screened." A `campaign_contacts` row existing at all is the only "eligibility"
check, and rows only exist if someone uploads a CSV (unobserved in this repo).
Not found / no longer eligible / already scheduled: the closest the agent gets
is the `outcome` enum on `mark_contact_completed`
(`src/agents/drsSchedulerAgent.ts:128`) — `scheduled`, `declined`, `callback`,
`no_answer`, `wrong_number`, `already_scheduled` — which the model chooses
after talking to the patient, not something checked beforehand. Nothing is
re-checked before booking. This is squarely a "don't know, don't guess"
per Wayne's standing instruction #1 — if the HEDIS table above is meant to be
the eligibility source, that is an operator decision/build item, not something
currently implemented.

---

## 3. Pre-context / caller recognition

**Does not apply to this agent, by construction, not by oversight.**
Caller-ID pre-context (`PRECONTEXT_SLUGS` in `src/voiceAgentRoutes.ts:2370`) is
an *inbound* mechanism — it looks up the calling phone number before the agent
answers. `drs-scheduler` is outbound-only
(`src/config/agents.ts:196-203`, `agentType: 'outbound'`) and is **absent**
from `PRECONTEXT_SLUGS`. Identity instead comes from the campaign record: the
agent's own `lookup_patient` tool (`src/agents/drsSchedulerAgent.ts:104-121`)
is called with `campaign_id`/`contact_id` values the outbound webhook already
knows (they were passed as query params when Twilio placed the call — see §6),
and returns `first_name`, `last_name`, `phone`, `email` from
`campaign_contacts`. There is no DOB check, no ambiguity handling, and no
"phone match is a candidate, not an identity" logic here — the contact row
*is* treated as the identity, unconditionally. No re-search after
verification; no looping behavior observed or coded (none of this has ever
run against production traffic to be measured).

---

## 4. Patient verification

**There is no verification step distinct from the lookup in §3.** The prompt
(`SYSTEM_PROMPT_TEMPLATE`, `src/agents/drsSchedulerAgent.ts:15-84`) tells the
model to "confirm date of birth" during the greeting (step 2), but this is a
prompt instruction, not a code-enforced check — nothing compares the spoken
DOB against a stored value, and no tool exists to do so. There is no
`patients_master` / mirror check anywhere in this agent (unlike
`patientVerification.ts` used by the inbound agents — that module is never
imported by `drsSchedulerAgent.ts`, confirmed by grep). "Authoritative post
verification" identity is just whatever `campaign_contacts` said at
`lookup_patient` time; nothing overwrites it, and nothing could, since no
canonical person ID (e.g. `patients_master.person_id`) is ever fetched or
attached. Ambiguity handling, retry/max-attempts, overwrite risk: none coded;
none applicable, because there is no matching step to fail.

---

## 5. Availability

**No live availability lookup exists in the calling agent's tool set.** The
agent has no tool that returns a list of open slots for the model to reason
over. The only path that resembles "availability" is the Playwright automation
described in §6, which drives Phreesia's own calendar widget directly
(`server/services/computerUseAgent.ts:304-330`, `selectDateTime`) — it clicks
whatever the *first enabled* slot button on the page is
(`button[class*="appointment"]:not([disabled])`), optionally clicking
"Next Week" once if none are visible. It does not parse a structured slot list,
does not filter by provider/type, and returns only `{ date: 'Selected from
calendar', time: slotText }` — the `date` field is a literal placeholder
string, not a real date, because the code never extracts one
(`server/services/computerUseAgent.ts:326`). There is therefore no exact
"authoritative slot identifier" produced anywhere — no slot ID, no
provider/location key beyond the location dropdown selection made moments
earlier. Compare this to `drs_slots` (§1), a Postgres table shaped exactly to
hold a real slot mirror (`slot_date`, `slot_begintime`, `location_id`,
`resource_id`, `capacity`, `booked_count`, `bookable_ind`) — it is 0 rows and
unreferenced by any code in this repo; it is not the source the agent uses.
Separately, `src/services/scheduleLookupService.ts` and
`src/services/providerNameCorpus.ts` do real, tested, live-traffic work, but
for the **answering-service/ticketing pipeline's provider-name resolver**, not
for DRS: they exist to recognize that `RenderingPhysician = 'DRS'` (and
`A-Scan`, `OCT-VF`) in the `Schedule` table means "a diagnostic machine, not a
doctor" and strip it before it reaches a ticket
(`src/services/ticketFieldSanitizers.ts:32-56`,
`src/services/providerNameCorpus.ts:32`). Confirmed by grep: `drsSchedulerAgent.ts`
imports none of these three files.

---

## 6. Booking

**Structurally cannot happen in the current wiring — this is the single
highest-value finding of this discovery.** Two independent gaps, both
verified in code, both required to be fixed before a booking could ever
succeed:

1. **`createDRSSchedulerAgent` only attaches the Phreesia tools
   (`schedule_patient_in_phreesia`, `submit_otp_code`) when both `callLogId`
   and `agentId` are truthy** (`src/agents/drsSchedulerAgent.ts:161-173`). The
   one and only place this factory is invoked for a live call
   (`src/voiceAgentRoutes.ts:2584-2593`) passes
   `{ ...metadata, callLogId: undefined, agentId: undefined }` **explicitly**,
   with the comment "callLogId backfilled after session.connect()". The
   backfill that follows (`src/voiceAgentRoutes.ts:4113-4132`) only writes
   `dbCallLogId` onto a metadata map (`callMetadataForDB`) for telemetry — it
   never re-creates the `RealtimeAgent` or mutates its already-closed-over
   `tools` array. **Net effect: the DRS agent, as constructed for a real call,
   never has `schedule_patient_in_phreesia` or `submit_otp_code` in its tool
   list at all** — only `lookup_patient` and `mark_contact_completed`.
2. Independently, the `computerTool({ computer })` path is also dead: the same
   call site passes `undefined` for `computer`
   (`src/voiceAgentRoutes.ts:2589`, comment: "computer - no Computer Use
   instance"). This half is also independently documented in
   `docs/voice-shadow-architecture/02-current-state-audit.md:80-83`: *"Computer-Use
   factory always receives `computer=undefined` → Phreesia automation inert in
   current wiring [V]."*

So even setting aside gap 1, gap 2 alone would prevent the `computerTool` path;
and gap 1 alone prevents the HTTP/Playwright-driven `schedule_patient_in_phreesia`
tool the prompt actually tells the model to use. Both gaps are present
simultaneously in the current codebase. This matches production data exactly:
`scheduling_workflows` is 0 rows (verified via Supabase, 2026-08-23) — not one
workflow row has ever been created, which is what `workflowManager.createWorkflow`
(`server/services/schedulingWorkflowManager.ts:48-84`) would insert the moment
the tool is called even once.

**If** the tool were reachable, the booking path is:
`schedule_patient_in_phreesia` (`src/tools/phreesiaSchedulingTool.ts:17-98`) →
`workflowManager.createWorkflow` (DB row in `scheduling_workflows`) →
`new PhreesiaComputerUseAgent(...).fillPhreesiaForm()`
(`server/services/computerUseAgent.ts:101-175`, a fixed sequence of Playwright
steps against CSS selectors on the live Phreesia page) → on success,
`workflowManager.completeWorkflow(..., true, confirmationNumber, appointmentDetails)`.
Required inputs: the full `patient_data` object (name, DOB, address, phones,
insurance — `src/tools/phreesiaSchedulingTool.ts:24-40`), `patient_type`,
`preferred_location`. Success/failure shape: a plain natural-language string
returned to the model (`✓ Appointment scheduled...` / `✗ Unable to complete...`),
not a structured object — the model is trusted to relay it faithfully. **The
proof that a booking actually happened** would be
`scheduling_workflows.status = 'completed'` AND
`submission_successful = true` AND a non-null `phreesia_confirmation_number`
— but `extractConfirmation()` (`server/services/computerUseAgent.ts:423-450`)
gets the confirmation number via a regex against the whole page's text
(`/confirmation.*?(\w{6,})/i`), which is fragile and unvalidated against any
real Phreesia confirmation page (no test exists — see §12). Conflict handling,
duplicate prevention, idempotency, and slot-disappearing-before-booking are
**not handled**: nothing checks whether the campaign contact already has an
appointment before starting a new Playwright run, and nothing re-verifies slot
availability between `selectDateTime` and form submission.

---

## 7. Existing-appointment check

**None exists for DRS specifically.** No code path queries `Schedule`,
`si_appointment_facts`, or any other appointment source to see whether the
patient the agent is calling already has a DRS (or any) appointment before or
during the call. `campaignContacts.appointmentDate` /
`appointmentDoctor` / `appointmentLocation` / `appointmentType` fields exist on
the schema (`shared/schema.ts:246-251`) and look built for exactly this, but
nothing in `drsSchedulerAgent.ts`, `agentAdapters.ts`, or the Phreesia tools
reads or writes them for this agent's flow — they are populated (per their own
naming) for the separate `appointment-confirmation` outbound agent's use case.
Duplicate scheduling is therefore fully possible today, though moot in
practice since no booking can currently succeed at all (§6).

---

## 8. Current voice architecture (DRS specifically)

- **Telephony:** Twilio outbound call, initiated by
  `CampaignExecutor.makeOutboundCall` (`server/services/campaignExecutor.ts:135-221`)
  via `twilioClient.calls.create(...)`, targeting
  `/api/voice/test/incoming?agentSlug=drs-scheduler&campaignId=...&contactId=...`
  (`campaignExecutor.ts:161`) — note this endpoint's path literally says
  "test", but it is the only outbound entry point that exists; it is what
  production traffic (if any were run) would also use.
  `machineDetection: 'DetectMessageEnd'` / `asyncAmd: 'true'` is set, i.e.
  voicemail detection is requested, but nothing in the reviewed code branches
  on `AnsweredBy` for this agent specifically.
- **Transport:** same as every other agent in this repo — Twilio conference →
  SIP → `sip.api.openai.com`, one OpenAI Realtime session as ear+brain+mouth
  (per `/CLAUDE.md`'s architecture note; this repo has no separate STT/TTS
  stage for any agent, DRS included).
- **Model / agent:** `RealtimeAgent` built by `createDRSSchedulerAgent`
  (`src/agents/drsSchedulerAgent.ts:86-207`), voice `sage`, instructions
  computed once per call from `SYSTEM_PROMPT_TEMPLATE` plus a Pacific-time
  context string and (if present) campaign-context text.
- **Tools actually attached in production wiring:** `lookup_patient`,
  `mark_contact_completed` only (see §6 for why the other two are absent).
- **VAD / transcription / barge-in / retry / loop guards:** nothing
  DRS-specific was found; whatever fleet-wide defaults `voiceAgentRoutes.ts`
  applies to every SIP session apply here too, but none of the DRS-specific
  guard modules (`identityArgGuard`, `conversationLoopGuard` AGENT_EXIT
  entries, director) were found to reference `drs-scheduler` by name in the
  files read for this task — `AGENT_EXIT`'s `default` entry would be what
  applies (per `docs/BACKEND_HANDOFF.md`/`AGENT_ONBOARDING.md` pattern), not
  verified further here.
- **State:** entirely in-memory for the parts that matter most — see §11.

---

## 9. Current workflow ownership

| Step | Owner | Basis |
|---|---|---|
| Which patient | **Deterministic code**, but from an empty table | `campaign_contacts` row selected by `campaignId`/`contactId` query params on the outbound call URL; `CampaignAdapter.lookupPatient` (`src/db/agentAdapters.ts:15-43`) |
| Eligibility | **Absent** | No code path computes this (§2) |
| Next question | **LLM / prompt** | `SYSTEM_PROMPT_TEMPLATE`'s "CALL FLOW" steps 1-7 (`src/agents/drsSchedulerAgent.ts:25-83`); no state machine |
| When to fetch availability | **LLM / prompt** | Model decides when to call `schedule_patient_in_phreesia`; no gate |
| Which slots offered | **Deterministic code, but degenerate** | Playwright's `selectDateTime` clicks the first enabled slot on the page (`computerUseAgent.ts:318`) — not model-chosen, not patient-preference-filtered beyond location |
| Which slot selected | Same as above | same |
| When booking runs | **LLM / prompt** | Model calls the tool when it judges "I have all your information" |
| Did booking succeed | **Tool-service, but unvalidated** | `PhreesiaFormResult.success` from a try/catch around the whole Playwright sequence (`computerUseAgent.ts:150-174`) — success is "no exception thrown," not a confirmed-booking check |
| When call ends | **LLM / prompt** | No `terminate_call` tool exists on this agent (only `lookup_patient`/`mark_contact_completed`/Phreesia tools were coded — no explicit call-ending tool was found in `drsSchedulerAgent.ts`); ending is presumably whatever the Realtime session/Twilio does when the model stops responding — not confirmed further here |

The pattern matches `docs/voice-shadow-architecture/02-current-state-audit.md`'s
fleet-wide finding: *"Voice model doubling as workflow engine? Yes — for every
agent except azul."* DRS has no exception to that rule; if anything it has
less server-side structure than the inbound queue agents, which at least gate
ticket creation on required fields.

---

## 10. Retry / loop behavior

| Retry class | Classification | Evidence |
|---|---|---|
| Identity retry | Absent | No verification step to retry (§4) |
| DOB retry | Prompted only | Prompt says "confirm date of birth"; no code checks or re-asks it |
| Patient lookup retry | Absent | `lookup_patient` throws on miss (`drsSchedulerAgent.ts:117-119`); no retry wrapper found |
| Availability retry | Hard-coded, narrow | `selectDateTime` clicks "Next Week" exactly once if zero slots are visible, then throws if still none (`computerUseAgent.ts:311-329`) |
| Slot-selection retry | Absent | First enabled slot only, no re-selection logic |
| Booking retry | Absent | Single attempt per `schedule_patient_in_phreesia` call; a failure returns the fallback-link message, no automatic re-attempt |
| Tool retry | Absent (agent-level) | No retry wrapper around any DRS tool `execute` found |
| Silence / no-answer retry | Hard-coded, but at the campaign layer, not in-call | `campaign_contacts.attempts`/`maxAttempts`/`nextAttemptAt` exist and `CampaignExecutor.executeCampaign` filters on `attempts < retryAttempts` (`campaignExecutor.ts:61`, default 3) — this governs whether a *future* call is placed, not anything inside a live call |
| Transcription retry | Absent (DRS-specific) | Nothing found beyond whatever fleet-wide Realtime defaults apply |
| Repeated-question protection | Absent (DRS-specific) | No `conversationLoopGuard` reference to `drs-scheduler` found in the files read |
| OTP retry | Hard-coded, bounded by timeout only | `workflowManager.requestOTP` rejects via a single `setTimeout` at `PHREESIA_CONFIG.otpTimeoutMs` (90s) with no retry of the SMS itself (`schedulingWorkflowManager.ts:141-165`); `otpAttempts` is incremented and stored but nothing reads it to cap retries |

---

## 11. Data / state — durable vs in-memory

| State | Durable (DB) | In-memory only |
|---|---|---|
| Campaign / contact records | Yes — `campaigns`, `campaign_contacts` (Operations Hub, Drizzle) | — |
| Active call metadata (ids, conference name) | Partially — `callSessionService.upsertSession` dual-writes to Postgres for conference/session lookup | Legacy `callMetadata`/`callIDtoConferenceNameMapping` maps in `voiceAgentRoutes.ts` are process-local |
| Scheduling workflow (status, step, OTP flags, screenshots) | Yes — `scheduling_workflows` table, written by `storage.updateSchedulingWorkflow` at every step | Mirrored into `SchedulingWorkflowManager.activeWorkflows: Map` (`schedulingWorkflowManager.ts:40`) — **lost on process restart** |
| **The pending OTP promise itself** | **No** | `otpPromises: Map<workflowId, {resolve,reject,timeout}>` (`schedulingWorkflowManager.ts:41`) — a live JS `Promise` cannot survive a restart; if the process restarts between `schedule_patient_in_phreesia` starting and the patient reading back the OTP, `submit_otp_code` will find no pending promise (returns "No active scheduling session found," `phreesiaSchedulingTool.ts:117-119`) even though the DB row still says `otp_requested` |
| `activeWorkflowsByCall` (workflowId lookup keyed by callLogId) | No | Plain `Map` in `phreesiaSchedulingTool.ts:15` — same restart-loses-it risk, and this is exactly the map that gates whether `submit_otp_code` can find its workflow at all |
| Transcript | Partially | `callTranscripts.get(callId)` array referenced for ticket context (`voiceAgentRoutes.ts:2565`) — in-memory per the fleet-wide pattern; not confirmed DB-persisted for this agent specifically in the files read |
| Booking result / confirmation number | Yes, once written | `scheduling_workflows.phreesia_confirmation_number` / `phreesia_appointment_details` |
| Retry/attempt counters | Yes | `campaign_contacts.attempts`; `scheduling_workflows.otp_attempts` |

---

## 12. Testing

**No test coverage exists for any part of this agent.** Confirmed by:
`find` for any file matching `*drs*test*` under the repo returns nothing, and
grepping every `.test.ts` file under `src/` for `drsSchedulerAgent` or
`createDRSSchedulerAgent` returns nothing. `src/shadow/` (the observation-only
replay/shadow system) *lists* `drs-scheduler` in its agent/tool catalogs
(`src/shadow/toolSimulator.ts:58-62`, `src/shadow/workflows.ts:175-180`,
`src/shadow/callLogReplay.ts:32`, `src/shadow/reasoning.ts:104`) — it knows the
tool names (`lookup_patient`, `mark_contact_completed`, `phreesia_schedule`,
`submit_otp`) and marks the Phreesia/OTP tools `mutating: true`,
`confirmationRequired: true`, `replayable: false` — but this is
configuration for a simulator, not a test exercising the real code path.

There is no sandbox/test Phreesia appointment type referenced anywhere, and no
mechanism found to create-then-clean-up a test booking. `PHREESIA_CONFIG.schedulingUrl`
(`src/config/phreesiaConfig.ts:2`) points at the **live** production Phreesia
form (`https://phreesia.me/AzulVisionDRS`) with no separate test/staging URL
in config — running the Playwright path today would hit production Phreesia.

**Actually running the suite (2026-08-23, after `npm install` — `node_modules`
was not present until this session installed it):**
- `npx vitest run`: **127 of 128 test files passed; 2,114 of 2,114 collected
  tests passed** (0 failing tests). The one failing *file* is
  `src/services/p0Hardening.test.ts`, which fails at import/setup with
  `Environment configuration invalid: DATABASE_URL: Required` — this is the
  same pre-existing, documented failure named in
  `docs/observatory/STATE-OF-PLAY.md` ("`p0Hardening.test.ts` fails to import
  without `DATABASE_URL`"), not a regression and not DR-related.
- `npx tsc -p . --noEmit`: **clean, zero output, zero errors.**
- No test in either run touches `drsSchedulerAgent.ts`, `phreesiaSchedulingTool.ts`,
  `computerUseAgent.ts`, or `schedulingWorkflowManager.ts` — their absence from
  the failing-file list is absence of coverage, not a passing grade.

---

## 13. Production topology

- **Repo:** this repo (`openai-realtime-api-voice-assistant-remix` on GitHub,
  per `docs/rebuild/README.md`'s allowed-repos list and this session's own
  checkout). **Branch:** `claude/dr-screening-discovery-3qo5r1`, HEAD
  `ba632db4` — identical to `origin/main` at time of writing (no divergence).
- **Git history caveat:** both `src/agents/drsSchedulerAgent.ts` and
  `src/tools/phreesiaSchedulingTool.ts` show exactly **one** commit each in
  `git log --follow`: `64da94c`, titled *"Surgery routing: the surgeon was
  carried by an optional argument (#215)"* — a commit message about unrelated
  surgery-ticket work. This means the two files' true incremental history is
  not visible through this repo's git log (most likely a squash/rewrite
  somewhere upstream of this checkout); do not infer a development timeline
  for DRS from `git log`.
- **Deployment host/process:** Replit VM deployment
  (`.replit:13-17`, `deploymentTarget = "vm"`). Start command:
  `npx tsx server/index.ts & npx tsx src/server.ts & wait` — two Express
  processes in parallel (API server port 5000, Voice Agent server port 8000,
  per `docs/PRODUCTION_SETUP.md` and `.replit:19-25`). Build step:
  `npx tsc --noEmit && npm --prefix client install && npm --prefix client run build`.
  Production domain: `openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app`
  (`.replit:104-107`).
- **Telephony webhook target (outbound, the only kind DRS uses):**
  `/api/voice/test/incoming` (`src/voiceAgentRoutes.ts:5439`), invoked by
  `CampaignExecutor.makeOutboundCall` with `agentSlug=drs-scheduler`. No
  inbound Twilio number is assigned to `drs-scheduler`
  (`src/config/agents.ts:196-203`, `twilioNumbers` omitted — outbound agents
  use whatever `getTwilioFromPhoneNumber()` resolves to as caller ID, not a
  dedicated assigned number in this registry).
  **Caveat on `twilio-inventory.md`:** this file is dated 2026-02-06 (over six
  months stale relative to 2026-08-23) and lists Twilio resources literally
  named *"5 Star DRS Sreening"* (a TwiML app and a Messaging Service, numbers
  `+16266998484` / `+16263821543`) — these route to a **different** Replit app
  (`3c312638-...janeway.replit.dev`) and belong to the unrelated **5Star /
  SAGE** platform (`docs/observatory` project `ttbypvstnnfcvmwbgqyy`), not to
  this repo's `drs-scheduler` agent. Do not conflate the two "DRS" names when
  reading that inventory file.
- **Env var names** (values never read/logged here): from
  `src/config/environment.ts:5-51` — required in production:
  `DATABASE_URL`, `DOMAIN`, `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`,
  `OPENAI_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. Optional/
  shared: `APP_ENV`, `SESSION_SECRET`, `TICKETING_API_KEY`,
  `TICKETING_SYSTEM_URL`, `TICKETING_ENRICHMENT_URL`, `HUMAN_AGENT_NUMBER`,
  `PCP_HUMAN_AGENT_NUMBER`, `PCP_AGENT_DIDS`, `PCP_ROUTING_MODE`,
  `TWILIO_PHONE_NUMBER`, `URGENT_NOTIFICATION_NUMBER`,
  `VOICE_AGENT_WEBHOOK_SECRET`, `DISABLE_PHI_LOGGING`, `SUPABASE_SERVICE_KEY`,
  `SUPABASE_REST_URL`, `SUPABASE_POOLER_URL`, `SUPABASE_URL`. Additional names
  set directly in `.replit` (`[userenv.shared]`, not secrets):
  `SHADOW_MODE_ENABLED`, `SHADOW_AGENT_ALLOWLIST` (includes `drs-scheduler`,
  100% capture per `SHADOW_CAPTURE_PCT`), `SHADOW_MODEL_ROUTING_ENABLED`,
  `DIRECTOR_AGENTS`. **No `PHREESIA_*` env var exists** — the Phreesia URL,
  visit type, OTP timeouts, and location list are all hard-coded in
  `src/config/phreesiaConfig.ts`, not environment-driven.
- **External services:** Twilio (calls), OpenAI Realtime API (SIP session),
  Phreesia (`phreesia.me/AzulVisionDRS`, live production form, driven by
  Playwright/Chromium — `playwright: ^1.52.0` in `package.json:58`).
- **DB projects:** Operations Hub `pslzngjciiifowemrzza` (campaigns, scheduling
  workflows, agents — all Drizzle-managed tables this agent actually touches).
  Patient-Console `kbbmywvasbsxnbblrhot` is **not touched by this agent** —
  confirmed no import of anything under a Patient-Console-facing service in
  `drsSchedulerAgent.ts`'s dependency chain.
- **Current production commit:** not determinable for DRS specifically.
  `docs/BACKEND_HANDOFF.md` and `docs/PRODUCTION_SETUP.md` document the
  ticket-path/deployment process in general but name no DRS-specific deployed
  commit, and (per the git-history caveat above) DRS's own file history gives
  no usable timeline either.

---

## Conflicts / Unknowns

- **What actually populates `HEDIS_CMS131_DiabeticRetinalExam` and keeps its
  `synced_at` current.** No code in this repo does it; the sync job (if any)
  lives outside this repository's scope entirely.
- **Whether `HEDIS_CMS131_DiabeticRetinalExam` is *intended* as the DR
  eligibility/gap-list source**, or is a separate reporting artifact with no
  planned connection to the calling agent. Nothing in code or docs states an
  intent either way — this is squarely a "don't fill the gap, ask" item per
  `/CLAUDE.md` standing instruction #1.
- **Whether `drs_slots` is intended to back availability for this agent**, or
  is scaffolding left over from a different, unbuilt integration. Same status
  as above — table exists, is empty, is unreferenced by any code found.
- **Where the true Phreesia-form CSS selectors currently stand** relative to
  the live site — `computerUseAgent.ts`'s selectors (`selectPatientType`,
  `selectLocation`, `fillPatientInfo`, etc.) have never run against the site
  from within a test, so whether they still match the live Phreesia DOM is
  unverified either way.
- **Whether any campaign has ever been run from a different, unreviewed entry
  point** (e.g. directly via SQL insert into `campaigns`/`campaign_contacts`
  rather than through this repo's admin UI). This document can only speak to
  what the reviewed code does; the DB state (0 rows in both tables at time of
  writing) is consistent with "never run," not proof no attempt was ever made
  through a path outside this repo.
- **Whether the "5 Star DRS Screening" Twilio resources in `twilio-inventory.md`
  have any bearing on Azul Vision's actual DR outreach** (e.g., whether 5Star/
  SAGE runs its own, separate diabetic-retinopathy outreach that this document
  should be aware of as a parallel effort). Out of scope for this repo;
  flagged here only so it is not mistaken for this agent's infrastructure.
- **Whether `terminate_call` or any explicit call-ending tool exists for
  `drs-scheduler`** — none was found in `drsSchedulerAgent.ts`'s tool list, but
  this document did not trace the full Twilio-side call-teardown path for
  outbound calls to confirm what ends the call when the model stops talking.
