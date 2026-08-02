# 15 — n8n Shadow Design (Checkpoint 5)

## 1. Governing constraint

July 2026 measured usage: **6,697 executions** (doc 13) against a 10,000 absolute /
8,000 planned monthly ceiling → headroom ≈ 1,300 before reserve considerations.
Therefore the shadow design's steady-state n8n consumption is **zero**, with an
optional, disabled, session-batched bundle workflow whose worst-case budget is
capped in configuration and enforced fail-closed.

## 2. Preferred-order compliance (as mandated)

1. **Consume copies of production n8n I/O from the application event stream** ✅
   primary mechanism — tap T4 in `ticketingApiClient` copies the exact request and
   response of every production gateway call (`submit-ticket`, `create-ticket`,
   `update-call-data`, `lookup`, `callback-campaign`). Zero new executions.
2. **Replay recorded production n8n results inside the shadow system** ✅ the n8n
   simulator answers "what would the gateway have returned" from the copied
   response; the replay harness re-feeds recorded pairs.
3. **Run reasoning/state/loop/comparison outside n8n** ✅ all in `src/shadow/`.
4. **Batch by completed session, not by turn** ✅ if the optional bundle is ever
   enabled, one bundle per completed session (or micro-batch of N sessions).
5. **Use n8n only where it provides clear orchestration value** ✅ none identified
   today; the bundle exists solely to land shadow summaries next to `va_executions`
   in n8n Data Tables if the operator prefers that surface.
6. **No duplicate calls to production n8n workflows** ✅ prohibited by code: the
   shadow module contains no production gateway URL and the budget enforcer rejects
   any URL matching the production webhook host/path allowlist-inverse.
7. **Never trigger mutating production workflows from shadow** ✅ same mechanism +
   simulation-only execution mode enforced at type level.

**Anti-pattern check:** there is no per-turn shadow execution, no per-turn comparison
execution, no per-turn logging execution, and no scheduled polling workflow. Target:
**0 executions/call default; ≤1 execution/call hard cap if the bundle is enabled.**

## 3. Optional session-bundle workflow (design only — NOT created in n8n)

Decision: we do **not** touch the production n8n instance in this work, not even to
add an inactive workflow. Instead the repo ships an importable definition +
runbook instructions (doc 16). Rationale: zero risk to the production account, fully
reviewable in git, alignable with the operator's naming at import time.

- Name: `VA SHADOW — session bundle (INACTIVE)`; **active: false** on import.
- Trigger: POST webhook, header auth with a **shadow-only** credential
  (`SHADOW_N8N_TOKEN`), path `/api/voice-shadow/session-bundle`.
- Contract (doc 04 §5): `{ shadowMode: true, executionMode: 'simulation-only',
  idempotencyKey, sessionId, agentId, bundle: {…session summary…} }`.
- Behavior: validate `shadowMode === true` else 403; reject any body containing
  `mutate`/production-endpoint fields; check idempotency (data-table lookup) and
  drop duplicates; write one row to a `va_shadow_sessions` data table; respond 200.
  No sub-workflows, no error workflow, no retries inside n8n (bounded retry lives
  app-side and counts against the shadow budget).
- Import artifact: `docs/voice-shadow-architecture/n8n/va-shadow-session-bundle.json`.

## 4. Batching parameters (when/if enabled)

| Parameter | Default | Notes |
|---|---|---|
| Batch unit | completed session | one bundle per call |
| Micro-batch (optional) | `SHADOW_N8N_BATCH_SIZE` = 10 sessions | one execution per 10 calls when near-real-time isn't required |
| Max wait | `SHADOW_N8N_BATCH_MAX_WAIT_MIN` = 15 | flush a partial batch after this |
| Incomplete/long calls | included at session-timeout finalization (30 min) with `status: 'failed:timeout'` | |
| Duplicate prevention | app-side idempotency key `shadow-{sessionId}` + workflow-side data-table check | |
| Replay | replaying a session re-uses the same idempotency key → workflow drops it | |
| Failure recovery | failed bundle POSTs re-queue with exponential backoff (app-side), retry cap 3, each attempt counted against budget | |

## 5. Budget interaction

All bundle sends pass the budget enforcer (doc 14/16): enabled flag → agent
allowlist → capture % → per-call cap (1) → daily budget → monthly budget →
idempotency. Fail-closed: on exhaustion or *uncomputable* budget, sends stop,
bundles remain in spool for later replay, an alert log/metric fires, **production
n8n is never touched** (it isn't reachable from this code path at all).
