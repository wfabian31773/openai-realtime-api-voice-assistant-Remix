# ADR-001 — One voice runtime, agents as configuration

- **Status:** Accepted — Wayne, 2026-08-29
- **Supersedes:** the recommendation in `docs/GROK_MIGRATION_PLAN.md` §8 Phase 4
  (first draft) to re-point the queue numbers at the ticketing app
- **Applies to:** every voice agent across Azul Vision — ticketing, scheduling,
  DRS, and whatever comes next

---

## The question

We are about to add voice agents faster than we have been. Do we build each one
inside the application it serves — a voice pipeline in the ticketing app, another
in the scheduling app, another in 5Star — or do we run **one voice operations hub**
that owns the telephony and talks to those applications over HTTP?

## Context — we already ran the experiment

Three codebases currently contain a voice pipeline: this repo (operations), the
ticketing app, and 5Star. That was not a plan; it accumulated. What it produced,
measured 2026-08-29:

1. **The app-owned pipeline silently loses observability.** The ticketing app's
   voice stack has **zero** call-record, quality-grading, or cost writes. This
   repo's `call_logs` carries ~100 columns — per-call cost and token counts,
   quality scores and grader results, transcripts, tool timelines, Twilio network
   insights, hangup attribution — and six agents write to it. Had the ticketing
   lanes taken the queue traffic, roughly **425 tech calls a week would have gone
   dark**: no quality score, no cost line, nothing to review. Nobody would have
   noticed until someone went looking for a number that was not there.

2. **The duplication tax is already being paid, by hand.** Two independent Grok
   wire implementations exist (~909 lines in ticketing, ~457 plus a bridge in
   5Star). In a single working session on 2026-08-24, two fixes had to be ported
   manually from one to the other: config-before-audio (the deaf agent) and
   response-gating (the silent agent). Same bugs, found once, fixed twice.

3. **The copies drift, and the drift reaches production.** The cancel-race guard
   added to the ticketing adapter on 2026-08-23 was **absent from 5Star**, where
   the same provider error routed to `handleProviderFailure` and **dropped the
   call**. It was found on 2026-08-29 by diffing the two implementations, not by
   a caller report, and fixed as 5Star #213. A third implementation would be a
   third copy of every fix, and a third place for them to rot.

The expensive part of a voice agent is not the agent. The prompt and tools are a
small fraction of the work; the rest is config-before-audio ordering, response
gating, barge-in and cancel races, mark-verified transcripts, dead-air watchdogs,
exactly-once teardown, stream-token auth, deploy markers, call-record
persistence, cost telemetry, and quality grading. **All of it is agent-agnostic**,
and every line of it must be re-learned per codebase under the app-owned model.

## Decision

**A centralized voice operations hub, in three layers.**

**1. Voice runtime — exactly one.** Twilio webhook and signature validation,
Media Streams bridge, provider adapters (Grok, OpenAI), every wire invariant,
teardown, call records, cost telemetry, quality grading. One implementation, one
place a wire bug is fixed.

**2. Agents as configuration, not code.** Per agent: slug, phone number, voice,
language, business-rules prompt, tool manifest, routing. Stored as data —
`ticket_agent_config` is the existing seed — and editable without a deploy.
**This is the layer that answers the scaling question:** a new agent becomes a
config row and a webhook, not a new codebase carrying a fresh copy of every
wire bug.

**3. Business capabilities behind HTTP.** Ticketing owns tickets. Scheduling owns
the book. The hub calls them as tools. Each application keeps its own domain,
its own database, and its own release cadence, and never touches μ-law framing
or WebSocket lifecycles.

**The boundary rule, stated so it can be enforced in review:** *if it would still
be true on a web form, it belongs in the application, not the hub.* Ticket
routing rules, eligibility logic, and booking validation are application
concerns that happen to be reachable by voice. Turn detection, barge-in, and
audio framing are hub concerns that no application should ever see.

## Token caching is a first-class runtime concern (added 2026-08-29, Wayne)

Caching was missing from the first draft and belongs in the runtime layer,
not in each agent. Measured from `call_logs`, all lines, since 2026-08-17:

| | Input tokens | Cached | Rate |
|---|---|---|---|
| **Audio** | 14.60 M | 7.58 M | **51.9%** |
| **Text** | 182.50 M | 152.68 M | **83.7%** |
| Combined | 197.10 M | 160.26 M | 81.3% |

**What drives the rate — measured, not assumed.** Both rates climb
monotonically with conversation length, which is the signature of
within-conversation prefix caching (turn *k* re-sends turns 1…*k*−1, so the
longer the call the larger the re-sent, cacheable share):

| Turns | Calls | Audio cached | Text cached |
|---|---|---|---|
| 1–4 | 273 | 6.3% | 30.6% |
| 10–14 | 525 | 39.4% | 79.0% |
| 20–24 | 579 | 45.7% | 84.6% |
| 40+ | 185 | 67.5% | 91.0% |

Two conclusions follow:

1. **Audio caching is largely mechanical.** It is a function of call length,
   and the first turn is always cold. There is no prompt trick that makes a
   4-turn call cache like a 40-turn one. Treat ~52% as near the practical
   rate for our call-length mix rather than a defect to fix.
2. **Text caching on SHORT calls is the real signal.** At 1–4 turns the text
   is overwhelmingly the system prompt and tool schemas, and it is only 30.6%
   cached — meaning a short call largely re-pays for its own prompt. If the
   static prefix were being reused across calls, short calls would start near
   the prompt's share of text, not at a third of it.

**Why the stakes differ by provider — and why this is not a cost argument
for migrating.** On OpenAI the discounts are steep: cached audio $0.40/M
against $32 uncached (80×), cached text $0.40/M against $4 (10×). On Grok's
flat $0.08/min, tokens are not billed at all — **caching becomes
economically irrelevant the moment a lane migrates.** That cuts both ways,
and it qualifies `GROK_MIGRATION_PLAN.md` §5: the measured "Grok is ~13%
cheaper" compares Grok against a *poorly-cached* OpenAI. A well-cached,
shorter-prompted OpenAI could close or reverse that gap. **Cost should
decide nothing here** — which is the plan's existing conclusion, now on
firmer ground.

**Where the money actually is** (same window, published rates; the text rate
is the least certain input):

| Line item | Cost |
|---|---|
| Output audio | ~$337 |
| **Uncached audio input** | **~$225** |
| Uncached text input | ~$119 |
| Cached text input | ~$61 |
| Cached audio input | ~$3 |

The largest *addressable* line is text: a re-sent prompt is billed on every
turn whether cached or not ($0.40/M is cheaper than $4/M, not free).
Directionally, **halving prompt size is worth more than any cache tuning** —
roughly $200+/month at current volume against ~$140 for pushing text cache
from 84% to 92%, and more than the entire Grok-vs-OpenAI delta. That makes
Wayne's prompt ruling (`GROK_MIGRATION_PLAN.md` §4.2 — strip the GPT
bandages) the single highest-value cost action available, independent of
which provider a lane runs on.

**Design rules this imposes on the hub**

1. **Stable prefix first, volatile context last.** The runtime assembles
   every prompt as `[static instructions][static tool schemas][volatile
   per-call context]`. Caller pre-context, names, timestamps and call ids go
   at the END. Interpolating any per-call value into the prefix invalidates
   the cache for everything after it, on every call. This is a review-time
   rule, not a preference.
2. **Byte-identical prefixes per agent.** Agents-as-config means each lane
   has its own prefix, which is fine — each caches independently — but the
   prefix must not vary within a lane. No timestamps, no per-call
   conditionals, no reordering, no environment-dependent text.
3. **Cache rate is a fleet metric, not a curiosity.** The hub records
   `input_cached_*` per call (the columns already exist and are ~99%
   populated). Cache rate by agent belongs alongside quality and cost in the
   per-line dashboard, and short-call text cache rate is the specific number
   that reveals a busted prefix.
4. **Regression gate.** A prompt or runtime change that drops an OpenAI
   lane's short-call text cache rate is a cost regression even if quality
   holds, and is caught by the same before/after discipline as everything
   else.

**Open question for Wayne:** these levers pay off only on lanes still running
OpenAI. If the migration moves quickly, prompt-shortening is worth doing for
quality and latency but its cost benefit is temporary. If the migration is
staged over months, it is worth doing early and on its own merits.

---

## Practice knowledge and organizational identity belong to the runtime (added 2026-08-29, Wayne)

**The ask.** Every agent should know the practice by heart — locations,
addresses, phone and fax numbers, providers, services rendered, the public
material anyone could read off the website — without that being injected into
each agent separately. And each agent should know *where it sits*: that it is
the Optical desk inside Azul Vision, what its own department handles, and what
the neighbouring desks handle.

**This is not a new build — it exists and is unevenly applied.**
`src/config/azulVisionKnowledge.ts` (481 lines) already holds
`AZUL_VISION_LOCATIONS`, `AZUL_VISION_SERVICES`, `AZUL_VISION_PROVIDERS`,
`AZUL_VISION_KNOWLEDGE` and `COMMON_QUESTIONS`, with builders
(`buildPracticeKnowledgePrompt`, `buildCompactLocationReference`,
`buildServicesReference`, `buildProvidersReference`). Measured 2026-08-29:

| Agents that import it | Agents that do NOT |
|---|---|
| answering-service, no-ivr, after-hours, pcp | **optical, surgery, tech**, azul-scheduling, records, drs-scheduler, no-ivr-v2, appointment-confirmation |

**The three lines carrying 67% of all call volume — optical, surgery and tech
— have no practice knowledge at all.** Worse, they carry *partial hand-copied
knowledge instead*: office names appear as inline string literals in
`surgeryAgent.ts` and `techAgent.ts`, which is duplication that can and does
drift (commit #223 had to alias two retired NextGen office names, North Valley
Eye → Mission Hills and Magan → Covina — proof this data churns and that stale
names reach production).

This is the ADR's thesis for the fourth time in one day: one behavior, spread
across agent files, present in some and missing in the highest-volume ones.

### Decision

**Practice knowledge is assembled by the runtime and given to every agent
automatically. No agent imports, copies, or hand-maintains it.**

**1. One pack, in the cached prefix.** The runtime composes the knowledge pack
from the single source and places it in the **static prompt prefix**, ahead of
any per-call context. This is the ideal prefix content — large, identical on
every call, never patient-specific — so it caches essentially for free (see the
caching section above), and on flat per-minute pricing it costs nothing at all.
It is also faster than a tool call: an agent that *knows* the Encinitas fax
number answers instantly, where a lookup costs a round trip mid-conversation.

**2. Organizational identity is part of every agent's config.** Each agent
declares its own place: the practice it works for, which desk it is, what that
desk handles, and what the neighbouring desks handle. This is not decoration —
**cross-queue routing depends on it.** Standing instruction 10 requires a
caller who reached the wrong queue to have their request taken and routed
(schedule-related to the HVA Hub, except a surgery date). An agent cannot route
correctly to a department it does not know exists.

**3. The static/volatile boundary.** The same rule that governs caching governs
this:

| In the pack (static, public) | Behind a tool (volatile or private) |
|---|---|
| Locations, addresses, hours | This caller's appointments |
| Phone and fax numbers | Slot availability |
| Providers and specialties | Ticket status |
| Services rendered | Anything patient-specific |
| Insurance/payer participation, accessibility | |
| Common questions; the org chart | |

**4. Public-only, and that is a safety property.** The pack carries only what is
already published. If it is on the website, reciting it to a caller cannot be a
disclosure problem. Nothing patient-specific, and nothing internal-only, ever
enters the pack — that keeps a large, freely-recited block of text inherently
safe to speak.

**5. Generated, never hand-maintained.** One source of truth, composed into the
prefix at session start. Change a location once and every agent has it on the
next call. Hand-editing N prompts is what produced the current split, and a
hand-maintained pack would drift the same way.

### The risk this creates, stated plainly

"Knowing it by heart" means the model can also **recite it wrongly with
confidence** — a plausible-looking fax number is worse than an admission of not
knowing, and **a stale pack is worse than no pack** for exactly that reason.
Three mitigations, all cheap:

- Keep the pack terse and structured; long prose invites paraphrase.
- Generate it from the source on every deploy, with a version/asof marker, so
  the prefix cannot silently age.
- For the highest-stakes specifics a caller will write down — fax numbers,
  exact street addresses — prefer the renderer/scripted path over free
  recitation, the same discipline the DRS line already uses for its authorized
  lines.

### Recommended now, independent of the migration

Giving `optical`, `surgery` and `tech` the existing knowledge pack is a
same-day change to 67% of call volume and does not depend on any of this
migration. It touches production agents, so it is Wayne's call to authorize
(standing instruction 5) — but the measurement discipline applies: baseline
first, since "the agent knew the address" shows up in quality score and in
callers not being told to call back.

---

## Consequences

**Accepted gains**
- One place to fix a wire bug; no more hand-porting between repos.
- Fleet-wide observability: every agent's calls land in one `call_logs`, graded
  by one grader, costed by one pipeline. Cross-agent comparison becomes possible.
- A new agent is cheap — config plus a webhook re-point.
- Provider migrations (this one, and the next) happen once, not once per app.

**Accepted costs — real, and mitigated rather than denied**
- **Blast radius.** One hub means one deploy that can affect every line; today a
  ticketing break cannot touch DRS. Mitigations: staged rollout, the
  webhook-re-point rollback we already rely on, and process isolation per lane
  group as volume grows. This is the single strongest argument against the
  decision and it is accepted knowingly.
- **Boundary discipline.** The hub becomes a monolith the moment ticket-flow or
  scheduling logic starts living in it. The boundary rule above exists to be
  cited in review.
- **Migration work.** Consolidating is more work than leaving three
  implementations alone — but strictly less than maintaining them, and the
  drift bug above is what maintaining them actually costs.

## Alternatives considered

- **Voice inside each application (status quo).** Rejected: loses fleet
  observability, multiplies the wire layer per app, and has already produced a
  production call-dropping drift bug.
- **A shared npm package consumed by three services.** Rejected for this
  operation: cross-repo version coordination across three Replit deploys is
  heavier than one service, and a package still leaves three call-record stores
  and three graders. Consolidate the *service*, not just the library.
- **Re-point the queue numbers at the ticketing app** (the first draft's
  recommendation). Rejected: locally the cheapest move — that code is built,
  reviewed and green — but it permanently splits the fleet's observability to
  save a few days.

## Implications

- **The Grok migration and this consolidation are the same project.** Phase 1 of
  `GROK_MIGRATION_PLAN.md` delivers *the hub's one Grok runtime*, with
  answering-service as its first agent-as-config row — not a bespoke pipeline for
  one agent.
- **The queue lines move into the hub**, not into the ticketing app. The
  ticketing implementation becomes the reference to port *from*, then retires.
- **DRS folds in when its line is next substantially touched.** Its
  `SchedulingCore` is already built on ports, so its data needs (slots,
  eligibility, booking) are already HTTP-shaped; it becomes an agent type in the
  hub without redesign.
- **Until consolidation completes, wire fixes must be applied to every live
  implementation.** Diff the adapters before assuming a fix is present — that is
  how #213 was found.
