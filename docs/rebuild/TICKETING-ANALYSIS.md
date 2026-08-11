# Ticketing tools — run down to one avenue

**Part 3 of the rebuild spec.** Source of truth: the **Support Center**
Supabase project `vsmcxhxeirkoobmjcrbn` (`Replit_Ticketing_App`) —
43,136 tickets, 16 departments, 60 request types, 288 request reasons, and
**102,866 rows of `voice_agent_api_logs`** recording every voice-agent API call
with status, latency, validation errors and request body.

Everything below is measured, not inferred.

---

## 0. Correction to Part 1

`TOOL-LIBRARY-SPEC.md` §1.2 claimed *"after-hours tickets are probably landing
in Tech Support"* because `afterHoursTicketing.ts` sets
`AFTER_HOURS_DEPARTMENT_ID = 3` while department 8 is "After Hours Call
Service". **The data disproves that.** Department 8 received **999 tickets in
90 days** (698 from `no-ivr`, 177 from `answering-service`, 101 from another
agent). Routing works.

The same correction applies to the Medical Records claim: department 16 is
absent from `ANSWERING_SERVICE_DEPARTMENTS`, yet it received **467 tickets, 401
of them from `answering-service`.**

**Why both constants are wrong and nothing broke:** the live path does not use
them. The endpoint carrying 97% of the volume classifies **server-side** (§2).
The department/type/reason constants in this repo are largely **dead code that
no longer describes the running system.** That is its own hazard — anyone
reading the repo to learn the taxonomy learns something false — but it is not
causing misrouted tickets.

---

## 1. The authoritative departments

| ID | Department | Tickets (90d) |
|---|---|---|
| 3 | Technicians Support | **9,318** |
| 2 | Surgery Coordination | **5,149** |
| 1 | Optical Support | 1,728 |
| 9 | HVA Hub | 1,653 |
| 8 | After Hours Call Service | 999 |
| 15 | OCS Hub | 715 |
| 16 | Medical Records | 467 |
| 18 | PCP Support | 174 |
| 17 | Locations | 168 |
| 5 | IT Department | 122 |
| 4 | Billing | 69 |
| 7 | Marketing | 26 |
| 6 | Facilities | 11 |
| 13 | Azul Payor Portal Support | 0 |
| **11** | **Research** | **0 — ever** |
| **12** | **CEC Networking** | **0 — ever** |

`ANSWERING_SERVICE_DEPARTMENTS` in this repo lists Research (11) and CEC
Networking (12), which have **never received a ticket**, and omits Medical
Records (16), which receives 467. The repo's list is wrong in both directions.

---

## 2. Three endpoints, one avenue

| Endpoint | Calls (90d) | Errors | p50 | p95 | p99 | Max |
|---|---|---|---|---|---|---|
| `/api/voice-agent/update-call-data` | 35,144 | 16 (0.0%) | 784ms | 2.7s | 6.6s | 49s |
| **`/api/voice-agent/submit-ticket`** | **18,263** | 8 (0.0%) | 3.6s | **22.8s** | **32.7s** | **319.7s** |
| `/api/voice-agent/create-ticket` | 453 | 19 (**4.2%**) | 1.7s | 4.1s | 4.7s | 6.0s |

### The two ticket-creation paths are architecturally different

**`submit-ticket` — the real one, 40× the volume.** Its body is:

```
patientFullName, patientDOB, patientPhone, patientEmail,
reasonForCalling, additionalDetails, preferredContactMethod,
lastProviderSeen, locationOfLastVisit, callData, idempotencyKey
```

**No `department_id`. No `request_type_id`. No `request_reason_id`.** The agent
states facts; **the server classifies.** That is why it is slow — it is doing
the routing work — and it is also why it is *right*.

**`create-ticket` — the agent supplies the IDs.** This is what the 18-parameter
`create_ticket` in `answeringServiceAgent.ts` targets. It is fast (p99 4.7s)
but carries 453 calls against 18,263.

### The decision: standardise on `submit-ticket`'s contract

Server-side classification is what makes **small department prompts possible.**
If an agent must supply `department_id` / `request_type_id` /
`request_reason_id`, then every agent needs the 16 × 60 × 288 taxonomy in its
prompt — which is precisely the giant-prompt problem the rebuild exists to
remove. A refill agent should say *"Wayne Fabian, DOB 03/17/1973, needs a
Latanoprost refill, callback 845-531-7471, prefers text"* and nothing more.

`submit-ticket` is architecturally correct and operationally slow. **Fix the
latency; keep the contract.** Retire `create-ticket` and the 18-parameter tool
with it.

`idempotencyKey` is already in the contract — retries are safe.

---

## 3. The latency is a dead-air source

| | over 5s | over 15s | over 30s | over 75s |
|---|---|---|---|---|
| `submit-ticket` | 4,642 (25%) | **1,379 (7.6%)** | 222 | **72** |

**One in four ticket submissions leaves the caller waiting more than five
seconds. One in thirteen waits more than fifteen.** The p95 is 22.8 seconds and
the worst case is **5 minutes 20 seconds** on a live call.

This is very likely a real contributor to the 186 calls averaging 19.7 minutes
found in `PLATFORM-DECISION.md` §2, and it is the strongest candidate for why
callers hear silence after "give me one moment while I get this submitted."

**AssemblyAI's `timeout_seconds` maxes at 300.** The 319-second worst case
would exceed even the maximum permitted timeout.

The ticketing app's source is not in this repo, so I cannot say *what* is slow.
The shape — sub-second reads, multi-second writes with a long tail — points at
synchronous work after insert (auto-assignment across 24 rules and 44 targets,
notifications, collaborator fan-out). **The fix is to return as soon as the
ticket is persisted and do assignment and notification asynchronously.** That
needs confirming against that app's code.

---

## 4. Location resolution — 18 of 19 validation failures

Every `create-ticket` validation failure but one:

```
No active location matches 'Azul Vision Oceanside'   ×9
No active location matches 'Azul Vision Encinitas'   ×8
No active location matches 'Encinitas Front Office CG' ×1
```

The `locations` table holds **bare city names** — `Oceanside` (32),
`Encinitas` (31), `West Hills` (41). The agent sends the brand-prefixed name it
uses with callers. **Stripping a leading "Azul Vision " would fix all 17.**

A related failure appeared in a live call yesterday:
`Location "Loma Linda Surgery Center LLC" not found in system`. That is a
different class — surgery centers from the `Schedule` table are not in the
33-row `locations` table at all. **The library needs one location resolver**
that normalises the prefix, matches case-insensitively, and returns a clean
"unknown location" rather than failing the whole ticket.

---

## 4b. CORRECTION — the real location/provider failure rate, from 18,263 calls

§4 above was drawn from the 19 `create-ticket` validation failures and
concluded the brand prefix was the problem. **That sample was too small and the
conclusion was wrong.** `submit-ticket`'s `response_body` records
`locationSearched` / `locationMatched` / `providerSearched` / `providerMatched`
on every call. Over 90 days:

| Lookup | Attempted | Failed | Rate |
|---|---|---|---|
| **Location** | 15,411 | **2,385** | **15.5%** |
| **Provider** | 15,663 | **3,088** | **19.7%** |

*(Also checked: `usedFallbackReason` is a **boolean**, true on only **88 of
17,116** — 0.5%. Server-side classification is healthy. It is the lookups that
fail.)*

### Locations — the table is incomplete, not misnamed

| Failed search | Count |
|---|---|
| Magan | 113 |
| Downtown LA | 112 |
| Chevy Chase Surgery Center | 98 |
| Barranca Surgery Center | 59 |
| Ontario Adv Surgery Center | 53 |
| Glenwood Surgery Center | 50 |
| Loma Linda Surgery Center LLC | 49 |
| Aurora Surgery Center | 33 |
| Mobile DRS | 29 |
| H Jones Surgery Center | 27 |
| Beaumont | 23 |

**`select count(*) from locations where name ilike '%surgery%'` returns 0.**
The 33-row table holds clinics only. Surgery centers — where the surgery
coordinators' patients actually go — do not exist in it at all. Neither do
Magan, Beaumont, or the Mobile DRS unit.

`Downtown LA` fails against an existing row named `Los Angeles`: an alias
problem, not a missing one.

**The brand prefix is real but marginal.** The dominant cause is missing
records. This is a **data problem, not a code problem.**

### Providers — three separate causes

| Failed search | Count | Cause |
|---|---|---|
| OCT-VF | 217 | **a test, not a provider** |
| A-Scan | 123 | **a test, not a provider** |
| DRS | 108 | **a screening, not a provider** |
| Todd Mishima, OD | 132 | **exists in `providers` — the `, OD` suffix breaks the match** |
| Evelyn Perez, OD | 131 | genuinely missing from `providers` |
| Amir Shama, OD | 81 | **exists — same suffix problem** |
| Unknown / Dr. Lee | 34 | unresolvable input |

1. **~448 failures are diagnostic codes being passed as a provider.** This is
   the exact hazard the answering-service prompt already warns about — *"the
   schedule's last provider seen may be a scan, test, or technician (e.g.
   'A-Scan'), not the caller's doctor."* The warning is in the prompt; nothing
   enforces it in the tool.
2. **Credential suffixes break matching.** `Mishima` and `Shama` are both in the
   92-row `providers` table, but `"Todd Mishima, OD"` does not match. Stripping
   `, OD` / `, MD` before comparison fixes ~200 failures on its own.
3. A genuine gap: some optometrists are not in the table.

### What the library owes

- **One provider resolver** that strips credential suffixes, rejects the known
  test codes (`OCT-VF`, `A-Scan`, `DRS`, `Unknown`) as *not a provider* rather
  than searching for them, and returns "unresolved" without failing the ticket.
- **One location resolver** per Part 4 §3 — but the bigger fix is **loading the
  surgery centers and satellites into `locations`.** No amount of string
  matching finds a row that isn't there.

---

## 5. What the answering service actually does

Department 3 "Technicians Support" is the biggest bucket, but it is **not a
technical support department in practice.** Its 90-day answering-service
tickets:

| Request type | Tickets | % |
|---|---|---|
| **Medication Requests** | **4,008** | 63.2% |
| Patient Assistance | 1,254 | 19.8% |
| Prescription Assistance | 750 | 11.8% |
| Medication Refill | 327 | 5.2% |

**Medication-related work is 5,085 of 6,339 — 80% of that department, and the
single largest thing the answering service does.**

### Agent roster, sized by evidence

| Proposed agent | 90-day volume | Source |
|---|---|---|
| **Medication / Refills** | **~5,085** | dept 3, types 6/7/33 |
| **Surgery Coordination** | 3,251 | dept 2 |
| **Optical** | 1,569 | dept 1 |
| Patient Assistance | 1,254 | dept 3, type 8 |
| HVA Hub | 789 | dept 9 |
| OCS Hub | 559 | dept 15 |
| **Medical Records** | 401 | dept 16 |
| After Hours | 177 | dept 8 |
| Billing | 36 | dept 4 |

Your instinct to make Medication Refills its own agent is the highest-value
split available — it is 80% of the largest department and about a third of all
answering-service tickets. Research and CEC Networking should not exist as
agents; they have never received a ticket.

---

## 6. Security finding — surface immediately

Supabase reports **Row Level Security disabled** on three tables in the Support
Center project: `counselor_roster`, `schedule_date_presets`,
`surgeon_counselor_scopes`. Anyone holding the anon key can read or modify every
row. All three are currently empty, which limits exposure today.

**Do not enable RLS blindly** — enabling it without policies blocks all access.
The remediation is Wayne's call:

```sql
ALTER TABLE public.counselor_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_date_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surgeon_counselor_scopes ENABLE ROW LEVEL SECURITY;
```

---

## 7. The one avenue, per tool

| Capability | The one avenue | State |
|---|---|---|
| Create a ticket | `POST /api/voice-agent/submit-ticket` | **works — fix latency** |
| Enrich with call data | `POST /api/voice-agent/update-call-data` | **works** (p95 2.7s) |
| Create with explicit IDs | `create-ticket` | **retire** |
| Resolve a location | *(does not exist)* | **build** — §4 |
| Look up a patient | `lookup_schedule` → Operations Hub | wrap as HTTP |
| Verify a patient | `patients_master` mirror | wrap as HTTP |
| Scheduling (21 tools) | Eye Care service | already HTTP |

---

## 8. Next

1. Confirm with the ticketing app's code what makes `submit-ticket` slow, and
   move assignment/notification off the request path.
2. Build the location resolver and prove it against the 33 real rows.
3. Wrap `lookup_schedule` and patient verification as HTTP endpoints.
4. Then, and only then, point an agent at them.
