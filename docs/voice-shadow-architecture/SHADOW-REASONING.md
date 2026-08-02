# Shadow Reasoning MD — Parallel Shadow Voice-Agent Architecture

> **Status:** master plan, written before any functional work began.
> **Branch:** `claude/shadow-voice-agent-architecture-02qun2`
> **Date started:** 2026-08-02
> **Author:** Claude (autonomous session), on behalf of Wayne Fabian.

This document records the explicit tasks, goals, checkpoints, stop conditions, and
production protections governing this work, per the task prompt. It is the first
artifact of the engagement and is updated only to reflect checkpoint completion
status — the plan itself is frozen.

---

## 1. Mission

Design, document, build, test, and prepare a **complete parallel shadow architecture**
for every active production voice agent, across the four connected repositories:

| Repo | Role (initial hypothesis — to be verified in Checkpoint 1) |
|---|---|
| `openai-realtime-api-voice-assistant-Remix` | Primary voice-agent host: Twilio SIP → OpenAI Realtime agents (`src/agents/*`), Express server, call lifecycle, grading, tooling. **Shadow architecture will live here.** |
| `eyecare-scheduling-agent` | NextGen scheduling service + its own realtime session API (`api/realtime-session.ts`), tools consumed by voice agents. |
| `ticketing-app` | Ticketing backend with a documented Voice Agent API (`VOICE_AGENT_API.md`) — downstream mutation target of voice tools. |
| `eyecare-patient-console` | Patient console (Next.js/Supabase) — likely not a voice host; verify. |

The shadow system is an **observation, reasoning, simulation, comparison, and
evaluation system only**. It must never speak to callers, mutate production data,
trigger mutating production tools or n8n workflows, alter routing, or delay the
live call path in any way.

## 2. Goals

1. **Production untouched.** The live path (caller → Twilio/SIP/WebSocket → realtime
   agent → tools/n8n → response) continues byte-for-byte as today.
2. **Non-blocking shadow tap.** Copies of transcripts, conversation events, tool
   requests/results, n8n inputs/outputs, session state, transfer and completion
   events flow into a shadow event stream asynchronously.
3. **Independent shadow reasoning.** For every meaningful turn the shadow answers:
   intent, entities, missing fields, active workflow step, next action, tool choice
   + validated args, legality, confirmation needs, model tier, loop/state-loss
   signals, and production-vs-shadow agreement with disagreement codes.
4. **n8n budget safety.** ≤ 10,000 executions/month absolute; planned ceiling 8,000;
   ≥ 2,000 reserve; prefer 0–1 shadow n8n executions per completed call, batched by
   session; fail-closed on budget exhaustion (shadow stops, production continues).
5. **Deployment-ready but OFF.** Feature flags default off; capture percentage
   defaults 0; production enablement stops at an approval gate.

## 3. Explicit non-negotiable production protections

- No refactor of production agents, prompts, tools, telephony/SIP/Twilio/WebSocket/
  WebRTC routing, or model selection.
- No writes to appointment/patient/CRM/referral/ticket/messaging/scheduling data.
- No synchronous shadow dependency in the live call path; shadow failure ⇒ zero
  production impact.
- No mutating credentials in shadow scope unless technically unavoidable and isolated.
- No reuse of production tool clients that can write without an enforced simulation
  boundary.
- No modification or activation of production n8n workflows; no changes to webhooks
  or n8n credentials; no shadow-triggered production mutations via n8n.
- Discovery via n8n MCP tools is **read-only** (search/list/get only).

## 4. Checkpoints (certified gates)

Work proceeds strictly in this order. Each checkpoint is certified with an entry in
`11-implementation-log.md` (name, timestamp, files inspected, findings, decisions,
validation, unresolved risks, safe-to-proceed verdict, associated commit/file set).

| # | Checkpoint | Gate |
|---|---|---|
| 1 | Repository discovery certified | No functional code changes before the active-agent inventory (`01-active-agent-inventory.md`) is documented and internally consistent. |
| 2 | n8n discovery certified | Full n8n workflow inventory (`13-n8n-workflow-inventory.md`) — read-only inspection only. |
| 3 | Current architecture audit certified | Per-agent audit of intent handling, state, validation, loops, retries, prompt-embedded logic (`02-current-state-audit.md`). |
| 4 | Shadow integration design certified | Non-blocking copy mechanism, event schema, ordering, correlation, failure isolation (`03-shadow-architecture-spec.md`). |
| 5 | n8n shadow design certified | Batch-by-session, replay-first, ≤1 shadow n8n execution per call (`15-n8n-shadow-design.md`). |
| 6 | Event & state contracts certified | Typed/schema-validated contracts (`04-event-and-state-contracts.md`). |
| 7 | Shadow reasoning & workflow architecture certified | Interpretation / deterministic workflow engine / simulated tool & n8n decisions / response planning separated; reasoning is advisory, engine decides legality. |
| 8 | Model-routing policy certified | Tiered routing on structured signals, real repo model names only (`05-model-routing-policy.md`). |
| 9 | Workflow definitions certified | Per-agent explicit states + legal transitions; one-question-at-a-time; no repeat questions; no premature/duplicate tools. |
| 10 | Tool-simulation controls certified | Per-tool policy; simulation-only recording; replay production results; no independent mutations (`06-tool-simulation-policy.md`). |
| 11 | n8n tool-simulation controls certified | Simulation adapters for n8n-backed tools; inactive shadow workflows only; mutation-blocked. |
| 12 | Loop & state-loss detection certified | Repeated questions/tools/n8n triggers, state regression, ignored answers, bundled questions. |
| 13 | Production-vs-shadow comparison certified | Turn + session comparison engine with disagreement codes (`07-comparison-and-scoring-spec.md`). Explicit limitation: caller responses answer *production's* questions, not shadow's. |
| 14 | Evaluation framework certified | better/equivalent/worse/indeterminate/human-review rules; review queue with priorities. |
| 15 | n8n execution-budget model certified | E = C×P×W×R/B; planned limit 8,000; reserve 2,000 (`14-n8n-execution-budget.md`). NOT READY if unverifiable. |
| 16 | n8n budget enforcement certified | App-level + workflow-level + operational controls; thresholds 5,600 warn / 6,800 critical / 8,000 stop / 10,000 absolute; fail-closed = shadow stops, production continues. |
| 17 | Retry & idempotency controls certified | Idempotent processing, bounded retries, backoff outside n8n, replayable failed sessions, retries counted against budget. |
| 18 | Testing certified | Full matrix in `08-testing-and-validation-plan.md`, incl. proofs that shadow failure/disable cannot change production output and shadow cannot mutate. |
| 19 | Historical replay certified | Replay harness over recorded/de-identified sessions; no PHI committed. |
| 20 | Observability certified | Structured logs/metrics + operational report; redaction of sensitive identifiers. |
| 21 | Security & privacy certified | Follow existing PHI/PII patterns; minimized structured state over transcript replay where possible. |
| 22 | Deployment readiness certified | Flags default off; runbooks (`09`, `16`); **stop at production-enablement approval gate**. |

## 5. Stop conditions (verbatim commitments)

Stop and document if: the only integration would block live calls; production/shadow
cannot be isolated; mutating tool or n8n access cannot be technically prevented;
production credentials would be exposed; the active-agent or n8n inventory cannot be
reliably determined; event capture would violate privacy controls; projected n8n
usage exceeds the planned limit; the n8n budget cannot be confidently calculated;
production deployment would occur without approval; a serious unrelated production
defect is revealed; or tests demonstrate shadow failures can affect production.
When stopping: preserve completed work, state the safest next step.

## 6. Deliverables (permanent implementation record)

All under `docs/voice-shadow-architecture/` in this repo (the voice-agent host):

`00-executive-summary.md`, `01-active-agent-inventory.md`, `02-current-state-audit.md`,
`03-shadow-architecture-spec.md`, `04-event-and-state-contracts.md`,
`05-model-routing-policy.md`, `06-tool-simulation-policy.md`,
`07-comparison-and-scoring-spec.md`, `08-testing-and-validation-plan.md`,
`09-deployment-and-operations-runbook.md`, `10-risks-assumptions-and-open-questions.md`,
`11-implementation-log.md`, `12-final-readiness-report.md`,
`13-n8n-workflow-inventory.md`, `14-n8n-execution-budget.md`,
`15-n8n-shadow-design.md`, `16-n8n-operations-runbook.md` — plus this file.

Code deliverables (shadow-only, flag-gated, default off) under `src/shadow/`:
event contracts & normalizer, shadow conversation state, deterministic workflow
engine, reasoning layer (advisory), model router, tool-simulation layer,
n8n-simulation + budget enforcement, retry/idempotency, loop & state-loss detection,
comparison engine, replay harness, observability, config/flags, tests.

## 7. Execution sequence (planned)

1. Inspect all four repos (read-only). 2. Docs skeleton. 3. Active-agent inventory.
4. n8n inventory (read-only MCP + repo grep). 5. Current-state audit. 6. n8n usage
estimate. 7. Certify discovery checkpoints. 8. Design non-blocking tap + n8n
batching. 9. Contracts. 10–20. Implement shared shadow engine, reasoning, routing,
workflow engine, tool/n8n simulation, budget, retries, loop detection, comparison,
replay, tests, observability. 21. Run tests/typecheck/lint/build; fix what this work
broke. 22. Deployment config + runbooks. 23. Budget projection + reserve check.
24. Final readiness report. 25. **Stop before production enablement.** Commit in
logical units; push; open draft PR.

## 8. Verified-fact discipline

Every claim in the inventory and audit documents is tagged **[VERIFIED]** (with
file/line or tool evidence) or **[ASSUMPTION]** (with reason and risk). No repository
evidence is replaced by assumption where evidence is obtainable.

## 9. Checkpoint completion ledger

| # | Checkpoint | Status |
|---|---|---|
| — | Shadow Reasoning MD created | ✅ this commit |
| 1–22 | See `11-implementation-log.md` | pending |
