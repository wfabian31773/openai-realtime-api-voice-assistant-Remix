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
