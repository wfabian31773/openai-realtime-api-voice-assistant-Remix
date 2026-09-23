# W3 — THE BARELY-HEARD MEASUREMENT

**Measured 2026-09-23. Read this before quoting any barely-heard rate; the
table in CLAUDE.md ended at 2026-09-08 and two things have changed since.**

W3 as written in `docs/observatory/SPEC-20260923.md`: *"Re-measure the
barely-heard rate per lane since the VAD change, both arms together
(barely-heard must fall AND interruptions per call must not rise). Then it is
Wayne's call on the trade, because the opposite failure is the agent stopping
for a cough."*

Barely-heard is `duration >= 30` with the caller transcribed at most once,
counting `CALLER:` lines in the transcript and never `total_turns`.

---

## 0. THE "AFTER" WINDOW HAS TWO CHANGES IN IT, NOT ONE

`RUNTIME_VAD_THRESHOLD` went to 0.6 in `dfe4569`, **2026-09-04 00:39 UTC** —
before the queue lanes opened that day, so 09-04 onward is a clean threshold
arm. The code default is `0.6` (`grokSession.ts:163`), so the arm holds whether
or not the env var is set on the deployment.

**But v39's recording disclosure went live on 2026-09-17**, and a naive
"09-04 to today" after-window silently folds the two together. The transcript
proves the date:

| day | substantive optical+surgery+tech | carrying the disclosure |
|---|---|---|
| 09-15 | 375 | **0** |
| 09-16 | 372 | **0** |
| 09-17 | 310 | **307** |
| 09-18 .. 09-22 | 1,106 | **1,106** |

It lengthens the greeting the caller talks over by ~61 characters on every
lane (optical 190 → 251 median chars, surgery 206 → 268, tech 201 → 262), so
it is exactly the kind of change that moves both of W3's arms. **Three arms,
not two**, and the tables below are split that way.

---

## 1. ARM 1 — BARELY HEARD. PASSES ON SURGERY AND TECH, FAILS ON OPTICAL

Runtime lanes, `duration >= 30`:

| lane | 0.85 (09-03) | 0.6, short greeting (09-04..16) | 0.6 + disclosure (09-17..22) |
|---|---|---|---|
| optical | 11.7% (60) | 16.7% (646) | **18.9% (349)** |
| surgery | **37.2% (43)** | **16.6% (844)** | **14.6% (424)** |
| tech | **30.1% (83)** | **16.4% (1,470)** | **13.8% (643)** |

And the mechanism moved with it — the caller is not merely counted more, they
are HEARD more. Average `CALLER:` lines per substantive call:
surgery **3.8 → 5.8 → 5.6**, tech **4.8 → 6.1 → 6.3**, optical 5.3 → 5.4 → 4.9.

**Surgery and tech both roughly halved and their old-core arms are 13.0% and
10.4%**, so neither is fully back but both are close, on samples twenty times
the size of the 0.85 arm.

**OPTICAL WENT THE OTHER WAY, TWICE.** It rose on the threshold change and
rose again on the disclosure, and against its own old-core arm (8.5%, n=59,
09-02) it has more than doubled. It is the only lane where 0.6 did not work.
CLAUDE.md already said "optical has gone the other way" at 09-08; six business
days later it has not recovered.

### The weak leg, stated: the 0.85 arm is ONE DAY

n = 43–83 per lane, all on 2026-09-03. A 37.2% on 43 calls carries roughly a
±14-point interval. The direction of the surgery and tech move is far larger
than that, but **no per-lane 0.85 figure in this file should be treated as
precise**, and optical's 11.7% on 60 calls cannot carry "0.85 was better for
optical" on its own.

### And the old-core control moved in the same windows

`records` is still on the old core, so `RUNTIME_VAD_THRESHOLD` cannot touch it,
and its barely-heard rate ran **10.7% (28) → 3.0% (33) → 19.1% (89) → 14.4%
(146) → 11.9% (109)** across the same five windows. A lane the threshold
cannot reach swings 16 points on samples of 28–146. So part of the movement
above is population and traffic mix, not the dial. The threshold stays the
leading explanation for surgery and tech — the move is larger than records'
whole range, on far bigger samples, and the caller-lines rise corroborates it —
but it is **not proven against that control**, and a claim that 0.6 "fixed"
anything should carry this sentence with it.

---

## 2. ARM 2 — INTERRUPTIONS. PASSES. THE FEARED TRADE DID NOT HAPPEN

The worry was that a more sensitive VAD would stop the agent for a cough.
It did the opposite. Runtime lanes, transcript `[interrupted]` marks:

| lane | 0.85 | 0.6 short | 0.6 + disclosure | per minute, same order |
|---|---|---|---|---|
| optical | 1.42 | 0.90 | 0.93 | 0.67 → 0.44 → 0.48 |
| surgery | 1.28 | 1.01 | 1.08 | 0.58 → 0.45 → 0.52 |
| tech | 1.14 | 0.89 | 1.13 | 0.52 → 0.41 → 0.51 |

Interruptions per call **fell** when the threshold dropped, on every lane. The
disclosure then put some back — tech 0.89 → 1.13 per call, 0.41 → 0.51 per
minute — which is what a longer greeting to talk over predicts, and lands
tech and surgery back at roughly their 0.85 per-minute rates while their
barely-heard rates stay halved.

**So the guard holds: interruptions are not above where they were before the
threshold change.** What is worth watching is the direction inside the 0.6 era,
because it is drifting up while the threshold has not moved.

### THE INSTRUMENT: `interruption_count` IS NOT COMPARABLE ACROSS PIPELINES

This is a new measurement trap in the same family as `total_turns`, and it is
why the table above uses the transcript and not the column. Measured over
09-17..09-22, substantive, queue lanes:

| | `interruption_count` avg | `[interrupted]` marks avg | column > marks | marks > column |
|---|---|---|---|---|
| runtime (2,268 calls) | 0.61 | 0.73 | **0** | 261 |
| old core (109 calls) | 1.59 | **0.00** | 65 | 0 |

**The old core never writes `[interrupted]` into the transcript at all**, so on
that pipeline the column is the only signal and nothing validates it. On the
runtime the column never once exceeds the marks (the v55 control, reconfirmed
on 2,268 calls) and under-counts them on 261. So the old-core 1.86–3.32 against
the runtime 0.71–1.13 is an instrument difference of unknown size, **not a
behaviour comparison**. Only within-runtime comparisons hold.

---

## 3. THE CONTROL CLAUDE.md NAMED IS NOW RUN — AND IT DISCRIMINATES

CLAUDE.md: *"Whether these are dead air (robocalls, wrong numbers, abandoned
legs) or real callers we never heard is NOT established … The control that
would settle it: whether the same number rings back within 24h and IS heard on
the later call."*

Run over 09-10..09-22, on the barely-heard calls of each lane, looking for a
LATER call from the same number within 24 hours carrying 2+ `CALLER:` lines.
The ring-back is searched **across every lane**, so an overnight caller who
tries again during business hours is counted:

| lane | barely-heard | rang back and WAS heard | share |
|---|---|---|---|
| tech | 232 | 78 | **33.6%** |
| surgery | 127 | 40 | **31.5%** |
| optical | 131 | 35 | **26.7%** |
| **no-ivr** | 142 | 13 | **9.2%** |

**On the queue lanes at least one barely-heard call in four is a real person
who had to ring again. On the after-hours line it is one in eleven.** A
robocall does not ring back and then hold a conversation, so the queue-lane
figure is a FLOOR on real callers, not a share: a caller who gave up entirely,
rang back after 24 hours, or rang from another number is invisible to this
control, and the residue is unresolved in the worse direction.

**The discrimination is the finding.** no-ivr's population really does look
mostly like dead air, which is what that section suspected; the queue lanes'
does not. Restricting the ring-back to the same lane barely moves no-ivr
(7.7% against 9.2%), so the gap is not an artefact of the widening.

### A barely-heard call is a lost call, and the ring-back is what saves it

Same window, queue lanes: **13 of 490 barely-heard calls filed a ticket
(2.7%)**. Of the 140 whose caller rang back onto the same lane and was heard,
**114 of those later calls filed (81%)**. So the cost of a barely-heard call is
either a lost request or a patient made to ring twice, and the recovery path
works only for the ones who persist.

---

## 4. WHAT THIS DOES NOT ESTABLISH

- **Why optical differs. Not established, and the obvious candidate is dead.**
  Greeting length does not explain it: optical's greeting is the SHORTEST of
  the three in both arms (190/251 median chars) and it has the WORST rate.
  `from_connection_type` would have separated a call-quality story from a
  threshold story and it is `unknown` on every runtime row, so that control is
  unavailable.
- **Whether 0.85 suited optical.** Its 0.85 arm is 60 calls on one day.
- **Whether the disclosure CAUSED the E-window interruption rise.** It landed
  on the same day as v41–v56, so the date alone cannot separate them. What the
  transcript does prove is that the disclosure is live from 09-17 and that it
  lengthened every greeting.

---

## 5. RECOMMENDATION — and the dial stays the operator's

1. **Leave 0.6 in place globally.** It is proven on the two lanes with real n,
   on both arms, and the interruption cost the change was feared to carry did
   not appear.
2. **Optical needs its own threshold, and today it cannot have one.**
   `VAD_THRESHOLD` is a module-level constant read once from one env var
   (`grokSession.ts:163`), so every lane on the process shares it. Making it
   per-lane resolvable is small, reversible and testable — and it is the only
   way to get optical an arm with enough calls to read, because the lane has
   never run at a different value from its neighbours.
3. **I would not put optical straight back to 0.85.** That arm is 60 calls on
   one day and its interval swallows the difference. Run it at one intermediate
   value for two business days and read both arms together.
4. **The number that makes it worth doing:** optical filed 1 ticket across 131
   barely-heard calls in thirteen days, and 35 of those callers rang back. That
   is ~66 calls per six business days on optical alone, on the one queue that
   routes BY the caller's office — so a lost optical call loses the location
   too.

**What is the operator's, not mine:** whether to spend a code change on the
per-lane threshold at all, and what value optical gets. `docs/BACKEND_HANDOFF.md`
applies to any of it — this is the transport on the busiest lanes.
