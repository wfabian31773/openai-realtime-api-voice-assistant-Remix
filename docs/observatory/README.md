# Agent Observatory — Spec Pack

Last reviewed: 2026-08-06

**Status: SPEC — nothing here is built unless its checkpoint row says DONE.**

One screen inside the Operator Hub that answers, for every agent Wayne runs
— the four Ops Hub voice agents (Answering Service, Azul Scheduling SD
Pilot, No-IVR After-Hours, PCP Support) and SAGE (5Star) — three questions
at a glance:

1. **Is each agent healthy right now?** (crashing / hallucinating / looping
   / quality / latency / outcomes — the six pillars)
2. **Is each agent converting?** (the full funnel, per week, with every
   leak visible)
3. **What exactly is happening live?** (every in-flight call, any agent,
   with real-time transcript — the view that today exists only for the SD
   pilot)

This pack exists because six months of agent regressions went undiagnosed
while the answers sat in two databases nobody joined. The 2026-08 forensics
that finally explained the 50/day → 6/day booking collapse (silent
reconciler cancellations + pipeline starvation + a frozen schedule mirror)
were all derivable from data that existed the whole time. The Observatory's
job is to make that class of blindness impossible.

## Design laws

1. **Every number reconciles.** Adjacent numbers with different definitions
   must show the bridge (e.g. "Scheduled today 18" = 15 direct + 3
   handoff-completed; "Pending entry 6" = the 16 direct rows minus 10
   already entered). A widget that can't state its source query doesn't
   ship.
2. **Actionable, not decorative.** Red/amber tiles carry a diagnosis card:
   what's wrong, measured how, worst examples (click-through to
   transcripts), and the playbook step. No naked numbers.
3. **Reuse existing signals; add no new scoring pipelines.** Ops Hub already
   grades every call (grader results, quality scores, outcomes); 5Star
   already has reviews, hallucination guards, KPI snapshots, telemetry, and
   the director decision feed. The Observatory reads; it does not re-judge.
4. **Server-side reads only.** The Hub backend holds read-only Postgres
   connections to both Supabase projects. No cross-origin browser calls, no
   key exposure, no data duplication/sync jobs.
5. **The checkpoint board below is the live status** — same discipline as
   5Star's campaign-overhaul pack: a PR that implements a row updates the
   row in the same PR, quoting the verification.

## Architecture (decided)

- **Host:** THIS app — the Operations Hub (the TypeScript/Express/React
  Replit app that runs all four voice agents and owns the `agents` /
  `call_logs` / `call_turns` / `active_call_sessions` schema). Confirmed by
  Wayne 2026-08-06: the Observatory lives where the agents run. (The spec
  briefly lived in the Flask Operator Hub repo — superseded by this copy.)
  New client page + server routes + a WebSocket/stream channel alongside
  the existing SD-pilot live view.
- **Data plane:** two read-only DSNs in Hub config —
  `OBS_OPSHUB_DATABASE_URL` (its own project) and `OBS_5STAR_DATABASE_URL`
  (5Star, a read-only role to be created). All queries live in one module
  (`hub/observatory_queries.py`) so every widget's source is greppable
  (law 1).
- **Live plane:**
  - Ops Hub agents: `active_call_sessions` + `call_turns` are written in
    real time by the existing pipeline for ALL agents — the SD pilot's
    live view is just the only UI ever built on them. The Observatory's
    live panel subscribes once and covers every agent, PCP included.
  - SAGE: 5Star holds live transcripts in-memory per call
    (`subscribeToTranscript`). Phase B adds a small service-token WebSocket
    relay endpoint in 5Star (voice/Sage lane) so the Hub can subscribe
    server-side and re-emit on the same Socket.IO namespace.
- **Refresh:** scorecards/funnels poll on a 60s server cache; live panel is
  push.

## The funnel (per agent, per week)

`reached → engaged → booked → entered → materialized → kept`

- *reached*: calls answered by a human / SMS delivered (per channel)
- *engaged*: contacted conversations (excludes voicemail/no-answer classes)
- *booked*: bookings created by the agent (5Star: `internal_bookings` by
  `AI Voice Agent%`; Ops Hub: grader `agent_outcome`/booking events)
- *entered*: staff completed NextGen entry (5Star `entered_in_nextgen` and
  later statuses)
- *materialized*: matched in the NextGen mirror (`nextgen_appointment_id`)
- *kept*: reconciler verdict completed/kept
Each stage shows count + loss vs prior stage + top loss-reason breakdown.
The June–August repair (PRs #166/#173 + the 2026-08-06 re-audit) is the
reference implementation of these definitions.

## Phases & checkpoint board

Status: `TODO` → `IN PROGRESS (PR)` → `DONE (PR, verified date)`.

| ID | Item | Checkpoint (verifiable) | Status |
|---|---|---|---|
| OBS-0 | Read-only DB roles + Hub config for both DSNs | `SELECT 1` from both connections in a Hub health endpoint; 5Star role can `SELECT` but `INSERT` fails | TODO |
| OBS-A1 | Query module: six-pillar scorecard queries for all 5 agents | Module returns all pillars for a fixed test window; every widget maps 1:1 to a named query | TODO |
| OBS-A2 | Scorecards + funnel page (read-only) in the Hub | Page renders 5 agent cards + weekly funnel; the 2026-06→08 funnel reproduces the forensics numbers (566 cancelled / 251 restored-kept) exactly | TODO |
| OBS-A3 | Reconciliation bridges on paired numbers | "Scheduled today" card shows direct + handoff-completed breakdown matching the Upcoming Schedule banner query | TODO |
| OBS-B1 | Live panel: Ops Hub agents (all four) via `active_call_sessions`/`call_turns` | A live PCP-agent call streams turns in the Observatory while in progress | TODO |
| OBS-B2 | 5Star live-transcript relay (service-token WS in 5Star, voice lane) + SAGE in the live panel | A live Sage call streams in the Observatory; PHI stays server-side; relay authed by service token | TODO |
| OBS-C1 | Diagnosis cards v1 (rules in 02-diagnosis-rules.md) | Each rule fires correctly against its recorded historical episode (backtest) | TODO |
| OBS-C2 | Daily "what changed & who's hurting" brief | Morning summary lists any pillar that crossed red/amber in the last 24h with links | TODO |

## Documents

- `01-data-contracts.md` — the exact tables/columns each pillar and funnel
  stage reads, per project, including known gaps (e.g. SAGE per-call cost
  untracked; Ops Hub telemetry partial).
- `02-diagnosis-rules.md` — the automated forensics: each rule = trigger
  query + threshold + historical episode it would have caught + playbook.

## Non-goals (v1)

- No writes to either product database from the Observatory.
- No new grading/scoring models.
- No replacement of existing per-app admin screens; the Observatory links
  into them for drill-down beyond transcripts.
