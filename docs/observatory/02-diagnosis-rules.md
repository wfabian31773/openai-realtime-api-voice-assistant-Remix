# Observatory diagnosis rules (v1)

Last reviewed: 2026-08-06

Each rule is an automated version of a forensic finding that actually
happened. A rule = trigger query + threshold + the historical episode it
would have caught + the playbook shown on the card. OBS-C1's checkpoint is
a backtest: every rule must fire on its episode's date range and stay
quiet on healthy ranges.

| # | Rule | Trigger (sketch) | Would have caught | Playbook on card |
|---|---|---|---|---|
| R1 | Booked-vs-kept divergence | weekly kept/booked < 60% for an agent | Jun–Jul: false-cancel wave (74% cancelled peak; 251 real screenings erased) | Check R2/R3 first; run re-audit query; inspect reconciler verdict mix |
| R2 | Mirror/sync staleness | `nge_schedule_sync_state` age > 25h; OPSHUB sync-state ages | Aug 1–5 mirror freeze; Ops Hub Schedule frozen since Jul 15 | Run morning-sync runner; verify watchdog page fired; #173 gate defers meanwhile |
| R3 | Silent-cancel spike | daily `internal_bookings` → cancelled flips with no user action, grouped by note class | SAFETY GUARD 2 era (destroyed reschedules + confirmed bookings, Jun 21–Aug 5) | Identify writer via note class; verify #166/#173 gates active; re-audit window |
| R4 | Entry-queue aging | `manual_import_needed` rows > 24h old with slot < 72h away (mirrors 5Star SLA cron) | Jul entry backlog weeks | Work the Pending NextGen worklist; card lists exact rows |
| R5 | Quota burnout / send burst | >40% of daily SMS in any hour; quota spent before 10:00 PT | The 8:05–8:40 AM 1,500-burst era (fixed by P1-4) | Check per-tick caps + overlap guard; inspect dispatcher run notes |
| R6 | Channel starvation | campaign calls/day = 0 while SMS flows; or follow-up share acted ≈ 0 | Zero campaign calls Jun 22 → Aug 5 (cadence starvation); fu_medicare starved by language gate | Check draw/acted mix in run notes; coordinator-language coverage; fallback counters |
| R7 | Empty-slot-offer rate | `get_scheduling_options` responses with no availability > 25%/week | Slot-supply thinning (15% → 31% empty, Jul→Aug) | Verify DRS slot sync ran; check per-location depth; escalate capacity to Wayne |
| R8 | Reasoning-director burst | ≥3 consecutive `reasoning_timeout`/`safety_validation_failed` handoffs within 10 min | Aug 6 2:50–2:54 PM burst (8 straight 4.5s timeouts) | Provider status; circuit-breaker state; consider raising timeout; coordinators absorbed N calls |
| R9 | Handoff dead-letter | answered-handoff rate < 50%/day, or `fallback_callback` share rising | Callback queue 0.3% completion; unanswered bridges Aug 5–6 | Coordinator staffing/hours; callback queue depth with names |
| R10 | Outcome-integrity mismatch | calls with answered handoff but outcome ∉ (scheduled, transferred); voicemail-shaped transcripts labeled `call_back_later` | Answered transfers logged `call_back_later`; 3 of 5 "callbacks" were machines (Aug 5 audit) | Classifier/feedback fix status; recount affected funnel cells |
| R11 | Prod-vs-repo divergence | FIVESTAR `release_history.git_short_sha` not on origin/main | Workspace deploys missing #170/#171 (twice in one week) | Merge main into workspace before deploy; list missing merges |
| R12 | Grader critical-failure spike (Ops Hub) | agent's critical-fail rate > 1.5× its 30-day baseline for 2+ days | SD pilot 56% critical era | Top failing check + 5 worst transcripts linked |

## Card anatomy (law 2)

Every fired rule renders: severity, one-sentence finding with measured
numbers, sparkline of the trigger metric, top 3–5 example calls/rows with
transcript links, the playbook, and an "acknowledged by" control so a known
condition stops re-alerting (with expiry).

## Daily brief (OBS-C2)

07:00 ET summary: any rule that fired or cleared in 24h, each agent's
pillar deltas, funnel week-to-date vs prior week, freshness header. Same
reconciliation law applies — every number in the brief links to its card.
