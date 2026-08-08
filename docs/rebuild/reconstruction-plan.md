# Voice Reconstruction Plan — The New Core

**Date:** 2026-08-08 (Saturday morning) · **Status:** AWAITING WAYNE'S APPROVAL — no rebuild code is written until this plan is approved.

> "I feel like we need to tear the whole voice apart. I think we need to
> reconstruct the whole voice from the beginning." (Wayne, 2026-08-08)
>
> This document is that reconstruction, on paper, for judgment before a single
> line is built. Nothing in it touches production. Nothing cuts over until each
> line's replacement has beaten the old line on replayed real calls **and**
> Wayne has reviewed the tapes.

---

## 1. The verdict on the old core (why patching is over)

`src/voiceAgentRoutes.ts` is ~6,000 lines of accretion: a year of patches with
this week's rails layered on top. The week proved the diagnosis empirically —
every fix collided with an older rule that stayed invisible until it fired on a
live patient:

| Collision | What happened |
|---|---|
| Gate × after-hours doctrine | The ticket gate's "BLOCKED—" reply hit the no-ivr prompt's "any non-success = technical issue → apologize → hang up" rule → the technical-fallback wave |
| Ramp × greetings | Ramp v1 parsed the first utterance as yes/no while the greeting asked an open question → silent death on live calls |
| Verify × context | Recognition pulled the record, then verification ignored it and ran fresh name lookups → "Staybeam", new-patient interview on a recognized caller |
| Rails × prompts | The prompt says one thing, the injected directive says another; which one wins depends on the model's mood that turn |

The structural flaw: **the model is the workflow engine.** The prompt holds the
process, the state, and the rules, and every turn the model re-derives all of
it. Every patch adds another voice to the argument. Good voice agents run
2.4–5% failure; this architecture cannot get there no matter how many rails are
bolted on, because the rails argue with the pile.

The old core is hereby **frozen**: bugfix-only, no new features, until it is
replaced line by line and then deleted.

## 2. What this week actually bought (what carries over)

The rebuild does not start from zero. This week produced exactly the assets a
reconstruction needs and did not exist before:

1. **The behavior spec** — `docs/ramp/playbook.md` + `docs/ramp/script-listing.md`,
   approved line-by-line by Wayne on 2026-08-07. Scenarios S1–S11, exact
   sentences, the capability matrix (who schedules, who transfers, who only
   files tickets), the fax/email/callback contact rule. **The new core is built
   to this spec and nothing else.**
2. **The spine modules** — proven in isolation, failed only where they touched
   the pile. They port as-is:
   - `callFactsLedger` — the constants of a call: seeded, harvested, locked, never re-asked
   - `rampEngine` — the deterministic state machine (today it only runs the opening; in the new core its pattern runs the *whole call*)
   - `toolDirection` — tool results classified in code, approved next line rides the result, gates block premature tool calls
   - `greetingResolver` + greeting guarantee — DB-sourced forced lines, verified against the transcript, resent if dropped
   - `conversationLoopGuard` — the busy-team script, agent exit maps
3. **The graders** — capability-aware critical/pass grading per call
   (deflection, language faults, repetition, callback completeness). These are
   the *judges* of the rebuild, unchanged, so old and new cores are scored by
   the same referee.
4. **The Observatory** — command center, live transcripts, listen-in, daily
   briefs, deploy stamp. This is the measurement harness that makes "beats the
   old core" a number instead of a feeling.
5. **The shadow architecture** — built Aug 2 (PR #60), sitting in `src/shadow/`
   with 98 passing tests and flags off: observation-only taps already wired
   into production, a session store, a deterministic workflow engine, a
   **replay harness that feeds recorded calls through a candidate engine**, and
   turn-by-turn comparison of "what production said" vs "what the candidate
   would have said" — with structural proofs it cannot speak, mutate, or delay
   a live call. The rebuild runs inside this chassis until it's proven.

## 3. The new core — architecture

One small module per line. State machine owns the call. The model is the
mouthpiece, not the brain.

```
                       ┌──────────────── NEW CORE (per line) ────────────────┐
 caller ─ Twilio ────► │  Line module (answering-service.ts / pcp.ts / ...)  │
                       │                                                     │
                       │   ┌───────────────┐     reads/writes                │
                       │   │ STATE MACHINE │◄──────────────► callFactsLedger │
                       │   │ (whole call,  │                  (the constants)│
                       │   │  script-listing│                                 │
                       │   │  S1–S11)      │──── forced line ──► model says  │
                       │   └──────┬────────┘     verbatim         exactly it │
                       │          │ tool needed                              │
                       │          ▼                                          │
                       │   toolDirection gate ──► tool ──► result classified │
                       │          │                        in code, next line│
                       │          ▼                        rides the result  │
                       │   model free-speak ONLY in bounded gaps             │
                       │   (empathy beat, question rephrase) — never process │
                       └─────────────────────────────────────────────────────┘
```

Principles, each one a direct answer to a failure this week:

- **The state machine runs the whole call, not just the opening.** Every state
  has: the exact line to say (from the approved script listing), what it's
  listening for, where each answer goes in the ledger, and the single next
  state. The model never decides what happens next — code does.
- **The prompt shrinks to a voice.** Persona, tone, language rules,
  pronunciation. Zero process. There is nothing in the prompt for a directive
  to collide with, because the prompt no longer contains a workflow.
- **The ledger is the only memory.** Every state reads its facts from the
  ledger before asking anything. A filled slot is physically unaskable — the
  state that would ask it is skipped by code, not discouraged by prose.
- **Every tool call passes a gate in code.** Requirements checked against the
  ledger pre-flight; results classified in code; the next sentence is attached
  to the result. No tool output is ever interpreted freely by the model.
- **Say-and-act in the same turn** (the PCP lesson: 88 transfer mentions, 7
  transfers). If the script says "I'll transfer you now," the transfer
  executes in the same code path that emitted the sentence. A promise and its
  action are one unit; the model cannot make one without the other.
- **Capability matrix enforced structurally.** The answering-service module
  *has no transfer tool to call* — deflection isn't a rule it must remember,
  it's the absence of the capability. Same for every line: tools exposed =
  exactly what the matrix allows, nothing more.
- **Noise/ASR tolerance at the state level.** Each listening state declares
  what an unparsable answer means: re-ask once with the scripted rephrase, then
  the scripted fallback (take a message / callback path) — never loop, never
  guess, never apologize for "technical issues."

Estimated size: ~300–500 lines per line module + the shared spine. Small
enough that every path is readable, testable, and replayable.

## 4. The cutover switch (old core stays live)

Per-line routing flag, checked at the single entry point where a call is
assigned its handler:

```
NEW_CORE_LINES=""                        # default: every line on the old core
NEW_CORE_LINES="pcp"                     # PCP on the new core, everything else old
NEW_CORE_LINES="pcp,answering-service"   # staged rollout
```

- Old core untouched and serving until each line is explicitly flipped.
- **Rollback is instant and per-line**: remove the name from the secret and
  republish — same lever as `RAMP_AGENTS`, which is already proven.
- The deploy stamp (built Friday) shows exactly which build and sha is live, so
  there is never again a question of "is this running or not."
- The Observatory command center shows, per call, which core handled it — new
  and old calls are graded by the same graders into the same scorecards, so
  the comparison continues live after cutover.

## 5. The proving ground — three gates before any live patient

**Gate A — Scripted scenarios (the spec, 100%).**
Every S1–S11 scenario from the approved script listing becomes an automated
test against the new line module: exact utterances in, exact required lines
out, ledger state asserted at every step, tools called (or blocked) exactly as
the matrix says. **Pass bar: 100%. Not 99.**

**Gate B — Replay of real calls (beat the old core on tape).**
The corpus: **3,364 replayable inbound calls from the last 7 days** —
answering-service 2,155 · no-ivr 463 · pcp 392 · azul-scheduling 354. The
shadow replay harness (`src/shadow/callLogReplay.ts` — already built and
tested) feeds each real call's caller utterances through the new line module
with simulated tool results; the same graders score the new core's transcript
against the old core's actual graded transcript for the same call.
**Pass bar, per line: the new core's critical rate on the replay corpus must
be lower than the old core's actual rate on those same calls — with the
explicit target of ≤5% en route to 2.4%.** Every replay is stored as a
side-by-side tape (old transcript vs new transcript, per call) that Wayne can
open in the Observatory and judge with his own eyes.

**Gate C — Live shadow (silent ride-along).**
Before cutover, the winning line module rides real live calls inside the
shadow chassis: it hears every caller line as it happens, decides what *it*
would have said, and the diff is recorded turn-by-turn — while the old core
still does all the talking. Structural isolation is already proven by the
shadow's test suite (a broken shadow cannot alter production output).
**Pass bar: at least one live-traffic session per line with no
would-have-been-critical divergence that the old core avoided** — i.e., the
shadow must never look *worse* than the pile it's replacing.

Only after A, B, and C — **and Wayne's explicit approval per line** — does a
line's name go into `NEW_CORE_LINES`.

## 6. Timeline (building through the weekend)

| When | What | Deliverable Wayne sees |
|---|---|---|
| **Sat morning** | This plan reviewed and approved/amended | The plan itself |
| **Sat day** | Core skeleton + **answering-service line** (biggest corpus, fully scripted mode, highest volume) + Gate A tests | S1–S11 green |
| **Sat night** | Answering-service through Gate B: 2,155-call replay | Side-by-side tapes + critical-rate comparison in the Observatory |
| **Sun morning** | **PCP line** (the face of the operation — fully scripted professional mode) through Gates A+B | PCP tapes + numbers |
| **Sun day** | **After-hours/no-ivr line** through Gates A+B; weekend live traffic runs Gate C shadow for AS + after-hours (they get weekend calls) | Shadow divergence report |
| **Sun night** | **SD front (azul-scheduling)** through Gates A+B | SD tapes + numbers |
| **Mon morning** | Review session: tapes and numbers, line by line. **Nothing is live yet.** | Wayne's go/no-go per line |
| **Mon+** | Cutover one line at a time, watched live on the command center, instant rollback armed. Recommended order: **PCP first** (lowest volume ≈65 calls/day — every single call can be watched live — and the highest reputational pain), then answering-service, then after-hours, then SD. | Live scorecards, new vs old |

Old core is deleted only when every line has cut over and held its numbers for
a full week.

## 7. What is required from Wayne

1. **Approve or amend this plan** (this morning). Amendments welcome —
   especially the cutover order in §6.
2. **One republish this weekend** to activate shadow mode for Gate C (flags
   only; old core behavior unchanged — the shadow architecture's isolation
   proofs cover this). The deploy stamp will confirm it landed.
3. **Judge the tapes** Monday morning. No trust required — the replays, the
   shadow diffs, and the grader numbers are the argument.

## 8. What this plan explicitly does NOT do

- It does **not** modify the old core's behavior this weekend (frozen,
  bugfix-only).
- It does **not** cut any line over automatically — every flip is a human
  decision with the tapes on the table.
- It does **not** discard the week's rails: they are the spine of the new
  core, running where they were always meant to run — in code that owns the
  call, instead of shouting over a 6,000-line pile.
- It does **not** promise 2.4% on day one. It promises: never worse than the
  old core on the same calls (proven before cutover), ≤5% as the first held
  target, and the architecture that makes 2.4% reachable — because every
  failure in a state machine is a reproducible, fixable path, not a mood.
