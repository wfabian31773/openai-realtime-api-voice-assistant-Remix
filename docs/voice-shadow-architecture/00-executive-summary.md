# 00 — Executive Summary: Parallel Shadow Voice-Agent Architecture

**Date:** 2026-08-02 · **Branch:** `claude/shadow-voice-agent-architecture-02qun2` · **PR:** #60

## What was built

A complete, tested, documented **observation-only shadow architecture** that
can watch every active production voice agent handle real calls, independently
decide what *it* would have done at each turn, and compare the two — without
the ability to speak, mutate, transfer, route, or delay anything.

- **7 active production/pilot agents + 1 dev agent** inventoried with evidence
  (doc 01); all hosted in this repo. Shadow workflow definitions exist for all.
- **11 n8n workflows** inventoried read-only (doc 13); July usage measured at
  **6,697 / 10,000** executions — so the shadow runs on **zero** n8n executions
  by default, consuming in-process *copies* of production gateway traffic.
- Production diff: **four one-line, never-throwing, flag-gated taps** plus one
  boot no-op. Everything else is new code under `src/shadow/` and docs.
- **98 shadow tests** (270 repo-wide, all green) including structural proofs
  that a disabled or broken shadow cannot change production output and that
  shadow code cannot reach any mutating client or production n8n webhook.
- All flags default **off**; production enablement stops at the approval gate
  in doc 12.

## Before (production, unchanged)

```
caller ─ Twilio/SIP ─► gpt-realtime agent ─► tools ──► n8n VA Gateway ─► ticketing-app
                        │ (prompt = workflow engine)   (log-only audit)
                        └► eyecare-scheduling service (azul pilot: server-side gates)
```

## After (production identical; shadow alongside)

```
caller ─ Twilio/SIP ─► gpt-realtime agent ─► tools ──► n8n VA Gateway ─► ticketing-app
              │tap           │tap                │tap (request/response copies)
              ▼              ▼                   ▼
        ┌─ shadowTap (never throws, drop-on-overflow, flag-gated) ─┐
        │  normalizer → idempotent session store → per-turn:       │
        │  interpretation (advisory) → DETERMINISTIC workflow      │
        │  engine → tool/n8n simulators (simulation-only types,    │
        │  replay of production results) → loop & state-loss       │
        │  detection → production-vs-shadow comparison →           │
        │  evaluation + review queue → JSONL spool + metrics       │
        │  (optional, OFF: batched n8n session bundle ≤1/call)     │
        └──────────────────────────────────────────────────────────┘
```

## What the shadow answers per turn

Caller intent (+confidence), extracted/missing fields, active workflow step,
legal next action (ask/confirm/simulate tool/respond/transfer/escalate/
complete), which tool with validated args, whether it's allowed and confirmed,
model tier (and why), loop/state-loss/bundled-question/repeated-question
signals on **both** sides, and per-turn + per-session agreement with
disagreement codes and review priorities. Every report carries the
counterfactual limitation statement (callers answered production's questions).

## Key findings already produced (fixture replay set)

The 8-session evaluation run shows the engine catching exactly the failure
modes the current architecture is known for: production re-asking a stored
name (verdict **better** for shadow), premature ticket creation before any
field was collected, repeated failing tool calls at the retry ceiling, and
safety-path nuances correctly routed to human review (doc 07 §5).

## Budget position

Production n8n usage alone is 84% of the 8,000 planned ceiling. The shadow
therefore contributes **0** executions by default, with a fail-closed,
blocklist-guarded, session-batched optional bundle capped at 300/month and 25%
capture if ever approved (docs 14–16).

## Status

**READY FOR STAGING SHADOW / READY FOR PRODUCTION SHADOW PENDING APPROVAL** —
see doc 12 for the certification detail, exact enable/disable commands, and
the recommended initial configuration (10% capture, canary + no-ivr).

## Next action required from the operator

Review PR #60; if approved, follow the enablement ladder in doc 09 §3 —
staging first (`dev-no-ivr`, 100%), then the production approval decision.
