# 02 — Dead and duplicated

Read-only survey, 2026-09-01. Nothing was deleted or changed. Every claim below
carries the grep or the file:line it came from.

> **Superseded in part, 2026-09-01 (later the same day).** `src/core/` and
> `src/standalone/` were deleted — the two unreachable voice pipelines this
> survey identified. Two live paths remain: the OpenAI SIP path
> (`src/voiceAgentRoutes.ts`) and the Grok runtime (`src/runtime/`). Every
> `src/core/…` or `src/standalone/…` path and line number below is historical
> and no longer resolves.

**Method.** An import graph was built over `src/`, `server/`, `shared/`,
`scripts/`, `client/src` (462 files) by resolving every relative `import`/
`require`/dynamic-`import` specifier. Reachability was computed from the two
real entry points named in `.replit` (`server/index.ts` and `src/server.ts`, run
as `npx tsx server/index.ts & npx tsx src/server.ts`). Exports were extracted
per file and word-boundary-matched across every other file, splitting test
importers from non-test importers. Env-var gates were cross-checked against
`.replit` `[userenv]` and `.env.production.example`.

**One caveat, stated once.** Secrets set in the Replit UI are not visible in
this repo. Where an item is called dead *because an env var is unset*, the
evidence is "not in `.replit` and not in `.env.production.example`". That is
strong for feature flags Wayne would have set in `.replit` alongside the others
(`SHADOW_*`, `DIRECTOR_AGENTS`, `RAMP_AGENTS` are all there), and weaker for
credentials (`XAI_API_KEY`). Each entry says which kind it is.

---

## Ranked by confusion cost

The ranking answers one question: *how likely is this to make the next person
build the wrong thing, or believe a green test means a live line works?*

| # | Item | Kind | Confusion cost |
|---|---|---|---|
| 1 | Three voice transports, one takes calls | Superseded / parallel | **Critical** |
| 2 | The new core (`src/core/`) is switched off by an unset env var | Dead branch | **Critical** |
| 3 | `replayRealCalls.test.ts` tests a code path that takes no calls | Test pins the wrong thing | **Critical** |
| 4 | Department / request-type / reason tables in four places, disagreeing | Same rule, N places | **Critical** |
| 5 | Medication cue list in three places, all different | Same rule, N places | **High** |
| 6 | Queue greetings in three places; optical's two copies disagree | Same rule, N places | **High** |
| 7 | Provider and location rosters: four copies, one live query | Stale config | **High** |
| 8 | `src/director/` never fires (`DIRECTOR_AGENTS=""`) | Dead branch | **High** |
| 9 | Transfer capability declared in two registries | Same rule, two places | **High** |
| 10 | Four slug allowlists that disagree; two registered agents unreachable | Same rule, N places | **High** |
| 11 | `lookup_patient` reads the appointment book, not the mirror | Superseded | **High** |
| 12 | Prompt-editing API + two version tables that nothing on the call path reads | Dead subsystem | **High** |
| 13 | `hubTaxonomy.ts` — 199 lines, zero importers, header claims it is wired | Dead file | **Medium-high** |
| 14 | `src/tools/server.ts` fails closed on an unset key | Dead branch | **Medium** |
| 15 | Duplicate `/api/voice/warm-transfer-status` route | Dead branch | **Medium** |
| 16 | Nine orphan files, ~1,400 lines | Dead files | **Medium** |
| 17 | Dead exports inside live files | Dead exports | **Medium** |
| 18 | `PCP_AGENT_DIDS` / `sequential` mode: accepted, parsed, ignored | Stale config | **Medium** |
| 19 | Shadow sub-systems behind flags that are off | Dead branch | **Low-medium** |
| 20 | Stale build marker, junk files | Stale config | **Low** |

---

## 1. Three voice transports. One of them answers the phone.

**What it is.** Three complete, independent ways for a Twilio call to reach an
agent, all mounted at boot, all with their own transport code, session
handling, greeting logic and call-record writing.

| Transport | Mount | Path | Prod traffic |
|---|---|---|---|
| OpenAI SIP conference | `src/server.ts:41` → `setupVoiceAgentRoutes` | `/api/voice/*` (35 routes) | **all of it** |
| Twilio Media Streams + Deepgram + Claude | `server/index.ts:385` `mountDemoLine` | `/demo/voice`, `/line/:slug/voice` | test number only |
| Grok realtime runtime | `server/index.ts:409` `mountVoiceRuntime` | `/voice/:slug` | none |

**Evidence.**
- `server/index.ts:400-407` mounts the Grok runtime with the comment, verbatim:
  *"No number points at /voice/:slug until Wayne points one, so mounting it
  changes nothing for any live line."*
- `src/runtime/readiness.ts:59` — the runtime refuses every call unless
  `XAI_API_KEY` is set. `XAI_API_KEY` appears nowhere in `.replit` or
  `.env.production.example` (credential-class caveat applies).
- Size: `src/runtime/` is **6,972 production lines and 7,613 test lines**.
  `src/standalone/` is 2,759 / 1,157. `src/voiceAgentRoutes.ts`, the only file
  that has ever answered a production call, is **8,594 lines with no test file
  at all** — `ls src/voiceAgentRoutes.test.ts` → no such file. Thirteen test
  files reference it, all by `readFileSync` on its source text.

**Why this is the top of the list.** A reader arriving at `src/runtime/` finds
the newest code, the best comments, the most tests, `mountVoiceRuntime` wired
into the server, and a `laneRegistry.ts` header explaining that adding a lane is
"a registry entry plus a prompt". Every one of those signals says "this is the
system." It has never carried a call. The 8,594-line file that does carry every
call has zero tests and looks abandoned by comparison.

**Safety note.** Deleting `src/runtime/` would remove `warmTransfer.ts`,
`transferAcceptWebhook.ts` and `runtimeTransfer.ts`, whose routes
(`TRANSFER_ACCEPT_PATH`, `TRANSFER_STATUS_PATH`) are registered on the public
server at `voiceRuntime.ts:366,370` — no Twilio number is configured to hit
them, but confirm in the Twilio console before removing. `src/standalone/`
cannot be deleted: `demoLine.ts` is the only consumer of `ticketAgentFor`, and
the demo number **+1 626-548-2660** (`demoLine.ts:1360-1361`) points at it.

---

## 2. The new core is off, and off by default

**What it is.** `src/core/` — 5,296 production lines: `ticketAgent.ts` (1,134),
`answeringServiceLine.ts` (799), `schedulingLine.ts` (567), `pcpLine.ts` (559),
`parsing.ts`, `intentExtractor.ts`, `conversationReader.ts` — is gated on two
env vars that are unset.

**Evidence.**
```
src/core/router.ts:29   const NEW_CORE_LINES     = new Set((process.env.NEW_CORE_LINES ?? '')...)
src/core/router.ts:37   const TICKET_AGENT_LINES = new Set((process.env.TICKET_AGENT_LINES ?? '')...)
src/core/router.ts:213  if (!NEW_CORE_LINES.has(slug) && !isTicketAgentLine(slug)) return null;
```
Neither `NEW_CORE_LINES` nor `TICKET_AGENT_LINES` appears in `.replit`
`[userenv]` or `.env.production.example` — and `.replit` is where every other
line-level flag lives (`SHADOW_*`, `DIRECTOR_AGENTS`, `PCP_*`). So
`newCoreFor(slug)` returns `null` for every slug except `'demo'`
(`router.ts:47-49`, hardcoded), and `newCoreEnabled` (`router.ts:251`) is false
everywhere else. The five call sites in `src/voiceAgentRoutes.ts`
(3476, 4452, 4467, 5003) are all behind that gate.

The only live door into `src/core/` is `ticketAgentFor` (`router.ts:62`), called
from `src/standalone/demoLine.ts:634,951,1280` — the test-number transport.

**Two secondary confusions inside it.**
- `router.ts:57` points at **`src/standalone/line.ts`**, a file that does not
  exist. The directory holds `demoLine.ts`, `claudeBrain.ts`, `claudeProbe.ts`,
  `transcribers/`.
- `src/core/parsing.ts` (293 lines) is a hand-maintained stop-word list for
  pulling names out of speech — `NOT_NAME_WORDS` at line 11, `SURNAME_PARTICLES`
  at line 40. Standing instruction 3 says extraction is the LLM's job. It is not
  in the live path, so it is not currently doing harm; it is the single most
  convincing-looking piece of "how we extract names" in the repo.

**Safety note.** `newCoreFor` and `newCoreEnabled` are imported by
`voiceAgentRoutes.ts:32`; removing them breaks the build. `ticketAgentFor` and
the whole `ticketAgent.ts` tree are load-bearing for the demo line. Setting
`NEW_CORE_LINES` would switch a live line onto untested-in-production code —
do not treat "it's dead" as "it's safe to enable."

---

## 3. The replay harness proves nothing about a live line

**What it is.** `src/core/replayRealCalls.test.ts` is the control CLAUDE.md
names for "stop making Wayne the test harness." It imports `createTicketAgent`
from `src/core/ticketAgent.ts` (line 18) — the module item 2 shows is
unreachable in production.

**Evidence.** `replayRealCalls.test.ts:18` `import { createTicketAgent } from
'./ticketAgent'`. `ticketAgent.ts`'s non-test importers are `conversationReader`,
`intentExtractor`, `replay/replayCall.ts` and `router.ts` — all inside the
same unreachable island. The live answering-service agent is
`src/agents/answeringServiceAgent.ts` (1,298 lines), which shares no parsing
code with `src/core/parsing.ts`.

Same shape elsewhere in `src/core/`: `answeringServiceLine.test.ts` (430),
`schedulingLine.test.ts` (385), `ticketAgent.test.ts` (879), `pcpLine.test.ts`,
`afterHoursLine.test.ts`, `router.test.ts` — 2,570 test lines against modules no
caller reaches.

**Why the cost is critical.** A red-then-green demonstration in
`replayRealCalls.test.ts` is exactly the evidence CLAUDE.md instruction 8 asks
for, and it can be produced without touching the code that answers the phone.

**Safety note.** Nothing breaks if these are deleted; the loss is the corpus of
real caller utterances (~15 real `call_sid`s with transcribed speech), which is
genuinely valuable data and should be moved, not dropped.

---

## 4. Departments, request types and reasons — four tables, four answers

**What it is.** The ticket taxonomy exists in four places with different
contents.

| Where | Constant | Contents |
|---|---|---|
| `src/config/answeringServiceTicketing.ts:1` | `ANSWERING_SERVICE_DEPARTMENTS` | `OPTICAL:1, SURGERY:2, TECH:3, RESEARCH:11, CEC_NETWORKING:12` |
| `src/config/answeringServiceTicketing.ts:9` | `DEPARTMENT_MAP` | same five, lower-cased keys |
| `src/config/afterHoursTicketing.ts:3` | `ANSWERING_SERVICE_DEPARTMENTS` | `OPTICAL:1, SURGERY_COORDINATION:2, TECH_SUPPORT:3` |
| `src/agents/tools/createTicketTool.ts:5` | `DEPARTMENTS` | `OPTICAL:1, SURGERY:2, TECH:3, CEC_NETWORKING:12, MEDICAL_RECORDS:16` |
| `src/tools/queueRouting.ts:45-59` | bare consts | `OPTICAL 1, SURGERY 2, TECH 3, HVA_HUB 9, MEDICAL_RECORDS 16` |

**Do they agree? No.** Two constants share the *same name* in two config files
with *different keys*: `SURGERY` vs `SURGERY_COORDINATION`, `TECH` vs
`TECH_SUPPORT`. `src/agents/answeringServiceAgent.ts:928` does
`ANSWERING_SERVICE_DEPARTMENTS[department.toUpperCase()]` where `department`
comes from `detectDepartment` returning `'surgery'`. Against the
`answeringServiceTicketing` copy (which is the one it imports, line 15) that
resolves to `2`. Against the `afterHoursTicketing` copy it would resolve to
`undefined`. Only the import line keeps that from being a live bug.

Department 9 (HVA Hub) and 16 (Medical Records) exist in `queueRouting` and
`createTicketTool` and in neither config file. Department 11 (Research) and 12
(CEC) exist in the config and not in `queueRouting`.

`REQUEST_TYPES` is duplicated too — `answeringServiceTicketing.ts:25` vs
`afterHoursTicketing.ts:11`. Same IDs, different names for them
(`LASIK_REFRACTIVE:11` vs `LASIK_SURGERY:11`; `OCULOPLASTIC_SURGERY:13` vs
`GLAUCOMA_SURGERY:13`), and the after-hours copy adds alias keys that collide
(`APPOINTMENT:8` = `PATIENT_ASSISTANCE:8`, `URGENT_TRANSFER:12` =
`RETINAL_SURGERY:12`). `REQUEST_REASONS` likewise
(`answeringServiceTicketing.ts:46` vs `afterHoursTicketing.ts:26`), with the
after-hours copy mapping nineteen distinct concepts onto reason `212`.

**The reason fallback, which is live.** `detectRequestReason`
(`answeringServiceTicketing.ts:377`) ends:

```ts
const reasonsForType = Object.entries(REQUEST_REASON_INFO)
  .filter(([_, info]) => info.requestTypeId === requestTypeId);
if (reasonsForType.length > 0) return parseInt(reasonsForType[0][0]);
```

— when no keyword matches, return the *first* reason of the type.
`src/tools/hubTaxonomy.ts:22-29` names this function by path as the cause of
**6,905 tickets wrongly stamped reason 153 in department 3, plus 224 in
department 9 and 13 in department 8**. It is called on every answering-service
ticket (`answeringServiceAgent.ts:927-945`, `generalServiceTools.ts:107-124`).
The per-queue taxonomies (`opticalTaxonomy`, `surgeryTaxonomy`, `techTaxonomy`,
`medicalRecordsTaxonomy`) each carry an explicit `*_CATCHALL` built to avoid
this — and none of them is reachable from the answering-service agent.

**Safety note.** `DEPARTMENT_MAP` is used once, inside its own file
(`answeringServiceTicketing.ts:502`); it is not externally imported but is not
removable without editing line 502. `afterHoursTicketing`'s copies are live —
imported by `afterHoursAgent.ts:9`, `noIvrAgent.ts:20`, `noIvrAgentV2.ts:12`,
`syncAgentService.ts:7`. Nothing here is deletable outright; the finding is that
five tables must be reconciled, not pruned.

---

## 5. The medication cue list, three times, all different

| Where | Line | Contents |
|---|---|---|
| `src/config/answeringServiceTicketing.ts` | 331 `techKeywords` | ~35 terms: brand names (restasis, xiidra, lumigan, latanoprost, timolol, combigan), pharmacies (cvs, walgreens, rite aid, costco pharmacy), **plus** `callback`, `call me`, `records`, `referral`, `forms`, `message`, `question`, `help` |
| `src/agents/tools/createTicketTool.ts` | 28 `MEDICATION_KEYWORDS` | ~28 terms: the same brand names and pharmacies, **no** generic words, **no** Spanish |
| `src/tools/queueRouting.ts` | 185 `TECH_CUES_STRONG` + 193 `TECH_CUES_AMBIGUOUS` | 12 terms: `refill, pharmacy, medication, medicine, eye drop, eyedrop, prior auth, medicamento, medicina, farmacia, gotas` + `prescription, receta, rx` |

**They disagree, three ways.** Only `queueRouting` has Spanish. Only
`queueRouting` lacks the brand names. Only `answeringServiceTicketing` treats
`question` and `help` as medication signals — which is why *any* generic
answering-service call with the word "help" in the description classifies as
department 3.

All three are live: `techKeywords` via `detectDepartment`;
`MEDICATION_KEYWORDS` inside `createTicketTool`'s validator (no-ivr, optical,
surgery, tech, records file through it); `TECH_CUES` via `detectCrossQueue`,
imported by eleven modules.

**Safety note.** Nothing found — all three have callers. This is a
reconciliation, not a deletion.

---

## 6. Queue greetings: three sources, two of them disagree

**What it is.** The line the practice answers with exists in three places per
queue, with a precedence chain nobody can read off a single file.

1. `agents.welcome_greeting` in the database — **wins**
   (`voiceAgentRoutes.ts:4414-4419`, `src/services/greetingResolver.ts:52`).
2. The route literal, stamped into `callMetadata`
   (`voiceAgentRoutes.ts:6252,6262,6274,6285,6297`).
3. The agent module's own `*AgentConfig.greeting`
   (`opticalAgent.ts:74`, `surgeryAgent.ts:88`, `techAgent.ts:63`,
   `recordsAgent.ts:57`, `answeringServiceAgent.ts:196`) — registered into
   `src/config/agents.ts` and read by the Grok runtime
   (`laneRegistry.ts:339` `greeting: config.greeting`).

**Two disagreements, quoted.**

*Optical* — `opticalAgent.ts:74`:
> "Thank you for calling Azul Vision optical. All of our opticians are currently
> assisting other **patients**, but I can take a message…"

`voiceAgentRoutes.ts:6262`:
> "Thank you for calling Azul Vision optical. All of our opticians are currently
> assisting other **customers**, but I can take a message…"

*Answering service* — `answeringServiceAgent.ts:196`:
> "Hello, thank you for calling Azul Vision, all of our **operators** are
> currently on the phone assisting other patients, how may I help you today?"

`voiceAgentRoutes.ts:6252`:
> "Hello and thank you for calling Azul Vision, all of our **agents are currently
> busy, but I am here to assist**, how can I help you?"

Surgery, tech and records match between their two copies, character for
character.

**Why it matters beyond wording.** Every queue prompt is written on the premise
that the greeting already played — `opticalAgent.ts:105`: *"Your greeting has
already played. Do NOT greet again."* The Grok runtime carries
`config.greeting` (source 3); the SIP path carries the route literal (source 2)
unless the DB overrides both. Three different strings can satisfy that premise,
and `laneRegistry.ts:225-239` records that the runtime not reading it at all
caused three cold-open calls on 2026-08-31.

A fourth, wholly disconnected copy: `server/seedAgents.ts:40,66,91,122,135,166,218`
carries seven more `welcomeGreeting` strings. That file has **zero importers**
(§16) and is only runnable by hand (`npx tsx server/seedAgents.ts`, per its own
line 2 and `TESTING_GUIDE.md:106`).

**Safety note.** The route literals are what `callMetadata` carries when the DB
lookup times out (1.5s, `greetingResolver.ts:32`) — they are the fallback, not
decoration. Removing them means a lost DB lookup produces silence.

---

## 7. Provider and location rosters — four copies plus a live query

| Where | Line | Size | Status |
|---|---|---|---|
| `src/config/answeringServiceTicketing.ts` | 277 `PROVIDERS` | **15** providers | **LIVE** — `findProviderByName`/`getProviderName`, called at `answeringServiceAgent.ts:933,945,1084,1087` and `generalServiceTools.ts` |
| `src/config/answeringServiceTicketing.ts` | 241 `LOCATIONS` | **33** locations | **LIVE** — `findLocationByName`, `answeringServiceAgent.ts:932,1076,1079` |
| `src/config/azulVisionKnowledge.ts` | 205 `AZUL_VISION_PROVIDERS` | **18** providers with bios | **LIVE** — `buildProvidersReference` → `knowledgePack.ts:136` and `buildPcpPublicKnowledgePrompt` → `pcpAgent.ts:563` |
| `src/services/providerNameCorpus.ts` | 132 `PROVIDERS_SNAPSHOT` | **91** names | **test-only** — file has 1 importer, `providerCorpus.test.ts` |
| `src/services/consoleDirectory.ts` | — | live query, "77 providers, 105 locations" | **LIVE** |
| `src/services/providerRoster.ts` | — | live `Schedule` query, 90-day window | **LIVE** — feeds transcription keyterms |

**Evidence of staleness, measured.** Cross-checking `AZUL_VISION_PROVIDERS`'s 18
names against `PROVIDERS_SNAPSHOT`'s 91 (the roster its own header dates to
2026-08-11), four have **no surname match at all**: `Claudia Montana-Collins,
O.D.`, `Anne Grattan, O.D.`, `Shabnam Habibi, O.D.`, `Lauren Liang-Chang, O.D.`
Those four names go into the knowledge pack every agent's prompt is prefixed
with (`knowledgePack.ts:136`).

`PROVIDERS` (15) is a strict subset of the 91 — every name resolves, but 76
providers are missing, so `findProviderByName` returns `undefined` for them and
the ticket goes out with no provider.

**The stated rule and the fourth copy.** `consoleDirectory.ts:9-13` says, in its
own words:

> *"Before it, 'is this string a real provider?' was answered by a hardcoded list
> in this repo — which is precisely the kind of fourth copy the rule exists to
> prevent."*

That hardcoded list is still there, still imported, still 15 rows, and
`consoleDirectory.ts:14-17` quantifies the cost of a name it cannot resolve:
**5,184ms → 10,741ms** median wait, **4.1% → 21.5%** of turns over fifteen
seconds.

**Safety note.** All three hardcoded tables have live callers. `LOCATIONS`/
`PROVIDERS` cannot be removed without replacing `findLocationByName` and
`findProviderByName` at four call sites in `answeringServiceAgent.ts`.
`PROVIDERS_SNAPSHOT` is safe to delete only together with
`providerCorpus.test.ts`.

---

## 8. `src/director/` never fires

**What it is.** 1,122 production lines and 834 test lines of turn-level
enforcement — the module CLAUDE.md's `.agents/memory/director-enforcement.md`
covers — gated on an env var that is explicitly set to empty.

**Evidence.**
```
src/director/director.ts:1113  export function directorAgents(env) {
                                 return (env.DIRECTOR_AGENTS ?? '').split(',')...filter(Boolean); }
src/director/director.ts:1120  directorEnabledFor(slug) => directorAgents(env).includes(slug)
.replit:                       DIRECTOR_AGENTS = ""
```
Empty list ⇒ `includes()` is false for every slug ⇒ all six call sites are dead:
`voiceAgentRoutes.ts:2502, 2522, 3608, 3708, 3764` and
`azulSchedulingAgent.ts:994`. `src/director/director.ts:1116` says so itself:
*"Empty = disabled everywhere."* `src/services/carriedAcross.test.ts:109`
confirms: *"Latent rather than live: DIRECTOR_AGENTS is empty in production."*

**Why the cost is high.** `agentCapabilities.test.ts:158-171` asserts that the
director resolves its ceiling by capability rather than slug — a green,
carefully-argued test for behaviour that has never run on a call.

**Safety note.** `director`, `directorEnabledFor` and `DirectorAction` are
imported at `voiceAgentRoutes.ts:39` and `azulSchedulingAgent.ts:45`;
`isTicketOnly` from `agentCapabilities` is imported *by* the director. Deleting
it means editing both importers. Enabling it is a behaviour change on a live
line, not a cleanup.

---

## 9. "Nothing else may keep its own list" — except one thing does

**What it is.** `src/config/agentCapabilities.ts` was written (header, lines
1-39) to end four disagreeing slug lists, and its rule is stated as: *"a
capability is a property of the agent, declared once here… nothing else may keep
its own list."* Its conformance test even greps the four old homes to prove they
are gone (`agentCapabilities.test.ts:138-156`).

A fifth list exists and the test does not look at it.

| Source | Line | Can transfer |
|---|---|---|
| `AGENT_CAPABILITIES` | `agentCapabilities.ts:114-139` | `no-ivr, dev-no-ivr, no-ivr-v2, pcp, azul-scheduling` |
| `TRANSFER_CAPABLE_LANES` | `laneRegistry.ts:116` | `no-ivr, no-ivr-v2, dev-no-ivr, azul-scheduling, pcp, **runtime-proof**` |
| `RUNTIME_TRANSFER_READY_LANES` | `laneRegistry.ts:140` | `no-ivr, no-ivr-v2, dev-no-ivr, pcp, runtime-proof` |

**Do they agree? No.** `runtime-proof` is transfer-capable in `laneRegistry` and
**absent entirely** from `AGENT_CAPABILITIES`. `capabilitiesOf('runtime-proof')`
therefore returns `UNKNOWN_AGENT` (`agentCapabilities.ts:155`) —
`canTransfer: false` — and logs *"'runtime-proof' is not in AGENT_CAPABILITIES."*
So the one lane built specifically for proving the runtime end to end is
declared able to transfer by the runtime and unable to transfer by the registry.

Also absent from `AGENT_CAPABILITIES`: `drs-scheduler`, `fantasy-football`,
`demo` — all three are registered or routed.

**Safety note.** Nothing found for the *disagreement* — reconciling is additive.
`laneRegistry`'s sets cannot be replaced by `capabilitiesOf` without importing
`src/config/agents` into the runtime, which `laneRegistry.ts:343-348`
deliberately avoids.

---

## 10. Four slug allowlists, and two registered agents that cannot be reached

| List | Line | Members |
|---|---|---|
| `agentRegistry` | `src/config/agents.ts:37-242` | no-ivr, dev-no-ivr, **no-ivr-v2**, after-hours, answering-service, optical, surgery, tech, records, **runtime-proof**, azul-scheduling, pcp, drs-scheduler, appointment-confirmation, fantasy-football |
| `validAgentSlugs` | `voiceAgentRoutes.ts:2297` | …no `no-ivr-v2`, no `runtime-proof`; **adds `demo`** |
| `validInboundAgents` | `voiceAgentRoutes.ts:5353` | …also no `dev-no-ivr` |
| `AGENT_CAPABILITIES` | `agentCapabilities.ts:77` | …no `runtime-proof`, `drs-scheduler`, `fantasy-football`, `demo` |

**Consequence.** A call arriving with `X-agentSlug=no-ivr-v2` or
`runtime-proof` hits `voiceAgentRoutes.ts:2313` `!validAgentSlugs.includes(...)`,
falls to the DB check, and — unless someone created a matching active row in
`agents` — is **coerced to `after-hours`** (line 2325) while the call record
looks normal. There are five such coercion sites: 2304, 2325, 5364, 5390, 5485.

The coercion target is itself described by `agentCapabilities.ts:88-91` as
*"Legacy slug, 4 calls ever. NOT the after-hours line — that is no-ivr."* So the
system's failure mode is to answer with an agent it documents as legacy.

`src/agents/agentWiring.test.ts` exists precisely because this class of gap
answered Optical's first three live calls as after-hours (its header, lines
1-24). It reads all three lists out of the routes file as text — which means the
guard depends on `const validAgentSlugs = [` and `const validInboundAgents = [`
never being renamed (it asserts exactly that, lines 49 and 68).

**Safety note.** Nothing found for adding the two missing slugs. `demo` must
stay in `validAgentSlugs` — `voiceAgentRoutes.ts:2291-2296` records that its
absence answered the demo line as after-hours three times.

---

## 11. `lookup_patient` still reads the appointment book

**What it is.** Exactly the violation CLAUDE.md instruction 14 describes, still
present.

**Evidence.**
- `src/tools/sharedPatientTools.ts:65` registers `lookup_patient`; line 113
  does `await import('../services/scheduleLookupService')`.
- `src/services/scheduleLookupService.ts:2` — `import { schedule } from
  '../../shared/schema'` — the Operations Hub's own `Schedule` copy.
- `src/services/patientVerification.ts` (which reads `patients_master`) has
  exactly two non-test importers: `src/core/router.ts:118` (the unreachable new
  core, §2) and `src/standalone/demoLine.ts:346` (the test-number transport).
- `lookup_patient` is the first tool on `optical` (`opticalAgent.ts:84`),
  `surgery` (`surgeryAgent.ts:98`), `tech` (`techAgent.ts:73`), `records`
  (`recordsAgent.ts:67`) and `runtime-proof` (`runtimeProofAgent.ts:48`).

**Safety note.** `scheduleLookupService` also supplies visit history, last
provider and last office — `sharedPatientTools.ts:16-19` records that
`lookup_patient` skipping surgery centres broke optical office resolution. It is
not replaceable by `patientVerification` alone; the two answer different
questions.

---

## 12. A prompt-editing subsystem nothing on the call path reads

**Three layers, none of them reaching an agent.**

1. **`prompt_versions` + `promptGovernanceService`** — `shared/schema.ts:1289`
   defines the table and `:1282` its enum; `src/services/promptGovernanceService.ts`
   (125 lines: `createVersion`, `promoteVersion`, `rollbackTo`) has **zero
   importers** anywhere in the repo. `drizzle-kit push` still creates the table.
2. **`agent_prompts` + `agent_prompt_versions`** — `shared/schema.ts:898,924`.
   Four routes (`server/routes.ts:682,693,704,744`) and three storage methods
   (`server/storage.ts:952-990`). `grep -rn "agent-prompts" client/src` returns
   **nothing** — no UI calls them. And nothing in either call path reads
   `agent_prompts`: the only reads are routes 695 and 710, both inside the CRUD
   handlers themselves.
3. **`agents.system_prompt`** — read once, at `voiceAgentRoutes.ts:3071`, and
   only in the `else` branch for an agent that is **not** in the hardcoded
   registry. Every production agent is in the registry, so no live line's prompt
   comes from the database.

**The trap.** `PUT /api/agent-prompts/:slug` (`routes.ts:704`) accepts a
`greeting` field and writes it to `agent_prompts.greeting`. The greeting that
actually plays comes from `agents.welcome_greeting`, a different column in a
different table (`greetingResolver.ts:37`). An operator editing "the greeting"
through that endpoint changes nothing and gets a 200.

**Safety note.** `promptGovernanceService.ts` is deletable today — zero
importers, and its table has no other reader. The `agent_prompts` routes are
deletable only if no external caller uses them (no client code does; check for
n8n or external tooling first).

---

## 13. `hubTaxonomy.ts` — the header describes wiring that does not exist

**What it is.** 199 lines, department 9, and **zero non-test importers**.

**Evidence.** `src/tools/hubTaxonomy.ts` is imported by exactly one file:
`src/tools/hubTaxonomy.test.ts`. The dependency runs the other way —
`hubTaxonomy.ts:67` `import { fold, SCHEDULING, SPECIALIST_CUES } from
'./queueRouting'`.

Its own header, lines 53-58, says:

> *"It is not an agent's taxonomy… it is the reason table that `queueRouting`
> uses when it files a scheduling request into department 9 on another queue's
> behalf."*

`queueRouting.ts` does not import it, and cannot — `queueRouting.ts:211-214`
explains that the reverse dependency would be a cycle, and duplicates
`SPECIALIST_CUES` locally for that reason. The HVA-hub routing that actually
runs is `detectCrossQueue` (`queueRouting.ts:252-303`), which emits
`requestTypeId: 32` and one of the six `SCHEDULING` reason IDs — never any of
`hubTaxonomy`'s interpreter (54/293/294) or eligibility pairs.

There is no `hubTools.ts` and no `file_hub_ticket` tool. The registered tool
names are: `check_open_tickets, classify_optical_request, classify_records_request,
classify_request, classify_surgery_request, classify_tech_request, create_ticket,
file_optical_ticket, file_records_ticket, file_surgery_ticket, file_tech_ticket,
lookup_patient, lookup_schedule, request_human_handoff, resolve_location,
schedule_patient_in_phreesia, submit_otp_code`.

`src/tools/serverRegistration.test.ts:47` nonetheless cites *"file_records_ticket
and **file_hub_ticket** were callable on a live call and 404 over HTTP"* as a
historical defect. Half of that sentence describes a tool that has never
existed.

**Safety note.** Deleting `hubTaxonomy.ts` also removes
`hubTaxonomy.test.ts`; nothing else references either. The 90-day ticket
analysis in its header (lines 6-64) is the highest-value content in the file and
belongs in `docs/` if the code goes.

---

## 14. The tool HTTP surface refuses every request

**What it is.** `src/tools/server.ts` publishes the whole tool library over
HTTP, is mounted unconditionally (`server/index.ts:428-435`), and fails closed.

**Evidence.**
```
src/tools/server.ts:38  const expected = process.env.VOICE_TOOL_API_KEY;
src/tools/server.ts:40  if (!expected) return false;   // Fail CLOSED
src/tools/server.ts:47-51  logs "VOICE_TOOL_API_KEY is NOT set, the HTTP surface
                            will refuse every request"
```
`VOICE_TOOL_API_KEY` is not in `.replit` or `.env.production.example`
(credential-class caveat). Both routes — `GET /api/tools` and
`POST /api/tools/:name` — return 401 for every caller when it is unset.

`src/tools/serverRegistration.test.ts` (the guard that every agent tool is also
published here) therefore tests the completeness of a surface that answers
nothing.

**Safety note.** Nothing found. The registry itself is live — the agents call
tools in-process through `realtimeAdapter.ts`, not over HTTP. Only the HTTP door
is shut.

---

## 15. `/api/voice/warm-transfer-status` is registered twice

**Evidence.**
- `src/voiceAgentRoutes.ts:7298` — the real handler: reads `CallStatus`, records
  the transfer outcome, rejects the pending accept.
- `src/voiceAgentRoutes.ts:7338` — commented *"Legacy warm transfer status
  callback - kept for backwards compatibility but no longer used"*, logs
  `[WARM-TRANSFER-STATUS] Received callback (warm transfer disabled)`.

Express dispatches to the first match, and the first handler calls
`res.sendStatus(200)` without `next()`. The second body is unreachable; its log
line can never appear. It is the only duplicated route path in the repo
(checked across `voiceAgentRoutes.ts`, `server/routes.ts`, `tools/server.ts`,
`demoLine.ts`, `claudeProbe.ts`).

Nearby and contradicting it: `voiceAgentRoutes.ts:383` reads
`// Note: warm transfer functionality has been removed`, immediately above the
state maps, while five warm-transfer routes and `src/runtime/warmTransfer.ts`
(367 lines of tests) exist.

**Safety note.** Nothing found for deleting the second registration — it is
provably unreachable.

---

## 16. Orphan files — zero importers, ~1,400 lines

Confirmed by both the reachability walk and a per-basename `grep -rl "from
'…<name>'"` across `src/`, `server/`, `scripts/`, `client/`.

| File | Lines | Note |
|---|---|---|
| `src/utils/contactValidation.ts` | 261 | 5 exported validators (`validatePhoneNumber`, `validateEmail`, `validateDateOfBirth`, `validateName`, `validatePatientContact`). `validateName` is regex name-checking — instruction 3's exact target. **0 importers, 0 test references.** |
| `src/services/promptGovernanceService.ts` | 125 | §12 |
| `src/middleware/twilioWebhookValidation.ts` | 66 | `validateTwilioWebhook`, `optionalTwilioValidation`. **0 importers.** Twilio signature checking is done in `src/runtime/voiceWebhook.ts` (`checkTwilioSignature`) instead — and that is the transport with no traffic. The live SIP routes use `webhookRateLimiter` only. |
| `src/agents/tools/documentTicketTool.ts` | 47 | `document_ticket` tool, superseded by `createTicketTool.ts` (`create_ticket`, 331+ lines with hard-requires). **0 importers.** Its schema still says `1=Optical, 2=Surgery Coordinator, 3=Clinical Tech` — no records, no hub. |
| `src/tools/hubTaxonomy.ts` | 199 | §13 (test-only) |
| `src/core/replay/gateBRunner.ts` | 121 | The Gate B runner CLAUDE.md quotes numbers from. **0 importers**, not in `package.json` scripts, not in `.replit`. |
| `server/productionServer.ts` | 111 | An alternative combined server. Referenced only by `scripts/start-production.sh:16`, which nothing runs — `.replit [deployment]` runs `npx tsx server/index.ts & npx tsx src/server.ts`. |
| `server/seedAgents.ts` | 294 | 7 `welcomeGreeting` strings (§6). Hand-run only. |
| `server/seedFantasyFootballData.ts` | 115 | Hand-run only. |
| `server/testTicketingConnection.ts` | 106 | Hand-run only; hardcodes `+16262229400` at line 37. |
| `server/services/supabaseSchedulingClient.ts` | 306 | `SupabaseSchedulingClient` + singleton. **0 importers.** Scheduling now goes through the Eye Care service's `sage_*` HTTP tools (`azulSchedulingAgent.ts:24`). |
| `src/testing/agentTests.ts` / `outboundTestRunner.ts` | 119+ / 30+ | Partly live: `runAgentTest` (`routes.ts:4038`) and the `testRunner` singleton (`routes.ts:3927,3942,3957,4006,4252`) are used. `AGENT_TEST_SUITES`, `runAllAgentTests` and the `OutboundTestRunner` class export are not. |
| `src/voiceAgent/services/stateManager.ts` | 90 | Exports `voiceAgentState`, an extracted call-state manager. `voiceAgentRoutes.ts:35` imports only `registerTicketingSyncRoutes` from the barrel and keeps its own maps at lines 370-382. An abandoned extraction: `CallMetadataEntry` at line 4 is a verbatim duplicate of the inline type at `voiceAgentRoutes.ts:370`. |

**Safety note.** All thirteen are removable as far as static imports go. Three
caveats: `seedAgents.ts` is referenced by `TESTING_GUIDE.md:106` as a documented
manual step; `gateBRunner.ts` produces the numbers CLAUDE.md quotes, so deleting
it deletes the ability to reproduce them; `start-production.sh` would need to go
with `productionServer.ts`.

---

## 17. Dead exports inside live files

897 exported symbols were scanned. Those with **no reference of any kind
anywhere else**, in files that are otherwise live:

**Config.**
- `src/config/agents.ts:259` `getAgentFactoryByNumber` — **0 callers**. It would
  not work anyway: only `answering-service` has a non-empty `twilioNumbers`
  (line 93, `['+19094135645']`); the other fourteen registrations pass `[]`, so
  the loop can never match and every call returns the `no-ivr` fallback at line
  266. `src/config/agents.ts:32` `AgentRegistry` (the class) is also unreferenced
  outside its own file — only the `agentRegistry` singleton is imported.
- `src/config/knowledgeBase.ts` — a **dead island of ~300 lines**.
  `buildGreeterSystemPrompt` (line 109) and `buildTicketingSystemPrompt`
  (line 216) have 0 importers, and they are the *only* consumers of
  `NON_URGENT_REQUESTS` (31), `TICKETING_FIELDS` (42), `GREETINGS` (68) and
  `AGENT_PROMPTS` (83). The file's only live exports are `URGENT_SYMPTOMS`
  (imported by `noIvrAgent.ts:13`, `workflowPromptBuilder.ts:15`,
  `shadow/reasoning.ts:9`) and the re-exported `getCurrentDateTimeContext`.
  `AGENT_PROMPTS.medicalDisclaimer` reads like the fleet's safety prompt. It is
  used by nothing.
- `src/config/azulVisionKnowledge.ts:347` `buildCallerContext` — 0 external refs.
- `src/config/transcription.ts:167` `CLINICAL_KEYWORDS`, `:196` `callerHintEnabled`.
- `src/config/environment.ts:340,344,348,360` `getDatabaseUrl`, `getDomain`,
  `getWebhookBaseUrl`, `clearConfigCache`.

**Middleware.** `src/middleware/rateLimiter.ts:40,89,95` `createRateLimiter`,
`apiRateLimiter`, `authRateLimiter` — only `webhookRateLimiter` is used.
`src/middleware/cacheControl.ts:11,23` `apiCacheHeaders`,
`staticAssetCacheHeaders` — only `noCacheHeaders` is used
(`voiceAgentRoutes.ts:5064`).

**Services.** `src/services/resilienceUtils.ts` — `voiceAgentRoutes.ts:27`
imports five of its seventeen exports; `resilientFetch` (381), `CircuitOpenError`
(286, used internally only), `OPENAI_RETRY_CONFIG` (45), `OPENAI_CIRCUIT_CONFIG`
(88), `TWILIO_CIRCUIT_CONFIG` (94) have no external callers.
`src/services/structuredLogger.ts:123-126` `callLogger`, `webhookLogger`,
`ticketingLogger`, `resilienceLogger` — four named loggers, none imported (every
log site in the repo is `console.*`).
`src/services/csvCostImport.ts:69,91,254`; `src/services/graderLexicons.ts:14,29`
`MEDICAL_ADVICE_PHRASES`/`PATTERNS`; `src/services/phiSanitizer.ts:30`
`redactGraderResult`; `src/services/callEventLog.ts:128` `getCallEvents`;
`src/services/consoleDirectory.ts:285` `getDirectory`;
`src/services/providerRoster.ts:143` `refreshProviderRoster`;
`src/services/azulRegressionWatch.ts:138` `runRegressionCheck`.

**Runtime (already dead per §1, listed for completeness).**
`mediaStreamBridge.ts:153,171,182,199` `guardsAllowedTermination`,
`DEFAULT_MAX_CALL_MS`, `DEFAULT_DEAD_AIR_MS`, `DEFAULT_END_CALL_TOOL_NAMES`;
`runtimeTransfer.ts:193` `toPcpHandoffOutcome`; `transcriptLog.ts:46`
`normalizeSpokenText`; `voiceWebhook.ts:52,112,119` `VOICE_PATH_PREFIX`,
`buildUnavailableTwiml`, `resolveRequestBase`; `warmTransfer.ts:141`
`BRIEFING_BUDGET_MS`.

**Server.** `server/services/dbResilience.ts:188,221,254,275,279`
(`withCircuitBreaker`, `acquireConnectionWithRetry`, `executeWithTimeout`,
`getRetryConfig`, `getTimeoutConfig`) — the entire public surface of that module
except what `databaseKeepAlive` uses; `server/services/emailService.ts:558`
`verifySmtpConnection`; `server/services/healthMetrics.ts:22`
`getDatabaseHealthMetrics`; `server/services/staleCallSweeper.ts:57,148`
`sweepStaleCalls`, `stopStaleCallSweeper`; `server/services/ticketingSyncPolicy.ts:7`
`NO_TICKET_GRACE_MS`; `server/observatory/dailyBrief.ts:107` `generateDailyBrief`;
`server/observatory/fivestarDb.ts:17` `isFivestarConfigured`; `server/auth.ts:26,77,591`
`requireAuth`, `requireAdmin`, `createFirstAdmin`.

**Schema.** `shared/schema.ts` — 15 `pgEnum` exports and 11 `relations` exports
with no reference outside the file (lines 38, 41, 97, 140, 176, 220, 325, 337,
345, 604, 647, 655, 665, 678, 690, 702, 776, 783, 799, 874, 991, 998, 1005,
1012, 1224, 1237, 1252, 1282, 1313, 1346). Drizzle relations are declaratively
useful even unimported; the enums are not.

**Only-called-by-tests** (a different category — the code is real but has never
been wired to a caller): `src/tools/afterHoursTaxonomy.ts` (6 exports),
`src/tools/surgeryTaxonomy.ts:336,423,479` `SURGERY_LOGISTICS`,
`SURGERY_CATCHALL`, `isSurgeryReasonId`, `src/tools/techTaxonomy.ts:211`
`TECH_REASON_IDS`, `src/tools/opticalTaxonomy.ts:123`
`OPTICAL_CONTACTS_STATUS_CUES`, `src/tools/cueMatch.ts:30,32` `SHORT_CUE_MAX`,
`cueMatches`, `src/shadow/contracts.ts` (13 zod schemas, 8 with no reference at
all).

**Safety note.** Every symbol above is unreferenced by static analysis, but
three patterns can hide a caller and were checked and found absent here:
`export *` re-export chains (only `src/workflows/index.ts` and
`src/shadow/index.ts` use them, and both were followed), string-keyed dynamic
dispatch, and the tool registry's import-for-side-effect pattern
(`src/tools/server.ts:28-34`, `runtimeProofAgent.ts`). Anything registered by
side effect is *not* in the list above.

---

## 18. `PCP_AGENT_DIDS` — set in config, parsed twice, ignored

**Evidence.**
- `.replit` sets `PCP_AGENT_DIDS = "+17143990670,+19097291250,+17143990721,+17143990681"`
  and `PCP_ROUTING_MODE = "sequential"`.
- Parsed at `src/config/environment.ts:255` and again, independently, at
  `src/voiceAgentRoutes.ts:101`.
- Passed to `resolvePcpDialSequence` at `voiceAgentRoutes.ts:1489`.
- `src/services/handoffPolicy.ts:107-118` **ignores the parameter entirely**:
  it returns `[queue]` and logs *"PCP_ROUTING_MODE=sequential is a testing mode
  and no longer changes routing."*
- `src/agents/pcpAgent.ts:75` calls the roster "retired."

The branch that *is* still taken (`voiceAgentRoutes.ts:1510`) loops over a
one-element array and logs `PCP sequential attempt 1/1`. Its failure return
(`voiceAgentRoutes.ts:1512`) reports `reason: 'pcp_agent_dids_not_configured'`
when what is actually missing is `PCP_HUMAN_AGENT_NUMBER`. That reason string
lands in the call record and points a future reader at the wrong env var.

**Safety note.** Removing `PCP_AGENT_DIDS` from `.replit` also silences the
warning at `handoffPolicy.ts:116`, which is the only thing telling anyone the
setting is inert. Remove the setting and the code path together, not one of
them. PCP is OFF in Twilio (CLAUDE.md line-status table), so nothing exercises
this today.

---

## 19. Shadow sub-systems behind flags that are off

`SHADOW_MODE_ENABLED = "true"` and `SHADOW_CAPTURE_PCT = "100"` in `.replit`, so
capture is live and `.shadow-spool/` holds real data
(`sessions-2026-08-30.jsonl`, 620 KB). These parts are not:

| Flag | Default | Set in `.replit`? | What is inert |
|---|---|---|---|
| `SHADOW_N8N_ENABLED` | `false` (`config.ts:101`) | no | `n8nSimulator.ts` (its own line 69: *"Inert unless SHADOW_N8N_ENABLED"*), `n8nBudget.ts`, the whole 14-field budget block at `config.ts:100-121` |
| `SHADOW_DUPLICATE_READONLY_ENABLED` | `false` (`config.ts:99`) | no | the duplicate read-only tool path in `toolSimulator.ts` |
| `SHADOW_STORE_TRANSCRIPTS` | `false` (`config.ts:81`) | no | transcript persistence |
| `SD_SHADOW` | unset (`sdShadow.ts:72` requires `'1'`/`'true'`) | no | `src/core/shadow/sdShadow.ts`, mounted at `src/server.ts:223` |
| `AB_MODEL_B` / `AZUL_AB_MODEL_B` | unset | **commented out** in `.replit` | `src/services/abCarriage.ts` returns `{}` on every call (line 31). The `.replit` comment records why: disabled 2026-08-03 after a bad call. |

`src/services/abCarriage.test.ts` has 6 tests, all of which supply the env vars
by hand — the module's production behaviour (return `{}`) is one line.

**Safety note.** The A/B block in `.replit` carries a written instruction not to
re-enable it until the bad call is diagnosed. Leave the commented lines; they
are the record.

---

## 20. Stale build marker and junk

- **`build-info.json`** is committed and says
  `{"builtAt":"2026-08-12T16:19:33.341Z","gitSha":"3f4ec74"}` — twenty days old.
  `package.json`'s `build` script regenerates it, but the committed value is
  what a reader sees. CLAUDE.md's whole "how to tell whether a deploy actually
  took" section depends on markers being trustworthy; this one is not.
- **`=`** — a zero-byte file at the repo root (`-rw-r--r-- 1 root root 0 Aug 21
  18:35 =`), a shell redirect accident.
- **`.shadow-spool/`** — 696 KB of captured session JSONL committed into the
  working tree.
- **`src/runtime/readiness.ts:28`** `VOICE_RUNTIME_DEPLOY_MARKER =
  "voice-runtime-v2-transfer-guardrails-tools"` (superseded 2026-09-05 by
  `voice-runtime-v3-precontext-diagnosable-20260905`, which carries its date)
  — a deploy marker for a
  transport that has never served a call, printed at every boot next to the SIP
  path's markers.

**Safety note.** `build-info.json` is read by `server/buildInfo.ts`; deleting
the file rather than the value would break that reader. The `=` file and
`.shadow-spool/` have no readers (`spoolDir` defaults to `'.shadow-spool'` at
`config.ts:82` and is written to, not read).

---

## Appendix A — tests that pin the wrong thing

**What was sampled.** The ten largest test files by line count
(`mediaStreamBridge` 2,120, `voiceRuntime` 1,419, `ticketAgent` 879,
`director` 834, `grokSession` 790, `demoLine` 766, `surgeryTools` 656,
`opticalTools.production` 613, `reconciliationExportHelpers` 589,
`medicalRecordsTools` 552), plus all 20 files that call `readFileSync`, plus
`agentCapabilities.test.ts`, `agentWiring.test.ts`, `callbackTiming.test.ts`,
`serverRegistration.test.ts`, `realLanes.test.ts`, `replayRealCalls.test.ts`.
Roughly 12,000 of 33,276 test lines.

**A1 — 22% of the test suite covers a transport with no traffic.**
`src/runtime/` holds 7,613 test lines; `src/core/` holds 2,570. Neither answers
a call (§1, §2). `src/voiceAgentRoutes.ts`, which answers all of them, has no
test file.

**A2 — `realLanes.test.ts` asserts a refusal that does not hold in production.**
Line 79-84 asserts `laneSupportStatus(config)` is truthy for
`['no-ivr','pcp','azul-scheduling','after-hours','fantasy-football']` — but it
calls it **without** `{ transferAvailable }`. `laneRegistry.ts:167` refuses on
`!opts.transferAvailable`, so the assertion is satisfied by the default. In
production `mountVoiceRuntime` builds a real transfer
(`voiceRuntime.ts:352-356`), under which `pcp` is served
(`RUNTIME_TRANSFER_READY_LANES`, line 140 includes `pcp`). The test would stay
green if the entire runtime-transfer feature were deleted. The whole file is
also `describe.skipIf(!ENABLED)` on `RUNTIME_LANE_SMOKE === "1"` (line 35),
which is not set anywhere — so **the only test that touches the real agent tree
does not run**, by its own header's admission (lines 20-27).

**A3 — source-text assertions that pin names, not behaviour.** Twenty test files
`readFileSync` production source. Examples:
- `agentCapabilities.test.ts:151-156` counts occurrences:
  `expect(uses.length).toBe(2)` for `/filesTickets\(agentSlug\)/g` in an
  8,594-line file. A third legitimate call site fails the test; deleting both
  and the feature passes it only if the negative assertion on line 155 also
  holds.
- `agentWiring.test.ts:49,68` fail with *"validAgentSlugs has moved or been
  renamed"* — the guard is coupled to two variable names.
- `agentCapabilities.test.ts:170` `expect(src).not.toMatch(/\btech: TICKET_ONLY_CEILING/)`
  — asserts the absence of a string in another file.

These are honest about being crude (`agentWiring.test.ts:21-23`: *"They read the
transport as text, which is crude, and that is the point"*). The cost is that a
rename reads as a failure and a behaviour change may not.

**A4 — `opticalTools.production.test.ts` mocks away what it is named for.**
21 tests. `vi.mock('../services/consoleDirectory')` at line 55 and
`vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService:
{ lookupPatient: async () => REAL_CONTEXT } }))` at line 99. Both data sources
are replaced by fixtures. The header (lines 4-6) says *"every value below was
read out of production on 2026-08-11, not invented"* — true of the fixture
*contents*, not of the path. What is verified is `lookup_patient`'s logic over
a frozen snapshot; the file name says the opposite.

**A5 — `callbackTiming.test.ts` is the good counter-example, worth copying.**
Lines 97-105 explicitly refuse to pin a phrase:
> *"'is that correct?' was banned; the model asked 'is this the best one to reach
> you?' and satisfied the letter of it. A prompt that forbids a string forbids
> nothing."*
and then asserts `not.toMatch(/do not ask "is that correct\?"/i)` — a test that
the prompt does **not** contain a string ban. It tests the timing rule
(`/THE NUMBER COMES BEFORE THE TICKET/`, `/already filed/i`) instead. This is the
only place in the suite that distinguishes the two.

**A6 — one skipped test.** `src/runtime/realLanes.test.ts` (A2) and one
`describe.skip` inside `src/agents/transferHoldLadder.test.ts`. No `.only` and
no `it.todo` anywhere.

---

## Appendix B — the same rule in two places, at a glance

| Rule | Copy A | Copy B | Copy C | Agree? |
|---|---|---|---|---|
| Department IDs | `answeringServiceTicketing.ts:1` | `afterHoursTicketing.ts:3` | `createTicketTool.ts:5`, `queueRouting.ts:45-59` | **No** — different keys, different membership |
| Request types / reasons | `answeringServiceTicketing.ts:25,46` | `afterHoursTicketing.ts:11,26` | — | **No** — same IDs, different names, colliding aliases |
| Medication cues | `answeringServiceTicketing.ts:331` | `createTicketTool.ts:28` | `queueRouting.ts:185,193` | **No** — Spanish in one, brand names in two, generic words in one |
| Optical greeting | `opticalAgent.ts:74` "patients" | `voiceAgentRoutes.ts:6262` "customers" | `agents.welcome_greeting` (DB) | **No** |
| Answering-service greeting | `answeringServiceAgent.ts:196` | `voiceAgentRoutes.ts:6252` | `agents.welcome_greeting` (DB) | **No** — different sentences |
| Surgery / tech / records greeting | agent config | route literal | DB | **Yes** (A vs B identical) |
| Who can transfer | `agentCapabilities.ts:114-139` | `laneRegistry.ts:116,140` | — | **No** — `runtime-proof` in one only |
| Valid agent slugs | `agents.ts:37-242` | `voiceAgentRoutes.ts:2297` | `voiceAgentRoutes.ts:5353` | **No** — `no-ivr-v2`, `runtime-proof`, `dev-no-ivr`, `demo` differ |
| Provider roster | `answeringServiceTicketing.ts:277` (15) | `azulVisionKnowledge.ts:205` (18) | `consoleDirectory` (77, live) / `providerNameCorpus.ts:132` (91, test) | **No** — 4 of 18 in copy B are not in the 91 |
| Location roster | `answeringServiceTicketing.ts:241` (33) | `azulVisionKnowledge.ts:12` (31) | `consoleDirectory` (105, live) | **No** |
| Callback number before filing | `rampEngine.ts:198,240` (code, answering-service/pcp/SD) | queue prompts, pinned by `callbackTiming.test.ts` | — | **Yes** — both put the number before the ticket |
| Surgery is exempt from the HVA-hub rule | `queueRouting.ts:288` `if (!mentionsSurgery)` | — | — | single source |
| Workflow engine | `src/workflows/workflowEngine.ts` (471) | `src/shadow/workflowEngine.ts` (216) | — | different jobs, same filename — naming collision only |
| "Director" | `src/director/director.ts` (turn enforcement, 1,122) | `src/pcp/director.ts` (PCP intake state, 400) | — | different jobs, same filename |
| Prompt versioning | `agent_prompts` + `agent_prompt_versions` (`schema.ts:898,924`) | `prompt_versions` + `promptGovernanceService` (`schema.ts:1289`) | — | **No** — neither is read on a call |

---

## Appendix C — reproducing this

```bash
# orphan files (zero importers), from the import graph
#   entry points: server/index.ts, src/server.ts   (per .replit [deployment])

# per-symbol: does anything outside this file mention it?
grep -rn "\bSYMBOL\b" --include=*.ts src server shared scripts client \
  | grep -v "path/to/its/own/file.ts"

# duplicated constants
grep -rn "ANSWERING_SERVICE_DEPARTMENTS\|REQUEST_TYPES =\|REQUEST_REASONS =" \
  --include=*.ts src

# env-gated branches: compare what the code reads against what is configured
grep -rhoE "process\.env\.[A-Z_0-9]+" --include=*.ts src server \
  | sort -u > used.txt
grep -oE '^[A-Z_0-9]+' .replit | sort -u > set.txt
comm -23 used.txt <(sed 's/^/process.env./' set.txt)

# duplicate route registrations
grep -oE "app\.(get|post|put|delete)\(\s*['\"][^'\"]+" src/voiceAgentRoutes.ts \
  | sort | uniq -c | awk '$1>1'
```
