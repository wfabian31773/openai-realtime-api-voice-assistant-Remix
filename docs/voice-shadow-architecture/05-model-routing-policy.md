# 05 — Model-Routing Policy (Checkpoint 8)

## 1. Verified model inventory (no invented identifiers)

Configured in this repo (doc 01 §6): `gpt-realtime` (voice, production only),
`gpt-4o-mini-transcribe` (STT, production only), `gpt-4o-mini` and `gpt-4o`
(chat completions — grading/summaries). No Anthropic models configured.

## 2. Tier mapping (provider-neutral interface, env-overridable)

| Tier | Default model | Env override |
|---|---|---|
| `deterministic` | no model call — rules only | — |
| `low` | `gpt-4o-mini` | `SHADOW_MODEL_LOW` |
| `mid` | `gpt-4o` | `SHADOW_MODEL_MID` |
| `high` | `gpt-4o` (no stronger model is configured in this repo; the tier interface exists so a stronger model can be mapped without code change) | `SHADOW_MODEL_HIGH` |

Shadow never uses `gpt-realtime` (audio model; shadow is text/structured only) and
never alters production model selection (`AZUL_AB_MODEL_B` untouched).

## 3. Tier responsibilities

- **deterministic** (always runs, and is the *only* layer in unit tests): regex/
  lexicon intent candidates, field extraction for structured formats (phones, DOB,
  ordinals), urgency keyword match (`URGENT_SYMPTOMS` reuse), next-step selection
  when the workflow state fully determines it, QA scoring, loop checks.
- **low**: intent classification among known intents, entity extraction from messy
  speech, field normalization, transcript cleanup, short summaries, routine
  next-step selection, simple tool-result interpretation.
- **mid**: ambiguous requests, conflicting preferences, ≥2 candidate intents,
  multi-step scheduling constraints, policy interpretation, tool-result edge cases,
  caller corrections, temporary topic changes, nuanced escalation.
- **high**: exceptional cross-domain reasoning, difficult recovery, ambiguity
  unresolved after ≥2 attempts, conflicting policy sources, rare operational
  exceptions, explicit escalation from the workflow engine.

## 4. Selection signals (never message length alone)

Structured `RoutingSignals`: `ambiguityScore` (0..1), `unresolvedFieldCount`,
`candidateIntentCount`, `constraintCount`, `retryCount`, `conflictCount`,
`policyComplexity` (per-agent static weight), `toolResultComplexity`,
`escalationRequested`. Deterministic scoring:

```
if engine fully determines next action              → deterministic
score = 2*ambiguityScore + candidateIntents>1 + conflicts + retries≥2
        + constraints≥3 + toolResultComplexity + policyComplexity
score == 0                                          → low
score ≤ 3 and !escalationRequested                  → mid
otherwise                                            → high
```

## 5. Logging (per decision)

`{tier, model, reason, signals, latencyMs, tokensIn/Out (when available),
structuredOutputValid, fallbackUsed, error, estCostUsd}` — cost from the repo's
`modelPricing` table where the model is listed, else marked `unpriced`.

## 6. Guardrails

- Model routing exists **only** inside the shadow path; flag `SHADOW_MODEL_ROUTING_ENABLED`
  (default false → deterministic tier only, zero API calls, zero cost).
- Structured output: JSON schema per call; invalid JSON → 1 bounded retry at same
  tier → fallback to deterministic result with `fallbackUsed: true`.
- Budgets: `SHADOW_MODEL_MAX_CALLS_PER_SESSION` (default 6),
  `SHADOW_MODEL_DAILY_COST_CAP_USD` (default 5) — exceeded ⇒ deterministic only.
- Routing never overrides the deterministic engine's legality decisions.
