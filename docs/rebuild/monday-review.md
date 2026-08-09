# Monday Review — the cutover evidence

**Date:** 2026-08-09 · For Wayne's go/no-go, per line. Nothing is live: `NEW_CORE_LINES` is empty.

## 1. The numbers

2,614 real calls from the last 7 days, replayed through the new core. Both
cores scored by the **same** deterministic graders, comparable graders only
(audio-plumbing metrics can't be reproduced in a text replay and are excluded
from both sides).

| Line | calls | old core critical | new core critical | better | same | worse |
|---|---|---|---|---|---|---|
| **PCP** | 391 | 61.1% | **28.6%** | 196 | 135 | 60 |
| **Answering service** | 1,945 | 57.5% | **34.4%** | 743 | 954 | 248 |
| **After-hours** | 278 | 36.3% | **27.3%** | 76 | 160 | 42 |

The failure modes that drove the week's rage, per line:

| | old | new |
|---|---|---|
| Question asked 3+ times (all lines) | 433 calls | **41** |
| Asked for a human, got nowhere | 444 calls | **12** |

## 2. What the replay found — real defects, fixed and re-measured

Every one of these was invisible to unit tests and visible only on real calls:

1. **The greeting-guarantee killed the rails.** Delivery cleanup released the
   ledger, tool-direction state and ramp — so every rail self-destructed the
   moment its first forced line played. This is the mechanism behind "it works
   for one line then falls apart." Fixed in #136; it is live now.
2. **PCP promised and filed nothing.** On an unanswered transfer the line said
   "I'll make sure they get your information" and filed a task carrying only a
   caller ID — no office, no callback. All 47 first-round PCP regressions were
   this. It now collects the office and callback before filing. 40.4% → 28.6%.
3. **A per-state re-ask counter reset on every transition** — one line emitted
   2,982 times across 514 calls. Replaced with a per-TOPIC budget: two asks per
   topic per call, whichever state or phrasing they come from.
4. **The name parser accepted sentences** — "I have seen before" was stored as
   a patient name and then failed verification forever.
5. **The deflection line dragged the pending question with it** — three human
   asks became three identical questions.
6. **Requests died on hang-up.** A `finalize()` net now files what a human can
   act on (name + callback + reason) and alerts instead of filing noise.
7. **A greeting became the call reason** — tickets whose reason field read
   "Okay". INTENT now requires substantive content.

## 3. The residual — read this before deciding

**Nearly every remaining "worse" call is one grader: `callback_fields_completeness`**
(PCP 59 of 60; answering service 228 of 248). It only runs **when a ticket
exists**, and the new core files on far more calls than the old core did. So
the shape of the regression is: *the new core captured a request the old core
dropped, and is then marked incomplete because the grader scans the transcript
for name/phone/reason keywords rather than reading the ticket.*

Breakdown of those 228 answering-service cases: 172 are "reason missing" —
requests like *"I'm calling to see when my glasses are ready"* that contain no
word from the grader's keyword list. The ticket carries the full request text.

**Two things I did NOT do:** I did not widen that keyword list, and I did not
exclude the grader. One referee change was made and applied to **both** cores:
an explicit name ask followed by the caller answering it now counts as name
evidence (every line's script asks in one of those forms). That is why the old
answering-service number moved 57.8% → 57.5%.

If you want the number with the ticket-only grader set aside: answering service
**35.4% → 5.8%**. Both figures are true; the honest headline is 34.4%.

## 4. Recommendation

**Cut PCP over first.** Reasons, in order:
- Lowest volume (~65 calls/day) — every single call is watchable live.
- Largest measured improvement (61.1% → 28.6%).
- Highest reputational cost of the old core's behavior: real medical groups.
- Its worst defect (promise-with-no-task) is fixed and proven on tape.

Then answering service (highest volume, biggest absolute win), then
after-hours, then SD.

## 5. Cutover procedure

```
NEW_CORE_LINES=pcp          # secret, then republish
```
- Old core keeps every other line, untouched.
- **Rollback:** clear the secret, republish. Same lever as `RAMP_AGENTS`.
- The deploy stamp on the Observatory spine confirms which build is live.
- Watch the command center: new-core calls log `[NEW-CORE]` with their state.

**Watch for, in the first hour:** any call where the agent says a line that is
not in `docs/ramp/script-listing.md` (it should be impossible — the model no
longer chooses process), tickets filed without a callback, and the PCP queue
dial firing in the same turn as the routing sentence.

## 6. Tapes to open first (Observatory → New Core Replays)

Defaults to PCP / worse — the case against, on top.

- Regressions worth judging: `5a893c4a`, `5c45e78f`, `5ddeca2c`, `5ed40f0d`, `f8f7ccf2`
- Wins for contrast: `5dc0ec7e`, `5ddd53ab`, `5e55eb2d`

Each tape shows the old transcript beside what the new core would have said,
both graded, with the replay's caveats listed underneath. The main caveat, on
every tape: the recorded caller answered the OLD core's questions, so where the
new core asks in a different order the pairing is approximate. Content is never
invented — only re-paired.
