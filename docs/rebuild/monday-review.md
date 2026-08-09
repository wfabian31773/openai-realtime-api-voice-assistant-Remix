# Monday Review — the cutover evidence

**Updated:** 2026-08-09, late afternoon · For Wayne's go/no-go, per line.

**Live right now:** `TICKET_AGENT_LINES=no-ivr` (the after-hours line, confirmed
working on a live call). `NEW_CORE_LINES` is empty — nothing else has cut over.

---

## 1. The short version

| Line | Monday 8 AM | why |
|---|---|---|
| **After-hours / no-ivr** | already live | cut over today, live call confirmed |
| **Answering service** | **ready — your call** | 57.5% → 19.1% on 1,945 real calls |
| **PCP** | **ready — your call** | 61.1% → 28.6%; transfer defects fixed |
| **SD / azul-scheduling** | **stay on the old core** | booking is unmeasured, not proven |

The one I'd hold is SD, and section 5 explains exactly why — it isn't that SD
is bad, it's that the evidence doesn't exist yet.

---

## 2. The numbers

Real calls from the last 7 days, replayed through the new core. Both cores
scored by the **same** deterministic graders, comparable graders only
(audio-plumbing metrics can't be reproduced in a text replay and are excluded
from both sides).

| Line | calls | old core critical | new core critical | better | same | worse |
|---|---|---|---|---|---|---|
| **Answering service** (ticket agent) | 1,945 | 57.5% | **19.1%** | — | — | — |
| **PCP** | 391 | 61.1% | **28.6%** | 196 | 135 | 60 |
| **After-hours** | 278 | 36.3% | **25.1%** | 76 | 160 | 42 |
| **SD / azul-scheduling** | 348 | 39.4% | **5.2%** | 125 | 219 | 4 |

The failure modes that drove the week's rage:

| | old | new |
|---|---|---|
| Question asked 3+ times (all lines) | 433 calls | **41** |
| …on the ticket agent specifically | — | **0** |
| Asked for a human, got nowhere | 444 calls | **12** |

---

## 3. The rebuild that produced the 19.1%

Your directive, 2026-08-09: *"rebuild a single agent, one whose sole purpose is
to create tickets… verify patient, classify intent, check what fields the intent
needs, collect the fields, execute."*

That is `src/core/ticketAgent.ts`, and it is the whole line. Three tables — the
fields, the intents and what each needs, and every sentence it can say — and a
five-step machine. It carries the answering-service, after-hours and no-ivr
lines. The model is a mouthpiece: no tools, no agenda, `create_response: false`.
It cannot invent a question because it is never asked to choose one.

The intent decides the questions. A fax-records request asks name, DOB, fax
number — three questions, and never a callback number, because a fax request
doesn't need one.

**Tuning without a deploy:** the `ticket_agent_config` table, one row per line.
`intents` (what each intent needs) and `lines` (every sentence) are re-read every
20 seconds. Change the row, make the next call, hear the change.
*Caveat:* the greeting is **not** wired to that row — it comes from
`agents.welcome_greeting`, cached ~5 minutes.

---

## 4. The demo line — testing without republishing

**+1 626-548-2660** → `POST /demo/voice`. `GET /demo/health` proves it's up.

`src/standalone/demoLine.ts` owns that call end to end and shares nothing with
`voiceAgentRoutes.ts`: no conferences, no SIP headers, no allowlists, no ramp.
Twilio streams audio to it, it talks to the Realtime API directly, and the
ticket agent picks every word. **If the demo line misbehaves, the bug is in that
file or in `ticketAgent.ts`, and nowhere else.**

Its transcripts land in `call_logs` at hang-up, so a bad call can be read
instead of recited.

---

## 5. SD — why it holds, and what would change that

SD's conversation quality is the best of any line (39.4% → 5.2%, 125 better vs
4 worse). That is not the question.

**The question is whether it books as well as the old core, and the replay
cannot answer it.** The harness only serves an offer when the original call
happened to record one at that point in the conversation, and only confirms a
booking when the original recorded a confirmed `sage_book` at that point. So:

- new core booked **7**, old core called `sage_book` **30** times
- **those two numbers are not comparable.** Most of the gap is the harness's
  ceiling, not the agent's behaviour. I am not going to defend them as a
  comparison, and no decision should rest on them.

**Fixed today (#151), and it was real:** 186 of 348 SD calls ended on *"I'll
make sure they get your information and call you back"* and filed **nothing** —
the line had no filing capability at all, by design. A promise with no record,
on the line that schedules live in NextGen. It now files a scheduling callback
on exactly that path, carrying name, DOB, number, provider, location and time
preference. Orphaned promises: **186 → 3**.

**Not a defect, corrected (#152):** I reported that a caller asking for "Dr.
Bach" was ignored. Wrong — the line captures the provider and re-queries for
them. The tape was showing the harness serving a stale recorded offer. Settled
by a test that passes against unchanged code.

**What would make SD ready:** Gate C — run the new line silently alongside the
old one on real SD calls, with `book`, `transfer` and `fileCallback` stubbed
out, and compare where each one gets to. That is the only thing that answers
the booking question. Until it runs, SD stays on the old core.

---

## 6. Cutover procedure

```
NEW_CORE_LINES=pcp                    # or:
TICKET_AGENT_LINES=no-ivr,answering-service
```
Set the secret, republish. Old core keeps every other line, untouched.

- **Rollback:** remove the name, republish. Same lever as `RAMP_AGENTS`.
- The deploy stamp on the Observatory spine confirms which build is live.
- New-core calls log `[NEW-CORE]` and `[TICKET-AGENT]` with their state.

**Watch in the first hour:**
- any line the agent says that isn't in `ticketAgent.ts` or
  `docs/ramp/script-listing.md` — it should be impossible
- tickets filed with no callback number
- `[NEW-CORE][ALERT]` — every one of these is a promise the system couldn't keep

---

## 7. Tapes to open first (Observatory → New Core Replays)

- Regressions worth judging: `5a893c4a`, `5c45e78f`, `5ddeca2c`, `5ed40f0d`, `f8f7ccf2`
- Wins for contrast: `5dc0ec7e`, `5ddd53ab`, `5e55eb2d`

Each tape shows the old transcript beside what the new core would have said,
both graded, with the replay's caveats underneath.

**The caveat that applies to every tape:** the recorded caller answered the OLD
core's questions, so where the new core asks in a different order the pairing is
approximate. Content is never invented — only re-paired. Where a tape looks like
the agent ignored the caller, check that first; on SD it was the harness twice.
