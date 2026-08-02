# 02 — Current-State Architecture Audit (Checkpoint 3)

> Answers the Checkpoint 3 question set per active agent, with evidence.
> **[V]** = verified (file:line), **[A]** = assumption/inference. No production
> behavior was changed during this audit.

## 1. Cross-cutting answers (apply to all Remix-hosted agents)

| Question | Answer | Evidence |
|---|---|---|
| Where is intent determined? | Inside the realtime voice model, from free-form prompts. **No explicit intent classifier exists** in the live path. | prompts in `src/agents/*.ts`; no classifier module [V] |
| Intent explicit or repeatedly inferred? | Repeatedly inferred each turn from conversation context by `gpt-realtime`. | [V] |
| Structured conversation state? | Partially. Infra state (ids, transfer flags, audio ms) is structured (`callMetadataStore`, `active_call_sessions`); **conversational** state (what was asked/answered) lives only in model context + transcript, except azul (see §2.4). | [V] |
| State persisted? | Infra state yes (`active_call_sessions`, 30-min TTL); conversational state no (except azul's `si_call_sessions`). | `callSessionService.ts:6` [V] |
| Current workflow step tracked? | **No** for all agents except azul (server-side phases in `si_call_sessions`: precontext→verified→…). | `call-session.ts:27-52` [V] |
| Required fields tracked? | No explicit tracking; prompts instruct collection. n8n validator measures the resulting gaps (`g0_no_name`, `g0_no_phone`, `g0_no_reason` fire in production). | doc 13 §2.1 [V] |
| Tools callable before validation? | Yes — model may call any attached tool at any time. Guards are per-tool and partial: azul has server-side gates (`sage_decision`, read-back gate, `guardBooking`); ticket agents validate inside handlers only. | `api/tools/[name].ts:365-389` [V] |
| Conflicting tools in same turn? | Possible; no cross-tool arbitration exists. `identityArgGuard` blocks one specific class (mangled identity retries). | `identityArgGuard.ts` [V] |
| Bundled questions? | Known production failure mode; incident-documented (INCIDENT_2026-07-30_REPEATED_QUESTIONS). Loop guard caps re-asks at 3 but does not prevent bundling. | console repo docs [V] |
| Tool failures → loops? | Mitigated but real: `conversationLoopGuard` injects a directive on 3rd same-topic ask; SEV-1 "loop hardening" commits exist (scheduling repo `6b2c82f`). | [V] |
| Retries bounded? | Mixed. NextGen client: idempotent verbs only, POST never retried (`nextgen.ts:156-160`) [V]. `ticket_outbox` worker retries ticket delivery; **submit-ticket path has no wire idempotency key** — n8n flags `r1_no_key` in production, a live duplicate window. | doc 13 [V] |
| Successful mutations repeatable? | Ticket paths: guarded app-side by `idempotency_keys` only when a key is sent; outbox retry window is unkeyed → duplicate risk [V]. Booking: `sage_book` read-back confirm + `booking_status` contract mitigates [V]. |
| State reconstructed from transcript? | Yes — the model's context *is* the state for non-azul agents. Graders and loop guard also re-derive from transcript. | [V] |
| Business logic only in prompts? | Largely yes for no-ivr/answering-service/after-hours (dept mapping tables are code: `answeringServiceTicketing.ts`, `afterHoursTicketing.ts`; but *when to ask what / when to ticket* is prompt-only). Azul is the exception: rules engine + eligibility matrix server-side. | [V] |
| Voice model doubling as workflow engine? | **Yes** — for every agent except azul (partial). This is the central architectural gap the shadow system measures. | [V] |
| Tool outputs normalized? | No shared normalization; each tool returns bespoke JSON; azul tools return `say`/`agent_instruction` scripts. | [V] |
| Interruption → state loss? | Barge-in truncations are counted (`conversationLoopGuard`, routes `:2089`); truncated agent turns can lose the pending question — flagged in call audits. | [V] |
| Side questions → abandonment? | Documented risk (call audits RC-series); no mechanism returns to the unfinished workflow except the model's own attention. | [A→V console docs] |
| Behavior differs across entry points? | Yes: IVR path forces `after-hours`; SIP-header path bypasses the inbound allowlist (`:3407-3415`); Spanish IVR switches voice/lang (`:3481-3486`). | [V] |
| Logs sufficient for shadow comparison? | **Mostly yes** — this is unusually good: per-turn transcripts (memory + DB), `toolTimeline` for every tool call (PHI-allowlisted), `call_logs`, post-call grades, n8n `va_executions` audit rows. Gaps: no per-turn timestamps in some legacy rows; production *intent* is never recorded (must be inferred); n8n telemetry lives in n8n Data Tables, invisible to the app DB. | [V] |
| Explicit reasoning layer? | No (grading is post-hoc, not in-call). | [V] |
| Deterministic workflow/state engine? | Only azul, partially (server-side gates + phases). V2 prototype (`dev-no-ivr`) has a `workflowPromptBuilder` but is not production. | [V] |
| Enforced validation before tool execution? | Azul: yes (multi-layer). Ticket agents: handler-internal only. n8n gateway validation is **log-only, post-respond, enforces nothing** ("do not rely on n8n to catch a bad department", ROUTING-MAP.md:145-175). | [V] |
| n8n used for orchestration/state/routing/errors? | **No.** n8n is a passthrough audit gateway on ticket endpoints only. No orchestration, no state, no retries, no error workflows. | doc 13 [V] |

## 2. Per-agent findings and risk register

### 2.1 `no-ivr` (primary inbound)
- Highest-traffic inbound agent; also most-edited (4 PRs in last week of July).
- Defects/risks: prompt-only workflow; ticket submission per call through n8n gateway
  (~215/day measured); `r1_no_key` fires on the outbox retry path → duplicate tickets
  possible [V]; DB prompt copy stale (`seedAgents.ts:175-218` unused at runtime) —
  documentation drift risk [V]; hours questions historically mis-ticketed (fixed in
  #59 — recurrence watch).

### 2.2 `answering-service`
- Local `classify_request` maps to dept/type/reason tables — the only inbound agent
  with a structured classification step [V]. Taxonomy skew still occurs downstream:
  ticketing app silently rewrites depts (`VOICE_ALLOWED_DEPARTMENTS` → dept 8;
  `ROUTING-MAP.md:184-198`) — **stored taxonomy ≠ agent intent**; shadow must compare
  against wire payloads, not stored rows.

### 2.3 `after-hours` (urgent triage, universal fallback)
- Being the coercion default means it receives every misrouted call [V] — shadow must
  therefore handle "agent mismatch" sessions gracefully.
- Urgent-symptom triage lives in prompt + `URGENT_SYMPTOMS` list; ticket creation via
  `create_after_hours_ticket` with dept mapping in code [V].
- Known cross-wiring: after-hours outbox traffic carries taxonomy IDs that
  systematically skew (`r4_taxonomy_skew_systematic` is expected-flagged in n8n) [V].

### 2.4 `azul-scheduling` (pilot)
- The architectural outlier: server-side rules gate (`sage_decision`), pilot fence
  (2/105 locations), zero-identifier contract, ordinal→GUID mapping server-side,
  read-back gate, `si_call_sessions` phase machine, offer tokens, guarded booking
  (`guardBooking`, `guardNewPatientIntake`) [V].
- Remaining risks: guards **fail open** on store errors (`call-session.ts:203,227`)
  [V]; identity guard soft-logs pending voice ≥2.6.0 (`:189-191`); repeated-question
  SEV-1 (2026-07-30) fixed via insert-race repair — regression watch active;
  ~19 PHI incidents documented from pre-hardening identity read-backs (console docs)
  — shadow must never regress this (zero-identifier compare only).
- 2026-07-29 call audit RC10: `tool_timeline`/`total_turns`/`who_hung_up` largely
  NULL before fleet-wide timeline (2026-08-01) — replay sets should prefer post-08-01 calls.

### 2.5 `appointment-confirmation` (outbound)
- Mutations are local DB (campaign contacts/appointments) — no n8n, no external API [V].
- 3-minute duration cap (`callLifecycleCoordinator.ts:35`). Risks: voicemail
  misclassification (`mark_voicemail`), repeat-dial duplicates handled by campaign
  attempt tables [V].

### 2.6 `drs-scheduler` (outbound)
- Computer-Use factory always receives `computer=undefined` → Phreesia automation
  inert in current wiring [V]. Shadow treats Phreesia tools as simulation-only with
  "production-inert" annotation.

### 2.7 `fantasy-football`
- Read-only tool surface; useful as shadow canary (zero mutation risk) [V].

### 2.8 `dev-no-ivr` (V2)
- Prototype of exactly the architecture the shadow system implements (workflow
  engine + prompt builder). Shadow's no-ivr workflow definition should mirror the
  V2 step model where sensible, giving production a migration path.

## 3. Defect / latent-risk list (input to doc 10 and comparison disagreement codes)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| DF-1 | HIGH | Unkeyed ticket retry window → duplicate mutations possible (`r1_no_key` live) | doc 13; outbox |
| DF-2 | HIGH | Stored taxonomy silently rewritten (dept flattening to 3/8; hardcoded reason 153) — downstream analytics measure the rewrite, not intent | ROUTING-MAP.md:184-215 |
| DF-3 | MED | n8n gateway validation is log-only but *positioned* like a gate — false sense of enforcement | ROUTING-MAP.md:145-175 |
| DF-4 | MED | Sage guards fail open on Supabase errors | call-session.ts:203,227 |
| DF-5 | MED | DB-stored prompts (`agents.system_prompt`) drift from code prompts; runtime ignores them | seedAgents.ts; databaseAgent dead |
| DF-6 | MED | `no-ivr-v2` registered-but-unroutable; silent coercion to after-hours masks config errors | agents.ts:56-64; routes :1384 |
| DF-7 | MED | SIP-header path bypasses inbound allowlist | routes :3407-3415 |
| DF-8 | LOW | `nextgen.ts:6` "read-only by design" comment false (5 mutating helpers exported) | scheduling repo |
| DF-9 | LOW | Deprecated browser demo (`voice.html`) still deployed, bypasses all safety headers | scheduling repo §1b |
| DF-10 | MED | n8n telemetry (va_executions) invisible from app DBs — split-brain observability | ROUTING-MAP.md:155 |
| DF-11 | LOW | `voice_agent_api_logs` written by only 3 of 9 ticketing endpoints — blind spots | ticketing report §6 |
| DF-12 | MED | Health warm-up gate depends on n8n `/api/health` fast-2xx "or no tickets are created" | doc 13 §2.6 |
| DF-13 | LOW | Two n8n instances referenced (n8n Cloud live vs Render blueprint docs) | doc 01 §7 |
| DF-14 | INFO | Loop guard caps re-asks at 3 — shadow flags at 2 (stricter than production) by design | conversationLoopGuard |

None of these is a *new* serious production defect requiring a stop condition — DF-1/DF-2
are already known and documented in-repo (n8n validators were built to measure them).
They are carried into `10-risks-assumptions-and-open-questions.md`.

## 4. Consequences for the shadow design

1. Production intent is unobservable → shadow records its own intent and marks
   production intent as *inferred* (from transcript + tool choices) in comparisons.
2. `toolTimeline.recordingExecute` and the transcript handlers in
   `voiceAgentRoutes.ts:2079-2200` are the natural, single-choke-point tap sites.
3. `callLifecycleCoordinator`'s `'call-ended'` event provides session completion
   without touching production code.
4. `qvoEmitterService` proves the house pattern for a fail-safe external emitter
   (no-op when unset, circuit breaker, PHI gate) — the shadow tap follows it.
5. The n8n gateway request/response pair is visible in-process inside
   `ticketingApiClient` — copying it there costs zero n8n executions.
6. Comparison must use wire payloads (what the agent sent), never stored rows (DF-2).
