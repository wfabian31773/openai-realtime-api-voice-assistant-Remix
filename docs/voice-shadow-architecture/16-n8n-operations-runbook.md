# 16 — n8n Operations Runbook (shadow-related)

All inspection is read-only. The shadow system itself performs **zero** n8n
executions in its default configuration.

## 1. Inspect current monthly usage
- n8n UI → Executions (instance `azulvision.app.n8n.cloud`), or via MCP:
  `search_executions` with `startedAfter=<month start>` — the `count` field is
  exact. Per-workflow: add `workflowId` (IDs in doc 13).
- In-app view: `shadowHealth().n8n` exposes the shadow ledger — executions
  today/this month, per-call map, duplicates blocked, rejected, retries,
  remaining planned/absolute budget, projected month-end, estimated cap date.

## 2. Estimate month-end usage
`(count so far this month / days elapsed) × days in month` — the enforcer
computes exactly this in `snapshot().projectedMonthEndTotal` (production
baseline + shadow actuals). Compare against 5,600 / 6,800 / 8,000 / 10,000.

## 3. Enable shadow workflows (approval required — doc 12)
1. Import `docs/voice-shadow-architecture/n8n/va-shadow-session-bundle.json`
   (imports INACTIVE by design).
2. Create the `va_shadow_sessions` data table (idempotencyKey, sessionId,
   agentId, verdict, summary, ts) and bind it in the Upsert node.
3. Attach a NEW header-auth credential (shadow-only token; never reuse the
   production `X-API-Key`).
4. Activate the workflow; copy its production webhook URL.
5. App side: `SHADOW_N8N_ENABLED=true`, `SHADOW_N8N_WEBHOOK_URL=<url>`,
   `SHADOW_N8N_TOKEN=<token>`, `SHADOW_N8N_CAPTURE_PCT≤25`; restart.

## 4. Disable shadow processing / pause when budget is high
- App side (preferred, instant): `SHADOW_N8N_ENABLED=false` + restart — the
  enforcer refuses all sends; bundles stop; sessions stay in spool.
- n8n side: deactivate `VA SHADOW — session bundle`. Both are safe in any
  order. **Never** deactivate the `VA Gateway — *` production workflows as part
  of a shadow action — they carry live ticket traffic.
- Automatic pause: at the 8,000 stop threshold the enforcer fail-closes on its
  own; at `critical` (6,800) reduce `SHADOW_N8N_CAPTURE_PCT` to 0 proactively.

## 5. Replay failed sessions
Failed/incomplete sessions are finalized as `failed:timeout` and spooled.
`npx tsx src/shadow/replayHarness.ts .shadow-spool/sessions-<date>.jsonl`
re-processes them (same idempotency keys ⇒ the bundle receiver drops
duplicates; the app enforcer blocks re-sends).

## 6. Investigate duplicate executions
- Shadow ledger: `snapshot().duplicatesBlocked` (app-side blocks) — expected
  non-zero when completion events double-fire; this is the guard working.
- n8n side: filter executions of the shadow workflow; the Upsert node matches
  on `idempotencyKey`, so even a duplicate POST cannot double-insert.
- Production duplicates (`r6_possible_duplicate` in `va_executions`) are a
  production concern (DF-1) — report, do not modify workflows.

## 7. Respond to failed workflows / inspect retries
- Shadow bundle failures: app logs `[SHADOW] bundle_errors`, bounded at
  `SHADOW_N8N_RETRY_MAX=3` with exponential backoff **outside** n8n; after the
  cap the bundle drops (spool retains the session). Check `snapshot().retries`.
- Production gateway failures: visible in n8n executions + `va_executions`
  `appStatus` — production on-call territory, not shadow's.

## 8. Verify mutation blocking
- `npx vitest run src/shadow/n8nSimulator.test.ts src/shadow/productionIsolation.test.ts`
  — proves the production-host blocklist and the module graph.
- Runtime: any attempt to point `SHADOW_N8N_WEBHOOK_URL` at a production host
  is refused with reason `target matches production blocklist`, counted in
  `snapshot().rejected`.
- Workflow side: the bundle receiver 403s anything without
  `shadowMode:true` + `executionMode:'simulation-only'` or containing
  production-mutation vocabulary.

## 9. Confirm production remains unaffected
- Production gateways' execution counts and latencies are unchanged by any
  shadow state (shadow copies traffic in-process; it never calls the gateways).
  Compare `search_executions` counts for `yS1ZZG4Dt5uGwuPo` before/after any
  shadow change — the trend should track call volume only.
- App: `shadowHealth()` errors rising while calls proceed normally is the
  designed failure mode — shadow degrades alone.

## 10. Emergency shadow shutoff
```
# App (any one of these closes the tap):
SHADOW_MODE_ENABLED=false          # master
SHADOW_AGENT_ALLOWLIST=            # empty allowlist
SHADOW_CAPTURE_PCT=0               # zero sampling
SHADOW_N8N_ENABLED=false           # n8n sends only
# then restart the Replit deployment.
# n8n (optional, belt+suspenders): deactivate "VA SHADOW — session bundle".
```
Nothing in this procedure touches production workflows, credentials, or the
live call path.
