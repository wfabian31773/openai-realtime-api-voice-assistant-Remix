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
