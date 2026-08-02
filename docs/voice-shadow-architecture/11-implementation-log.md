# 11 — Implementation Log

Running log of checkpoint certifications and work units. Times UTC.

---

## Checkpoint 1 — REPOSITORY DISCOVERY CERTIFIED ✅
- **Completed:** 2026-08-02 ~20:50 UTC
- **Method:** four parallel read-only repository sweeps (Remix, scheduling-agent,
  ticketing-app, patient-console) + first-hand reads of registry/routing/model files.
- **Files inspected (principal):** `src/config/agents.ts`, `src/voiceAgentRoutes.ts`,
  `src/agents/*.ts`, `src/services/{toolTimeline,conversationLoopGuard,callSessionService,
  callMetadataStore,callLifecycleCoordinator,callGradingService,qvoEmitterService,
  structuredLogger}.ts`, `server/services/ticketingApiClient.ts`, `server/seedAgents.ts`,
  `twilio-inventory.md`, `.replit`, `shared/schema.ts`; scheduling repo `lib/tools.ts`,
  `lib/scheduling-intel/*`, `api/*`; ticketing repo `app/api/voice-agent/*`,
  `VOICE_AGENT_API.md`, `ticket-workflow/{MASTER,ROUTING-MAP}.md`, `render.yaml`;
  console repo `apps/npx/docs/scheduling-agent/*`, migrations.
- **Findings:** 7 active agents + 1 dev-only, all hosted in the Remix repo; 4 archived/
  dead constructs identified and excluded. Full inventory: `01-active-agent-inventory.md`.
- **Decisions:** shadow architecture lives in the Remix repo (`src/shadow/`);
  `dev-no-ivr` shares the no-ivr workflow definition; archived items untouched.
- **Validation:** internal consistency checks in doc 01 §8 (slug↔registry↔route↔number).
- **Unresolved risks:** dual n8n instance references (DF-13); Computer-Use inert (noted).
- **Safe to proceed:** YES.
- **Artifacts:** commits `4e09c50` (SHADOW-REASONING.md), doc 01 (this commit).

## Checkpoint 2 — N8N DISCOVERY CERTIFIED ✅
- **Completed:** 2026-08-02 ~20:35 UTC
- **Method:** read-only n8n MCP (`search_workflows`, `get_workflow_details` on the
  active gateways + digest, `search_executions` with per-workflow July windows).
  No workflow modified/activated/executed.
- **Findings:** 11 workflows (7 active); July 2026 = **6,697 executions** (submit-ticket
  6,665; digest 28; create-ticket 4; others 0). Gateways are passthrough + post-respond
  log-only validation writing `va_executions`. Full detail: `13-n8n-workflow-inventory.md`.
- **Decisions:** shadow consumes copied gateway traffic in-process (0 executions);
  any shadow n8n workflow is optional, inactive, session-batched, budget-gated.
- **Sub-workflow check:** none present (no Execute Workflow / error workflows / loops);
  per-execution external calls are HTTP nodes inside the same execution.
- **Unresolved risks:** attribution of 6,665 executions/month to call volume pending
  (resolved in doc 14 budget model with measured totals regardless of cause).
- **Safe to proceed:** YES.
- **Artifacts:** commit `f20cd6e` (doc 13).

## Checkpoint 3 — CURRENT ARCHITECTURE AUDIT CERTIFIED ✅
- **Completed:** 2026-08-02 ~21:05 UTC
- **Findings:** voice model doubles as workflow engine everywhere except azul; no
  explicit intent classifier/reasoning layer; conversational state unstructured
  (except `si_call_sessions`); retries bounded in NextGen client but unkeyed ticket
  retry window (DF-1); logs unusually good for shadow comparison (transcripts +
  toolTimeline + va_executions). 14-item defect register. Full detail: doc 02.
- **Stop-condition review:** no *new* serious unrelated production defect discovered
  (DF-1/DF-2 already known and instrumented in-repo). No stop triggered.
- **Safe to proceed:** YES — production untouched.
- **Artifacts:** doc 02 (this commit).

---

## Work-unit log

| When (UTC) | Unit | Notes |
|---|---|---|
| 2026-08-02 20:10 | Shadow Reasoning MD | master plan committed before any work |
| 2026-08-02 20:35 | n8n inventory | read-only MCP; doc 13 |
| 2026-08-02 20:40 | Draft PR #60 opened | subscription + hourly self check-in armed |
| 2026-08-02 21:05 | Docs 01/02/11 | discovery + audit certified |
