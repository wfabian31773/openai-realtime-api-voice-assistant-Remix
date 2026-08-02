# 14 — n8n Execution-Budget Model (Checkpoints 15 & 16)

## 1. Verified inputs (doc 13)

| Input | Value | Source |
|---|---|---|
| Absolute account limit | 10,000 exec/month | task constraint (~10k plan) |
| Planned ceiling | **8,000** | mandated default |
| Safety reserve | **2,000** (20%) | mandated default |
| July 2026 measured production usage | **6,697** | `search_executions`, `estimated:false` |
| — submit-ticket gateway | 6,665 | per-workflow query |
| — daily digest | 28 | per-workflow query |
| — create-ticket gateway | 4 | per-workflow query |
| Staged (inactive) workflows if later enabled | ~150/mo (disposition audit ~30 + taxonomy cache ~120) | workflow descriptions |

**Production baseline used: `N8N_CURRENT_PRODUCTION_MONTHLY_ESTIMATE = 6,700`**
(measured July, rounded up). Confidence: HIGH for the total (full-month count via
API); MEDIUM for per-call attribution (6,665 submissions/month is far above
plausible completed-call ticket volume — likely includes outbox retries and
non-call traffic; the budget uses the measured total regardless of cause, which
is the conservative choice).

## 2. The mandated model

```
E = C × P × W × R / B
```

| Var | Meaning | Value (default config) | Value (100% capture) |
|---|---|---|---|
| C | expected production calls/month | ~6,600 (upper bound from ticket-gateway volume; real call count is likely lower) | same |
| T | avg meaningful turns/call | ~6 (fixture/audit-informed; not an E input — shadow does NOT execute per turn) | same |
| P | % of calls captured by shadow | **0%** (default) | 100% |
| W | new n8n executions per captured call | **0** (default: bundle disabled; all replay in-app) | 1 (bundle enabled) |
| R | retry multiplier | 1.1 (bounded retry cap 3, expected rare) | 1.1 |
| B | batch size | 10 (micro-batch) | 10 |
| **E** | **projected shadow executions/month** | **0** | 6,600 × 1.0 × 1 × 1.1 / 10 ≈ **726** |

Session-level batching note: with `batchSize=10`, ten completed sessions share
one bundle POST — but the enforcer still counts the POST per triggering session
key for the per-call cap; E uses the actual send count (≈ C×P/B × R).

## 3. Projected totals

| Scenario | Production | Shadow | Total | % of 10,000 | Within 8,000 planned? |
|---|---|---|---|---|---|
| Default (shipping config) | 6,700 | **0** | **6,700** | 67% | ✅ (reserve intact: 3,300 to absolute, 1,300 to planned) |
| Bundle on, P=100%, B=10 | 6,700 | ~726 | ~7,426 | 74% | ✅ but only 574 headroom — NOT recommended |
| Bundle on, P=25%, B=10 (recommended max if ever enabled) | 6,700 | ~182 | ~6,882 | 69% | ✅ |
| Bundle on, P=100%, B=1 (anti-pattern) | 6,700 | ~7,260 | ~13,960 | 140% | ❌ prohibited by config caps |

**Maximum safe capture percentage (shadow n8n bundle): 25%** with batching (B=10),
which keeps projected totals under 6,900 and preserves > 1,100 headroom below
the planned ceiling for production variability. For the shadow SYSTEM itself
(in-app processing), capture percentage is not n8n-constrained at all — 100%
event capture costs 0 n8n executions; the model-cost budget governs it instead.

## 4. Enforcement configuration (implemented in `src/shadow/config.ts` + `n8nBudget.ts`)

| Concept | Env var | Default |
|---|---|---|
| Monthly absolute limit | `N8N_MONTHLY_ABSOLUTE_LIMIT` | 10000 |
| Monthly planned limit | `N8N_MONTHLY_PLANNED_LIMIT` | 8000 |
| Safety reserve | `N8N_SAFETY_RESERVE` | 2000 |
| Warning threshold | `N8N_WARN_THRESHOLD` | 5600 |
| Critical threshold | `N8N_CRITICAL_THRESHOLD` | 6800 |
| Shadow stop threshold | `N8N_STOP_THRESHOLD` | 8000 |
| Production baseline | `N8N_CURRENT_PRODUCTION_MONTHLY_ESTIMATE` | 6700 |
| Shadow n8n enabled | `SHADOW_N8N_ENABLED` | **false** |
| Shadow capture % (bundle) | `SHADOW_N8N_CAPTURE_PCT` | **0** |
| Max shadow executions/call | `SHADOW_N8N_MAX_PER_CALL` | 1 |
| Daily shadow budget | `SHADOW_N8N_DAILY_BUDGET` | 10 |
| Monthly shadow budget | `SHADOW_N8N_MONTHLY_BUDGET` | 300 |
| Batching enabled | `SHADOW_N8N_BATCHING_ENABLED` | true |
| Batch size | `SHADOW_N8N_BATCH_SIZE` | 10 |
| Fail-closed | `SHADOW_N8N_FAIL_CLOSED` | true |
| Retry cap (counted in budget) | `SHADOW_N8N_RETRY_MAX` | 3 |
| Production-host blocklist | `SHADOW_N8N_PRODUCTION_BLOCKLIST` | azulvision.app.n8n.cloud/webhook/, ticketing-n8n.onrender.com/webhook/, ticketing-app host |

⚠️ NOTE ON THE BASELINE THRESHOLDS: the measured production baseline (6,700) is
already **above the 5,600 warning threshold and below critical** — the enforcer
therefore reports `warning` from day one. This is correct and intentional: it
reflects that *production alone* is consuming 84% of the planned ceiling, which
is precisely why the shadow ships with W=0. Reducing production submit-ticket
volume (e.g. the documented `TICKETING_ENRICHMENT_URL` direct-app bypass) is
the operator lever that restores headroom — flagged in doc 10.

Enforcement layers: application (decide→record ledger, per-call/daily/monthly/
threshold/idempotency/host checks), workflow (the importable bundle receiver
validates shadow-mode, vocabulary, idempotency — doc 15 §3), operational
(`shadowHealth()` exposes today/month counts, per-call map, duplicates blocked,
rejected count, retries, remaining planned/absolute, projected month-end, and
estimated cap-reach date).

## 5. Fail-closed semantics (verified by tests)

When any budget dimension is exhausted or uncomputable: the send is refused,
the bundle is dropped from the queue (session remains replayable from spool),
a metric/log fires, **no production workflow is touched** — production
gateways are unreachable from shadow code by blocklist and by module graph.
Fail closed never means stopping production.
