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

1. **The 0.0% phone-ID figure on the queue lines is a LOGGING GAP, not an
   identification failure. Corrected twice; this is the version supported by
   the code.** `surgeryAgent.ts`, `opticalAgent.ts` and `techAgent.ts` contain
   **zero** calls to `updateCallLog`/`stampVerifiedIdentity` — they never write
   `patient_found` or `patient_name` at all, so the column sits at its default
   forever no matter what the agent knew. The column cannot measure these
   lines, in either direction.

   This is precisely the trap STATE-OF-PLAY §3 records ("a `false` can mean
   *never written*"), and `answeringServiceAgent.ts:614` documents the same
   bug being fixed for that agent: *"it is why `patient_found` was false on
   every answering-service call in the log while the agent was plainly
   recognising callers on the air."* Answering-service got the fix (hence its
   26.8%); the queue agents never did.

   **How the queue agents identify callers, then:** in conversation. The agent
   asks for name and date of birth, the model extracts them, and the lookup
   runs by name/DOB — `matchedBy` is `'phone' | 'name' | 'dob' |
   'name_and_dob'`. The filing tool carries the result onto the ticket. None
   of that path touches `call_logs.patient_found`, which is why tickets carry
   patient details while the column reads false.

   **no-ivr's 0% is a third, distinct case.** It *does* write the column
   (`noIvrAgent.ts:886`) — but only inside the pre-answer **phone**-lookup
   success branch, and only if `metadata.callLogId` already exists, which is
   the same backfill-timing hazard the answering-service comment describes. So
   its 0% means "no phone match logged", not "no caller identified".

   **Consequence for the migration:** *there is currently no fleet-wide
   measurement of caller identification.* The plan lists phone-ID rate as a
   cutover gate; that gate is unmeasurable on 3 of 5 lines and unreliable on a
   4th. Identity logging has to move into the runtime — written once for every
   agent, with the match path recorded — before it can gate anything. This is
   ADR-001's argument in miniature: one behavior implemented in five agent
   files, fixed in one, half-fixed in another, absent in three.

2. **tech halved week-over-week** (931 → 425 across comparable business days),
   with surgery and optical down similarly. Recorded as an observation, not a
   conclusion — the cause is operational (routing, volume, seasonality) and is
   not something this migration should infer.

## Measurement traps checked (STATE-OF-PLAY §3)

Both zero-valued columns above were verified as *measured* rather than
*never written*, because a `false` in this table has misled us before:

- `patient_found`: the column is non-null on every row, which is what misled
  this document twice — a non-null default is not a measurement. Three of the
  five agents never write it at all. **Checking that a column is populated is
  not the same as checking that something writes it.**
- `agent_outcome`: written on ~99.7% of calls; `abandoned` simply is not a
  value these agents emit, so an abandonment rate cannot be read from it and is
  deliberately absent from the tables above.

## Token cache baseline (OpenAI lanes only)

| | Rate |
|---|---|
| Audio input cached | 51.9% |
| Text input cached | 83.7% |
| Text cached, calls of 1–4 turns | **30.6%** |
| Text cached, calls of 40+ turns | 91.0% |

Both rates climb monotonically with turn count — within-conversation prefix
caching. The short-call text figure is the one to watch: it is where a
busted static prefix shows up first. Analysis and the design rules it
imposes are in `adr/ADR-001-centralized-voice-operations-hub.md`. Note these
numbers stop mattering for cost on any lane that moves to Grok's flat
per-minute pricing.

## How these gate the migration

| Metric | Gate |
|---|---|
| Quality score | must not fall below the line's baseline after cutover |
| Ticket % | the line's job; a drop is a regression regardless of quality |
| Outcome mix | material shift = behavior change, investigate before proceeding |
| Median 1st transcript | latency reference; the plan's §6 gate is "not materially worse" |
| Phone-ID % | **NOT USABLE as a gate yet** — see the logging gap above. Fix identity logging in the runtime first, then baseline it |
| $/call-minute | $0.0918 baseline; Grok's flat $0.08 should show as a modest fall |
| Short-call text cache % | OpenAI lanes only; a fall means a per-call value leaked into the static prompt prefix |
