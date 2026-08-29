# OpenAI → Grok Voice Migration Plan — Azul Vision voice agents

Written 2026-08-29. Companion to `/CLAUDE.md` and `docs/observatory/STATE-OF-PLAY.md`
— both were re-read before this plan was written, per their own standing rule.
Pricing figures carry their source and date; verify before any budget commitment.

---

## 0. Executive summary

- **The one-line "change the base URL" migration does NOT apply to our
  production lines.** Every live agent in this repo (answering-service, no-IVR,
  queue agents, PCP, SD) runs as **one OpenAI SIP session** — Twilio →
  conference → `sip.api.openai.com` — where ear, brain, and mouth are a single
  session and audio never touches our servers. xAI publishes **no SIP
  endpoint** (its docs cover WebSocket, and mention WebRTC only in event
  footnotes). Migrating therefore means changing the **transport**: Twilio
  Media Streams ↔ our bridge ↔ Grok WebSocket.
- **That transport is not a science project — it is already built, hardened
  through ~20 code-review rounds, and taking live test calls** on the
  ticketing-app answering-service lanes (surgery/optical/tech,
  `grok-telephony-v2`) and the 5star DRS line (`drs-grok-telephony-v6`). The
  migration is a **port of a proven wire layer under the existing agents**, not
  new construction. Per standing instruction 2: *same exact agent, different
  voice pipeline*.
- **Cost is roughly neutral — it is not the reason to migrate.** At our traffic
  shape, Grok's flat $0.08/min lands within the same band as OpenAI
  gpt-realtime's token-metered ~$0.05–0.08/min (details in §5). The drivers
  are **control and reliability**: mark-verified transcripts, scripted lines
  the model cannot rewrite (`force_message`), dead-air watchdogs, fail-closed
  signed webhooks, per-lane voices, instant webhook-re-point rollback — none of
  which the SIP architecture can give us, because audio never passes through
  anything we run.
- **The honest trade:** the new architecture puts our server in the audio path.
  Under SIP, our app crashing mid-call doesn't kill audio; under Media Streams
  it does. §7 covers what we own once we take that on, and what's already built
  to carry it.
- **Sequencing** (§8): prove answering-service on a test number against the
  Gate B replay corpus → cut over in a low-volume window → no-IVR/after-hours →
  queue lines (a decision is owed on Remix-vs-ticketing ownership) → PCP/SD
  migrate while OFF → outbound/Sage outreach as a later phase with the same
  recipe. Every cutover is a Twilio webhook re-point; every rollback is the
  same re-point in reverse.

---

## 1. Scope

**In scope — the OpenAI-realtime agents in this repo:**

| Agent | File | Runs today on |
|---|---|---|
| Answering service | `src/agents/answeringServiceAgent.ts` | gpt-realtime, SIP |
| No-IVR / after-hours (v1 + v2) | `noIvrAgent.ts`, `noIvrAgentV2.ts`, `afterHoursAgent.ts` | gpt-realtime, SIP |
| Queue agents: Optical, Surgery, Tech | `opticalAgent.ts`, `surgeryAgent.ts`, `techAgent.ts` | gpt-realtime, SIP |
| PCP | `pcpAgent.ts` | OFF (was gpt-realtime, SIP) |
| Azul Scheduling (San Diego) | `azulSchedulingAgent.ts` | OFF |
| Appointment confirmation (outbound) | `appointmentConfirmationAgent.ts` | gpt-realtime, SIP |

**Already on Grok (the proven foundation, not part of this plan's work):**
- ticketing-app answering-service lanes — surgery/optical/tech slugs, per-lane
  voice, marker `grok-telephony-v2`, live-tested 08-23/24.
- 5star DRS scheduling line — marker `drs-grok-telephony-v6-sage-opening`,
  merged 08-24, awaiting operator publish + test call.

**Out of scope here:** the Claude-brain experiment (`src/standalone/claudeBrain.ts`
— parallel R&D, unaffected); the 5star Sage outreach agents (inbound/outbound/
reminder/rebooking on OpenAI realtime) — same recipe applies, listed as Phase 6
so it is not forgotten, but it is a separate repo and a separate sign-off.

---

## 2. Current state — deep analysis

### 2.1 Architecture

One OpenAI SIP session per call (`OpenAIRealtimeSIP.buildInitialConfig`,
`src/voiceAgentRoutes.ts`): Twilio answers, bridges the caller into a
conference, and dials `sip.api.openai.com`. STT, reasoning, and TTS all happen
inside OpenAI's session. Caller-ID pre-context is looked up **before**
answering, so the agent opens confirm-not-ask. Model: `gpt-realtime`
(per-call override capable).

**What this gives us today**
- Lowest possible media latency — no server of ours in the audio path.
- Our app's availability does not gate mid-call audio: if the Node process
  dies, the SIP leg keeps talking.
- Zero audio egress/compute on our side.

**What it structurally cannot give us** (each of these has already cost us —
see STATE-OF-PLAY §3):
- **No swap of any one part.** STT fabricating fiction that patients heard
  could only be fixed by removing caller audio from the session entirely — not
  by swapping the transcriber. This limitation is the whole reason
  `src/standalone/` exists.
- **No ground truth that audio played.** Twilio `mark` events — the only proof
  a caller heard a line — are unavailable when Twilio isn't carrying the media
  to us.
- **No scripted utterances.** Everything the caller hears is model output. The
  improvisation incidents ("hiccups", Russian, reciting its own instructions)
  were mitigated by config, but the class of bug remains open: prompts steer,
  they do not bind.
- **Vendor-coupled transport.** The session is OpenAI's; observability is what
  their events expose.

### 2.2 Per-line inventory (volumes per CLAUDE.md/STATE-OF-PLAY, verify current)

| Line | State | Volume | Notes |
|---|---|---|---|
| answering-service | LIVE | ~500/day (579 peak, Aug 10) | Carries the practice. Quality avg ~2.7–2.8, flat. |
| no-ivr (after-hours) | LIVE | ~30–50/day + **all overnight volume** | Best transcripts in the system; Wayne's quality benchmark (STATE-OF-PLAY §6). |
| optical (queue) | LIVE | dept 1, 1,744 tickets/90d (~19/day) | "Works like a charm." |
| surgery (queue) | LIVE | dept 2 | VA-51121 proof of filing. |
| tech (queue) | Built, number pending | dept 3, 9,288 tickets/90d (~103/day) | Largest queue; medication queue. |
| pcp | **OFF** | was ~200/day | Off since 08-10 (transfer failures) — has handoff per rule 9. |
| azul-scheduling (SD) | **OFF** | was ~80/day | Gate B: booked 8 of 21. Not ready. |
| appointment-confirmation | outbound | — | Outbound leg, same SIP core. |

### 2.3 Known open reliability issues on the current stack (STATE-OF-PLAY §7)

- Spurious barge-in (fired 617ms into a greeting, pre-speech).
- `openai socket closed MID-CALL … 1005` at teardown (cosmetic so far).
- One phone number carrying two patients blends them in lookup (needs
  group-by-person + refuse-to-guess) — **pipeline-independent; migrates with
  us unless fixed first**. Note: the DRS/ticketing pre-context selector now has
  the deterministic-tiebreak + refuse-incomplete pattern to reuse.
- Main just took `d4a201d` (pool self-heal + stale-call sweeper after a DB
  restart produced 52h "live" calls) — evidence that our operational stack
  already needs, and now has, self-healing around the DB.

### 2.4 Current cost (estimated — token-metered)

OpenAI `gpt-realtime` (flagship, 2026 pricing): **$32 / 1M audio input tokens,
$64 / 1M audio output tokens**; cached audio input steeply discounted; mini
tier $10/$20. Real-world per-minute math from published measurements: ~600
audio-input tokens per heard minute ≈ **$0.019/min**, ~1,200 output tokens per
spoken minute ≈ **$0.077 per agent-speaking minute**. For phone calls where the
agent speaks ~40–50% of wall time, blended ≈ **$0.05–0.08 per wall-clock
minute**, plus text/context tokens (small with caching).

At today's live volume (~690 calls/day across AS + no-ivr + queues, ~1.75 min
avg — the benchmark clean call runs ~85s, ticket calls run longer):

- ~1,200 call-minutes/day → **≈ $60–95/day → $1.8k–2.9k/month.**
- With PCP + SD restored (+280 calls/day): ~1,700 min/day → **$2.6k–4.1k/month.**

These are estimates from published per-token rates and measured token densities,
not from our invoices — **pull the actual OpenAI usage dashboard for the true
baseline before quoting savings or costs to anyone.**

---

## 3. The central finding: this is a transport migration, not a URL swap

The xAI migration guide's Step 1 ("update the base URL and API key") applies to
applications that already hold a **WebSocket** to OpenAI. Ours hold a **SIP
call**. xAI's docs list `output_audio_buffer.*` events as "WebRTC/SIP only" but
publish no SIP endpoint, no SIP URI, and no telephony onramp equivalent to
`sip.api.openai.com`. Until xAI ships one (open question §10), the old core
cannot be pointed at Grok.

The migration path is therefore the one we have already walked twice:

```
BEFORE  Twilio ──conference──> SIP ──> OpenAI realtime (ear+brain+mouth, opaque)

AFTER   Twilio <──Media Streams WS──> our bridge <──WS──> Grok realtime
                    (μ-law 8kHz)      (marks, watchdogs,   (wss://api.x.ai/v1/realtime)
                                       gates, records)
```

This is **exactly** the architecture running the ticketing lanes and the DRS
line today. The port ticketing → 5star already proved the wire layer moves
between codebases cleanly.

---

## 4. Future state

### 4.1 What carries over verbatim (built, reviewed, live-tested)

The Grok wire layer and bridge, with every rule a live failure taught us:

| Invariant | Why it exists |
|---|---|
| Session config **always** precedes caller audio (pre-config hold, opener drains first) | the deaf-agent failure (5star #199) |
| Response-gated scripted lines, FIFO, one per `response.done`; tool answers never gated | the silent-after-identity failure (5star #200) |
| `force_message` scripted utterances — renderer text spoken verbatim, model bypassed | scripted lines a model cannot rewrite |
| Twilio `mark` echoes as the only proof audio played; `[interrupted]` attribution | transcript ground truth |
| Dead-air watchdog (utterance + response causes) | no caller left in silence |
| Barge-in = `response.cancel` (only while open) + Twilio `clear` + **discard queued lines** | stale-speech desync (5star #200 r4) |
| Cancel-race error treated as the missing `response.done` | live fix, ticketing 08-23 |
| `cancelDoneOwed` stall accounting | an unacknowledged cancel freezes the queue |
| Caller transcript via `transcription.updated` (cumulative, xAI-specific) | already the adapters' contract |
| Signed webhooks + single-use stream tokens, fail-closed without `TWILIO_AUTH_TOKEN` | patient lines never accept unauthenticated media |
| Deploy markers + `/voice/health` (liveReady, missing env names, voice) | a failed pull looks exactly like a failed fix |
| Per-lane slugs, one number per queue (`/voice/<slug>`), per-lane `XAI_VOICE_NAME_<SLUG>` | standing instruction 11 |
| Caller-ID pre-context: deterministic total-order row pick, trim + completeness gates, confirm-not-ask with a three-way yes/no/unclear contract and one bounded re-ask | the Sage inbound precedent, hardened in 5star #200 |

### 4.2 Same agent, different pipeline (standing instruction 2)

The Grok pipeline **borrows** each production agent's `instructions` and
`tools` the way `claudeBrain.ts` already does — it reimplements nothing and
the production agent files stay untouched until cutover (standing instruction
5: all of this lives in `src/standalone/` on a test number first).

xAI's guidance to "simplify your system prompt" and "remove workaround
prompting" is **a suggestion we take to Wayne, not an action** — prompts are
operator-owned copy. Two honest observations for that conversation: (a) our
architecture already moved the critical lines out of the prompt and into the
renderer/`force_message`, so much of the old workaround prompting becomes dead
weight rather than active risk; (b) any prompt trim must re-pass the Gate B
replay corpus before it ships.

### 4.3 xAI extensions we gain (and should adopt deliberately)

- **`force_message`** — already the backbone of the ported design.
- **`resumption`** (session cache + replay on reconnect) — adopt in Phase 4: a
  mid-call Grok socket drop today means teardown; with resumption it can mean a
  reconnect the caller barely notices. Needs bridge work + tests.
- **`replace`** (pronunciation substitutions pre-TTS, transcript unchanged) —
  immediate practical wins: provider and place names ("Dr. Sleboda",
  "Azul", office names). Build the list with Wayne; never guess pronunciations.
- **Reasoning control** — both proven configs run `effort: high` in live calls
  with a `none` override knob (`XAI_*_REASONING_EFFORT`). Latency has been
  acceptable at `high`; measure per line before touching it.

### 4.4 Event-compatibility deltas (all already handled or unused)

| Delta | Impact on us |
|---|---|
| `input_audio_transcription.updated` is cumulative (not delta) | already the adapters' contract |
| `conversation.item.retrieve` / `.done` / transcription `.failed`/`.segment` unsupported | not used |
| `output_audio_buffer.*` WebRTC/SIP-only | not used (we clear Twilio's buffer, not the provider's) |
| `rate_limits.updated` not emitted | not used; capacity is watched operationally |

---

## 5. Cost analysis — current vs future

**Pricing as fetched 2026-08-29 (verify at source before budgeting):**

| | OpenAI `gpt-realtime` (flagship) | xAI `grok-voice-think-fast-2.0` |
|---|---|---|
| Audio | $32 in / $64 out per 1M audio tokens | **$0.08/min flat** ($4.80/hr) |
| Text | $4 in / $16 out per 1M (approx., cached input discounted) | "$0.004 / text input" (as published; unit ambiguous — clarify with xAI) |
| Practical per-minute | ≈$0.05–0.08 blended for phone-call talk ratios | $0.08 fixed |
| Mini tier | $10/$20 (gpt-realtime-mini) | none published |
| STT/TTS a-la-carte | — | STT $0.10–0.20/hr; TTS $15/1M chars |

**Monthly model (1.75 min avg call; verify against invoices):**

| Scenario | Minutes/day | OpenAI est. | Grok est. |
|---|---|---|---|
| Today's live lines (~690 calls/day) | ~1,200 | $1.8k–2.9k/mo | **≈$2.9k/mo** + text |
| All lines restored (~970 calls/day) | ~1,700 | $2.6k–4.1k/mo | **≈$4.1k/mo** + text |

**Honest conclusions:**
1. **This migration is approximately cost-neutral** — Grok's flat rate sits at
   the top of OpenAI's blended band for our talk ratios. Do not sell it as a
   cost cut.
2. Grok's flat per-minute pricing is **predictable**: immune to context growth,
   verbose callers, long instructions, and token-density drift. OpenAI's
   token metering rewards short calls and caching but makes the bill a function
   of prompt engineering.
3. Second-order costs move in both directions: we take on bridge compute and
   egress on Replit (small at this volume), and we drop nothing on the Twilio
   side (Media Streams carries no per-minute surcharge beyond the call).
4. If cost ever becomes the driver, the leverage is `gpt-realtime-mini`
   ($10/$20) on OpenAI's side — there is no published Grok mini tier — but that
   is a quality decision that needs Gate B evidence, not a pricing decision.

---

## 6. Latency

**What we know (measured/observed, not vendored claims):**
- Live Grok calls on the ticketing lanes and the DRS line hold a conversation
  at reasoning `high` — the 08-23/24 live-test rounds surfaced wire-ordering
  bugs, not speed complaints. We do not yet have per-turn TTFT numbers for
  Grok; **capture them during Phase 1** (the bridge sees every timestamp:
  caller `speech_stopped` → first audio delta → first Twilio `mark`).
- The old core (SIP, no middleman) is the latency baseline to beat or match;
  its advantage is the missing server hop.
- For reference from the Claude experiment: Haiku TTFT ~791ms was judged viable
  for voice; Sonnet ~1,730ms was not. That is the perceptual budget.

**What changes structurally:** Media Streams adds two WS legs through our
server (Twilio↔us, us↔xAI). At 8kHz μ-law this is milliseconds of transport,
not seconds — the ticketing/DRS lines demonstrate it is not perceptible — but
it is nonzero and it stacks with Replit's placement. If a line ever feels slow,
the order of investigation is: reasoning effort → our event handling (the
response-gate queue) → transport, with the bridge's own timestamps deciding,
not vibes.

**Levers, in order of preference:** per-lane `reasoning.effort` (`high` →
`none`), prompt/context size (secondary — Grok's flat pricing removes the cost
pressure but not the latency effect), model pin choice.

**Gate:** no line cuts over with measured caller-perceived response latency
materially worse than its old-core baseline on the same call shapes.

---

## 7. Reliability / resiliency

**What we gain:**
- Fail-closed everything: unsigned webhooks rejected, missing config = the
  controlled unavailable answer, never dead air or an open line.
- Watchdogs + ground truth: dead-air detection with re-asks, mark-verified
  transcripts, per-call records with outcomes in `call_logs`.
- **Rollback in seconds**: every line's cutover is a Twilio webhook re-point;
  rollback is the same re-point back. The OpenAI SIP path stays deployed and
  warm until a line has weeks of green history.
- Deploy verification by marker on every ship (the failed-pull lesson).
- Offline replay (Gate B corpus + `replayRealCalls.test.ts` pattern) so
  regressions are caught without a phone, and without making Wayne the test
  harness (standing instruction 8).
- Optional next step: xAI `resumption` to survive provider socket drops
  mid-call (Phase 4).

**What we newly own (the honest cost of control):**

| New responsibility | Standing mitigation |
|---|---|
| Our process is in the audio path — a bridge crash is a dead call | exactly-once teardown + `/voice/drs/after`-style post-stream TwiML that speaks a controlled technical-trouble line instead of silence; keep it on every migrated line |
| Replit restarts/redeploys sever live calls | publish in low-volume windows; stale-call sweeper (`d4a201d`) already patrols zombie state |
| Capacity: N concurrent calls = N WS pairs + N Grok sessions | trivial at ~700 calls/day spread across a day; load-test before PCP+SD restore pushes concurrency up |
| DB slowness can no longer be allowed to stall call setup | already enforced: pre-context lookups are time-bound (1.5s → proceed without), lookups indexed (7,038ms → 3.5ms, PR #164) |
| Single-vendor dependency per line (xAI) | the retained OpenAI path is the DR plan; revisit dual-provider only if xAI reliability data demands it |

**Provider-side unknowns to watch in Phase 1:** xAI realtime uptime/limits at
our concurrency (no `rate_limits.updated` event — watch for connection
rejections), sustained-session stability at 5–10 min call lengths.

---

## 8. Migration sequence

Every phase obeys: build in `src/standalone/` (rule 5) · replay red-then-green
before any dial (rule 8) · marker bump on every ship · **measure the production
number before and after** (BACKEND_HANDOFF's one rule) · cutover = webhook
re-point, rollback = the same re-point back.

**Phase 0 — prerequisites (hours)**
- `XAI_API_KEY` secret in this repo's deployment; pin a **versioned** model
  (xAI's own guidance: `grok-voice-latest` for dev, pinned for prod).
- Pull the real OpenAI invoice baseline (§2.4 is an estimate).
- Export the current Gate B corpus + fresh answering-service call sample as the
  parity referee.

**Phase 1 — answering-service on a test number (the big one)**
- Port the Grok wire layer (ticketing `adapter.ts` lineage + 5star telephony
  bridge) into `src/standalone/grokLine.ts`; borrow
  `answeringServiceAgent.instructions/tools` verbatim — the `claudeBrain.ts`
  borrowing pattern, nothing reimplemented.
- Wire caller-ID pre-context through the existing indexed lookups; adopt the
  hardened selector rules (deterministic total-order pick, trim + completeness,
  refuse-to-guess between people — this also retires the two-patients-blended
  open issue on the migrated path).
- Gate B replay through the Grok pipeline: **must match or beat the old core's
  19.1% failure rate on the same corpus, same referee.** TTFT captured per turn.
- Test-number calls only after replay is green. Wayne dials when *we* have
  evidence, not to produce it.

**Phase 2 — answering-service cutover**
- Low-volume window, webhook re-point, old core warm. Watch: quality score
  (baseline 2.7–2.8), identification-by-phone rate, question-repetition (0 is
  the standard the ticket agent already set), ticket filing success, latency
  vs baseline. Any regression → re-point back, diagnose offline from records.

**Phase 3 — no-IVR / after-hours**
- Same recipe. Benchmark against the §6 "perfect to the letter" transcript.
- **This line carries all overnight volume (rule 13)** — it cuts over only
  after answering-service has green daytime history, and in the morning, never
  at night.

**Phase 4 — queue lines + resilience features**
- **Decision owed (§10):** the ticketing-app Grok lanes already implement
  surgery/optical/tech. One implementation should own each queue (rule 11).
  Recommendation: point the queue numbers at the ticketing-app voice server
  and retire this repo's queue agents at cutover, rather than porting them a
  second time. Tech's number is still pending regardless.
- Adopt `resumption` + build the `replace` pronunciation list with Wayne.

**Phase 5 — PCP and San Diego (migrate while OFF)**
- Zero live risk: both lines are off. Port them (PCP keeps its handoff — the
  DRS handoff port pattern, #198, is the template; rule 9 governs who gets
  one). **Reactivation is a separate operator decision** — they are off for
  behavior reasons (transfer failures; SD booked 8/21), and turning them back
  on requires their own Gate B evidence, Grok or not.

**Phase 6 — outbound + 5star Sage outreach (separate sign-off)**
- `appointmentConfirmationAgent` (outbound) and the 5star Sage
  inbound/outbound/reminder/rebooking agents: same recipe, own repo, own plan
  addendum. The DRS line already proves Grok + the 5star stack end to end.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Grok behavior differs on our real call distribution despite green replay | Medium | Caller-facing | Gate B parity gate before any dial; test number before any cutover; instant rollback |
| Latency perceptibly worse than SIP baseline | Low-Med | Quality score | Measure in Phase 1; reasoning knob; hard gate in §6 |
| Our server in the audio path → new outage class | Certain (structural) | Dropped calls during deploys/crashes | Low-volume publish windows, post-stream TwiML fallback, sweeper, capacity test; resumption in Phase 4 |
| xAI platform maturity (limits, drops) at our concurrency | Unknown | Call failures | Phase 1 soak on test number; old core warm for months |
| Prompt "simplification" regresses hard-won behavior | Medium if done casually | Caller-facing | Prompts are operator-owned; any change re-runs Gate B |
| Cost estimate wrong (unit ambiguity in xAI text pricing; token densities) | Medium | Budget only | Invoice baseline in Phase 0; observed $/min from Phase 1 |
| Context loss / re-litigating settled decisions during a multi-week effort | Proven pattern | Wayne's sanity | This document is the record; update it like STATE-OF-PLAY, every phase |

---

## 10. Open questions — Wayne's calls, not ours (standing instruction 1)

1. **Queue ownership:** retire this repo's optical/surgery/tech agents in favor
   of the ticketing-app Grok lanes at cutover, or port them here? (Recommended:
   ticketing-app owns them.)
2. **Cutover windows** for answering-service and no-IVR (which low-volume
   window; who is watching).
3. **PCP / SD:** migrate-while-off is free — but is reactivation even on the
   table this quarter? (Sets Phase 5 priority.)
4. **Model pin:** pin `grok-voice-think-fast-2.0` now, or track
   `grok-voice-latest` on test numbers only? (Recommended: pin in prod, latest
   on test.)
5. **Voices per line** (`XAI_VOICE_NAME_<SLUG>`) — your pick per lane.
6. **Prompt simplification appetite:** leave production prompts byte-identical
   through cutover (recommended), then trim with Gate B evidence?
7. **Pronunciation list** for `replace` — names/terms you want said right.
8. Ask xAI whether a SIP/telephony onramp is on their roadmap — if it ships,
   it reopens a lower-effort path for any line still on the old core.

---

## 11. Acceptance gates (per line, no exceptions)

1. Gate B replay: failure rate ≤ old-core baseline on the same corpus/referee.
2. Deploy marker present in the running build before any call is interpreted.
3. Test-number soak: clean end-to-end calls including barge-in, silence,
   unclear replies, and a filed ticket verified in the backend.
4. Latency: caller-perceived response time not materially worse than baseline.
5. Cutover watch: quality score, phone-ID rate, repetition count, filing
   success — measured before and after on the production number.
6. Rollback rehearsed once per line (re-point the webhook, confirm old core
   answers) **before** the real cutover.
