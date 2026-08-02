# 09 — Deployment and Operations Runbook (Checkpoint 22)

## 1. What ships in this PR

- `src/shadow/**` — the shadow system (inert until configured).
- Four one-line taps: `src/server.ts` (init), `src/voiceAgentRoutes.ts`
  (session start + 2 transcript lines), `src/services/toolTimeline.ts` (tool
  copies), `server/services/ticketingApiClient.ts` (n8n gateway copies).
- No DB migration. Storage is a gitignored JSONL spool. (Optional future
  Postgres tables — `shadow_sessions`, `shadow_turn_comparisons` — are a
  documented plan only; adding them via drizzle would follow the repo's
  existing `db:push` flow and needs separate approval.)
- No n8n change. An importable INACTIVE bundle workflow lives at
  `docs/voice-shadow-architecture/n8n/va-shadow-session-bundle.json`.

## 2. Environment variables (all default safe/off)

Core: `SHADOW_MODE_ENABLED=false`, `SHADOW_AGENT_ALLOWLIST=` (empty),
`SHADOW_CAPTURE_PCT=0`, `SHADOW_STORE_TRANSCRIPTS=false`,
`SHADOW_SPOOL_DIR=.shadow-spool`, `SHADOW_SPOOL_ENABLED=true`,
`SHADOW_RETENTION_DAYS=14`, `SHADOW_QUEUE_MAX=5000`,
`SHADOW_SESSION_TIMEOUT_MIN=30`, `SHADOW_COMPARISON_ENABLED=true`.
Model: `SHADOW_MODEL_ROUTING_ENABLED=false`, `SHADOW_MODEL_LOW=gpt-4o-mini`,
`SHADOW_MODEL_MID=gpt-4o`, `SHADOW_MODEL_HIGH=gpt-4o`,
`SHADOW_MODEL_MAX_CALLS_PER_SESSION=6`, `SHADOW_MODEL_DAILY_COST_CAP_USD=5`,
`SHADOW_DUPLICATE_READONLY_ENABLED=false` (reserved; not implemented).
n8n: full table in doc 14 §4 (`SHADOW_N8N_ENABLED=false`, capture 0, per-call 1,
daily 10, monthly 300, batching on, fail-closed on, host blocklist).
Secrets: none required. Optional: `SHADOW_N8N_WEBHOOK_URL` + `SHADOW_N8N_TOKEN`
(shadow-only credential, NEVER a production gateway URL — blocklisted anyway).

The production path reads none of these; only `src/shadow/**` does.

## 2.1 Enablement state (updated 2026-08-02, operator-approved)

PR #60 merged. Per operator approval ("enable staging shadow on all active
agents"), `.replit [userenv.shared]` now sets `SHADOW_MODE_ENABLED=true`,
`SHADOW_AGENT_ALLOWLIST=<all 8 agents>`, `SHADOW_CAPTURE_PCT=100` for both the
development and production deployments. All riskier flags remain at their off
defaults (no transcript storage, no model calls, zero n8n executions).
**A Replit republish is required for the deployment to pick this up.**
Operator surface: the **Shadow Agent Review** card on every call-details page —
replay any stored call through the shadow engine, and record the rollout
decision with the *Keep in Shadow Mode / Turn Live* buttons
(`GET/POST /api/shadow/mode|status`, persisted in `app_settings.shadow_rollout_mode`).
"Turn Live" records the operator's approval only: the shadow engine remains
observation-only until a live-cutover deployment is built and shipped — it has
no code path to speak or mutate, by design.

## 3. Enablement ladder (each step reversible instantly)

1. **Local replay (no flags):**
   `npx vitest run src/shadow && npx tsx src/shadow/replayHarness.ts src/shadow/fixtures/replay-set.json`
2. **Dev/staging shadow:** on the dev deployment set
   `SHADOW_MODE_ENABLED=true`, `SHADOW_AGENT_ALLOWLIST=dev-no-ivr`,
   `SHADOW_CAPTURE_PCT=100` → place test calls to `/api/voice/dev-no-ivr`,
   inspect spool + `shadowHealth()` output.
3. **Production shadow (REQUIRES OPERATOR APPROVAL — see doc 12):**
   recommended initial config:
   `SHADOW_MODE_ENABLED=true`, `SHADOW_AGENT_ALLOWLIST=fantasy-football,no-ivr`
   (read-only canary first, then the highest-volume agent),
   `SHADOW_CAPTURE_PCT=10`, everything else at defaults (0 n8n executions,
   deterministic reasoning only). Ramp: 10% → 25% → 50% → 100% with a
   `shadowHealth()` review at each step.
4. **Optional model routing:** `SHADOW_MODEL_ROUTING_ENABLED=true` (adds
   OpenAI cost, capped at $5/day by default).
5. **Optional n8n bundle (separate approval):** import the INACTIVE workflow,
   attach a shadow-only header credential, activate it, then set
   `SHADOW_N8N_ENABLED=true`, `SHADOW_N8N_CAPTURE_PCT≤25`,
   `SHADOW_N8N_WEBHOOK_URL=<shadow webhook>`. Never exceed the doc 14 limits.

Deployment mechanics: this repo deploys as a Replit VM (`.replit`); env vars are
set in the Replit deployment config; a restart picks them up. There is no CI —
run §5 checks locally before deploying.

## 4. Disable / rollback / incident response

- **Instant disable:** unset `SHADOW_MODE_ENABLED` (or set `false`) + restart.
  Production behavior is identical with the flag on or off; disabling is purely
  precautionary.
- **Emergency (no deploy possible):** the tap also goes silent if
  `SHADOW_AGENT_ALLOWLIST` is emptied or `SHADOW_CAPTURE_PCT=0` — any one of
  the three gates closes it.
- **Code rollback:** revert this PR's commits; taps are additive one-liners.
- **n8n bundle shutoff:** set `SHADOW_N8N_ENABLED=false` (app side) AND/OR
  deactivate the shadow workflow in n8n. Production workflows are untouched
  either way.
- **Spool disk pressure:** `SHADOW_RETENTION_DAYS` purge runs every minute;
  manual: `rm -rf .shadow-spool/` is always safe (observation data only).
- **Alert conditions:** `shadowHealth().healthy === false`, rising
  `pipeline_errors`, `dropped`, `bundle_errors`, or budget level
  `critical`/`stopped` — investigate shadow only; production needs no action.

## 5. Pre-deploy verification commands

```
npx tsc --noEmit
npx vitest run
npx tsx src/shadow/replayHarness.ts src/shadow/fixtures/replay-set.json
```

## 6. Throughput, cost, rate limits

- In-app processing: deterministic path is sub-ms/turn; at ~300 calls/day ×
  ~6 turns the pipeline load is negligible; queue cap 5,000 events.
- Model cost (only if routing enabled): worst case ≈ 6 calls/session ×
  ~1.5k tokens ≈ <$0.01/session at gpt-4o-mini rates; hard daily cap $5.
- n8n: 0/month default; ≤300/month by config cap if the bundle is enabled.
- Retention: spool 14 days; transcripts not stored unless
  `SHADOW_STORE_TRANSCRIPTS=true` (requires the doc 21 privacy review).
