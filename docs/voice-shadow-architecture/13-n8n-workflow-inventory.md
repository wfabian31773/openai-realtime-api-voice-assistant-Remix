# 13 — n8n Workflow Inventory (Checkpoint 2)

> Evidence source: read-only n8n MCP inspection (`search_workflows`, `get_workflow_details`,
> `search_executions`) against instance `azulvision.app.n8n.cloud`, performed 2026-08-02.
> No workflow was modified, activated, or executed during discovery.
> All facts below are **[VERIFIED]** unless tagged **[ASSUMPTION]**.

## 1. Instance summary

- 11 workflows total: **7 active**, 4 inactive (staged/test).
- **July 2026 executions (full month, verified): 6,697** — see §4.
- The account limit context given for this project: ~10,000 executions/month.
  July usage is therefore ≈ **67% of the absolute limit** and ≈ **84% of the
  8,000 planned ceiling** before any shadow work exists.

## 2. Active workflows

### 2.1 VA Gateway — submit-ticket — `yS1ZZG4Dt5uGwuPo` ⚠️ hot path
- **Active:** yes. **Trigger:** POST webhook `…/webhook/c02059a6…/api/voice-agent/submit-ticket`, header auth `X-API-Key`.
- **Role:** *inline production gateway.* The voice client calls this n8n webhook instead
  of the ticketing app directly. Flow: `VA Webhook → Forward to App (POST
  ticketing-app…/api/voice-agent/submit-ticket, 30s timeout, neverError) → Respond to
  Caller (verbatim status+body) → post-respond branch: Validate (log-only G0,R1–R3,R7,R9–R10)
  → Fetch Recent Tickets (GET …/recent-tickets, 10s) → R6 Assess (duplicate detection)
  → Build Audit Row → Write Audit Row (data table va_executions vLh8bPjrbRrUUpbJ)`.
- **Mutating?** The *forward* is mutating (creates tickets in ticketing-app). The
  validation branch is log-only by design ("Rule #3"), runs after the caller already
  got the response, every node `onError: continueRegularOutput`.
- **Extra external calls per execution:** 1 mutating POST + 1 read-only GET (recent-tickets).
- **July executions:** 6,665 (99.5% of account usage). ≈215/day.
- **Retry/duplicate protection:** none in-workflow; relies on app-side idempotency.
  Validator itself flags `r1_no_key` when the caller sends no idempotency key.
- **Sub-workflows:** none. **Error workflow:** none observed.

### 2.2 VA Gateway — create-ticket — `O3Irc3cL1YKy9HdD`
- Same gateway shape as 2.1 for `POST /api/voice-agent/create-ticket` (structured
  taxonomy create used by the after-hours outbox path). Adds R4/R5 taxonomy-hierarchy
  checks against a baked snapshot (2026-06-12) and dept allowlists.
- **July executions:** 4. Low-volume path.

### 2.3 VA Gateway — update-call-data — `uH8lfIWE9YulioCU`
- Gateway for `POST /api/voice-agent/update-call-data` (60s forward timeout), U1–U5 +
  R10 log-only validation, flags orphaned call data on app 404. **July executions: 0.**

### 2.4 VA Gateway — lookup — `CJMYSoccfuMu3vDN`
- Pure read-only proxy for `POST /api/voice-agent/lookup` (provider/location name
  resolution). No PII fields on this endpoint. **July executions: 0.**

### 2.5 VA Gateway — callback-campaign — `6I9WyiYsmiVzHi7f`
- Passthrough placeholder for `POST /api/voice-agent/callback-campaign`; description
  notes zero voice-side callers today. **July executions: 0.**

### 2.6 VA Gateway — health — `MG7P0ntvguggvXe3`
- Static 200 JSON for `GET /webhook/api/health`, `responseMode: onReceived`. The voice
  client's warm-up gate requires a fast 2xx here *or no tickets are created* — this is
  a production-critical dependency. **July executions: 0 recorded** [ASSUMPTION:
  `onReceived` health hits may not create billed executions, or the warm-up gate was
  not exercised via this path in July; treat as ~0 but production-critical].

### 2.7 VA Daily Digest — `NjAaRnTcjwzlTTLy`
- **Trigger:** schedule, daily 13:00 UTC (6am PT). Reads all `va_executions` rows,
  aggregates last 24h, inserts one row into `va_daily_digest` (`s2wPwkFAOevvaKpi`).
- Explicitly designed to replace per-event telemetry "to conserve n8n execution
  quota". **July executions: 28** (≈1/day; created 2026-06-15).

## 3. Inactive (staged/test) workflows

| Workflow | ID | Purpose | Status |
|---|---|---|---|
| VA Sage — disposition audit (daily) | `BYtjKOwrRBmPSIuc` | Daily Tier-1 reconciliation (~30 exec/mo when enabled): GET Sage disposition-audit endpoint → anomaly thresholds → upsert `sage_disposition_audit`. | Staged **inactive** |
| VA Shared — taxonomy cache | `nRugBcYZNlkWL1Cu` | Every-6h taxonomy snapshot upsert into `va_taxonomy` (~120 exec/mo when enabled). Cadence deliberately cut from a latent 1-min default for budget safety. | Staged **inactive** (awaiting credential) |
| VA Audit Digest | `szlUuSLnvZmVhsXx` | Manual read-only aggregate of `va_executions`. | Inactive, manual |
| Ticket Workflow — Bridge Ping | `uU3qFTneCNyH0FJd` | Hello-world MCP bridge test. | Inactive, test-only |

## 4. Execution volume (verified via `search_executions`)

| Window | Count | Notes |
|---|---|---|
| July 2026 (07-01 → 08-01) | **6,697** | full month, `estimated:false` |
| — VA Gateway submit-ticket | 6,665 | webhook mode |
| — VA Daily Digest | 28 | schedule mode |
| — VA Gateway create-ticket | 4 | webhook mode |
| — lookup / update-call-data / callback-campaign / health | 0 | |
| Jul 1 → Aug 2 (incl. Aug) | 6,759 | ≈211/day running rate |

Observed pattern: submit-ticket executions cluster during business hours at a
few-minute cadence, with a long tail overnight (after-hours agents). All sampled
executions succeeded (status `success`).

**[ASSUMPTION — flagged for the current-state audit]** 6,665 submit-ticket
executions/month is far higher than a plausible human-call ticket volume; the
repo audit (doc 02) must reconcile which client paths call this webhook and how
often per call (e.g. per-call submission + retries + warm-up traffic). Budget
modeling in doc 14 uses the *measured* 6,697/month regardless of cause,
with per-call attribution resolved from repository evidence.

## 5. Agent → n8n mapping (to be completed against repo evidence in doc 01/02)

- Voice agents submitting tickets (`agentUsed` vocabulary in the validators:
  `no-ivr`, `answering-service`, `urgent-triage`, `after-hours`) → **submit-ticket**
  gateway (per-call, mutating-by-forward).
- After-hours outbox / structured taxonomy path → **create-ticket** gateway.
- Call-data enrichment → **update-call-data** gateway (currently unused).
- Provider/location resolution → **lookup** gateway (currently unused; the app path
  is presumably called directly [ASSUMPTION until doc 01 confirms]).
- Sage (scheduling agent) → no active n8n involvement; **disposition audit** staged.

## 6. Consequences for shadow design (input to docs 14/15)

1. Headroom above current usage to the planned 8,000 ceiling is only ≈1,300
   executions/month. **The shadow architecture must consume ≈0 n8n executions in
   steady state.** All shadow reasoning/comparison runs in-app; production n8n
   inputs/outputs are consumed as *copied events*, never re-triggered.
2. Any optional shadow n8n workflow must be inactive by default, session-batched
   (≤1 execution/completed call), and budget-gated with fail-closed behavior.
3. Duplicate calls to the production gateways from shadow mode are prohibited —
   they are both budget-costly and (for submit/create) mutating.
4. Existing precedent in this account already favors digest/batching (§2.7) —
   the shadow design follows the same house pattern.
