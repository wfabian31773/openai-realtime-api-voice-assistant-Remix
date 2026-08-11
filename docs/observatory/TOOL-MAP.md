# Tool Map — every tool, every agent, every backend

Generated 2026-08-11 by walking `src/agents/**`, `src/agents/tools/**`,
`src/tools/**` and `src/config/agents.ts`.

**Why this exists:** to answer "what would we have to carry over if we moved the
voice pipeline to a managed platform (Vapi / Retell / LiveKit / Pipecat)."
The headline: **69 tool definitions across 12 agents, and the single largest
group is already HTTP.**

Note on counting: the raw scan finds 72 `tool({`/`recordedTool({` sites; three
of those are the `recordedTool` wrapper declarations themselves, not tools.
`computerTool({ computer })` on the DRS agent is unnamed by design.

---

## 1. Agents, and whether they are live

| Agent | Slug | Tools | Status |
|---|---|---|---|
| Overflow Answering Service | `answering-service` | **5** | **LIVE** — 579 calls Aug 10 |
| No-IVR | `no-ivr` | **6** | **LIVE** — ~30–50/day, quality benchmark |
| No-IVR v2 | `no-ivr-v2`, `dev-no-ivr` | 7 | registered, not the live path |
| After Hours | `after-hours` | 3 | registered |
| PCP Professional | `pcp` | **8** | **OFF in Twilio** (see `/CLAUDE.md`) |
| Azul Scheduling (San Diego) | `azul-scheduling` | **21** | **OFF** (books 8 of 21 on replay) |
| DRS Scheduler | `drs-scheduler` | 2 + Computer Use | outbound, diabetic retinopathy screening |
| Appointment Confirmation | `appointment-confirmation` | 6 | outbound |
| Database Agent | — | 2 | utility |
| Fantasy Football | `fantasy-football` | 4 | demo/unrelated to the practice |
| Shared: create ticket | — | 1 | `src/agents/tools/createTicketTool.ts` |
| Shared: document ticket | — | 1 | `src/agents/tools/documentTicketTool.ts` |
| Shared: Phreesia | — | 2 | `src/tools/phreesiaSchedulingTool.ts` |

---

## 2. The tools that matter — by agent

### answering-service (LIVE, 5 tools)
`src/agents/answeringServiceAgent.ts`

| Tool | Backend |
|---|---|
| `lookup_schedule` | Supabase **Operations Hub** → `Schedule` table via `scheduleLookupService` |
| `check_open_tickets` | `server/storage` → Supabase |
| `classify_request` | in-process reasoning + `toolDirection` |
| `create_ticket` | **HTTP** → n8n `azulvision.app.n8n.cloud/webhook` + ticketing-app |
| `terminate_call` | transport-level (ends the call) |

### no-ivr (LIVE, 6 tools)
`src/agents/noIvrAgent.ts` — `lookup_schedule`, `check_open_tickets`,
`emit_decision`, `create_ticket`, `terminate_call`, `escalate_to_human`

### pcp (OFF, 8 tools)
`src/agents/pcpAgent.ts` — `record_pcp_intake`,
`get_public_practice_information`, `lookup_patient_appointments`,
`create_pcp_task`, `record_automated_resolution`, `handoff_to_pcp`,
`handle_patient_medical_records_request`, `terminate_call`

Backends: `src/pcp/director`, `src/pcp/pcpTicketing`, `scheduleLookupService`,
`escalationStore`, `guardrails/pcpSafety`.

### azul-scheduling (OFF, 21 tools) — **already HTTP**
`src/agents/azulSchedulingAgent.ts`

The twelve `sage_*` tools plus the appointment/location/provider reads are
**already remote calls**:

```
POST {EYECARE_SCHEDULING_BASE_URL}/api/tools/<tool_name>
Authorization: Bearer ${EYECARE_AGENT_API_KEY}
default: https://eyecare-scheduling-agent-wayne-fabians-projects.vercel.app
```

`sage_decision`, `sage_patient_context`, `sage_availability`,
`sage_new_patient_intake`, `sage_book`, `sage_reschedule`,
`sage_confirm_appointment`, `sage_handoff`, `sage_info`,
`sage_insurance_check`, `sage_practice`, `sage_precontext`,
`verify_patient_identity`, `get_patient_appointments`,
`get_appointment_details`, `cancel_appointment`, `lookup_location`,
`list_locations`, `lookup_provider`, `get_provider_locations`,
`transfer_to_office`, `terminate_call`

Per-tool timeout budgets are declared in the file (`sage_book` 75s,
`sage_precontext` 5s). There is an auth-outage alarm after a 2026-07-28
incident where a rotated `EYECARE_AGENT_API_KEY` turned away three consecutive
callers for 24 minutes.

### after-hours (3)
`transfer_to_human`, `create_after_hours_ticket`, `terminate_call`

### Outbound agents
- **drs-scheduler** — `lookup_patient`, `mark_contact_completed`, plus
  `computerTool({ computer })`. Drives **Phreesia** (`z1-rpw.phreesia.net`,
  `phreesia.me`) through Computer Use.
- **appointment-confirmation** — `get_appointment`, `confirm_appointment`,
  `reschedule_request`, `cancel_appointment`, `mark_confirmed`,
  `mark_voicemail`.

---

## 3. Backends the tool layer depends on

| System | Reached by | How |
|---|---|---|
| **Supabase Operations Hub** `pslzngjciiifowemrzza` | `lookup_schedule`, `check_open_tickets`, call logging | Postgres via drizzle (`Schedule`, `call_logs`, `ticket_agent_config`) |
| **Supabase Patient-Console** `kbbmywvasbsxnbblrhot` | `patientVerification` | read-only pool → `patients_master` (909,376 persons) |
| **Eye Care Scheduling Service** (Vercel) | all 21 scheduling tools | **HTTPS + bearer token — already webhook-shaped** |
| **n8n ticketing** `azulvision.app.n8n.cloud/webhook` | `create_ticket` | **HTTPS + API key** |
| **Ticketing app** (Replit) | ticket enrichment / call data | **HTTPS** |
| **Phreesia** | DRS outbound | Computer Use (browser automation) |
| **NextGen (NGE)** | via Eye Care service | indirect |
| Sleeper API | fantasy football | unrelated |

---

## 4. What this means for moving off the OpenAI transport

**Already portable — no work.** All 21 scheduling tools and `create_ticket` are
HTTP calls with bearer/API-key auth. Any platform that can POST a JSON function
call can use them today. That is **22 of the 69 tools**, and it includes the
most valuable ones — booking, rescheduling, cancellation, identity
verification, ticket creation.

**Needs a thin HTTP wrapper — mechanical.** `lookup_schedule`,
`check_open_tickets`, `lookup_patient_appointments`, `record_pcp_intake`,
`create_pcp_task` and friends are in-process TypeScript reading Supabase. Each
becomes one Express route wrapping the existing service call. The services
(`scheduleLookupService`, `callerMemoryService`, `patientVerification`,
`appointmentAnswers`) already exist and do not change — only the entry point
does. `claudeBrain.ts` already proved these tools can be driven generically
through `invoke(runContext, jsonString)`.

**Transport-level, does not port — the platform provides it.**
`terminate_call`, `transfer_to_human`, `transfer_to_office`, `sage_handoff`,
`escalate_to_human`. These are exactly the capabilities a managed platform
gives you natively, and the ones this transport could never do (no conference
to transfer into).

**Genuinely special — plan separately.** The DRS agent's Computer Use path into
Phreesia is not a function call and does not map onto a voice platform's tool
model.

**Not migrating.** Fantasy football, database agent.

### Rough shape of the work

| Bucket | Tools | Effort |
|---|---|---|
| Already HTTP | 22 | none |
| Wrap in HTTP | ~30 | mechanical, one route each |
| Platform provides | ~10 | delete ours, configure theirs |
| Special / skip | ~7 | separate decision |

**The tool layer is not the thing standing between you and a platform
migration.** Roughly a third of it is already remote, and the rest is wrapping
service calls that already exist and already have tests.

---

## 5. Caveats

- Counts are from static analysis of `tool({`/`recordedTool({` sites. Tools
  added dynamically at runtime (e.g. `computerTool` pushed onto the DRS array
  when a Computer instance exists) are noted but not counted as named tools.
- Two agents share a `create_ticket` name with different implementations
  (`answeringServiceAgent` inline vs `tools/createTicketTool.ts`) — worth
  reconciling before exposing them as webhooks so one name means one thing.
- Same for `cancel_appointment` (`azulSchedulingAgent` and
  `appointmentConfirmationAgent`) and `lookup_schedule` (three agents).
- Effort estimates above are structural, not schedule commitments.
