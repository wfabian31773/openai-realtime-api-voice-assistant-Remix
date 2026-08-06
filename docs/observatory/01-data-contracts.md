# Observatory data contracts

Last reviewed: 2026-08-06

Every widget reads through `hub/observatory_queries.py`; this file is the
authoritative map of what feeds what. Two read-only connections:

- **OPSHUB** — Operations Hub Supabase (project `pslzngjciiifowemrzza`)
- **FIVESTAR** — 5Star Supabase (project `ttbypvstnnfcvmwbgqyy`)

## Agents roster

| Agent | Source of truth |
|---|---|
| Answering Service, Azul Scheduling (SD Pilot), No-IVR After-Hours, PCP Support | OPSHUB `agents` (id, name, model config) |
| SAGE | FIVESTAR (single agent; version/experiment from `sage_agent_versions`, `sage_voice_experiments`) |

## Six pillars — sources

### Ops Hub agents (per agent_id)

| Pillar | Tables/columns |
|---|---|
| Crashing | `call_logs` telephony/status error columns; `daily_reconciliation` |
| Hallucinating* | `call_logs` grader critical-failure columns (14-check scorecard: criticalFailures, medical_advice_guardrail, question_repetition, handoff_expected_vs_actual, interruption_rate). *Inferred from grader criticals — no dedicated guard table on this side.* |
| Looping | `call_logs.total_turns` (>45-turn calls), interruption averages |
| Quality | `call_logs.quality_score` (n/5) |
| Latency/Telemetry | `call_turns` timing columns; `active_call_sessions` |
| Outcomes | `call_logs.agent_outcome` (resolved / escalated / transferred / inconclusive) |
| Cost | `daily_openai_costs`, `daily_twilio_costs`, `daily_org_usage` |

### SAGE (FIVESTAR)

| Pillar | Tables/columns |
|---|---|
| Crashing | `sage_voice_call_telemetry.openai_error_count`, `tool_error_count`, `reconnect_count`; `sage_tool_calls.outcome/error_message` |
| Hallucinating | `sage_hallucination_incidents` (guard hits); `sage_booking_validation_warnings.warning_reason` |
| Looping | director feed "Assistant response loop detected" (`handoff_attempts.reason`); repeat-guard logs |
| Quality | `sage_call_reviews` (8 sub-scores), `sage_review_runs` aggregates |
| Latency | telemetry `response_latency_*`, `greeting_latency_ms`; director decision latency (monitor feed) |
| Outcomes | `call_logs.outcome` + `sage_kpi_daily_snapshots` (inbound/outbound scheduled rates, frustration) |
| Director health | `handoff_attempts.reason` classes: `reasoning_timeout`, `safety_validation_failed`, `invalid_structured_reasoning`, loop-detected — count/hour + consecutive-burst detection |
| Cost | **gap** — no per-call cost columns; display "untracked" honestly |

## Funnel stages (SAGE reference implementation)

| Stage | Query sketch |
|---|---|
| reached | `call_logs` outbound answered + inbound, `sms_logs` delivered (`purpose='outreach'`, `delivered_at`) |
| engaged | calls with outcome NOT IN (voicemail, no_answer, wrong_number, patient_unavailable, abandoned); SMS link clicks (`link_clicked_at`) + replies |
| booked | `internal_bookings` where `booked_by_name LIKE 'AI Voice Agent%'` (by created week) |
| entered | status ∈ (entered_in_nextgen, completed, no_show) OR later terminal via sweep; staff action = `mark-entered` endpoint |
| materialized | `nextgen_appointment_id IS NOT NULL` (mirror match) |
| kept | status = completed (reconciler verdict incl. roster date-of-service rescue) |
| loss reasons | cancelled (with/without note class), `pending_orphan_review`, staleness-deferral counts (`staleDeferredCount` in sweep summaries), auto-cancel guard notes |

Ops Hub funnel v1 is shallower (reached → engaged → resolved/booked →
escalated) until its booking write-back lands; the contract records that
asymmetry rather than faking parity.

## Live plane

| Feed | Mechanism |
|---|---|
| Ops Hub live calls (ALL 4 agents) | `active_call_sessions` (current calls) + `call_turns` (turn stream, written in real time by the shared pipeline). Observatory Socket.IO namespace polls/pushes deltas. The SD pilot's existing live view proves the data path; the Observatory generalizes the UI. |
| SAGE live calls | Phase B: 5Star service-token WebSocket relay wrapping its in-memory `subscribeToTranscript` feed (voice lane change in 5Star, small). Until then: near-live via `sage_voice_call_telemetry` in-flight rows + latest `call_logs` transcript refresh. |

## Freshness / integrity signals (surfaced on the Observatory header)

- FIVESTAR `nge_schedule_sync_state.last_run_at` (mirror age vs 25h SLA;
  the #173 gate defers destructive verdicts when stale — show both)
- FIVESTAR `release_history` latest deploy (and whether main is ahead —
  the repo-vs-prod divergence that bit twice this week)
- OPSHUB `ScheduleSyncState` / `ChargeSyncState` ages; the frozen
  `public."Schedule"` copy (since 2026-07-15) until retired
- Morning-sync runner outcome (5Star `docs/runbooks/morning-sync.md`) via
  watchdog state

## Known gaps (stated on-screen, never faked)

- SAGE per-call cost untracked → fleet spend covers Ops Hub only.
- SAGE runtime telemetry covers a minority of historical calls (began
  mid-May); trends before that are directional.
- Ops Hub "hallucination" is grader-inferred, not guard-confirmed.
- Handoff→appointment attribution on Ops Hub side pending disposition
  logging (5Star's `resulted_in_appointment` pattern is the model).
