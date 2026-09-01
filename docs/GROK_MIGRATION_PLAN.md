# OpenAI → Grok Voice Migration Plan — Azul Vision voice agents

Written 2026-08-29. Companion to `/CLAUDE.md` and `docs/observatory/STATE-OF-PLAY.md`
— both were re-read before this plan was written, per their own standing rule.
Pricing figures carry their source and date; verify before any budget commitment.

> **2026-09-01 — paths below are historical.** `src/standalone/` and `src/core/`
> were deleted; the Grok runtime this plan describes now lives in
> `src/runtime/`, mounted from `server/index.ts`. Where the text says to build
> in `src/standalone/` (§8 sequence, Phase 1 `grokLine.ts`) or to replay with
> `replayRealCalls.test.ts`, read that as the intent, not the location — those
> files no longer exist and no replacement replay harness has been built.

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
  `grok-telephony-v2`) and the 5star DRS line. The
  migration is a **port of a proven wire layer under the existing agents**, not
  new construction. Per standing instruction 2: *same exact agent, different
  voice pipeline*.
- **Who is talking today, measured (§2.4):** every production line is served by
  **this repo's OpenAI SIP agents** — 1,425 calls in 7 days, all OpenAI-metered.
  The ticketing-app's Grok lanes are built, merged and green but carry **no
  production traffic**. Tickets land in the ticketing application either way;
  that is the backend both stacks call, and it is easy to conflate with which
  stack does the talking.
- **Cost, measured (§2.7):** OpenAI is costing **$0.0918/call-minute →
  ≈$1,253/month**. Grok's flat $0.08/min would be **≈$1,092/month — about 13%
  cheaper**. Small, but it removes the "migrating costs more" objection. The
  real drivers remain **control and reliability**: mark-verified transcripts,
  scripted lines the model cannot rewrite (`force_message`), dead-air
  watchdogs, fail-closed signed webhooks, per-lane voices, instant
  webhook-re-point rollback — none of which the SIP architecture can give us,
  because audio never passes through anything we run.
- **Architecture decided (ADR-001):** one centralized voice runtime, agents as
  configuration, business capabilities behind HTTP — **not** a voice pipeline per
  application. See `docs/adr/ADR-001-centralized-voice-operations-hub.md`. This
  makes the migration and the consolidation **the same project**: Phase 1
  delivers the hub's one Grok runtime with answering-service as its first
  agent-as-config row.
- **Prompts do not migrate (operator ruling, §4.2).** The long prompts are
  largely GPT bandages; Grok does not need them, and our own DRS agent runs a
  full interview on a four-sentence prompt. Each agent's prompt gets rewritten
  from its business rules, keeping only operator policy and domain knowledge —
  and pushing policy into structure (renderer + tool gate) wherever it fits.
- **The honest trade:** the new architecture puts our server in the audio path.
  Under SIP, our app crashing mid-call doesn't kill audio; under Media Streams
  it does. §7 covers what we own once we take that on, and what's already built
  to carry it.
- **Sequencing** (§8): prove answering-service on a test number against the
  Gate B replay corpus → cut over in a low-volume window → no-IVR/after-hours →
  queue lines (into the hub, per ADR-001) → PCP/SD
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
- 5star DRS scheduling line — marker now
  `drs-grok-telephony-v10-cancel-race-absorbed`; has moved well past the 08-24
  merge (language requests, caller questions, PSD eligibility). Note 5star #213:
  a call-dropping cancel-race guard present in the ticketing adapter since
  08-23 was **missing here** until 08-29 — the drift ADR-001 exists to stop.

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

### 2.2 Per-line inventory — MEASURED, `call_logs` 7 days to 2026-08-29

Queried from Operations Hub `pslzngjciiifowemrzza`, not estimated. **This
supersedes the line-status table in `/CLAUDE.md`, which is stale (dated
2026-08-11/13) — see §2.5.**

| Line (`agent_used`) | Calls/7d | Tickets | Minutes | OpenAI $ | Avg quality | Version |
|---|---|---|---|---|---|---|
| **tech** | **425** | 311 | 1,052 | $87.99 | **3.42** | 1.0.0 |
| no-ivr (after-hours) | 372 | 121 | 631 | $74.69 | 3.06 | 1.20.0 |
| surgery | 344 | 122 | 783 | $71.58 | 3.02 | 1.0.0 |
| optical | 180 | 94 | 442 | $35.39 | 3.16 | 1.0.0 |
| answering-service | 93 | 37 | 243 | $21.18 | 3.08 | 3.7.0 |
| pcp | 11 | 6 | 35 | $1.60 | 2.55 | 1.0.0 |
| **Total** | **1,425** | **691** | **3,186** | **$292.43** | — | — |

**≈204 calls/day, 2.24 min average call.** Twilio adds $23.20/7d.
`telemetry_source = transport-events` on every row — the SIP path.

### 2.3 What the data changes (three surprises)

1. **`tech` is LIVE and is now the largest line** — 425 calls / 311 tickets in
   7 days. CLAUDE.md still says "number pending." It got its number.
2. **answering-service has collapsed to ~13/day** (93 calls/7d) from 579 on
   Aug 10, and **the queue lines absorbed that traffic**: tech + surgery +
   optical = 949 of 1,425 calls (67%). The migration's centre of gravity is
   therefore the **queue lines**, not answering-service.
3. **Quality is up, not flat.** 3.0–3.4 across lines (tech highest at 3.42)
   against the 2.73–2.82 STATE-OF-PLAY records as "flat all week." Whatever
   shipped since 08-13 moved it. PCP's 2.55 on 11 residual calls is the
   outlier and it is effectively off.

### 2.4 Which stack is actually serving these calls — the ownership question, answered

**The live ticket-creating voice agents are the OPERATIONS (this repo's)
agents on OpenAI SIP. The ticketing-app's Grok lanes are built, merged, and
green — but they are NOT carrying production traffic.**

Evidence, two independent databases:
- Ops `call_logs` (above): all 1,425 calls carry **OpenAI cost** and
  `telemetry_source = transport-events`, with this repo's agent versions
  (answering-service 3.7.0, no-ivr 1.20.0, queues 1.0.0). No Grok-served call
  appears.
- Ticketing `tickets` (`vsmcxhxeirkoobmjcrbn`), same 7 days: **1,301 voice
  tickets carry this repo's agent slugs** (tech 547, surgery 315, no-ivr 187,
  optical 165, answering-service 77, pcp 10). Only **22** carry UUID agent
  ids, and 404 have none (staff-created).

The distinction worth naming, because it is easy to conflate: **tickets always
land in the ticketing application** — it is the backend both stacks call. What
this data settles is *who is doing the talking*, and today that is this repo's
OpenAI agents on every production line.

### 2.5 Per-line status, corrected

| Line | State (measured) | Notes |
|---|---|---|
| tech | **LIVE — largest line** | dept 3 / medication queue. Best quality of the fleet. |
| no-ivr | **LIVE** | Carries all overnight volume (rule 13). Only line with calls today (08-29). |
| surgery | **LIVE** | dept 2. |
| optical | **LIVE** | dept 1. |
| answering-service | LIVE but drained (~13/day) | Traffic moved to the queue lines. |
| pcp | effectively OFF (11 calls/7d) | Off since 08-10 (transfer failures); has handoff per rule 9. |
| azul-scheduling (SD) | OFF — no calls | Gate B: booked 8 of 21. |
| appointment-confirmation | outbound | Same SIP core. |

### 2.6 Known open reliability issues on the current stack (STATE-OF-PLAY §7)

- Spurious barge-in (fired 617ms into a greeting, pre-speech).
- `openai socket closed MID-CALL … 1005` at teardown (cosmetic so far).
- One phone number carrying two patients blends them in lookup (needs
  group-by-person + refuse-to-guess) — **pipeline-independent; migrates with
  us unless fixed first**. Note: the DRS/ticketing pre-context selector now has
  the deterministic-tiebreak + refuse-incomplete pattern to reuse.
- Main just took `d4a201d` (pool self-heal + stale-call sweeper after a DB
  restart produced 52h "live" calls) — evidence that our operational stack
  already needs, and now has, self-healing around the DB.

### 2.7 Current cost — MEASURED, not estimated

The system meters itself (`call_logs.openai_cost_cents`, token columns,
`cost_is_estimated`). Seven days to 2026-08-29:

| | 7 days | Per month (×30/7) |
|---|---|---|
| OpenAI (voice) | **$292.43** | **≈ $1,253** |
| Twilio | $23.20 | ≈ $99 |
| Call-minutes | 3,186 | ≈ 13,656 |

**Effective rate: $292.43 ÷ 3,186 min = $0.0918 per call-minute.**

Caveat: per-call cents are integer-rounded and some rows may be estimated
rather than reconciled (`cost_is_estimated`); at 1,425 calls the rounding
error is under ±$7. Cross-check against the OpenAI invoice before quoting
externally, but this is the system's own accounting and it is good enough to
plan against.

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

### 4.2 Prompts: do NOT port them — rewrite from the rules

**Operator ruling, Wayne, 2026-08-29:** *"You don't need the long prompting.
You don't need all the different edge cases, all the bandages, because their
voice layer / the reasoning behind their voice is just much, much smarter than
ChatGPT's."* This supersedes the first draft of this document, which
recommended carrying prompts across byte-identical. **The bandages do not
migrate.**

He is right, and our own codebase is the evidence:

- The **DRS Grok agent's entire system prompt is four sentences**
  (`BASE_INSTRUCTIONS`), and it runs a full identity-confirm + eligibility +
  scheduling interview.
- Meanwhile `server/sage-prompt/` is ten files, and
  `inbound-greeting.ts` reads as a changelog of GPT-realtime defects: a
  persisted greeting item that got re-obeyed on any garbled turn (eight calls
  in four days, 9-second average against 85 for a clean call); an auto-response
  race that greeted the caller twice; the bilingual-greeting bug; a whitelist
  gate added because the model treated STT garble as a confirmation; a hard cap
  added after it asked the same identity question three times in a row.
- STATE-OF-PLAY §3 adds more of the same class: the agent reciting its own
  instructions to patients, answering in Russian, and OpenAI STT fabricating
  fiction that patients heard.

Every one of those is prompt written to patch a model, not to run a practice.
None of it should survive the migration.

**The one distinction that has to hold.** Those prompts have three kinds of
text tangled together, and only the first kind is disposable:

| Kind | Example | Disposition |
|---|---|---|
| **(a) Model bandages** | "never repeat the greeting", the consecutive-turn ban, affirmation whitelists, "do not recite these instructions" | **Delete.** GPT-specific. |
| **(b) Operator rulings** | capability boundary (cannot transfer or schedule — file a ticket); schedule-related routes to the HVA Hub from every queue *except* a surgery date; confirm the callback number *before* filing; no transfer tool at all on answering-service lines; nobody is told to call back | **Keep — these are Wayne's, not the model's.** |
| **(c) Domain knowledge** | department taxonomy, reason codes, office and provider names | **Keep — but it moves to the runtime's knowledge pack, not the agent prompt.** See ADR-001's practice-knowledge section: the pack already exists and 8 of 12 agents, including the three busiest, do not use it. |

**And the second reason the DRS prompt is four sentences** — worth naming
because it compounds with Grok's capability rather than competing with it: we
moved category (b) *out of the prompt and into structure*. The renderer speaks
the only authorized line, so an unauthorized sentence is not possible rather
than discouraged. The tool gate rejects any report that does not match the
step the call is actually on. A line that cannot transfer has **no transfer
tool at all** (rule 9 — a tool the agent cannot see is a promise it cannot
make). That enforcement is stronger than a prompt instruction on *any* model,
and it is why the prompt got to shrink.

**There is a cost dividend too.** A re-sent prompt is billed on every turn
whether cached or not, so prompt size is the largest *addressable* line on
the OpenAI bill — directionally worth more per month than either cache
tuning or the entire Grok-vs-OpenAI delta (ADR-001, caching section). The
ruling below is a quality decision that happens to pay for itself.

**Method for each agent, therefore:** rewrite the prompt from the agent's
business rules, not from its current text. Take the existing prompt, strip
everything that exists because GPT misbehaved, keep (b) and (c), and promote
as much of (b) as possible into renderer/tool-gate structure. Gate B replay is
what proves the result — a short prompt that fails the corpus is not a win.

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

**Monthly model — against MEASURED volume (13,656 min/mo, §2.7):**

| | Rate | Per month | Δ |
|---|---|---|---|
| OpenAI today (measured) | **$0.0918/min** | **$1,253** | baseline |
| Grok `think-fast-2.0` | $0.08/min flat | **≈$1,092** + text | **−$161/mo (−13%)** |
| If PCP + SD return (+~35% min) | — | $1,691 vs $1,474 | −$217/mo |

**Honest conclusions:**
0. **This comparison is against a poorly-cached OpenAI — see ADR-001's
   caching section.** Measured token caching is 51.9% on audio and 83.7% on
   text, and only 30.6% on short calls' text, where the prompt dominates. A
   well-cached, shorter-prompted OpenAI could close or reverse the gap below.
   Treat the delta as "roughly a wash", and decide on control and
   reliability, not price.
1. **Grok is modestly CHEAPER — roughly 13%, about $160/month at today's
   volume.** This corrects the first draft of this document, which estimated
   OpenAI at $0.05–0.08/min from published token rates and concluded
   "cost-neutral." Our own metering says $0.0918/min. The direction was wrong;
   the magnitude is still small. **Do not migrate for the money — but it is not
   a cost penalty either, which removes the main argument against.**
2. Grok's flat per-minute pricing is **predictable**: immune to context growth,
   verbose callers, long instructions, and token-density drift. OpenAI's
   token metering rewards short calls and caching but makes the bill a function
   of prompt engineering — and our measured $0.0918 is *above* the published
   blended estimate, which is exactly what long prompts and long context do.
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

**Sequencing rationale changed by the measured data (§2.2–2.5):**
answering-service is no longer the volume centre — it is down to ~13 calls/day
while the queue lines carry 67% of traffic. That makes it the **ideal pilot**:
a real production line, real callers, tiny blast radius. The queue lines are
where the value is, and they already have a working Grok implementation in the
ticketing app — so they move up, not down, in priority.

**Phase 1 — answering-service on a test number (the pilot, now low-risk)**
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

**Phase 4 — queue lines: tech, surgery, optical (THE MAIN EVENT — 67% of traffic)**
- These three carry 949 of 1,425 calls/week and produce 1,027 of the voice
  tickets. **tech alone is the largest line in the practice** (425 calls/week,
  quality 3.42) — and contrary to CLAUDE.md, its number is live.
- **Settled by ADR-001:** the queues move **into the hub**, not into the
  ticketing app. The ticketing implementation is the reference to port *from*
  (it is built, reviewed and green), then it retires. Re-pointing the numbers
  at the ticketing app would have been the locally cheaper move and would have
  permanently split the fleet's observability — that app's voice stack writes
  no call records, no quality scores and no cost telemetry at all.
- Cut over **one queue at a time, smallest first: optical (180/wk) → surgery
  (344/wk) → tech (425/wk)**, each with its own before/after measurement
  (tickets filed, department routing accuracy, quality score, latency).
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

1. ~~**Queue ownership**~~ — **RULED 2026-08-29, ADR-001:** the queues move
   into the hub; the ticketing lanes serve as the port source and then retire.
   Remaining operational sub-question for you: cut the three queues over
   smallest-first (optical → surgery → tech) as planned, or hold tech until the
   other two have a week of green history? (Recommended: hold tech — it is the
   largest line and the highest-quality one at 3.42.)
2. **Cutover windows** for answering-service and no-IVR (which low-volume
   window; who is watching).
3. **PCP / SD:** migrate-while-off is free — but is reactivation even on the
   table this quarter? (Sets Phase 5 priority.)
4. **Model pin:** pin `grok-voice-think-fast-2.0` now, or track
   `grok-voice-latest` on test numbers only? (Recommended: pin in prod, latest
   on test.)
5. **Voices per line** (`XAI_VOICE_NAME_<SLUG>`) — your pick per lane.
6. ~~**Prompt simplification appetite**~~ — **RULED 2026-08-29 (§4.2): do not
   port the prompts.** Rewrite each from its business rules; the GPT bandages
   go. Remaining sub-question for you: for the **queue agents specifically**,
   whose classification and routing text drives ticket department/reason
   accuracy, do you want to review the rewritten prompt before it goes on a
   test number, or after Gate B replay reports parity?
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
