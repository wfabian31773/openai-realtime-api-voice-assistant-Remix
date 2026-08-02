# 07 — Comparison and Scoring Specification (Checkpoints 13 & 14)

Implementation: `src/shadow/comparison.ts`, `src/shadow/evaluation.ts`.

## 1. Turn-level comparison (`TurnComparison`)

Recorded per meaningful (caller) turn, deferred until that turn's production
events have arrived (production tools fire *after* the caller speaks; the
comparison flushes when the next caller turn starts, or at finalization):

production side — inferred intent (null: production intent is unobservable,
doc 02), assistant message, tool request + args digest, n8n endpoint, observed
state (null), escalation; shadow side — intent, step, final (engine-legal)
action, proposed question/response, simulated tool + args digest, simulated n8n
workflow, model tier; matches — intent (nullable), action, tool, n8n; hygiene —
bundled/repeated questions both sides, premature tool/n8n both sides,
state-loss signals; `reviewRequired`; disagreement codes:

`intent_mismatch, action_mismatch, tool_mismatch, tool_args_mismatch,
n8n_workflow_mismatch, production_bundled_questions, shadow_bundled_questions,
production_repeated_question, shadow_repeated_question,
production_premature_tool, shadow_premature_tool, production_premature_n8n,
shadow_premature_n8n, state_loss_signal, escalation_mismatch, urgency_mismatch,
duplicate_action_risk, shadow_blocked_would_be_mutation`

`shadow_blocked_would_be_mutation` fires only when the shadow's allowed
mutating simulation has **no matching production call** — the divergent case a
reviewer must see; an agreeing mutation is just tool agreement.

## 2. Session-level summary (`SessionComparisonSummary`)

Agreement percentages (intent/action/tool/tool-args/n8n), repeated-question,
bundled-question, loop, premature-tool/n8n, duplicate-action, state-loss
counts (each split production/shadow where applicable), escalation agreement,
production outcome vs shadow predicted outcome, model-tier distribution,
average reasoning latency, estimated shadow cost, n8n execution estimate,
% of turns requiring review, disagreement-code histogram, and — on **every**
summary — the limitation text:

> “Counterfactual limitation: callers answered PRODUCTION questions. Shadow
> paths after any divergence are hypothetical; no claim is made that the shadow
> conversation would have completed successfully.”

## 3. Deterministic verdicts (Checkpoint 14)

Automated scoring confidently evaluates ONLY: tool eligibility, required-field
completeness, duplicate actions, repeated questions, loop signals,
one-question-at-a-time compliance, state-transition legality, retry limits,
confirmation requirements, structured-output validity, escalation-rule
compliance, n8n-budget compliance (≤1 execution estimate per session).

| Verdict | Rule |
|---|---|
| `human_review` | any priority ≥ 70 code (below), or meaningful disagreement below auto-confidence |
| `worse` | shadow hygiene metrics strictly worse than production's |
| `better` | shadow strictly avoided hygiene defects production exhibited AND action agreement ≥ 60% |
| `equivalent` | action agreement ≥ 80% and zero review-priority codes |
| `indeterminate` | everything else (incl. zero-turn sessions) |

## 4. Review queue priorities

| Priority | Trigger |
|---|---|
| 100 | safety/urgency disagreement |
| 90 | different escalation decisions |
| 80 | different tool choices |
| 75 | different n8n workflow involvement |
| 70 | duplicate-action risk |
| 60 | state-loss finding |
| 50 | shadow recommendation that would have mutated production if not blocked |
| 40 | loop signals |
| 35 | incomplete-field tool recommendation (either side) |

Human review is required for: tone, empathy, clarity, nuanced caller
experience, whether an alternate question would have produced a better answer,
medically or operationally ambiguous cases, and different-but-both-valid paths.
The queue is bounded (500), sorted by priority, exposed via `shadowHealth()`.

## 5. Validated behavior (fixture evaluation set, 2026-08-02)

| Session | Verdict | Action agreement | Loops | Notes |
|---|---|---|---|---|
| fx-ticket-happy | equivalent | 100% | 0 | tool + n8n agreement, zero executions |
| fx-loop-name | **better** | 100% | 3 | production repeated/ignored/bundled asks detected; shadow avoided them |
| fx-urgent | human_review | 0% | 0 | escalate-vs-transfer nuance — correctly conservative for safety |
| fx-tool-failure | human_review | 67% | 2 | repeated failure + retry ceiling |
| fx-multi-intent | equivalent | 100% | 0 | correction + side intent held |
| fx-premature-ticket | human_review | 50% | 1 | production ticket before any field |
| fx-side-question | human_review | 100% | 1 | ignored-answer signal on return from side question |
| fx-cancellation-flow | equivalent | 100% | 0 | no mutation recommended after caller cancelled |
