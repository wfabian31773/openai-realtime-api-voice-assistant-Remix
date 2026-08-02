# 05 — Model-Routing Policy (Checkpoint 8)

## 1. Verified model inventory (no invented identifiers)

Production (unchanged by this project): `gpt-realtime` (voice),
`gpt-4o-mini-transcribe` (STT), `gpt-4o`/`gpt-4o-mini` (pre-existing graders).

Shadow reasoning tiers (updated 2026-08-02): the **GPT-5.6 family**, identifiers
verified against developers.openai.com/api/docs/models — `gpt-5.6-luna`
($0.20/$1.20 per 1M in/out), `gpt-5.6-terra` ($2/$12), `gpt-5.6-sol` (alias
`gpt-5.6`, $5/$30). Newer realtime models exist (`gpt-realtime-2.1`) — a
*production* upgrade candidate via the existing `AZUL_AB_MODEL_B` A/B lever,
out of shadow scope.

## 2. Tier mapping (provider-neutral interface, env-overridable)

| Tier | Default model | Env override |
|---|---|---|
| `deterministic` | no model call — rules only | — |
| `low` | `gpt-5.6-luna` | `SHADOW_MODEL_LOW` |
| `mid` | `gpt-5.6-terra` | `SHADOW_MODEL_MID` |
| `high` | `gpt-5.6-sol` | `SHADOW_MODEL_HIGH` |

Shadow never uses realtime/audio models (shadow is text/structured only) and
never alters production model selection (`AZUL_AB_MODEL_B` untouched).

## 2.1 Live refinement adapter (implemented 2026-08-02)

`src/shadow/llmAdapter.ts` performs the actual tier-model call when
`SHADOW_MODEL_ROUTING_ENABLED=true` (now on in `.replit`): minimized structured
state + identifier-masked current utterance only (never transcript history,
per the grading-service precedent); JSON-object output validated against a
strip-unknown schema that **cannot carry tool choices or arguments** —
tool decisions remain deterministic; urgency is raise-only; caller-facing text
is sanitized; 10s timeout; budget-gated (6 calls/session, $5/day; unpriced
models charged an assumed per-call cost so the cap always binds); every
failure path returns the deterministic result.

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
