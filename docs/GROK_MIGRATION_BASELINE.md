# Migration parity baseline — measured "before" numbers

Companion to `docs/GROK_MIGRATION_PLAN.md` (Phase 0) and
`docs/adr/ADR-001-centralized-voice-operations-hub.md`.

**Why this file exists.** `docs/BACKEND_HANDOFF.md` enforces one rule: *do not
merge a change to the ticket path without measuring the production number it is
meant to move, before and after.* Green tests did not prevent a single one of
the regressions recorded there. This is the **before** half, captured while
every line is still on OpenAI SIP, so the after half has something to be
compared against.

- **Captured:** 2026-08-29, from Operations Hub `call_logs`
  (`pslzngjciiifowemrzza`).
- **Window:** calls since **2026-08-17** — deliberately *not* 30 days; see
  "Traffic regime change" below.
- **Contents:** aggregates only. No transcripts, names, numbers or any other
  patient data is recorded here or committed anywhere in this repo.

---

## Per-line baseline (2026-08-17 → 08-29)

| Line | Calls | Median secs | Quality | Ticket % | Turns | Interrupts | Median 1st transcript | Phone-ID % |
|---|---|---|---|---|---|---|---|---|
| tech | 1,356 | 134 | **3.33** | **70.3** | 18.4 | 2.12 | 3,892 ms | 0.0 |
| surgery | 966 | 115 | 3.06 | 44.7 | 15.9 | 2.07 | 4,019 ms | 0.0 |
| no-ivr | 753 | 53 | 3.06 | 31.1 | 11.6 | 1.59 | 5,475 ms | 0.0 |
| optical | 663 | 115 | 3.11 | 45.7 | 17.1 | 2.16 | 3,781 ms | 0.0 |
| answering-service | 310 | 148 | 3.00 | 43.5 | 15.4 | 1.49 | 3,804 ms | **26.8** |

## Outcome mix — the sharpest parity signal

| Line | follow_up_needed | resolved | inconclusive | escalated |
|---|---|---|---|---|
| surgery | 96.9% | 0.8% | 0.7% | 1.6% |
| tech | 93.6% | 4.1% | 0.9% | 1.4% |
| optical | 92.9% | 3.6% | 1.8% | 1.7% |
| answering-service | 67.8% | — | **28.0%** | 4.3% |

A migrated line whose outcome mix moves materially has changed behavior, even
if its quality score holds. Answering-service's 28% `inconclusive` is the
outlier worth watching in both directions.

## Cost baseline

Measured across all lines, 7 days to 2026-08-29: **$292.43 OpenAI + $23.20
Twilio over 3,186 call-minutes = $0.0918 per call-minute (≈$1,253/month)**.
See `GROK_MIGRATION_PLAN.md` §2.7.

---

## Traffic regime change — why the window starts 2026-08-17

Weekly calls, showing the queue lines absorbing answering-service:

| Week of | answering-service | tech | surgery | optical | no-ivr |
|---|---|---|---|---|---|
| 07-20 | 2,407 | 0 | 0 | 0 | 540 |
| 07-27 | 2,668 | 0 | 0 | 0 | 576 |
| 08-03 | 2,447 | 0 | 0 | 0 | 554 |
| 08-10 | 1,720 | 358 | 237 | 179 | 527 |
| 08-17 | **217** | 931 | 623 | 483 | 563 |
| 08-24 | 93 | 425 | 343 | 180 | 190 |

Answering-service did not decay — its traffic was **deliberately re-routed**
into the queue lines when they launched (~08-10, complete by 08-17). A 30-day
baseline would average across two different operating regimes and be
meaningless as a parity reference. Hence 08-17.

**Consequence for the plan:** answering-service at ~93 calls/week is now the
*low-blast-radius pilot*, not the flagship. The queue lines are the volume and
the value.

---

## Two findings that need an operator decision

1. **The queue lines do NO caller-ID identification — 0.0%, and that is real,
   not a logging gap.** `patient_found` is written on 100% of their calls
   (1,356/1,356 for tech), and `patient_name` on 0% — so they genuinely never
   resolve the caller before answering, while answering-service does on 26.8%.
   The hub's pre-context capability (the confirm-not-ask pattern hardened on
   DRS) would therefore be a **behavior change** for these lines, not a port.
   It is likely an improvement — but it is Wayne's call, not a detail to slip
   in during a pipeline swap.
2. **tech halved week-over-week** (931 → 425 across comparable business days),
   with surgery and optical down similarly. Recorded as an observation, not a
   conclusion — the cause is operational (routing, volume, seasonality) and is
   not something this migration should infer.

## Measurement traps checked (STATE-OF-PLAY §3)

Both zero-valued columns above were verified as *measured* rather than
*never written*, because a `false` in this table has misled us before:

- `patient_found`: **written on every call** for every line → the 0.0% is real.
- `agent_outcome`: written on ~99.7% of calls; `abandoned` simply is not a
  value these agents emit, so an abandonment rate cannot be read from it and is
  deliberately absent from the tables above.

## How these gate the migration

| Metric | Gate |
|---|---|
| Quality score | must not fall below the line's baseline after cutover |
| Ticket % | the line's job; a drop is a regression regardless of quality |
| Outcome mix | material shift = behavior change, investigate before proceeding |
| Median 1st transcript | latency reference; the plan's §6 gate is "not materially worse" |
| Phone-ID % | answering-service only today; must not regress from 26.8% |
| $/call-minute | $0.0918 baseline; Grok's flat $0.08 should show as a modest fall |
