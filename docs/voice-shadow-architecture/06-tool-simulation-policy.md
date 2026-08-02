# 06 — Tool-Simulation Policy (Checkpoints 10 & 11)

Authoritative implementation: `src/shadow/toolPolicies.ts`. Every production tool of
every active agent has a policy row. `executionMode` is the literal `'simulation-only'`
for all shadow records; the shadow module holds **no client capable of executing any
of these tools** (module-graph test enforced).

Legend — R: read-only, M: mutating, n8n: traverses the VA Gateway (doc 13).

## 1. Per-tool policy table

| Tool | Agents | R/M | n8n | Allowed intents | Allowed states | Required fields | Confirmation | Idempotency | Retry | Replayable |
|---|---|---|---|---|---|---|---|---|---|---|
| lookup_schedule | no-ivr, answering-service | R | no | any scheduling/hours intent | any active | none | no | n/a | 2 | yes |
| check_open_tickets | no-ivr, answering-service | R | no | ticket status | any active | callerPhone | no | n/a | 2 | yes |
| classify_request | answering-service | R (local) | no | any | collect/validate | reason text | no | n/a | n/a | yes |
| emit_decision | no-ivr | R (log) | no | any | any | none | no | n/a | n/a | yes |
| create_ticket | no-ivr, answering-service, dev-no-ivr | **M** | **yes** (submit-ticket gateway) | ticket-worthy intents | validate→simulate_tool only | name, phone, reason | **yes** (read-back) | key `call-{callSid}` expected; absence = DF-1 flag | ≤1 recommend; never re-recommend after success | yes (copied gateway response) |
| create_after_hours_ticket | after-hours | **M** | **yes** (submit/create gateway) | triage outcomes | validate→simulate_tool | name, phone, reason, urgency | yes | as above | ≤1 | yes |
| escalate_to_human / transfer_to_human | no-ivr, after-hours | **M** (call state) | no | urgent/explicit request | any (urgency bypass allowed) | reason | no (urgency) | once per session | 1 | partial (transfer events) |
| terminate_call | all | **M** (call state) | no | completion/farewell | complete | none | no | once | 0 | yes (session_completed) |
| get_appointment | appointment-confirmation | R | no | confirmation flow | any active | contactId | no | n/a | 2 | yes |
| confirm_appointment (campaign) | appointment-confirmation | **M** | no | confirm | confirm state, after read-back | apptId, patient assent | **yes** | once per appt | 0 | yes |
| reschedule_request / cancel_appointment (campaign) | appointment-confirmation | **M** | no | resched/cancel | after confirmation | apptId, assent | **yes** | once | 0 | yes |
| mark_confirmed / mark_voicemail | appointment-confirmation | **M** | no | outcome recording | terminal states | contactId | no | once | 0 | yes |
| lookup_patient / mark_contact_completed | drs-scheduler | R / **M** | no | DRS flow | active / terminal | contactId | no / no | once | 1/0 | yes |
| Phreesia scheduling/OTP | drs-scheduler | **M** (external form) | no | DRS booking | simulate only — production currently inert (`computer=undefined`) | patient fields, OTP | yes | n/a | 0 | no (no production result exists) |
| getPlayerInfo/Stats/compare/top | fantasy-football | R | no | any | any | player names | no | n/a | 2 | yes |
| sage_decision, sage_precontext, sage_patient_context, sage_availability, sage_info, sage_insurance_check, sage_practice | azul-scheduling | R | no | scheduling | per workflow (decision gate FIRST) | per tool | no | n/a | 2 | yes |
| verify_patient_identity | azul-scheduling | R (sensitive) | no | identity phase | identity state only | lastName+DOB+phone4 | no | n/a | ≤3 (production caps retries; shadow flags at 2) | yes — **match/no-match only; identifiers never compared/stored** |
| get_patient_appointments / get_appointment_details / lookup_location / list_locations / lookup_provider / get_provider_locations | azul-scheduling | R | no | scheduling | post-identity where PHI | per tool | no | n/a | 2 | yes |
| sage_book | azul-scheduling | **M** | no | booking | confirm→simulate_tool, after offer-token + read-back | offer token, verified identity, slot | **yes** | offer-token single-use | 0 (booking_status contract) | yes |
| sage_reschedule / sage_confirm_appointment / cancel_appointment (NextGen) | azul-scheduling | **M** | no | resched/confirm/cancel | after identity + read-back | apptId/ordinal, assent | **yes** | once per appt | 0 | yes |
| sage_new_patient_intake | azul-scheduling | **M** | no | new-patient | after identity-nonmatch path | demographics set | **yes** | guarded (duplicate-chart near-miss 2026-07-23) | 0 | yes |
| sage_handoff | azul-scheduling | **M** (callback packet + ticket) | no | handoff/escalation | any (urgency bypass) | reason, callback number | no | once | 1 | yes |
| transfer_to_office | azul-scheduling | **M** (live dial) | no | transfer | transfer-eligible hours | office | no | once | 1 | partial |
| sage_record_transfer_bridge / sage_resolve_callback | azul (system) | **M** (telemetry) | no | system | system | ids | no | once | 1 | yes |

## 2. Simulation record requirements (every proposed call)

Recorded exactly as doc 04 §4: tool, validated args (zod per-tool schemas),
allowed status + validation code, missing fields, confirmation requirement,
`executionMode: 'simulation-only'`, and production-replay metadata
(`matched`, result digest) when a copied production result exists for the turn.

## 3. Production-result replay rules

- Copied production tool results (T3) and gateway responses (T4) are the **only**
  source of "what the tool returned".
- Shadow never independently calls a production mutation to reproduce a result.
- Read-only duplicate execution (e.g. re-running `lookup_schedule` for divergence
  measurement) is governed by `SHADOW_DUPLICATE_READONLY_ENABLED` (default **false**),
  a rate limit (`SHADOW_DUPLICATE_READONLY_PER_HOUR`, default 10), a read-only-tool
  allowlist, and the cost budget. **Not implemented in this phase** — flag reserved,
  documented as off; enabling requires the deployment approval gate.

## 4. n8n-backed tool adapters (Checkpoint 11)

For `create_ticket`/`create_after_hours_ticket` (the n8n-traversing tools):

| Field | Value |
|---|---|
| Production workflow | `yS1ZZG4Dt5uGwuPo` (submit-ticket), `O3Irc3cL1YKy9HdD` (create-ticket) |
| Trigger contract | POST + `X-API-Key` header (doc 13 §2) |
| Input schema | submit: {patientFullName, patientPhone, reasonForCalling, patientDOB?, patientEmail?, preferredContactMethod?, idempotencyKey?, callData{callSid, agentUsed, timings…}}; create: taxonomy-ID form (departmentId, requestTypeId, requestReasonId, split DOB) |
| Output schema | app response verbatim: `{ticketId | ticket:{id,…}, …}` + HTTP status |
| Read-only/mutating | **mutating** (forward creates tickets) |
| Replayable | yes — T4 copies both directions |
| Mock available | yes — deterministic fixtures for tests |
| Dedicated shadow workflow | not required (bundle covers reporting; doc 15 §3) |
| Execution impact | 0 (copies only); duplicates prohibited |

Simulated n8n requests are recorded per doc 04 §4 with `mutationBlocked: true`,
budget impact 0 (or 1 for an enabled bundle send), and replay availability.

## 5. Caller-facing response hygiene

Proposed responses/questions generated by the shadow must never contain raw errors,
stack traces, DB details, credentials, internal URLs, or identifiers the caller did
not themselves provide (zero-identifier rule inherited from the sage contract).
A response-sanitizer stage enforces this before any proposed text is stored.
