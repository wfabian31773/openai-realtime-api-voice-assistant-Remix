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

## Checkpoint 4 — SHADOW INTEGRATION DESIGN CERTIFIED ✅
- **Completed:** 2026-08-02 ~21:15 UTC. Doc 03. Non-blocking in-process tap
  (qvoEmitter precedent), 4 one-line call sites, alias-based correlation,
  bounded queue drop-oldest, JSONL spool. Safe to proceed: YES.

## Checkpoint 5 — N8N SHADOW DESIGN CERTIFIED ✅
- Doc 15. Zero-steady-state design; replay-first; optional INACTIVE
  session-bundle workflow shipped as importable JSON (n8n instance untouched —
  decision recorded in doc 15 §3). Safe to proceed: YES.

## Checkpoint 6 — EVENT AND STATE CONTRACTS CERTIFIED ✅
- Doc 04 + `src/shadow/contracts.ts` (zod). Literal-typed simulation-only
  records. Contract tests green. Commit `767f777` (design), `a6b8b9a` (code).

## Checkpoint 7 — SHADOW REASONING & WORKFLOW ARCHITECTURE CERTIFIED ✅
- `reasoning.ts` (advisory) + `workflowEngine.ts` (authority) + response
  sanitizer + planners separated per spec. Engine overrules tested.

## Checkpoint 8 — MODEL-ROUTING POLICY CERTIFIED ✅
- Doc 05 + `modelRouter.ts`. Verified repo model names only; structured
  signals; deterministic default; caps. Tier tests green.

## Checkpoint 9 — WORKFLOW DEFINITIONS CERTIFIED ✅
- `workflows.ts`: 8 agent definitions, legal-transition maps, required fields,
  confirmation/retry/escalation rules. Coverage asserted by test.

## Checkpoint 10 — TOOL-SIMULATION CONTROLS CERTIFIED ✅
- Doc 06 + `toolSimulator.ts`: 38 tool policies, validation codes,
  replay metadata, duplicate-mutation block. Duplicate read-only execution
  remains flag-reserved and unimplemented (doc 06 §3).

## Checkpoint 11 — N8N TOOL-SIMULATION CONTROLS CERTIFIED ✅
- `n8nSimulator.ts` adapters for gateway-backed tools; importable INACTIVE
  bundle workflow with shadow-mode/vocabulary/idempotency guards.

## Checkpoint 12 — LOOP AND STATE-LOSS DETECTION CERTIFIED ✅
- `loopDetector.ts`: 14 loop/state signal types, both sides, dedup, cause +
  correction recorded. Threshold stricter than production's (2 vs 3).

## Checkpoint 13 — PRODUCTION-VS-SHADOW COMPARISON CERTIFIED ✅
- Doc 07 + `comparison.ts`. Deferred per-turn flush (production tools land
  after the caller turn — bug found by test, fixed in `c472afe` series).
  Limitation text on every summary.

## Checkpoint 14 — EVALUATION FRAMEWORK CERTIFIED ✅
- `evaluation.ts`: conservative verdicts, priority-ordered review queue.
  `shadow_blocked_would_be_mutation` scoped to divergent mutations only.

## Checkpoint 15 — N8N EXECUTION-BUDGET MODEL CERTIFIED ✅
- Doc 14. E = C×P×W×R/B with measured inputs; default E=0; max safe bundle
  capture 25%. Confidence: HIGH on totals (measured), stated MEDIUM on
  per-call attribution — model uses measured totals, so budget verifiable.

## Checkpoint 16 — N8N BUDGET ENFORCEMENT CERTIFIED ✅
- `n8nBudget.ts`: app-level gates (enabled/host/capture/per-call/daily/monthly/
  threshold/idempotency), workflow-level guard, operational snapshot.
  Thresholds 5,600/6,800/8,000/10,000. Fail-closed semantics tested.

## Checkpoint 17 — RETRY AND IDEMPOTENCY CONTROLS CERTIFIED ✅
- Idempotent ingestion (eventId dedupe), duplicate-finalize guard, bounded
  bundle retries (3) with app-side backoff counted against budget, replayable
  failed sessions (timeout finalization + spool).

## Checkpoint 18 — TESTING CERTIFIED ✅
- Doc 08. 98 shadow tests / 270 repo-wide, tsc clean. Pre-existing
  `p0Hardening.test` env failure reproduced on origin/main (not ours).
  Commit `c472afe`.

## Checkpoint 19 — HISTORICAL REPLAY CERTIFIED ✅
- `replayHarness.ts` + 8-session de-identified evaluation set; live run
  recorded in doc 07 §5; deterministic across runs (tested). No PHI committed.

## Checkpoint 20 — OBSERVABILITY CERTIFIED ✅
- `observability.ts` + `shadowHealth()`: ingestion/lag/queue, per-tier and
  per-verdict counters, budget snapshot incl. projected month-end and cap
  date, review-queue depth. Redaction upstream of all surfaces.

## Checkpoint 21 — SECURITY AND PRIVACY CERTIFIED ✅
- Doc 10 §5. Deny-by-default redaction, transcripts off by default, 14-day
  retention, no new external vendors, zero-identifier comparisons. Open items
  Q2 (transcript storage approval) and Q5 (stale fixture name in sibling repo)
  documented, non-blocking.

## Checkpoint 22 — DEPLOYMENT READINESS CERTIFIED ✅ (STOPPED AT APPROVAL GATE)
- Docs 09/16/12. All flags default off; enable/disable commands exact;
  **production shadow capture NOT enabled** — awaiting operator approval per
  the mandate. Final status: READY FOR PRODUCTION SHADOW PENDING APPROVAL.

---

## Work-unit log

| When (UTC) | Unit | Notes |
|---|---|---|
| 2026-08-02 20:10 | Shadow Reasoning MD | master plan committed before any work |
| 2026-08-02 20:35 | n8n inventory | read-only MCP; doc 13 |
| 2026-08-02 20:40 | Draft PR #60 opened | subscription + hourly self check-in armed |
| 2026-08-02 21:05 | Docs 01/02/11 | discovery + audit certified |
| 2026-08-02 21:15 | Docs 03/04/05/06/15 | design certified (`767f777`) |
| 2026-08-02 21:35 | `src/shadow/**` + 4 taps | engine implemented, tsc clean (`a6b8b9a`) |
| 2026-08-02 21:55 | 98-test matrix + fixes | deferred comparison, assent folding, regex, verdict scoping (`c472afe`) |
| 2026-08-02 22:10 | Docs 00/07/08/09/10/12/14/16 + n8n bundle JSON | all checkpoints certified; stopped at production approval gate |
| 2026-08-02 21:45 | **Operator approval received** | "approved — merge PR #60 and enable staging shadow on all active agents" |
| 2026-08-02 21:47 | PR #60 merged (`ec2db8a`, squash) | branch restarted from main |
| 2026-08-02 21:55 | Shadow enabled via `.replit userenv.shared` (all 8 agents, 100%, safe defaults) | requires Replit republish |
| 2026-08-02 22:00 | Shadow Agent Review card + stored-call replay + mode endpoints | follow-up PR; 277 tests green, tsc clean, client build clean |
| 2026-08-02 23:25 | GPT-5.6 tier upgrade + live LLM refinement adapter | identifiers verified vs OpenAI docs; routing enabled in .replit; 114 shadow tests |
| 2026-08-02 23:40 | Production realtime A/B armed: `AZUL_AB_MODEL_B=gpt-realtime-2.1` (azul pilot, pre-existing Phase-7 carriage, env-only) | operator-approved; rollback = unset var |
