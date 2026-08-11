# Tool Library — Specification

**Part 1 of the rebuild spec.** The shared library that department agents draw
from. Agents are cheap and will be rewritten; tools are the durable asset, so
they get defined, reconciled and verified first.

Source: static extraction of every `tool({...})` / `recordedTool({...})` in
`src/**`, cross-checked against the ticketing config and the live database.

**68 tool definitions → 54 unique names → ~34 real tools once duplicates are
reconciled.**

---

## 1. Before anything is built: four things are broken today

These are not migration issues. They are live inconsistencies, and every one of
them has to be settled before a tool library can exist, because a library needs
one name to mean one thing.

### 1.1 `create_ticket` is forked four ways

The single most important tool in the system — the thing the answering service
exists to do — has four incompatible signatures:

| Definition | Params | Shape |
|---|---|---|
| `answeringServiceAgent.ts` | **18** | `department_id`, `request_type_id`, `request_reason_id`, name parts, DOB, callback, subject, description, priority, location/provider id **and** name, email, `confirmation_type`, `unresolved_info` |
| `noIvrAgentV2.ts` | 10 | `request_category`, `request_summary`, `preferred_contact`, … |
| `noIvrAgent.ts` | 9 | `request_summary`, `doctor_name`, `appointment_time`, … |
| `tools/createTicketTool.ts` | (camelCase, separate schema) | `departmentId`, `requestTypeId`, `requestReasonId`, `unresolvedInfo` … |

Three different vocabularies for the same ticket: `department_id` vs
`departmentId`, `request_summary` vs `subject`+`description`,
`request_category` vs numeric IDs. **This is the number-one item to
reconcile.** One canonical `create_ticket`, snake_case on the wire, numeric IDs.

### 1.2 The department taxonomy contradicts itself

| ID | `answeringServiceTicketing.ts` | `createTicketTool.ts` | `afterHoursTicketing.ts` |
|---|---|---|---|
| 1 | Optical | Optical | Optical |
| 2 | Surgery | Surgery Coordinator | Surgery Coordination |
| **3** | **Tech** | **Tech** | **Tech Support — *and* `AFTER_HOURS_DEPARTMENT_ID = 3`** |
| 8 | — | Review queue | — |
| 11 | Research | — | — |
| 12 | CEC Networking | CEC Networking | — |
| **16** | **absent** | **Medical Records** | — |

Two live defects fall out of this:

- **After-hours is department 3 in `afterHoursTicketing.ts`, but 3 is Tech
  Support.** `knowledgeBase.ts` separately says *"Department ID (8 for
  after-hours)"*, and the review queue uses 8. **After-hours tickets are
  probably landing in Tech Support.**
- **Medical Records (16) is missing from `ANSWERING_SERVICE_DEPARTMENTS`**, yet
  the answering-service prompt has an entire section (STEP 4C, Right of Access)
  on collecting WHO / WHICH / HOW for records requests. The agent is instructed
  to gather records requests it cannot route.

**Both need your confirmation before I touch them** — these are ticketing
taxonomy decisions, not code decisions.

### 1.3 `cancel_appointment` is two different tools sharing a name

| Where | Params | Meaning |
|---|---|---|
| `appointmentConfirmationAgent.ts` | `appointment_id`, `reason` | cancel a known appointment by id |
| `azulSchedulingAgent.ts` | `appointmentOrdinal`, `reasonName`, `comment` | cancel the Nth of the appointments read to the caller |

Different contracts, different backends. They must become
`cancel_appointment_by_id` and `cancel_appointment_by_ordinal`, or the library
will hand agents the wrong one.

### 1.4 The registry table exists and is empty

`agent_tools` is already in the Operations Hub —
`id, agent_id, tool_name, tool_description, enabled, created_at` — with **0
rows**. The schema for the UI-configurable tool library you described was built
and never populated. **We should populate this rather than invent a new store.**
It needs three more columns to be sufficient: `parameters_json`, `endpoint_url`,
`timeout_seconds`.

---

## 2. The library

Grouped by domain. **Status** is what it takes to expose the tool as an HTTP
endpoint a voice platform can call.

### 2.1 Patient identity & records — *shared by every department*

| Tool | Params | Backend | Status |
|---|---|---|---|
| `lookup_schedule` | `phone`, `first_name`, `last_name`, `date_of_birth` | Operations Hub → `Schedule` | **wrap** — identical in all 3 agents, clean canonical |
| `verify_patient_identity` | — | Eye Care service | **already HTTP** |
| `check_open_tickets` | *(none)* | Hub → tickets | **wrap** — identical in all 3 agents |
| `get_patient_appointments` | — | Eye Care service | **already HTTP** |
| `get_appointment_details` | — | Eye Care service | **already HTTP** |

`lookup_schedule` and `check_open_tickets` are the easy wins: three agents, one
signature, no disagreement.

### 2.2 Ticketing — *the core of the answering service*

| Tool | Backend | Status |
|---|---|---|
| `create_ticket` | n8n `azulvision.app.n8n.cloud/webhook` | **already HTTP** — but §1.1 first |
| `classify_request` | in-process | **wrap**, or fold into the router agent |
| `document_ticket` | ticketing app | **wrap** |
| `record_pcp_intake` | `src/pcp/pcpTicketing` | **wrap** |
| `create_pcp_task` | `src/pcp/pcpTicketing` | **wrap** |
| `create_after_hours_ticket` | ticketing | **wrap** — §1.2 first |
| `record_automated_resolution` | escalation store | **wrap** |

### 2.3 Scheduling — *already a remote service, 21 tools*

All of these are already `POST {EYECARE_SCHEDULING_BASE_URL}/api/tools/<name>`
with `Authorization: Bearer ${EYECARE_AGENT_API_KEY}`:

`sage_decision`, `sage_patient_context`, `sage_precontext`, `sage_availability`,
`sage_book`, `sage_reschedule`, `sage_confirm_appointment`,
`sage_new_patient_intake`, `sage_insurance_check`, `sage_info`, `sage_practice`,
`sage_handoff`, `lookup_location`, `list_locations`, `lookup_provider`,
`get_provider_locations`

**Status: zero work.** These drop into any platform as-is.

⚠️ **`sage_book` has a 75-second timeout budget** (`sage_reschedule` also 75s,
`sage_confirm_appointment` 45s, `sage_new_patient_intake` 60s). Any platform we
choose must tolerate a 75-second tool call. AssemblyAI's "Hold" execution mode
is built for this — **it must be verified, not assumed.**

⚠️ These carry an **auth-outage alarm** added after 2026-07-28, when a rotated
`EYECARE_AGENT_API_KEY` produced 401s for 24 minutes and turned away three
consecutive callers silently. Whatever calls these tools needs that alarm.

### 2.4 Call control — *the platform provides these; ours get deleted*

`terminate_call` (×5 definitions), `transfer_to_human` (×2),
`escalate_to_human` (×2), `transfer_to_office`, `handoff_to_pcp`, `sage_handoff`

**These are exactly what failed and why PCP is offline.** This transport has no
conference to transfer into. On a managed platform they become native
capabilities plus a summary payload for the receiving human.

### 2.5 Outbound & specialist — *out of scope for the department rebuild*

`schedule_patient_in_phreesia`, `submit_otp_code` (Computer Use into Phreesia),
`lookup_patient`, `mark_contact_completed`, `confirm_appointment`,
`reschedule_request`, `mark_confirmed`, `mark_voicemail`, `get_appointment`

Fantasy football and the database agent are not part of this.

---

## 3. Effort

| Bucket | Tools | Work |
|---|---|---|
| Already HTTP | **22** | none |
| Wrap in HTTP | ~12 | one Express route each, around services that already exist and already have tests |
| Platform provides | ~10 | delete ours, configure theirs |
| Reconcile first | 4 issues | §1 — needs your decisions |
| Out of scope | ~10 | later |

The wrapping is mechanical. **§1 is the real work, and most of it is decisions
rather than code.**

---

## 4. What "the endpoints work" should mean

A tool is *verified* when, against a staging or read-only target:

1. It answers at its URL with the documented auth.
2. A known-good input returns the expected shape.
3. A known-bad input returns a clean error, not a 500 or a hang.
4. It completes inside its declared timeout — **including `sage_book` at 75s.**
5. Failure is visible across calls, not one line in one call's log (§2.3).

I can run 1, 3 and 4 against the Eye Care service and the ticketing health
endpoint without side effects. **I am not going to fire `create_ticket` or
`sage_book` against production** — those create real tickets and real
appointments. Tell me whether there's a staging target, or whether you want to
watch while I send one deliberate test through each.

### What has been probed so far (2026-08-11)

| Target | Result | What it proves |
|---|---|---|
| `eyecare-scheduling-agent…vercel.app/` | **200** | host is up |
| `…/api/tools/sage_practice` (GET) | 405 | see caveat |
| `ticketing-app…replit.app/api/health` | **200** | ticketing service is up |
| `azulvision.app.n8n.cloud/webhook` | **200** | n8n is reachable |

**Caveat, stated plainly:** a nonsense path — `/api/tools/does_not_exist_xyz` —
*also* returns 405. So the 405 proves only that the host answers and rejects
GET; **it does not prove any individual tool route exists.** Per-tool existence
needs an authenticated POST with a real body, which is step 2 above and needs a
staging target or your go-ahead.

Nothing in this table should be read as "the 21 scheduling tools work." It reads
as "the three hosts are alive."

---

## 5. What I need from you

1. **The department list.** Which get their own agent? The code says Optical,
   Surgery Coordination, Clinical Tech, Medical Records, Research, CEC
   Networking, plus Refills (a *request type*, ID 6, not a department today) —
   you named Refills and Surgery Questions as agents. Some of these are
   departments, some are request types. **Only you can say which deserve an
   agent.**

2. **The two taxonomy defects in §1.2** — is after-hours department 3 or 8, and
   should Medical Records (16) be routable from the answering service?

3. **Ticket volume by department.** I could not get it: `support_tickets` in
   the hub holds 417 rows, all `clinical_tech`, none newer than 2026-02-20, and
   `answering_service_logs` is empty. **The real ticket data lives in the
   external ticketing app.** An export of the last 90 days by department and
   request type would size every agent on evidence instead of intuition — it's
   the single most useful thing you could hand me.

4. **A staging target**, or permission for one deliberate live test per
   write-tool.
