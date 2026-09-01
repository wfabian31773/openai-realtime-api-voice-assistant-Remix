# 03 — Change-impact map

Read-only survey, 2026-09-01. What each frequently-edited file is wired to, how
many queues a change to it moves, and which catch site turns its failure into a
value that reads like a normal answer.

Departments referenced throughout: **1 Optical**, **2 Surgery Coordination**,
**3 Clinical Tech Support**, **8 After Hours Call Service**, **9 HVA Hub**,
**16 Medical Records**.

Databases referenced: **OPSHUB** = Operations Hub Supabase
`pslzngjciiifowemrzza` (reached over `DATABASE_URL`/`SUPABASE_POOLER_URL` via
`server/db.ts:19`), **CONSOLE** = Patient-Console `kbbmywvasbsxnbblrhot`
(reached over `OBS_CONSOLE_DATABASE_URL`, read-only pool,
`src/services/consoleDirectory.ts:67`), **SUPPORT** = Support Center
`vsmcxhxeirkoobmjcrbn` (never reached by SQL from this repo — only over HTTP
through `TICKETING_SYSTEM_URL`, which today is the n8n gateway).

---

## The live chain, proved once

Everything below that says "live call path" hangs off this chain. It is traced,
not assumed.

```
server/productionServer.ts:71   setupVoiceAgentRoutes(app)
  └─ src/voiceAgentRoutes.ts:5058  setupVoiceAgentRoutes
       └─ :6132  function registerOverflowLine({path, slug, tag, greeting})
            ├─ :6248  /api/voice/answering-service   slug 'answering-service'
            ├─ :6258  /api/voice/optical             slug 'optical'
            ├─ :6270  /api/voice/surgery             slug 'surgery'
            ├─ :6281  /api/voice/tech                slug 'tech'
            └─ :6293  /api/voice/records             slug 'records'
       └─ :6161-6175  caller joined to conf_<CallSid>, maps stamped
       └─ :6231       SIP participant dialed with X-agentSlug=<slug>
  └─ src/voiceAgentRoutes.ts:5071  POST /api/voice/realtime  (OpenAI SIP webhook)
       └─ :5208-5212  reads the X-agentSlug header
       └─ :2281       observeCall(...)
            ├─ :2298  validAgentSlugs allow-list (optical/surgery/tech/records present)
            ├─ :2331  agentRegistry.getAgentConfig(slug)   → src/config/agents.ts:255
            ├─ :2335  agentRegistry.getAgentFactory(slug)  → src/config/agents.ts:250
            └─ :2748 / :2789 / :2829 / :2868  per-slug factory call
                 └─ src/agents/opticalAgent.ts:249 createOpticalAgent
                      └─ :264 realtimeToolsFor(OPTICAL_TOOLS, ctx, telemetry)
                           └─ src/tools/realtimeAdapter.ts:42
                                └─ :152 runTool(name, {...context, ...supplied})
                                     └─ src/tools/registry.ts:162
                                          └─ src/tools/opticalTools.ts:99 handler
```

Second, independent entry point into the *same* registry:

```
server/index.ts:430  mountToolServer(app)
  └─ src/tools/server.ts:46
       ├─ :53  GET  /api/tools           → manifest()
       └─ :61  POST /api/tools/:name     → runTool(name, body)   (auth: VOICE_TOOL_API_KEY, fails closed :38-43)
```

Third entry point, mounted but **carrying no traffic** — no Twilio number points
at `/voice/:slug` (`server/index.ts:401-424`):

```
server/index.ts:405  mountVoiceRuntime(app, earlyServer, {...})
  └─ src/runtime/voiceRuntime.ts:53  resolveLane
       └─ src/runtime/laneRegistry.ts:259
            ├─ :278 source.getAgentConfig(slug)  (src/config/agents.ts via :347)
            ├─ :306 factory(handoff, metadata)
            └─ :309 bindAgent(agent, {instructionsPrefix: buildKnowledgePack()})
                 └─ src/runtime/agentBinding.ts:218
```

---

# Per-file entries

## 1. `src/tools/sharedPatientTools.ts` (408 lines)

**Responsible for** registering the three tools every queue calls before it
files anything — `lookup_patient` (:64), `resolve_location` (:211),
`check_open_tickets` (:325) — plus the `str` / `isTwilioCallSid` /
`normalizePhone` helpers (:356, :368, :375) that the four filing tools import.

**Who imports it**

| group | site |
|---|---|
| live call path (named import ⇒ also the registration side effect) | `src/tools/opticalTools.ts:19`, `src/tools/surgeryTools.ts:30`, `src/tools/techTools.ts:30`, `src/tools/medicalRecordsTools.ts:34` |
| live call path (bare side-effect import) | `src/agents/surgeryAgent.ts:55`, `src/agents/techAgent.ts:40`, `src/agents/recordsAgent.ts:35` |
| live call path (transitive only) | `src/agents/opticalAgent.ts:41` imports `../tools/opticalTools`, which pulls this in at its line 19. Optical never names this module. |
| runtime / other | `src/agents/runtimeProofAgent.ts:23`; HTTP surface `src/tools/server.ts:30` |
| tests | `sharedPatientTools.test.ts:48`, `surgeryTools.test.ts:19`, `techTools.test.ts:11`, `medicalRecordsTools.test.ts:11`, `lookupFallback.test.ts:19`, `realtimeAdapter.test.ts:26`, `src/agents/agentWiring.test.ts:277` |
| dead | none |

**Queues affected: 4 — optical, surgery, tech AND records, simultaneously.**
Plus the `runtime-proof` lane and the `/api/tools/:name` HTTP surface. Every one
of `OPTICAL_TOOLS` (`opticalAgent.ts:83`), `SURGERY_TOOLS`
(`surgeryAgent.ts:97`), `TECH_TOOLS` (`techAgent.ts:72`) and `RECORDS_TOOLS`
(`recordsAgent.ts:66`) lists these same three names first. A one-character
change to `lookup_patient`'s return shape lands on all four lines on the next
deploy with no per-queue gate anywhere.

Note the asymmetry the `queue` context carries: `ToolQueue` is typed
`'optical' | 'surgery'` only (:34). `techAgent.ts:263` and `recordsAgent.ts:281`
inject **no** `queue`, so tech and records take the neutral branch —
`acceptsFacility` returns `true` for every facility kind (:47), `facilityWord`
returns `'office'` (:51), `askWhichOffice` returns the generic line (:59). Tech
and records will therefore accept a surgery centre as a usual office; optical
will not (:43).

**What it reads that it does not own**

- `input.queue`, `input.caller_phone` — injected by `realtimeAdapter.ts:152`,
  merged *under* the model's args. Not in any schema (asserted by
  `sharedPatientTools.test.ts:294`).
- `scheduleLookupService.lookupPatient` (:113, :131) → OPSHUB `Schedule`.
- `consoleDirectory.lookupLocation` / `isDirectoryConfigured` (:236, :393) →
  CONSOLE `si_locations`, gated on `OBS_CONSOLE_DATABASE_URL`.
- `ticketFieldSanitizers.sanitizeLocationName` (:230).
- `SyncAgentService.checkOpenTickets` (:342) → OPSHUB `call_logs` via
  `server/storage.ts:693`.

**What silently swallows its errors**

- `src/services/scheduleLookupService.ts:477`, `:506`, `:551` — each catch
  returns `this.emptyContext()`. `patientFound:false` reaches
  `sharedPatientTools.ts:138-146`, which answers `{success:true, found:false,
  message:'No record found. They may be new…'}`. **A dead OPSHUB pool and a
  genuine stranger produce the identical sentence.** The only difference is a
  `console.error('[ScheduleLookup] Error looking up by …')` line.
- `src/tools/sharedPatientTools.ts:403-405` — `mostRecentAcceptable`'s own
  `catch { return locations[0] }`. If the directory throws, the first (most
  recent) visit location is returned regardless of facility kind — the exact
  optical/surgery-centre confusion the function exists to prevent (:154-164).
- `src/services/consoleDirectory.ts:301-304` — a refresh failure returns the
  previous snapshot, or `null` if none was ever loaded. A `null` snapshot makes
  `lookupLocation` return `null` (:320-324), which reaches
  `sharedPatientTools.ts:243-278` and produces the refusal *"I'm not finding an
  office by that name"* — indistinguishable from a caller naming an office we
  really do not have.
- `src/services/syncAgentService.ts:500-502` — `catch → return []` ⇒
  `has_open_tickets:false`.
- `src/tools/registry.ts:182-185` wraps all three handlers: anything thrown
  becomes `{success:false, error, retryable:true}`.

**Tests that would catch a regression** — `src/tools/sharedPatientTools.test.ts`
(23 cases; caller-phone fallback :74, non-mutation of the service's object :107,
queue-shaped office :146, refusal envelopes :116/:201, `queue` never in a schema
:294, every field has an `askAs` :303); `src/tools/lookupFallback.test.ts` (6);
`src/tools/registry.test.ts:209-256`;
`src/tools/opticalTools.production.test.ts:116-186`.

**What they would NOT catch** — every service is stubbed at the module boundary
(`sharedPatientTools.test.ts:35-45`), so no test distinguishes a thrown DB error
from a legitimate miss, and none asserts the log line that would tell them
apart. Nothing exercises the tech or records neutral-`queue` branch. Nothing
covers two calls racing the same directory snapshot. Nothing asserts what
`identity_is_certain:false` (:172) does to a live prompt.

---

## 2. `src/tools/registry.ts` (186 lines)

**Responsible for** the single module-level tool table and the contract around
it: `registerTool`/`getTool`/`allTools`/`manifest`, the `missing()` refusal
envelope, shallow `validateInput`, and `runTool`'s per-tool timeout.

**Who imports it**

| group | site |
|---|---|
| live call path | `sharedPatientTools.ts:31`, `opticalTools.ts:15`, `surgeryTools.ts:29`, `techTools.ts:29`, `medicalRecordsTools.ts:33`, `realtimeAdapter.ts:15` |
| live call path (PCP, records-via-library) | `src/agents/pcpAgent.ts:726` (`getTool`) |
| runtime / HTTP | `src/tools/server.ts:16`, `src/tools/generalServiceTools.ts:15`, `src/tools/handoffBroker.ts:22` |
| tests | `registry.test.ts:19`, `surgeryTools.test.ts:18`, `techTools.test.ts:10`, `medicalRecordsTools.test.ts:10`, `lookupFallback.test.ts:18`, `generalServiceTools.test.ts:9`, `opticalTools.production.test.ts:103`, `sharedPatientTools.test.ts:47`, `src/agents/opticalAgent.test.ts:16`, `src/agents/agentWiring.test.ts:280`, `src/pcp/recordsViaLibrary.test.ts:36` |
| dead | none |

**Queues affected: 4 (optical, surgery, tech, records) plus PCP's records path,
the runtime-proof lane, and both HTTP surfaces.** There is exactly one
`Map` (:88) and it is process-global; every tool on every line runs through
`runTool` at :162.

**What it reads that it does not own** — nothing external. No env, no DB, no
network. Its state is entirely `const registry = new Map()` at :88.

**What silently swallows its errors**

- `:182-185` — the universal handler catch. Everything a tool throws becomes
  `{success:false, error: e.message, retryable:true}`. This is why a thrown
  ticket-filing bug reaches the caller as *"having trouble"* and never as a
  stack anywhere but stdout.
- `:173-181` — the timeout is a `Promise.race`, **not a cancellation**. When a
  30 s `file_*_ticket` overruns, the agent is handed `{error:'<name> timed out',
  retryable:true}` while the handler keeps running and can still POST
  create-ticket. That is the documented reason `surgeryTools.ts:331-333` carries
  its own `RESOLVE_BUDGET_MS = 10_000`; the other three filing tools have no
  equivalent budget.
- `:91-94` — `registerTool` **throws** on a duplicate name. That is not a
  swallow, but it is an import-time throw, so it fails whichever module is
  imported second, i.e. it takes down process boot rather than one call.
- `:139-159` — `validateInput` is required-and-non-empty only, by design
  (:132-138). A `request_reason_id` of `"abc"` passes validation, `Number()`s to
  `NaN` at `opticalTools.ts:145` / `surgeryTools.ts:181` / `techTools.ts:157` /
  `medicalRecordsTools.ts:234`, and falls through to the text classifier with no
  log.

**Tests** — `src/tools/registry.test.ts` (26 cases: refusal fields :38, blank vs
missing :60, handler never runs when a required field is absent :78, thrown →
retryable :98, declared timeout honoured :111, duplicate name refused :153,
manifest hides primitives :133).

**Would NOT catch** — that the raced handler is still in flight after the
timeout resolves; that a duplicate registration crashes at boot rather than at
call time; coercion of a non-numeric `request_reason_id`; anything about
concurrency (the Map is never asserted under parallel `registerTool`).

---

## 3. `src/tools/realtimeAdapter.ts` (236 lines)

**Responsible for** converting registry entries into `@openai/agents/realtime`
tool objects, merging call context under the model's arguments, and recording
plus per-call flushing of the tool timeline.

**Who imports it**

| group | site |
|---|---|
| live call path | `src/agents/opticalAgent.ts:39`, `src/agents/surgeryAgent.ts:51`, `src/agents/techAgent.ts:38`, `src/agents/recordsAgent.ts:33` |
| runtime | `src/agents/runtimeProofAgent.ts:21` |
| tests | `src/tools/realtimeAdapter.test.ts:28/133/151` |
| dead | none |

**Not** on the HTTP path — `src/tools/server.ts:100` calls `runTool` directly.
**Not** on the Grok runtime path — `agentBinding.ts:140-167` re-derives its own
wire schema from `agent.tools`, so `strict:false` (:126) and
`additionalProperties:false` (:121) set here do not travel there.

**Queues affected: 4 — optical, surgery, tech AND records — plus runtime-proof.**
This one `execute` closure (:130-187) is on every SIP-path tool call the queue
fleet makes. The two `console.info` lines at :150 and :159 are the only per-tool
in/out record those lines have.

**What it reads that it does not own**

- The `context` object each agent factory builds — `call_sid`, `caller_phone`,
  `dialed_number`, and for optical/surgery `queue`
  (`opticalAgent.ts:265-273`, `surgeryAgent.ts:370-378`).
- `telemetry.callLogId`, deliberately a **getter** (:212-214) because the
  `call_logs` row does not exist at agent-construction time
  (`opticalAgent.ts:282`).
- `toolTimeline.recordingExecute` and `flushAzulTimeline` (:16).

**What silently swallows its errors**

- `:228-235` `flushTimelineSafely` — `catch → console.warn('[TOOLS] timeline
  flush failed (call unaffected)')`. A persistently failing flush leaves
  `tool_timeline` and `tool_call_count` null on the call row, which reads
  downstream as *"the agent called no tools"*.
- `src/services/toolTimeline.ts:344-346` — `recordingExecute` catches its own
  record failure and `console.error`s; the tool result is returned unchanged.
- `src/services/toolTimeline.ts:591-593` — `flushAzulTimeline`'s outer catch,
  `console.error('[AZUL-TIMELINE] Flush failed')`.
- `src/services/toolTimeline.ts:533` — `catch { /* optional */ }` around the
  A/B-arm read.
- `:178-186` is the exception: it logs `[TOOLS] ✗ … threw` and **rethrows**, so
  an adapter defect surfaces to the SDK rather than being absorbed.
- The dangerous *non*-catch: if `strict:false` (:126) or the registry-schema
  passthrough (:117-122) regresses, the SDK rejects the arguments **before**
  `execute` runs — no handler, no log line, no timeline event. That is the
  2026-08-12 surgery failure recorded at :96-116, and nothing in this file can
  observe it.

**Tests** — `src/tools/realtimeAdapter.test.ts` (7: flush after return :58,
callSid fallback :71, no flush without a call :77, telemetry failure never
reaches the call :84, exact live arguments reach the handler :114, only the
tool's real required list is enforced :149).

**Would NOT catch** — the SDK's own validation, because the options object is
cast at :188 and `tool()` is not exercised against a real session; concurrent
flushes of the same call key; a wrong `queue` injected by an agent (no model
argument can override it, and no test asserts per-agent context).

---

## 4. `src/tools/opticalTools.ts` (410 lines)

**Responsible for** department 1's two tools — `classify_optical_request` (:23)
and `file_optical_ticket` (:71), the only filing tool for which **location is a
hard gate**.

**Who imports it**

| group | site |
|---|---|
| live call path | `src/agents/opticalAgent.ts:41` (bare, for the registration side effect — and it is what pulls `sharedPatientTools` in for that lane) |
| runtime | `src/agents/runtimeProofAgent.ts:24` |
| HTTP | `src/tools/server.ts:31` |
| tests | `opticalTools.production.test.ts:104`, `registry.test.ts:22`, `src/agents/agentWiring.test.ts:278` |
| dead | none |

**Queues affected: 1 home queue, 4 destination departments.** It files into
dept 1 by default, and `detectCrossQueue` (:327) can redirect it into **9 (HVA
Hub)**, **2 (Surgery)** or **3 (Tech)** — `queueRouting.ts:246`, `:317`, `:329`.
It cannot redirect into 16.

**What it reads that it does not own**

`./opticalTaxonomy` (:44, :137 — `OPTICAL_DEPARTMENT_ID`, `classifyOptical`,
`classificationByReasonId`); `../services/gsm7` (:157); `../services/
ticketFieldSanitizers` (:163); `../../server/services/ticketingApiClient`
(:172); `./dobParts` (:173); `./otherReason` (:302); `./queueRouting` (:327).
Through `ticketingApiClient` it reads `TICKETING_SYSTEM_URL`,
`TICKETING_API_KEY`, `TICKETING_ENRICHMENT_URL`
(`src/config/environment.ts:259-263`) and writes to **SUPPORT** via
`POST /api/voice-agent/create-ticket`.

**What silently swallows its errors**

- **`server/services/ticketingApiClient.ts:1001-1008`** — `lookupProviderAndLocation`
  catches and returns `{success:false, error}`. A no-match returns
  `{success:true, locationId:null}`. Reading only `locationId` collapses the
  two. `opticalTools.ts:208` (`const lookupRan = lookup.success !== false`) is
  the single line separating them, and `:210` vs `:265` are the two different
  behaviours it selects. Deleting that line reproduces 2026-08-31 exactly:
  43 callers told their real office does not exist (:198-206).
- `server/services/ticketingApiClient.ts:662-668` — `createTicket`'s catch
  returns `{success:false, error}`; `opticalTools.ts:381-387` turns it into a
  retryable tool failure. The n8n gateway answering 200 with a non-JSON body
  arrives here as `Invalid JSON response` thrown at `ticketingApiClient.ts:507`.
- `server/services/ticketingApiClient.ts:636-640` — the `call_logs.ticket_number`
  writeback is `void`-ed with a `.catch(console.warn)`. A ticket can exist in
  SUPPORT while `call_logs.ticket_number` stays null; the graders read the
  latter.
- `src/services/gsm7.ts` via `:158` and the sanitizers via `:166-167` return
  values, never throw — a dropped provider name (`ticketFieldSanitizers.ts:110`,
  `:113`) leaves `cleanProvider` empty with only a `[TICKET-FIELDS]` info line.

**Tests** — `src/tools/opticalTools.production.test.ts` (22 cases against a
real-patient fixture: no surgery centre handed to optical :117, ticketing app's
location name not the mirror's :138/:176, numeric `locationId` sent :252,
phone-digit floor and ceiling :279/:306/:328/:351, never `submit-ticket`
:376/:435, refuses without an office :462, **and :528 "does not tell the caller
their real office does not exist when the lookup service is down"** — the guard
for `lookupRan`).

**Would NOT catch** — nothing measures dept-1 location/assignment fill in
production before and after a change; the raised-priority signal for an
unrouted ticket (:338) is asserted nowhere against a real queue view; the
`detectCrossQueue` interaction is only tested against the pure function
(`queueRouting.test.ts:222-235`), never through `file_optical_ticket`; the
`otherReason` table (:302) is checked against the live database only by the
`otherReasonsMatchDatabase` test named in `otherReason.ts:36-41`.

---

## 5. `src/tools/surgeryTools.ts` (533 lines)

**Responsible for** department 2's `classify_surgery_request` (:34) and
`file_surgery_ticket` (:98), including the three-rung surgeon-resolution ladder
(:309-403).

**Who imports it**

| group | site |
|---|---|
| live call path | `src/agents/surgeryAgent.ts:56` |
| runtime | `src/agents/runtimeProofAgent.ts:25` |
| HTTP | `src/tools/server.ts:32` |
| tests | `surgeryTools.test.ts:20`, `src/agents/agentWiring.test.ts:279` |
| dead | none |

**Queues affected: 1 home queue, 3 destination departments** (1, 3, 9 via
`detectCrossQueue` at :254 — surgery is excluded as a destination from itself,
and `queueRouting.ts:230` makes surgery the *exception* to the HVA-Hub rule).

**What it reads that it does not own** — `./surgeryTaxonomy` (:59, :175);
`../services/gsm7` (:200); `../services/ticketFieldSanitizers` (:206);
`../../server/services/ticketingApiClient` (:212); `./dobParts` (:213);
`./queueRouting` (:254); **`../services/scheduleLookupService` (:345)** — the
only filing tool that reads OPSHUB `Schedule` directly, via
`lookupByNameAndDOB(first, last, YYYY-MM-DD, {logIdentifiers:false})`,
deliberately *not* `lookupPatient` (:346-357: the phone fallback would attach a
spouse's clinician).

**What silently swallows its errors**

- `:386-389` — `catch (error) { console.warn('[surgery] provider lookup from
  schedule failed:', error) }`. A thrown ladder leaves `lookup.providerId`
  undefined and the ticket files unassigned; nothing in the tool result says the
  ladder ran and failed as opposed to the record being empty.
- `server/services/ticketingApiClient.ts:1001-1008` again — and here the
  `{success:false}` collapse is **not** guarded the way optical guards it. The
  only signal is `:400-405`, a `console.error('[surgery] ✗ SURGEON DID NOT
  RESOLVE')` that fires for both a down lookup and a genuinely unknown surgeon.
  The comment at :394-399 records that this is what left 66 unrouted tickets
  with no trace but the null column.
- `src/services/scheduleLookupService.ts:551-554` — the DOB lookup's own catch
  returns `emptyContext()`, so `ctx.patientFound` is false and the ladder is
  skipped at :364 with no distinct log.
- `:331-341` `RESOLVE_BUDGET_MS` exists because `registry.ts:173` races rather
  than cancels; when the budget is spent the only record is
  `console.warn('[surgery] provider ladder stopped — resolve budget spent')`
  at :371.
- `server/services/ticketingApiClient.ts:662-668` for the create;
  `:636-640` for the writeback.

**Tests** — `src/tools/surgeryTools.test.ts` (33 cases: phone digits
:42/:56/:71/:90, never `submit-ticket` :112, reason-earned filing :150-235,
urgent and post-op priority :256/:270, files **without** a location unlike
optical :298, the full ladder :384-548, redirected ticket carries no surgeon
:587, **budget stops the ladder :621**).

**Would NOT catch** — dept-2 provider-fill measured in production (the exact
number `docs/BACKEND_HANDOFF.md` says went 98% → 49%); the ladder's behaviour
when the ticketing lookup is *down* rather than *empty* (all ladder tests stub
`lookupProviderAndLocation` returning `{success:true, …}` shapes); the
interaction between the 30 s tool timeout and the 15 s per-`/lookup` bound when
three rungs run.

---

## 6. `src/tools/techTools.ts` (307 lines)

**Responsible for** department 3's `classify_tech_request` (:34) and
`file_tech_ticket` (:84) — the medication queue, largest in the practice.

**Who imports it**

| group | site |
|---|---|
| live call path | `src/agents/techAgent.ts:41` |
| runtime | `src/agents/runtimeProofAgent.ts:26` |
| HTTP | `src/tools/server.ts:33` |
| tests | `techTools.test.ts:12` |
| dead | none |

**Queues affected: 1 home queue, 3 destination departments** (1, 2, 9 via :227).
`queueRouting.ts:263` is the one place `TECH_CUES_STRONG` holds a call *against*
another queue's signal — a change to that list moves traffic between dept 3 and
dept 1 in both directions.

**What it reads that it does not own** — `./techTaxonomy` (:59, :151);
`../services/gsm7` (:177); `../services/ticketFieldSanitizers` (:183);
`../../server/services/ticketingApiClient` (:189); `./dobParts` (:190);
`./queueRouting` (:227). Hardcodes `cls.requestReasonId === 155` (glaucoma) as
the only high-priority trigger at :211.

**What silently swallows its errors**

- `server/services/ticketingApiClient.ts:1001-1008` — same `{success:false}`
  collapse, and **techTools does not check `lookup.success` at all** (:200-206
  reads only `providerId`/`locationId`). A down lookup and an unknown prescriber
  both produce a ticket with `provider_id: null` and the note at :298.
- `server/services/ticketingApiClient.ts:662-668` → `:274-276` retryable
  failure.
- `server/services/ticketingApiClient.ts:636-640` writeback.
- The `note` at :298 is suppressed whenever `redirect` is truthy, so a
  redirected medication call reports no missing prescriber even when there is
  none.

**Tests** — `src/tools/techTools.test.ts` (22: phone digits :38-93, never
`submit-ticket` :95, reason table :123, cannot take another department's reason
:131, catch-all is 542 not 153 :145, medication/pharmacy on their own lines
:156, prescriber note :174/:186, glaucoma priority :207).

**Would NOT catch** — that `lookup.success` is unread; dept-3 provider-fill in
production; the volume consequence of any `TECH_CUES_STRONG` edit (103
tickets/day pass through this cue list).

---

## 7. `src/tools/medicalRecordsTools.ts` (391 lines)

**Responsible for** department 16's `classify_records_request` (:38) and
`file_records_ticket` (:91), including the HHS-OCR CAP gate — `requester` is
hard-required (:189-196) and `deliver_to`/`date_range` are required **only when
the clock applies** (:217-233).

**Who imports it**

| group | site |
|---|---|
| live call path | `src/agents/recordsAgent.ts:36` |
| live call path (PCP) | `src/agents/pcpAgent.ts:727` — dynamic `await import('../tools/medicalRecordsTools')` behind `getTool` at :726 |
| runtime | `src/agents/runtimeProofAgent.ts:27` |
| HTTP | `src/tools/server.ts:34` |
| tests | `medicalRecordsTools.test.ts:12`, `src/pcp/recordsViaLibrary.test.ts:37` |
| dead | none |

**Queues affected: 1 home queue + the PCP line, 3 destination departments**
(1, 2, 9 via :292 — `queueRouting.ts:212-216` makes 16 a home-only department:
`holdsOnRecordsLine` keeps a records request here against every subject-matter
cue, but scheduling still leaves for the Hub).

**What it reads that it does not own** — `./medicalRecordsTaxonomy` (:63, :177 —
`classifyRequester`, `determineCapClock`); `../services/gsm7` (:258);
`../services/ticketFieldSanitizers` (:264);
`../../server/services/ticketingApiClient` (:270); `./dobParts` (:271);
`./queueRouting` (:292). It sends four fields the receiving app may not read
yet — `requestorType`, `requestPathway`, `capClockApplies`, `requestorName`
(:345-355).

**What silently swallows its errors**

- `classifyRequester` returning null is coerced to `'other'` at :196 —
  an unparsed requester becomes a third-party classification with no log.
- `server/services/ticketingApiClient.ts:1001-1008` — same collapse,
  `lookup.success` unread (:278-284).
- `server/services/ticketingApiClient.ts:662-668` → `:362`.
- `server/services/ticketingApiClient.ts:636-640` writeback.
- The four CAP fields are additive-only: an endpoint that ignores them returns
  `success:true` and the tool reports `cap_clock_applies` back to the agent as
  though it had been stored (:377). Nothing in this repo can observe whether
  SUPPORT persisted them.

**Tests** — `src/tools/medicalRecordsTools.test.ts` (44 cases: only dept-16
reasons :116/:136, requester required :345, requester-type → clock table :372,
personal representative :392, gate on presence not quality :507, third party
**not** gated :524, clock line first in the body :427, unrecognised requester is
third-party not patient :442).

**Would NOT catch** — whether the CAP fields survive the n8n gateway; whether
`mr_cases` rows still default to `roa_patient`; the PCP path (`recordsViaLibrary.test.ts`
asserts only that the tool is reachable through `getTool`).

---

## 8. `src/tools/queueRouting.ts` (365 lines)

**Responsible for** `detectCrossQueue` (:245) — where a request filed on one
queue actually belongs — plus the exported cue tables `SCHEDULING` (:109),
`SPECIALIST_CUES` (:143) and the `fold` normaliser (:200).

**Who imports it**

| group | site |
|---|---|
| live call path — `detectCrossQueue` | `src/tools/opticalTools.ts:327`, `src/tools/surgeryTools.ts:254`, `src/tools/techTools.ts:227`, `src/tools/medicalRecordsTools.ts:292`, `src/agents/pcpAgent.ts:678` |
| live call path — via `createTicketTool` | `src/agents/tools/createTicketTool.ts:3` → imported by `src/tools/generalServiceTools.ts:16`, invoked at `:139` |
| live call path — `fold` | `src/tools/medicalRecordsTaxonomy.ts:58`, `src/tools/cueMatch.ts:28` (which is imported by `opticalTaxonomy.ts:31`, `surgeryTaxonomy.ts:62`, `techTaxonomy.ts:61`), `src/tools/afterHoursTaxonomy.ts:92` (reached from `src/agents/noIvrAgent.ts:1259`), `src/tools/afterHoursTriage.ts:65` (reached from `noIvrAgent.ts:16`) |
| dead | `src/tools/hubTaxonomy.ts:67` imports `fold`, `SCHEDULING`, `SPECIALIST_CUES` — but `hubTaxonomy` itself has no non-test importer |
| tests | `queueRouting.test.ts:14`, `hubTaxonomy.test.ts:20`, `src/pcp/patientCaller.test.ts:110/120/178` |

**Queues affected: all 4 queue agents, plus PCP, plus the no-IVR / after-hours
classifier through `fold`.** `detectCrossQueue` is called immediately before
every `createTicket` on optical, surgery, tech and records, and it can change
`departmentId`, `requestTypeId` and `requestReasonId` on any of them. A change
to `SCHEDULING` (:109) moves traffic into dept 9 from **five** lines at once. A
change to `fold` (:200) changes cue matching in **five taxonomies**
simultaneously, including the after-hours path.

**What it reads that it does not own** — nothing. Pure functions over strings;
no env, no DB, no imports at all. The department, type and reason ids at :246,
:317, :329, :341 are hardcoded SUPPORT rows.

**What silently swallows its errors** — nothing catches, because nothing throws.
The silent failure here is *shape*, not exception: `detectCrossQueue` returns
`null` to mean "keep it home" (:363), and a cue that stops matching produces
exactly the same `null`. There is no counter, no log, and no distinction between
"considered and declined" and "the table no longer matches this phrasing". The
callers log only the positive case (`opticalTools.ts:340`,
`surgeryTools.ts:265`, `techTools.ts:236`, `medicalRecordsTools.ts:301`).

**Tests** — `src/tools/queueRouting.test.ts` (≈45 cases: scheduling → Hub from
every department :21, surgery is the exception :57, Spanish nominalisation and
accents :88-125, records held on the records line :141, the operator's
glasses-on-the-medication-line example :174, silence when the line is already
right :192, specialist reason preferred :289).

**Would NOT catch** — a cue that silently stops firing (a `null` return is never
asserted to be *wrong*); the production distribution of redirects per queue; the
effect of a `fold` change on `afterHoursTaxonomy`/`afterHoursTriage`, which have
their own tests but are not re-run against a `fold` diff.

---

## 9. `src/tools/otherReason.ts` (107 lines)

**Responsible for** the department → "Other - See Description" table (:60-77)
and `otherReasonFor` (:86), so an unclassifiable request files as Other **in the
department that took the call**.

**Who imports it**

| group | site |
|---|---|
| live call path | `src/tools/opticalTools.ts:302` (dynamic) — the only queue tool that uses it; surgery/tech/records get a guaranteed classification from their own taxonomies instead (`surgeryTools.ts:236-246`, `techTools.ts:158-160`, `medicalRecordsTools.ts:234-236`) |
| live call path (PCP) | `src/agents/pcpAgent.ts:679` (dynamic) |
| tests | `otherReason.test.ts:11`, `src/pcp/patientCaller.test.ts:121` |
| dead | `isOtherReasonId` (:103) and `departmentsWithOtherReason` (:98) have no production caller |

**Queues affected: 1 directly (optical), 16 departments indirectly** — the table
covers departments 1–9, 11–13, 15–18 (:60-77), and `queueRouting.ts` hardcodes
the same ids independently at :318-320 (dept 1: type 66 / reason 536), :330-332
(dept 2: 65 / 535) and :342-344 (dept 3: 72 / 542). **Those two copies must
agree and nothing enforces it at runtime.**

**What it reads that it does not own** — SUPPORT `request_types` /
`request_reasons` row ids, snapshotted by hand on 2026-08-12 (:56-59). Nothing
revalidates them at runtime.

**What silently swallows its errors** — `otherReasonFor` returns `null` for an
unknown department (:88), which is the safe answer; `opticalTools.ts:304-313`
turns that into a non-retryable error. The real silent mode is upstream: a row
renamed or deactivated in SUPPORT leaves these ids pointing at nothing, and
`createTicket` would reject or misfile with only
`ticketingApiClient.ts:657-659`'s `usedFallbackReason` warning to show for it.

**Tests** — `src/tools/otherReason.test.ts` (8: distinct reason ids :14, distinct
type ids :22, covers the queues with agents :29, covers every answering-service
destination :34, same name everywhere :43, null for unknown :49). The
`otherReasonsMatchDatabase` guard described at :36-41 is the query that produced
the table.

**Would NOT catch** — divergence between this table and the hardcoded ids in
`queueRouting.ts:318/330/342`; a row deactivated in SUPPORT between deploys.

---

## 10. `server/services/ticketingApiClient.ts` (1,012 lines)

**Responsible for** every outbound call to the ticketing app —
`createTicket` (:578), `createLocationQueueTicket` (:693), `submitTicket` (:777),
`logCallbackCampaign` (:846), `updateTicketCallData` (:876), `createPcpTicket`
(:921), `lookupProviderAndLocation` (:973), `healthCheck` (:402) — behind one
`makeRequest` (:452) and one process-wide singleton (:1012).

**Who imports it**

| group | site |
|---|---|
| live call path — the four queues | `opticalTools.ts:172`, `surgeryTools.ts:212`, `techTools.ts:189`, `medicalRecordsTools.ts:270` (all dynamic) |
| live call path — other lines | `src/agents/azulSchedulingAgent.ts:657`, `src/agents/pcpAgent.ts:680`, `src/pcp/pcpTicketing.ts:139`, `src/services/syncAgentService.ts:1` (the answering-service / no-ivr / after-hours filing path), `src/services/ticketOutboxService.ts:4` |
| live call path — post-call | `src/voiceAgentRoutes.ts:4850`, `:7707`, `:8095` |
| background | `server/services/ticketingSyncService.ts:4` |
| ops | `server/testTicketingConnection.ts:2` |
| tests | `server/services/ticketWarmUpCost.test.ts:34` (source-text assertions), `src/services/locationQueueTicket.test.ts:36`, and per-tool spies in all four queue test files |
| dead | none |

**Queues affected: all 4 queue lines, plus answering-service, no-ivr,
after-hours, PCP and azul-scheduling — i.e. every ticket the fleet files.** This
is the widest blast radius in the repo.

**What it reads that it does not own**

- `getEnvironmentConfig()` (:363) → `TICKETING_SYSTEM_URL`, `TICKETING_API_KEY`,
  `TICKETING_ENRICHMENT_URL` (`src/config/environment.ts:259-263`), re-read
  every 60 s (`CONFIG_REFRESH_INTERVAL_MS`, :245).
- `process.env.OPENAI_PROJECT_ID` is not used here; the only direct `process.env`
  reads are inside `getEnvironmentConfig`.
- `shadowTap.emit` (`src/shadow/tap.ts`), called at :473, :519, :528, :536 —
  documented never to throw (`tap.ts:5`).
- `../storage` dynamically at :637 → OPSHUB `call_logs` via
  `server/storage.ts:451` `releaseTicketCreationLock`.
- Writes to SUPPORT over HTTP only. **No SQL connection to `vsmcxhxeirkoobmjcrbn`
  exists anywhere in this repo.**

**What silently swallows its errors**

- **`:1001-1008`** — `lookupProviderAndLocation`: `catch → {success:false,
  error}` with the comment *"Don't fail ticket creation if lookup fails"*. This
  is the single most-cited swallow in the codebase: `opticalTools.ts:190-207`,
  `surgeryTools.ts:394-399`. A never-ran lookup and a name that matched nobody
  are the same object to every caller that reads only `locationId`/`providerId`.
- `:662-668` — `createTicket`: `catch → {success:false, error}`. All four queue
  tools convert that into `{success:false, retryable:true}`
  (`opticalTools.ts:381`, `surgeryTools.ts:489`, `techTools.ts:274`,
  `medicalRecordsTools.ts:362`).
- `:636-640` — the `call_logs.ticket_number` writeback is fire-and-forget with a
  `.catch(console.warn)`. **A real ticket in SUPPORT with a null
  `call_logs.ticket_number` is the state this line exists to prevent, and its
  failure is a warn.**
- `:446-449` — `healthCheck`: `catch → {ok:false,error}`.
- `:565-567` — `warmUpWithRetry`: per-attempt `catch → console.warn`, then
  `:574` `console.error` and `return false`; `createTicket:602-604` treats that
  as advisory and sends anyway.
- `:506-509` — a non-JSON body (an n8n plan-cap refusal answering 200) becomes
  `throw new Error('Invalid JSON response from ticketing API: <status>')`, which
  is then caught by whichever public method called it. The optical outage of
  2026-08-31 travelled this exact path.
- `:747` and `:761-763` — `createLocationQueueTicket`'s bare `catch {}` on the
  response parse and `catch (e) → console.warn` on its writeback.
- `:904-912` — `updateTicketCallData` downgrades a 404 no-ticket to
  `console.info` and returns `{success:false}`.
- `:958-960` — `createPcpTicket` writeback `catch (e) → console.warn`.

**Downstream fact worth stating plainly:** `releaseTicketCreationLock`
(`server/storage.ts:451-463`) sets `ticketingSynced:true` and `ticketingSyncedAt:
new Date()` when a ticket number is passed. `check_open_tickets` counts a call's
ticket as open only when `call.ticketNumber && !call.ticketingSyncedAt`
(`src/services/syncAgentService.ts:482`). Every ticket filed through
`createTicket` is therefore stamped synced at creation, so it can never appear
in a later `check_open_tickets` result on any queue.

**Tests** — `server/services/ticketWarmUpCost.test.ts` (19 cases, asserted
against the **source text** rather than behaviour: every warm-up site goes
through the cache :38, liveness recorded from a real response :57, host
comparison not flag comparison :96-125, 60 s window :134, warm-up still advisory
:156, timeouts unchanged :164-170). `src/services/locationQueueTicket.test.ts`
covers the location-queue mode.

**Would NOT catch** — anything about the real endpoint. No test issues a request;
`makeRequest`, the 15 s abort, the JSON-parse throw, the 404 branch and the
shadow-tap emits are all unexercised. Nothing asserts the writeback actually
runs. The four queue test files stub the client entirely, so a change to
`createTicket`'s response handling is invisible to them.

---

## 11. `src/services/scheduleLookupService.ts` (789 lines)

**Responsible for** every read of OPSHUB `Schedule` — `lookupByPhone` (:450),
`lookupByName` (:483), `lookupByNameAndDOB` (:512), the `lookupPatient` chain
(:557), and `buildContext` (:583), which is where cancelled/no-show/future rows
are separated and where `splitByPerson` (:411) prevents two people on one phone
number being merged.

**Who imports it**

| group | site |
|---|---|
| live call path — the queue tools | `src/tools/sharedPatientTools.ts:113` (`lookup_patient`, hence all four queues), `src/tools/surgeryTools.ts:345` (the surgeon ladder), `src/tools/generalServiceTools.ts:74` (`lookup_schedule`) |
| live call path — the agents | `src/agents/pcpAgent.ts:9`, `src/agents/afterHoursAgent.ts:5`, `src/agents/answeringServiceAgent.ts:4`, `src/agents/appointmentConfirmationAgent.ts:6` |
| live call path — routes / core | `src/voiceAgentRoutes.ts:3537`, `src/core/router.ts:360`, `src/core/shadow/sdShadow.ts:84` |
| standalone | `src/standalone/demoLine.ts:1213` |
| types only | `src/workflows/workflowPromptBuilder.ts:18` |
| tests | `scheduleLookupService.test.ts:10`, plus stubs in `opticalTools.production.test.ts:151/492` and `surgeryTools.test.ts:393-634` |
| dead | none |

**Queues affected: 4 (optical, surgery, tech, records) plus answering-service,
no-ivr/after-hours, PCP, azul-scheduling and the demo line.** Everything that
recognises a caller reads this file.

This is also the file `CLAUDE.md` standing instruction 14 names as the open
violation: `lookup_patient` — the first tool optical, surgery, tech and records
call — resolves identity against **OPSHUB `Schedule`** (`:2` imports
`{ schedule }` from `shared/schema.ts:1036`), not against CONSOLE
`patients_master`. `src/services/patientVerification.ts` (which does read
`patients_master`) is wired into `src/core/router.ts` and the standalone demo
line only, never into `sharedPatientTools.ts`.

**What it reads that it does not own** — `server/db.ts:1` (`db`), i.e. OPSHUB
over `DATABASE_URL` / `SUPABASE_POOLER_URL` / `PRODUCTION_DATABASE_URL`
(`server/db.ts:19-60`, `src/config/environment.ts:213-219`); `shared/schema.ts`
`Schedule` columns (`patientCellPhone`, `patientHomePhone`, `patientLastName`,
`patientFirstName`, `patientDateOfBirth`, `appointmentDate`, `officeLocation`,
`renderingPhysician`, `appointmentStatus`, `doctorType`, `serviceCategory1`);
`src/utils/phone.ts` `normalizePhone` (:5). Row cap `LOOKUP_ROW_LIMIT = 60`
(:370) applied to all three queries.

**What silently swallows its errors**

- `:477-480`, `:506-509`, `:551-554` — three catches, all returning
  `this.emptyContext()`. **`patientFound:false` means "the query threw", "the
  pool is exhausted", "the DOB did not parse" and "this person has never been
  here" with no distinction in the return value.** The only separator is the
  `console.error('[ScheduleLookup] Error looking up by …')` line each one emits.
- `:524-527` — an unparseable DOB returns `emptyContext()` after a
  `console.warn`; with `logIdentifiers:false` (the surgery ladder's call at
  `surgeryTools.ts:349`) the warn does not even name the value.
- `:156`, `:183`, `:210`, `:337` — bare `catch {}` in `formatDate`,
  `formatTimeString`, `formatAppointmentTime` and `normalizeDOB`. A malformed
  row silently becomes `'Unknown'` in the summary the agent reads out.
- `:652-656` is the **deploy marker** `CLAUDE.md` names: `[ScheduleLookup] N
  row(s) as of <date> -> …`. Its absence in a log means the build is stale, not
  that the lookup was clean.

**Tests** — `src/services/scheduleLookupService.test.ts` (≈35 cases against
row fixtures: cancelled-future never a past visit :67, last Active visit :73,
no-show excluded :80, two people on one number :131-165, `lastPhysicianSeen`
prefers the booked surgeon :212-265, retina counts :268, spoken DOB forms :291).

**Would NOT catch** — that `lookup_patient` reads the appointment book rather
than `patients_master` (the whole of standing instruction 14 is untested); any
error path, because every test constructs `buildContext` from fixture rows and
never exercises the `db.select()` catches; the 60-row cap truncating a
high-volume patient's history.

---

## 12. `src/services/consoleDirectory.ts` (330 lines)

**Responsible for** the in-memory provider/location snapshot read from CONSOLE —
`getDirectory` (:285), `lookupProvider` (:314), `lookupLocation` (:320),
`directoryKey` (:204), the `LOCATION_ALIASES` exception table (:151) and the
`__resetDirectory` test seam (:327).

**Who imports it**

| group | site |
|---|---|
| live call path | `src/tools/sharedPatientTools.ts:236` (`resolve_location`) and `:393` (`mostRecentAcceptable`) — so all four queues; `src/services/ticketFieldSanitizers.ts:206` (`resolveTicketLookupFields`) → `src/services/syncAgentService.ts:9` → the answering-service / no-ivr / after-hours filing path |
| tests | `consoleDirectory.test.ts:7`, `locationAliases.test.ts:14` |
| dead | `lookupProvider` has exactly one production caller (`ticketFieldSanitizers.ts:208`); nothing else uses the providers map |

**Queues affected: 4 (optical, surgery, tech, records) plus every line that
files through `syncAgentService`.** `resolve_location` is in all four queue tool
sets, and `usual_clinic`/`usual_office` on `lookup_patient` is resolved through
this same snapshot.

**What it reads that it does not own** — `process.env.OBS_CONSOLE_DATABASE_URL`
(:26 TTL override `CONSOLE_DIRECTORY_TTL_MS`, :64, :69); CONSOLE tables
`si_providers` and `si_locations` (:217, :221), filtered on
`is_deleted_in_nextgen`. Its own `pg.Pool` (:71-81), max 3, session forced
read-only with a 2,500 ms `statement_timeout`.

**What silently swallows its errors**

- **`:301-304`** — `getDirectory`'s catch: `console.warn('[DIRECTORY] refresh
  failed … using what we have')` and returns the **previous** snapshot, or
  `null` when none was ever loaded. A snapshot stale for hours is
  indistinguishable from a fresh one to every caller; `lookupLocation` returns
  `null` for both "the console is unreachable" and "no such office" (:320-324).
- `:290` — when `isDirectoryConfigured()` is false the loader returns the
  existing snapshot with **no log at all**. An unset `OBS_CONSOLE_DATABASE_URL`
  in a process is silent here; `sharedPatientTools.ts:237-240` and `:394` then
  take their unconfigured branches and pass strings through unverified.
- `:82` — `pool.on('error', …)` logs and nothing else.
- `:254-261` and `:270-276` — a broken alias target, or an alias that would
  steal a real office's key, each `console.warn` and `continue`. The alias
  simply does not exist afterwards; nothing surfaces that at call time.
- `src/services/ticketFieldSanitizers.ts:221-223` and `:236-238` — two bare
  `catch {}` around the directory calls, comment *"keep the string-rule answer"*.

**Tests** — `src/services/consoleDirectory.test.ts` (13: `directoryKey`
normalisation including the two typo'd credentials :27, the 2026-08-21 renames
:53-88, degrades safely when unconfigured :89-118);
`src/services/locationAliases.test.ts` (10: every spoken form resolves and files
as the right name :68, the NextGen typo :76, **an alias never steals another
clinic** :85, the table stays small :116).

**Would NOT catch** — a stale-but-loaded snapshot (no test advances time past
`REFRESH_MS`); the `load()` in-place mutation of `entry.fileAs` (:263) on
objects already inserted into the Map under multiple keys (:244, :248), so one
alias entry writes `fileAs` onto every key pointing at it; concurrent
`getDirectory` callers sharing `inFlight` (:287).

---

## 13. `src/services/ticketFieldSanitizers.ts` (244 lines)

**Responsible for** cleaning the two fields the ticketing app resolves by name —
`sanitizeProviderName` (:104), `sanitizeLocationName` (:138), the combined
`sanitizeTicketLookupFields` (:159) and the directory-checked
`resolveTicketLookupFields` (:198).

**Who imports it**

| group | site |
|---|---|
| live call path — the four queues | `src/tools/opticalTools.ts:163`, `src/tools/surgeryTools.ts:206`, `src/tools/techTools.ts:183`, `src/tools/medicalRecordsTools.ts:264`, `src/tools/sharedPatientTools.ts:230` (`resolve_location`) — all dynamic |
| live call path — answering service | `src/services/syncAgentService.ts:9` (both `sanitizeTicketLookupFields` and `resolveTicketLookupFields`) |
| tests | `ticketFieldSanitizers.test.ts`, `consoleDirectory.test.ts:8`, `providerCorpus.test.ts:9` |
| dead | none |

**Queues affected: 4 (optical, surgery, tech, records) plus every line filing
through `syncAgentService`.** The queue tools use only the **pure** functions;
`resolveTicketLookupFields` — the one that consults CONSOLE — is used **only by
`syncAgentService`**, never by a queue tool.

**What it reads that it does not own** — nothing in the pure path (:44-156 are
constants and regexes). `resolveTicketLookupFields` dynamically imports
`./consoleDirectory` (:206) and therefore reads CONSOLE.

**What silently swallows its errors**

- `:221-223` and `:236-238` — two bare `catch {}`. A directory failure leaves
  the string-rule answer in place with no note appended to the `[DIRECTORY]`
  log line at :239.
- `:110`, `:113`, `:120` — `sanitizeProviderName` returns `{dropped:true}` with
  no `value`. Callers spread `.value` (`opticalTools.ts:167`,
  `surgeryTools.ts:210`, `techTools.ts:186`, `medicalRecordsTools.ts:267`), so a
  dropped provider becomes an empty string. On surgery that silently skips rung
  1 of the ladder; the only trace is `[TICKET-FIELDS]` at :167, and **that log
  is written by `sanitizeTicketLookupFields` only** — the queue tools call the
  single-field functions directly, so they log nothing.
- `:212-215` — a provider CONSOLE has never heard of is set to `undefined` and
  dropped from the payload; the note `provider-unknown-to-nextgen` goes to a
  `console.info` at :239.

**Tests** — `src/services/ticketFieldSanitizers.test.ts` (17: the seven
non-provider values :14-40, credential suffixes :41-79, the comma requirement so
a name is never truncated :62, brand prefix stripping :82, does **not** invent a
surgery-centre match :93, logs once and only on change :119).

**Would NOT catch** — that the queue tools bypass the logging wrapper; the
directory-consulting path from a queue tool (there isn't one); the
`resolveTicketLookupFields` provider-drop under a live CONSOLE.

---

## 14. `src/config/agents.ts` (306 lines)

**Responsible for** the one registry of lanes — id, factory, `enabled`,
description, `twilioNumbers`, `agentType`, version, voice, language, greeting —
constructed eagerly at module load (:35-243) and exported as a singleton
(:306).

**Who imports it**

| group | site |
|---|---|
| live call path | `src/voiceAgentRoutes.ts:2287` — dynamically, on **every** call, inside `observeCall` |
| live call path | `server/productionServer.ts:66` at boot |
| runtime | `src/runtime/laneRegistry.ts:347` (`defaultLaneSource`) |
| entrypoints | `src/server.ts:4`, `src/testing/outboundTestRunner.ts:2` |
| tests | `src/agents/agentWiring.test.ts:247/304`, `src/runtime/realLanes.test.ts` (opt-in, `RUNTIME_LANE_SMOKE=1`) |
| dead | `getAgentFactoryByNumber` (:259) — `twilioNumbers` is `[]` for every queue lane (:112, :128, :145, :163), so it always falls through to the `no-ivr` default at :266 |

**Queues affected: all of them, plus every other line.** The static import list
at :1-15 means importing this module constructs **every** agent module in the
repo and everything they import (the reason `laneRegistry.ts:343-348` and
`voiceAgentRoutes.ts:2287` both import it lazily, and the reason
`realLanes.test.ts:20-24` is opt-in). Flipping one `enabled` flag changes
whether a line answers on **both** transports at once.

**What it reads that it does not own** — each agent's exported config object
(`opticalAgentConfig`, `surgeryAgentConfig`, `techAgentConfig`,
`recordsAgentConfig`, `pcpAgentConfig`, `azulSchedulingAgentConfig`,
`noIvrAgentConfig`, `answeringServiceAgentConfig`, `runtimeProofAgentConfig`) for
slug, description, version, voice, language and greeting.

**What silently swallows its errors**

- `:250-253` — `getAgentFactory` returns `undefined` for a **disabled** agent and
  for an **unknown** one, identically. `voiceAgentRoutes.ts:2338-2343`
  distinguishes them only by first calling `getAgentConfig`, and then throws
  `Agent disabled or not found` mid-call.
- `:259-267` — `getAgentFactoryByNumber` silently defaults to `no-ivr` for any
  unmapped number. With every queue's `twilioNumbers` empty this is the only
  branch it ever takes.
- `src/runtime/laneRegistry.ts:279` — a disabled lane resolves to `null` with no
  log; the caller plays its unavailable line.
- `:247` / `:292` — `register` and `updateAgent` overwrite by id with only a
  `console.log`; a second `register` of the same slug replaces the first
  silently (unlike `registry.ts:91`, which throws).

**Tests** — `src/agents/agentWiring.test.ts` (every accepted slug has a factory
case :92, is in `validInboundAgents` :107, lines that read precontext are in
`PRECONTEXT_SLUGS` :133, the records lane clears every gate :230-300, **no
accepted slug points at a disabled or missing registration :302**);
`src/runtime/realLanes.test.ts` (opt-in) resolves all five served lanes against
the real tree.

**Would NOT catch** — a wrong `twilioNumbers` entry (nothing asserts them);
a `voice` or `greeting` change (only `laneRegistry.test.ts:192-231` asserts that
the OpenAI voice is *not* forwarded to Grok); the eager-construction cost of the
static import list.

---

## 15. `src/config/transcription.ts` (278 lines)

**Responsible for** the single `audio.input.transcription` object every session
starts with — `transcriptionModel` (:86), `buildTranscriptionConfig` (:248),
`activeKeywords` (:217), `practiceLanguages` (:118), `transcriptionDelay` (:108),
`callerHintEnabled` (:196).

**Who imports it**

| group | site |
|---|---|
| live call path | `src/voiceAgentRoutes.ts:53` — `buildTranscriptionConfig` and `transcriptionModel`, used at the four call sites the header (:1-10) says used to disagree |
| standalone | `src/standalone/demoLine.ts:28` |
| tests | `src/config/transcription.test.ts` |
| dead | `PREVIOUS_TRANSCRIPTION_MODEL` (:84) is documented as unused |

**Queues affected: every SIP line — optical, surgery, tech, records,
answering-service, no-ivr, pcp, azul-scheduling, demo — simultaneously.** There
is no per-lane override; the model comes from one env var (:87) and the keyword
list from one function (:217).

**What it reads that it does not own** — `process.env.TRANSCRIPTION_MODEL`,
`TRANSCRIPTION_DELAY`, `TRANSCRIPTION_LANGUAGES`, `TRANSCRIPTION_CALLER_HINT`;
`../services/providerRoster` via a **synchronous `require`** at :223, guarded
because this sits in the accept path and must not await a query (:216); the
caller's surname from caller-ID pre-context, passed in by the caller of
`buildTranscriptionConfig`.

**What silently swallows its errors**

- **`:227-229`** — `catch { /* roster unavailable — seeds below cover it */ }`.
  A failed roster load silently degrades to the 2026-08 hardcoded seed list
  (:144-161) with no log line at all. A live roster of 77 providers and 105
  offices becomes 14 office names and 14 surnames, and nothing says so.
- `:230` — `if (live === 0)` is the only signal that happened, and it is not
  logged.
- `:110` — an invalid `TRANSCRIPTION_DELAY` returns `undefined`, so the field is
  simply absent; a typo'd value is indistinguishable from unset.
- `:122` — a `TRANSCRIPTION_LANGUAGES` that parses to nothing falls back to
  `['en','es']` silently.
- `:277` — an older model with no established language gets `{model}` alone. If
  `TRANSCRIPTION_MODEL` is set to a string the API rejects, the **session fails**,
  not just the transcript (:68-71), and the only forensic trail is the
  `[SESSION] Call config: … transcription=…` line named at :64.

**Tests** — `src/config/transcription.test.ts` (≈25: default is
`gpt-live-transcribe` :23, env rollback with no deploy :29, delay absent unless
set :49, **no language pin when the call established none** :90, both practice
languages sent :115, established language first :122, no patient data in the
prompt :139, legacy models get neither :145, LA/OC offices hinted not just SD
:178, `Tompkins` hinted :188).

**Would NOT catch** — the roster `require` failing (no test forces it); that a
model string is accepted by the real API; the latency effect of `delay`, which
the file itself says can only be measured on a call (:48-49).

---

## 16. `src/runtime/agentBinding.ts` (283 lines)

**Responsible for** borrowing a built agent's own instructions, tools and output
guardrails onto the Grok voice runtime — `toJsonSchema` (:121), `toGrokTools`
(:140), `resolveInstructions` (:195), `bindAgent` (:218) and the non-throwing
`dispatch` (:257).

**Who imports it**

| group | site |
|---|---|
| runtime (mounted, no traffic) | `src/runtime/laneRegistry.ts:42` |
| types only | `src/runtime/mediaStreamBridge.ts:109`, `src/runtime/regression/regressionRunner.ts:42`, `mediaStreamBridge.test.ts:14`, `regressionRunner.test.ts:10` |
| tests | `src/runtime/agentBinding.test.ts:3` |
| live call path | **none.** The SIP transport does not use it; `server/index.ts:405` mounts the runtime but no number points at `/voice/:slug` (`server/index.ts:398-401`) |

**Queues affected: 0 today; 5 the moment a number is pointed at the runtime** —
`realLanes.test.ts:39` names the served set as optical, surgery, tech, records
and answering-service. On that day this file becomes a peer of
`realtimeAdapter.ts` in blast radius, because it re-derives the wire schema for
every tool on all four queues (`:163`) rather than reusing what
`realtimeToolsFor` produced.

**What it reads that it does not own** — `agent.instructions` (string or
closure), `agent.getSystemPrompt`, `agent.tools[].parameters`,
`agent.tools[].invoke`, `agent.outputGuardrails` — all off objects built by the
production agent factories, which it is forbidden to modify (standing
instruction 5).

**What silently swallows its errors**

- **`:134-136`** — `toJsonSchema`'s `catch { /* fall through */ }` returns
  `EMPTY_OBJECT_SCHEMA` (:113). An unconvertible schema becomes a tool with **no
  declared parameters**: the model can call it with anything, and the refusal
  contract in `registry.ts:139` is the only thing left standing. Deliberate
  ("an untyped tool beats a missing one") and completely silent.
- `:203-209` — `getSystemPrompt` throwing is caught and falls through to calling
  the raw closure. Only a prompt that resolves to empty throws (:223-227).
- `:271-280` — `dispatch`'s catch returns `{ok:false,
  output:'{"ok":false,"error":"tool_failed"}', error:message}`. The model is told
  `tool_failed` and nothing more; the real message goes only to the call record.
- `:259-265` — an unknown tool name returns `unknown_tool`, structurally
  identical to a tool that failed.
- `:242-249` — a malformed guardrail is dropped with a `console.warn`. **The
  medical-safety guardrails on pcp/no-ivr/azul-scheduling (:94-102) would
  silently thin out.**
- `:151-157` — a tool with no `invoke` is skipped into `BoundAgent.skipped` and
  never offered; that list is surfaced but nothing in the runtime asserts it is
  empty.

**Tests** — `src/runtime/agentBinding.test.ts` (24: instructions verbatim :16,
refuses an agent with no instructions :21, **plain JSON Schema passed through
unchanged :39**, **never emits `strict` :50**, Zod optional stays out of required
:56, unconvertible schema still yields a usable tool :70, skipped tools reported
:77/:83, prompt closures evaluated not stringified :90-126, dispatch never
throws :128-176, guardrails carried verbatim :177-205).

**Would NOT catch** — the stringified-prompt-closure bug on a served lane, which
`realLanes.test.ts:13-20` puts on the record as an explicit gap (none of the five
served lanes builds instructions with a closure; the two that do are refused for
other reasons); whether Grok accepts the emitted schema.

---

## 17. `src/runtime/laneRegistry.ts` (349 lines)

**Responsible for** resolving a lane slug to a bound agent + voice config +
version + greeting — `laneSupportStatus` (:160), `resolveLane` (:259),
`defaultLaneSource` (:346) — and for the three refusal sets
`NON_UNIFORM_FACTORY_LANES` (:85), `TRANSFER_CAPABLE_LANES` (:116),
`RUNTIME_TRANSFER_READY_LANES` (:140).

**Who imports it**

| group | site |
|---|---|
| runtime (mounted, no traffic) | `src/runtime/voiceRuntime.ts:53` |
| types only | `src/runtime/runtimeTransfer.ts:34`, `src/runtime/voiceRuntime.test.ts:27` |
| scripts | `scripts/run-runtime-regression.ts:25` |
| tests | `laneRegistry.test.ts:3`, `realLanes.test.ts:33` |
| live call path | **none** — same as `agentBinding.ts` |

**Queues affected: 0 today; 5 when a number is pointed at `/voice/:slug`.** It
deliberately builds no registry of its own (:6-11) and reads
`src/config/agents.ts` at :347 — so it inherits every `enabled` flag rather than
duplicating it.

**What it reads that it does not own** — `agentRegistry.getAgentConfig` (via the
`LaneSource` interface :193); `process.env` through `deps.env ?? process.env`
(:316) for `XAI_VOICE_NAME_<SLUG>` (:331) and `XAI_VOICE_LANGUAGE_<SLUG>` (:335)
via `pickLaneEnv`; `buildKnowledgePack()` (:313); each factory's
`(handoff, metadata)` contract.

**What silently swallows its errors**

- **`:284-290`** — an unsupported lane produces `console.warn('[voice-runtime]
  …')` and `return null`. The caller answers with its controlled unavailable
  line, so a misconfigured lane and a deliberately disabled one sound identical
  to a caller.
- `:279` — a disabled lane or an unknown slug returns `null` with **no log at
  all**.
- `:244-249` — `refuseHandoff` throws by design; it is a tripwire, so on a lane
  that does invoke it the failure is loud, not silent.
- `:322-330` — the registry's `voice` field is deliberately dropped. That is
  correct here and is the reason `realLanes.test.ts` exists (`sage` is not a
  Grok voice), but nothing logs the discard.

**Tests** — `src/runtime/laneRegistry.test.ts` (30: borrows the agent's
instructions with the knowledge pack in front :39, passes the SIP transport's
own metadata :49, refusing handoff not a lying no-op :62, tools carried with
their own schema never strict :75, null for unknown/disabled :88/:96,
non-uniform factory refused :106, outbound refused :121, transfer lanes refused
without a handoff :156/:275, azul still refused **with** one :313, cache prefix
byte-identical across lanes :242); `src/runtime/realLanes.test.ts` (opt-in,
`RUNTIME_LANE_SMOKE=1`) is the only test that touches the real agent tree.

**Would NOT catch** — anything about the wire; `realLanes.test.ts` states its own
gap at :13-20.

---

## 18. `src/voiceAgentRoutes.ts` (8,594 lines)

**Responsible for** every inbound and outbound Twilio/OpenAI-SIP webhook and the
whole `observeCall` session lifecycle. 40+ `app.post`/`app.get` handlers,
registered by `setupVoiceAgentRoutes` (:5058).

**Who imports it**

| group | site |
|---|---|
| live call path | `server/productionServer.ts:71` (dynamic, at boot), `src/server.ts:7` |
| tests | none — **there is no test file for this module** |
| dead | n/a |

**Queues affected: every line the practice runs.** The five overflow lines are
one factory (`registerOverflowLine`, :6132), so a change inside it lands on
answering-service, optical, surgery, tech and records at once (:6248, :6258,
:6270, :6281, :6293). `observeCall` (:2281) is shared by all of them plus
no-ivr, demo, pcp, azul-scheduling and appointment-confirmation.

**What it reads that it does not own** — ~60 modules statically (:8-65, plus
:829, :1136-1140) and a dozen dynamically. Env: `DOMAIN`, `OPENAI_PROJECT_ID`
(:6231), `OPENAI_API_KEY` (:2286), plus everything `getEnvironmentConfig` (:40)
carries. Databases: OPSHUB through `../server/storage` (:34) and the services;
CONSOLE indirectly through `fetchAzulPrecontext` (:2495) and the tools; SUPPORT
through `ticketingApiClient` (:4850, :7707, :8095). Twilio through
`src/lib/twilioClient` (:20).

**What silently swallows its errors**

- **`:6240-6244`** — `registerOverflowLine`'s participant-create `catch (error)
  → console.error('[TAG] ✗ Failed to add agent to conference')`. The TwiML has
  already been sent at `:6210`, so the caller is **in a conference with no
  agent** and the only record is one stderr line. Identical shape at :6108
  (dev-no-ivr), :6404 (demo), :6605 (azul-scheduling), :6760
  (appointment-confirmation).
- `:6225-6228` — a missing `CallToken` becomes `''` after a `console.warn`, and
  the SIP dial proceeds.
- `:2318-2321` — the "is this an active DB agent?" check `catch → console.warn`,
  then `:2325-2327` coerces the slug to `after-hours`. That coercion is what
  answered a brand-new demo line as the after-hours agent three times
  (:2311-2315).
- `:2496` — `azulPrecontextPromise` ends `.catch(() => null)`. Every
  pre-context failure — unset key, HTTP status, fetch abort — is normalised to
  `null` here.
- `:2664-2672` — `racePrecontext` returns `null` on timeout (1,500 ms at :2669)
  **and** on throw (`catch { return null }` at :2671). A slow-but-successful
  lookup and a hard failure both produce a cold greeting; the four queue
  branches (:2760, :2800, :2839, :2879) log only `matched` vs `no unique match`.
- `server/index.ts:421-423`, `:432-434`, `:385-387` — the runtime, tool server
  and demo line each mount inside a `try/catch` that logs and continues, so a
  broken `mountToolServer` leaves `/api/tools/*` returning 404s from the SPA
  fallback rather than failing the boot.

**Tests** — none directly. Adjacent coverage: `src/agents/agentWiring.test.ts`
asserts against this file's **source text** (the factory-switch cases :92, the
`validInboundAgents` list :107, `PRECONTEXT_SLUGS` :133, the records webhook
route :235, no string-equality slug resolution :198).

**Would NOT catch** — anything runtime. No test issues a webhook, builds TwiML,
or drives `observeCall`. Every conference-map write, the SIP header parse
(:5208), the greeting personalisation and the whole teardown path are unexercised.

---

# Hubs found while tracing (not in the starting set)

### `src/services/toolTimeline.ts`
`recordingExecute` (:312) and `flushAzulTimeline` (:489) are called for **all
four queues** from `realtimeAdapter.ts:16`, and separately by azul-scheduling
and the director (`voiceAgentRoutes.ts:23`). Swallows: `:344-346`, `:591-593`,
`:533`, `:385`. Its `timelines` Map (:57) is the only record that a tool ran.

### `src/utils/phone.ts`
`normalizePhone` — 3 lines, `slice(-10)`. Re-exported by
`sharedPatientTools.ts:375` and used as the `patientPhone` value by **all four**
filing tools (`opticalTools.ts:360`, `surgeryTools.ts:461`, `techTools.ts:256`,
`medicalRecordsTools.ts:329`) and by `scheduleLookupService.ts:5`. Its own
header (:17-24) states it assumes the caller already refused implausible
lengths; the four ceiling checks (`opticalTools.ts:130`, `surgeryTools.ts:167`,
`techTools.ts:144`, `medicalRecordsTools.ts:170`) are four copies of that guard.

### `src/tools/dobParts.ts`
`normalizeDobParts` — called by all four filing tools
(`opticalTools.ts:173`, `surgeryTools.ts:213`, `techTools.ts:190`,
`medicalRecordsTools.ts:271`). Returns `null` for anything it cannot read, and
all four turn that into the same `missing(['date_of_birth'], …)` line.

### `src/services/gsm7.ts`
`sanitizeForSms` — all four filing tools (`opticalTools.ts:157`,
`surgeryTools.ts:200`, `techTools.ts:177`, `medicalRecordsTools.ts:258`) plus
`syncAgentService.ts:691` and `pcpAgent.ts:681`. It is the last thing that
touches the description before it becomes a patient-facing SMS.

### `src/tools/server.ts`
The second entry point into the same registry (:46). Its explicit import list
(:30-35) is the only thing keeping the HTTP manifest in step with what the
agents declare; `serverRegistration.test.ts:40/81` is the guard. `authorised`
(:37-43) fails **closed** when `VOICE_TOOL_API_KEY` is unset — the surface then
401s everything, with the state announced once at :48-51.

### `server/storage.ts`
`releaseTicketCreationLock` (:451) is the create-ticket writeback target;
`getCallHistoryByPhone` (:693) backs `check_open_tickets` on all four queues.
Both write/read OPSHUB `call_logs`.

### `src/services/syncAgentService.ts`
Owns `checkOpenTickets` (:460) — one of the three shared tools' handlers — and
the whole answering-service filing path (`ticketingApiClient` at :1,
`ticketFieldSanitizers` at :9). Its `catch → return []` at :500-502 is the
swallow behind `check_open_tickets`.

---

# HUB FILES — ranked by blast radius

| # | File | Rule |
|---|---|---|
| 1 | `server/services/ticketingApiClient.ts` | Touching this changes behaviour on **9 lines** (optical, surgery, tech, records, answering-service, no-ivr, after-hours, PCP, azul-scheduling) — every ticket the fleet files. Measure, before and after: **tickets created per line per day** in SUPPORT, and **`call_logs.ticket_number` non-null rate** in OPSHUB (the writeback at :636 and the grader disagree independently). |
| 2 | `src/tools/registry.ts` | Touching this changes behaviour on **4 queues + runtime-proof + both HTTP surfaces** — every registered tool. Measure: **tool refusal rate and tool timeout rate per tool per line**, from the `[TOOLS] ← <name> <ms> <outcome>` lines (`realtimeAdapter.ts:159`) and `[TOOLS] <name> <ms> <outcome>` (`server.ts:111`). |
| 3 | `src/tools/sharedPatientTools.ts` | Touching this changes behaviour on **4 queues simultaneously — optical, surgery, tech AND records** — because `lookup_patient`, `resolve_location` and `check_open_tickets` head all four tool sets. Measure: **`lookup_patient` found-rate and `resolve_location` verified-rate per queue per day**. |
| 4 | `src/tools/realtimeAdapter.ts` | Touching this changes behaviour on **4 queues + runtime-proof** — every SIP-path tool call. Measure: **`tool_call_count` non-null rate on `call_logs` per queue** (a regression here makes tools invisible, not broken) and **tool-call-to-filing conversion per queue**. |
| 5 | `src/voiceAgentRoutes.ts` | Touching this changes behaviour on **every inbound line**; `registerOverflowLine` alone covers 5. Measure: **answered-call count and conference-join rate per line per hour**, before and after. There is no test file; production is the only instrument. |
| 6 | `src/tools/queueRouting.ts` | Touching `detectCrossQueue` changes **4 queues + PCP + `createTicketTool`**; touching `fold` changes **5 taxonomies** including the after-hours classifier. Measure: **tickets filed into departments 1/2/3/9 per originating queue** — a redirect moves a ticket out of the queue that took the call. |
| 7 | `src/services/scheduleLookupService.ts` | Touching this changes behaviour on **4 queues + answering-service + no-ivr/after-hours + PCP + azul-scheduling + demo**. Measure: **`patientFound` rate per line**, and confirm the `[ScheduleLookup] N row(s) as of …` marker (:652) is present in the log before trusting any call. |
| 8 | `src/services/consoleDirectory.ts` | Touching this changes **`resolve_location` and `usual_clinic` on 4 queues** plus `resolveTicketLookupFields` on the answering-service path. Measure: **`resolve_location` refusal rate per queue per day**, and the `[DIRECTORY] loaded from the Patient Console: N providers, M location keys` line (:295) — a stale snapshot logs nothing. |
| 9 | `src/config/agents.ts` | Touching this changes **which lines answer at all, on both transports**. Measure: for each slug, **calls answered per hour** before and after; a flipped `enabled` is silent on the runtime (`laneRegistry.ts:279`) and throws mid-call on SIP (`voiceAgentRoutes.ts:2340`). |
| 10 | `src/services/ticketFieldSanitizers.ts` | Touching this changes the provider and location strings on **4 queues + the answering-service path**. Measure: **`providerMatched` / `locationMatched` rate** in the create-ticket responses (`ticketingApiClient.ts:644-651`). |
| 11 | `src/services/toolTimeline.ts` | Touching this changes the **only record that a tool ran** on 4 queues + azul. Measure: **`tool_timeline` non-null rate per queue**. |
| 12 | `src/utils/phone.ts` · `src/tools/dobParts.ts` · `src/services/gsm7.ts` | Each is called by **all four** filing tools. Measure: **filed-ticket count and `patientPhone` length distribution per queue** (phone), **date-of-birth refusal rate per queue** (dobParts), **description-changed log rate** (gsm7). |
| 13 | `src/config/transcription.ts` | Touching this changes **every SIP session on every line** — one model, one keyword list, no per-lane override. Measure: **session-establishment rate** first (a bad model string kills the session, not just the transcript), then surname/DOB accuracy on a bilingual pair of calls. |
| 14 | `src/runtime/laneRegistry.ts` · `src/runtime/agentBinding.ts` | **0 queues today** — mounted at `server/index.ts:405` but no number points at `/voice/:slug`. The moment one does, both become peers of #3 and #4 across 5 lanes. Measure before pointing a number: run `RUNTIME_LANE_SMOKE=1 npx vitest run src/runtime/realLanes.test.ts`. |

---

# SHARED MUTABLE STATE

Module-level state written by more than one caller.

### `registry` — `src/tools/registry.ts:88` `Map<string, ToolDefinition>`
- **Writers:** `registerTool` (:90) from `sharedPatientTools.ts` (3 tools),
  `opticalTools.ts` (2), `surgeryTools.ts` (2), `techTools.ts` (2),
  `medicalRecordsTools.ts` (2), `generalServiceTools.ts` (3),
  `handoffBroker.ts` (1). Registration happens as an **import side effect**, so
  the contents depend on which modules the process happened to load.
- **Clearers:** none. There is no unregister.
- **Failure mode if the wrong set is loaded:** `/api/tools/:name` answers 404
  with `availableTools` (`server.ts:66-74`) — the exact defect
  `server.ts:20-29` records; `realtimeToolsFor` throws at **agent-construction**
  time (`realtimeAdapter.ts:75-79`), so the call fails before the greeting. A
  duplicate name throws at import (`registry.ts:91-93`) and takes down boot.

### `snapshot` / `inFlight` / `pool` — `src/services/consoleDirectory.ts:59-61`
- **Writers:** `getDirectory` (:289-308, sets `snapshot` and `inFlight`);
  `load` (:263) mutates `entry.fileAs` **in place** on objects already inserted
  into `locations` under up to three keys (:244, :248, :277);
  `__resetDirectory` (:327).
- **Clearers:** `__resetDirectory` (tests, and "lets a deploy force a refresh
  without a restart" per :326); the `REFRESH_MS` TTL check at :286
  (`CONSOLE_DIRECTORY_TTL_MS`, default 15 min).
- **Failure mode if not cleared:** a refresh that throws returns the stale
  snapshot forever (:301-304) with one `console.warn` per attempt. A renamed or
  newly-added office is invisible until the process restarts, and every caller —
  `resolve_location` on four queues — reports it as "I'm not finding an office by
  that name".

### `timelines` — `src/services/toolTimeline.ts:57`
- **Writers:** `recordAzulToolEvent` (:273) via `recordingExecute` (:312) for all
  four queues through `realtimeAdapter.ts:208`; `recordDirectorAction` (:363).
- **Clearers:** **only** the 2-hour reaper `setInterval` at :597.
  `flushAzulTimeline` deliberately does **not** delete (:507-524 records why —
  a destructive flush gutted a third of the pilot's QA record).
- **Failure mode if not cleared:** unbounded growth, one entry per call. The
  reaper is the only bound; if it stops, memory grows with call volume.

### `TicketingApiClient` singleton fields — `server/services/ticketingApiClient.ts:240-245`, `:284`
- **Writers:** `ensureInitialized` (:346-392) on every request, re-reading env
  every 60 s (`CONFIG_REFRESH_INTERVAL_MS`, :245); `refreshConfig` (:396-399);
  `markAlive` (:316-331) from `makeRequest` (:532) and `healthCheck` (:440).
- **Clearers:** `refreshConfig` only (`initialized=false`, `lastInitTime=0`);
  `lastAliveAt` is never reset, only advanced.
- **Failure mode if not cleared:** `lastAliveAt` is **process-wide and
  cross-queue** — one queue's successful POST suppresses the warm-up probe for
  all nine lines for 60 s (`LIVENESS_TTL_MS`, :285). The host comparison at :329
  is what keeps that honest once `TICKETING_ENRICHMENT_URL` is set; without it,
  a gateway success would suppress the probe of a sleeping direct app
  (:305-314). A rotated `TICKETING_API_KEY` is picked up within 60 s by
  `ensureInitialized`, silently — the only sign is the
  `[TICKETING API] API Key configured: YES (length: N)` line at :373.

### `AgentRegistry.agents` — `src/config/agents.ts:33`, singleton at `:306`
- **Writers:** the constructor (:35-243, 15 lanes); `register` (:245);
  `updateAgent` (:287); `enableAgent`/`disableAgent` (:296-302).
- **Readers:** `voiceAgentRoutes.ts:2331/2335` on **every call**;
  `laneRegistry.ts:347`; `productionServer.ts:66`; `src/server.ts:4`.
- **Clearers:** none.
- **Failure mode:** `register` overwrites by id with only a `console.log` (:247)
  — unlike `registry.ts:91`, a duplicate slug silently replaces the earlier
  registration. A runtime `disableAgent` makes `getAgentFactory` return
  `undefined` (:252) while `getAgentConfig` still returns the row, which
  `voiceAgentRoutes.ts:2338-2343` turns into a thrown
  `Agent disabled or not found` **after** the caller is already in the
  conference.

### Conference maps — `src/voiceAgentRoutes.ts:370-382`
`callMetadata` (:370, `Map`), `callIDtoConferenceNameMapping` (:371),
`ConferenceNametoCallerIDMapping` (:372), `ConferenceNametoCalledNumberMapping`
(:373), `ConferenceNametoCallTokenMapping` (:374), `conferenceNameToCallID`
(:375), `conferenceNameToTwilioCallSid` (:381), `conferenceSidToCallLogId`
(:382).
- **Writers:** every inbound webhook. `registerOverflowLine` writes six of them
  at :6161-6175 for **all five overflow lines**; `/api/voice/no-ivr` (:5827),
  `/api/voice/dev-no-ivr` (:6004), `/api/voice/demo` (:6309),
  `/api/voice/pcp` (:6410), `/api/voice/azul-scheduling` (:6471),
  `/api/voice/incoming-call` (:5686) write the same keys.
- **Clearers:** not at the write sites. Keys are `conf_<CallSid>` and
  `<CallSid>`, so cross-call collision is not possible, but the plain `Record`
  objects (:371-382) have no TTL of their own.
- **Failure mode:** entries accumulate for the process lifetime; `callMetadata`
  is the one consulted by `observeCall` for `agentGreeting`/`agentSlug`
  (:6169-6175), so a webhook that writes it and then fails to add the SIP
  participant (:6243) leaves a metadata entry for a call that never had an agent.

### `handoffs` — `src/tools/handoffBroker.ts:24`
- **Writers:** `registerCallHandoff` (:30) from `runtimeProofAgent.ts:115`.
- **Clearers:** `releaseCallHandoff` (:38) from `voiceRuntime.ts:60` at teardown.
- **Failure mode if not cleared:** a per-call closure over the transfer leaks;
  `registeredHandoffCount()` (:43) is the only counter.

### `callMetadataForDB` — `src/services/callMetadataStore.ts:25`
- **Writers:** `voiceAgentRoutes.ts` at many sites (:1256, :1381, :1943, :3287,
  :3326 read it; the session setup writes it).
- **Readers:** `toolTimeline.ts:531` (A/B arm at flush), `voiceAgentRoutes.ts`
  escalation and handoff paths.
- **Failure mode:** a missing entry silences the A/B arm on the flushed row
  (`catch { /* optional */ }` at `toolTimeline.ts:533`).

### `BY_DEPARTMENT` — `src/tools/otherReason.ts:60` (const, but a hand-copied snapshot)
- **Writers:** none at runtime.
- **The duplicate:** `queueRouting.ts:318-320`, `:330-332`, `:342-344` hardcode
  the same three (typeId, reasonId) pairs independently. Nothing at runtime
  compares them.
- **Failure mode:** a SUPPORT row renamed or deactivated leaves both copies
  pointing at nothing; the only symptom is `usedFallbackReason` warned at
  `ticketingApiClient.ts:657-659`, or a rejected create.

### `LOCATION_ALIASES` — `src/services/consoleDirectory.ts:151`
- Exported as a mutable array and read by `load()` (:252) on every refresh;
  `load()` writes `entry.fileAs` back onto the snapshot objects (:263).
- **Failure mode:** an alias whose `mirror` key no longer exists is skipped with
  a `console.warn` (:257-260) and simply stops resolving — the 2026-08-21
  retired-name case (`north valley eye`, `magan`) is the reason
  `locationAliases.test.ts:108-121` asserts the table's shape.
