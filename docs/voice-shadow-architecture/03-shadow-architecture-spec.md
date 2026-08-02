# 03 — Shadow Architecture Specification (Checkpoint 4)

## 1. Placement and principle

The shadow system lives in `src/shadow/` in this repo, runs **in-process** with the
voice server as a strictly asynchronous observer, and is wholly gated by
configuration that defaults **off**. Production code gains only four one-line,
never-throwing tap calls (§3). When disabled, each tap is a single boolean check.

```
                         PRODUCTION (unchanged)
 caller ──► Twilio ──► realtime session ──► tools / n8n gateway ──► response
                │              │                   │
                │ transcripts  │ toolTimeline      │ ticketingApiClient req/res
                ▼              ▼                   ▼
        ┌─────────────────────────────────────────────────────┐
        │ shadowTap.emit(...)  — never throws, never blocks    │
        │  • enabled? sampled? agent allowlisted? else return  │
        │  • push → bounded ring buffer (drop-oldest + count)  │
        └───────────────┬─────────────────────────────────────┘
                        ▼  async drain (setImmediate batches)
        normalizer → session store (idempotent) → pipeline per turn:
        interpretation (advisory) → deterministic workflow engine →
        tool simulator → n8n simulator (replay-first) → response planner →
        loop/state-loss detector → comparison → evaluation/review queue
                        ▼
        JSONL spool + metrics + operational report (+ optional batched
        n8n session bundle — inactive by default, budget-gated)
```

## 2. Event sourcing design (Checkpoint 4 required fields)

| Aspect | Design |
|---|---|
| Event source | Four in-process taps (§3) + `callLifecycleCoordinator.on('call-ended')` subscription (no production edit). |
| Event schema | `ShadowEvent` (doc 04), zod-validated at ingestion; invalid events counted + quarantined to spool, never crash. |
| Ordering | Monotonic per-process `seq` assigned at emit; pipeline sorts per session by `(seq, ts)`; out-of-order tolerated — state updates are pure reducers over sorted history. |
| Session correlation | `sessionId` = OpenAI callId (primary), with `twilioCallSid` alias carried in payload; alias resolution mirrors `callLifecycleCoordinator` id-alias map. |
| Turn correlation | `turnId` = count of user-transcript events at emit time; tool events attach to the current turn. |
| Transcript source | Same handler that feeds `callTranscripts` (routes `:2079-2200`) — CALLER/AGENT lines. |
| Tool events | `toolTimeline.recordingExecute` wrapper (fleet-wide since 2026-08-01) — args already PHI-allowlisted by production code before we copy. |
| n8n request/result events | `ticketingApiClient` around gateway HTTP calls — copies of exactly what production sent/received; **zero additional n8n executions**. |
| Latency expectation | Tap → pipeline start: same tick to <50 ms (setImmediate). Turn analysis: ms-scale deterministic path; model calls (if enabled) are post-hoc, no deadline coupling to the call. |
| Replay | Spool JSONL per session; replay harness re-feeds identical events (doc §6, CP19). |
| Duplicate events | `eventId` = hash(sessionId, type, seq-scoped content); session store dedupes; processing idempotent. |
| Missing events | State machine tolerates gaps (e.g. tool_completed without tool_requested → synthesized `other` provenance, flagged `missing-event`). |
| Error isolation | Every tap and pipeline stage wrapped; failures increment counters and structured-log at most once per session; **no exception can cross into production frames** (tap catches internally). |
| Backpressure | Ring buffer cap (default 5,000 events); overflow drops oldest + increments `shadow_dropped_events`; pipeline batch size capped. |
| Privacy/redaction | Redaction stage before spool/report: identifier hashing (phone → last4+hash), DOB masked, free text length-capped; reuses production allowlist philosophy (deny by default). Transcript storage **off by default** (flag). |
| Storage | JSONL spool under `SHADOW_SPOOL_DIR` (default `<repo>/.shadow-spool`, gitignored). Optional Postgres tables are a documented migration plan (doc 09), **not applied**. |
| Retention | Spool files date-stamped; purge > `SHADOW_RETENTION_DAYS` (default 14, matching the console's snapshot retention precedent). |
| Environment separation | Config namespace `SHADOW_*`; no shared mutable state with production modules; no production credential is read by shadow code (it receives copies of results instead). |
| Credentials | None required for core operation. Optional LLM reasoning uses the existing `OPENAI_API_KEY` (read-only inference); optional shadow n8n bundle uses a **separate** `SHADOW_N8N_WEBHOOK_URL` + `SHADOW_N8N_TOKEN`, never production gateway URLs. |
| Failure modes | enumerated in doc 08 test matrix: queue full, spool unwritable, model timeout/invalid JSON, pipeline crash, budget exhausted — all isolate. |
| Cost controls | model budget caps (per-call and daily token/cost ceilings), n8n budget module (doc 14/16). |

## 3. Production tap sites (the entire production diff)

| # | File | Site | Event(s) |
|---|---|---|---|
| T1 | `src/voiceAgentRoutes.ts` | `observeCall()` after agent resolution | `session_started` |
| T2 | `src/voiceAgentRoutes.ts` | transcript handlers (CALLER / AGENT lines) | `user_transcript`, `assistant_transcript` |
| T3 | `src/services/toolTimeline.ts` | record points in `recordingExecute` | `tool_requested`, `tool_completed`, `tool_failed` |
| T4 | `server/services/ticketingApiClient.ts` | gateway request/response wrapper | `n8n_workflow_requested`, `n8n_workflow_completed`, `n8n_workflow_failed` |
| — | (no edit) `callLifecycleCoordinator.on('call-ended')` | subscription from `src/shadow/index.ts` | `session_completed` |
| — | (no edit) transfer events derived from tool events (`transfer_to_office`, `escalate_to_human`, `transfer_to_human`) | | `transfer_started`/`transfer_completed` |

Rules for taps: one line each; argument construction must be allocation-cheap;
`shadowTap.emit` returns `void`, never throws (outer `try {} catch {}` inside the
method, not at call sites); no `await` at any call site. The production path has
**zero** knowledge of shadow success/failure.

Precedent followed: `qvoEmitterService` (fire-and-forget, no-op unless configured,
circuit breaker, PHI gate) — the established house pattern for exactly this shape.

## 4. Two-process note

The repo runs two processes (`server/index.ts` API, `src/server.ts` voice). All
voice-path taps live in the voice process. `ticketingApiClient` is also imported by
API-process services; the tap is process-agnostic (events carry `source.pid`), and
each process drains to its own spool file — the replay/aggregation layer merges by
sessionId. Comparison quality is unaffected (ticket calls carry callSid correlation).

## 5. Non-goals (enforced)

- No inline positioning between caller and agent; no synchronous handoff.
- No production mutation: the shadow has **no clients capable of writes** — the tool
  simulator holds policies + validators only; the n8n simulator holds contracts +
  replayed results only. There is no code path from shadow to Twilio, NextGen,
  ticketing-app mutation endpoints, or production n8n webhooks. (Tests assert the
  module graph: `src/shadow/**` must not import mutating clients.)
- No model-side workflow authority: reasoning output is advisory; the deterministic
  engine decides legality (CP7).

## 6. Session lifecycle in the shadow store

`active` → (`waiting_for_user` | `waiting_for_production_tool_result` |
`waiting_for_production_n8n_result`) → `completed` | `escalated` | `failed`.
Sessions with no `session_completed` within `SHADOW_SESSION_TIMEOUT_MIN` (default 30,
matching production's `active_call_sessions` TTL) are finalized as `failed` with
reason `timeout` and remain replayable from spool.
