# Adding an agent to the fleet

Read this before shipping a new voice agent, and again before shipping a new
fleet-wide capability.

## Why this exists

Four times now, a capability the fleet already had did not reach an agent, and
nobody noticed until a patient or a caller paid for it.

| When | What was missing | What it cost |
|---|---|---|
| 2026-07-30 | The azul terminal sweep ran for the WHOLE fleet | ~30 false "call them back" tickets reached the staff queue between 09:50 and 12:03 PT before it was gated |
| 2026-08-01 → 08-06 | The PCP agent (added 08-03) never inherited the fleet tool timeline (shipped 08-01) | All 196 PCP calls on 08-06 recorded zero tool events. A ticket-discarding defect ran ALL DAY invisibly: 41 tickets from 196 calls, and 21 medical-records requests filed nothing at all |
| 2026-07-22 → 08-06 | The on-call phone was reachable by ANY agent | azul-scheduling rang the operator's personal number 7 times, every one during business hours, none of them urgent |
| 2026-08-06 | `ticketState` reported only the professional field block | A records call burned 11 attempts on `missing_required_field:statedRelationship`; the ticket didn't say the patient was unidentified |

The pattern is always the same, and it is not carelessness: **the capability
was written for the agent that needed it, and the next agent was authored
somewhere else.** Nothing in the codebase makes the gap visible. This checklist
is what makes it visible.

## The one distinction that matters

Two kinds of wiring exist in this repo, and they fail in opposite ways.

**Fleet-by-construction** — the call path passes `effectiveSlug` through, so a
new agent is covered the moment it exists. The conversation loop guard
(`conversationLoopGuard.onCallerLine/onAgentLine`, called with `effectiveSlug`
in `voiceAgentRoutes.ts`) works this way, as does the call-log write path.
Nothing to do; do not add your slug.

**Opt-in by slug** — a `Set`, array, or `switch` names the agents that get the
behavior. A new agent is silently absent, and absence looks exactly like
"working fine" until you go looking. **Every incident above was an opt-in
list.** This checklist is a list of the opt-in lists.

A safe opt-in list is one whose *default* is the safe direction. Prefer
default-deny for anything that can dial a phone or spend money, and
default-INCLUDE for anything that records what happened. Two examples worth
copying:

- `urgentTransfer.ts` — `ON_CALL_AUTHORIZED_AGENTS` is default-deny: an unknown
  or absent slug gets no on-call number. A new agent cannot ring a personal
  phone by accident.
- `conversationLoopGuard.ts` — `AGENT_EXIT` has a `default` entry, so a new
  agent inherits a sane escape directive instead of none.

---

## The checklist

Tick every box, or write down why the item does not apply. "I assumed it was
automatic" is the failure mode this document exists to prevent.

### 1. Registration and routing

- [ ] **Agent registry** — `src/config/agents.ts`, `this.register({...})` with
      `id`, `factory`, `enabled`, `agentType`, `version`, `voice`, `language`,
      `greeting`.
- [ ] **Twilio webhook route** — a route in `voiceAgentRoutes.ts` that stamps
      `X-agentSlug=<slug>` on the SIP URI and sets `callMetadata` for the
      conference. Copy `/api/voice/pcp`. Never let a new line inherit the
      after-hours default.
- [ ] **`validAgentSlugs`** (`voiceAgentRoutes.ts:~1734`) — the slug is
      rejected outright if absent.
- [ ] **`validInboundAgents`** (`~3969`) — inbound-only.
- [ ] **Factory `case` in the agent switch** (`~2108`) — the factory signature
      differs per agent; pass `callId`, `callSid`, `callerPhone`,
      `dialedNumber`, and a **live** `get callLogId()` (see item 3).
- [ ] **DB seed** — `server/seedAgents.ts` if the agent needs a row.

### 2. Telemetry — this is what makes a bad day debuggable

- [ ] **Tool timeline.** Wrap EVERY tool's `execute` with `recordingExecute`
      from `services/toolTimeline`. Copy the `recordedTool` wrapper from
      `pcpAgent.ts` or `answeringServiceAgent.ts`:
      ```ts
      const timelineCtx = { callId, callSid, callLogId, agentSlug: '<slug>' };
      const recordedTool: typeof tool = ((def: any) =>
        tool({ ...def, execute: recordingExecute(timelineCtx, def.name, def.execute) })) as typeof tool;
      ```
      **This is the item that cost the most.** Without it `tool_timeline` and
      `tool_call_count` stay NULL and you cannot tell "never attempted" from
      "attempted and failed" — which is the difference between a prompt problem
      and a server bug.
- [ ] **The flush can resolve an id.** The timeline entry needs `callSid` or
      `callLogId` or it silently writes nothing (`toolTimeline.ts:~420`).
      Pass both.
- [ ] **Classifier coverage** — `classifyForAgent` in `toolTimeline.ts` routes
      anything non-azul to `classifyFleetCall`, which only knows
      `create_ticket` / `classify_request` / `escalate_to_human` /
      `lookup_schedule` / `terminate_call`. An agent with its own tool names
      (as PCP has) lands on `Unclassified — N tool call(s)`. Either add your
      tools to the classifier or accept a useless `result` string; do not
      assume it works.
- [ ] **Grading / rubric** — `callGradingService`, if the agent should be
      graded. Currently azul-specific in places.

### 3. Identity plumbing

- [ ] **`callLogId` is a LIVE getter, not a value.** `backgroundDbOps` resolves
      the id AFTER the agent is constructed. A captured `undefined` stays
      `undefined` forever:
      ```ts
      get callLogId() { return liveCallLogId(); },   // ✅
      callLogId,                                     // ❌ captured at construction
      ```
      Note the trap: destructuring a getter (`const { callLogId } = metadata`)
      captures the value and undoes this.
- [ ] **`callMetadataForDB`** carries `agentSlug`, `twilioCallSid`,
      `dbCallLogId` — several subsystems resolve ids through it.

### 4. Anything that dials a phone

- [ ] **On-call / personal numbers** — `ON_CALL_AUTHORIZED_AGENTS` in
      `services/urgentTransfer.ts`. Default-deny. Add your slug **only** if the
      agent is genuinely authorized to wake a human at home. If you are not
      sure, the answer is no.
- [ ] **Transfer destination policy** — `services/handoffPolicy.ts`.
- [ ] **Warm-transfer acceptance** — a keypress is the ONLY accept. AMD
      (`answeredBy`) is recorded, never acted on — it hung up on live staff
      before they could press a key (fixed in #85).
- [ ] **Hours awareness** — `utils/timeAware.ts`. The 12:00–13:00 Pacific lunch
      closure downgrades HAND_OFF to CREATE_TASK for administrative traffic.
      **Urgent clinical traffic is deliberately NOT gated** — do not "fix" that
      without asking.

### 5. Anything that files a ticket

- [ ] **Never discard a request for a missing administrative field.** File with
      placeholders and put the gap in the narrative (`ticketState` /
      `annotateGaps` in `pcpAgent.ts`). One uncaptured field must never cost a
      whole request.
- [ ] **The server and the directive must agree.** The loop guard's default
      exit tells the model *"Create the ticket NOW with whatever you have —
      missing fields may stay blank."* On 08-06 the PCP server then threw
      `missing_required_field`. The model obeyed the directive, the server
      refused, and the caller heard "there was an issue recording." If you add
      a server-side requirement, check what the guard is telling the model.
- [ ] **Seed the callback number from caller ID.** You are on a phone call with
      this person. Asking for a number you already have was the single most
      common reason a PCP request died.
- [ ] **Use `safeParse`, never `parse`.** A thrown ZodError reaches the model as
      a raw tool error and it improvises — it told callers the system was
      broken and to phone the records department themselves.
- [ ] **Ticket-persistence gates** — the slug lists at `voiceAgentRoutes.ts`
      `~3566` and `~6499` control whether the transcript/ticket is attached.

### 6. Sweeps and anything that runs on every call

- [ ] **Read the gate before you widen it.** The terminal sweep
      (`voiceAgentRoutes.ts:~3393`) is azul-only and the comment above it says
      DO NOT REMOVE. It reasons in azul's vocabulary — `sage_*` booking flows.
      Pointing it at a fleet timeline full of `create_ticket` events re-files
      the same ~30 false tickets from a fresh direction.
- [ ] **New sweep? Default to one agent** and widen deliberately, with the
      blast radius written in the comment.

### 7. Conversation quality

- [ ] **Pre-context** — `PRECONTEXT_SLUGS` (`voiceAgentRoutes.ts:~1904`) is how
      the agent knows who is calling. PCP is absent by choice; be sure yours is
      absent by choice too.
- [ ] **Output guardrails** — `agent.outputGuardrails`.
- [ ] **Identity guard** — `services/identityArgGuard.ts`, if the agent
      collects name/DOB.
- [ ] **Loop guard exit directive** — `AGENT_EXIT` in
      `conversationLoopGuard.ts`. The `default` is safe; override only if the
      agent has a better escape hatch.
- [ ] **Director** — opt-in via the `DIRECTOR_AGENTS` env var, not code.

### 8. Shadow / replay (observation-only, but it goes blind without you)

- [ ] `shadow/callLogReplay.ts` agent list · `shadow/toolSimulator.ts` tool
      definitions · `shadow/workflows.ts` · `shadow/reasoning.ts`

---

## Verify, don't assume

Find every opt-in list that names an existing agent but not yours:

```bash
# Which slug-aware modules know about <slug>?
for f in $(grep -rl "'azul-scheduling'\|'answering-service'" --include=*.ts src/ | grep -v test); do
  printf "%-50s %s\n" "$f" "$(grep -c "'<slug>'" "$f")"
done | awk '$2==0'
```

After the first production calls, confirm telemetry actually records — the
answer must come from data, not from the fact that the code looks right:

```sql
select agent_used, count(*) calls,
       count(*) filter (where tool_timeline is not null) with_timeline,
       count(*) filter (where ticket_number is not null) with_ticket
from call_logs
where start_time >= current_date and duration is not null
group by 1 order by 2 desc;
```

A new agent sitting at `with_timeline = 0` while its peers record is the
signature of a missed item in section 2. Then read what the tools actually did:

```sql
select e->>'tool' tool, e->'outcome'->>'error' error, count(*)
from call_logs c, jsonb_array_elements(c.tool_timeline->'events') e
where c.agent_used = '<slug>' and c.tool_timeline is not null
group by 1,2 order by 3 desc;
```

## When you ship a fleet-wide capability

The obligation runs the other way too, and this is the half that keeps getting
missed. Before merging something "fleet-wide":

- [ ] List every agent in `src/config/agents.ts` and name which ones get it.
- [ ] If it is opt-in by slug, say so in the commit message and say which
      agents are deliberately excluded.
- [ ] Add it to the relevant section above, so the next agent inherits it.
- [ ] Prefer threading `agentSlug` through the call path over a new `Set` —
      fleet-by-construction cannot be forgotten.

## Current state

As of 2026-08-06. `-` means deliberately absent, `MISSING` means it should
probably be there.

| | no-ivr | answering-service | azul-scheduling | pcp |
|---|---|---|---|---|
| Registered + route | ✅ | ✅ | ✅ | ✅ |
| Tool timeline | ✅ | ✅ | ✅ | ✅ (08-06, #92) |
| Fleet classifier covers its tools | ✅ | ✅ | ✅ (own) | **MISSING** — lands on `Unclassified` |
| Live `callLogId` getter | ✅ | ✅ | ✅ | **MISSING** — no `callLogId` on its metadata at all |
| Pre-context | ✅ | ✅ | ✅ | - |
| On-call authorized | ✅ | - | - (was reachable until #93) | - |
| Terminal sweep | - | - | ✅ | - |
| Loop guard | ✅ default | ✅ (no-transfer) | ✅ custom | ✅ default |
| Grading | ✅ | ✅ | ✅ | ✅ fleet-by-construction |
| Shadow replay | ✅ | ✅ | ✅ | **MISSING** |

Grading is worth dwelling on, because it is the counter-example that proves the
distinction at the top of this document. Nobody added PCP to the grader, and
PCP is graded anyway — 209 of 210 calls on 2026-08-06 — because
`runAndPersistDeterministicGraders` takes a `callLogId` and does not ask which
agent produced it. Only one azul-specific branch exists
(`callGradingService.ts:1102`). Build the next capability that way and it
cannot be forgotten.

The remaining `MISSING` rows are the current backlog for this document. Note
what they are NOT: nobody weighed them and decided against. They were simply
never carried across — which is the whole failure mode, one more time.
