# The Grok runtime — where it actually stands

**Scope: the ticketing agents only.** Optical, surgery, tech, records,
answering-service. No Sage, no diabetic-retinopathy, no 5Star. Anything in this
document that mentions another lane does so only to say why it is not our
problem.

Written 2026-09-03 by reading `main` at `bfe4d75`, not from memory. Every claim
below carries the `file:line` it came from so the next person can check it
instead of re-deriving it.

---

## The one-line answer

**The runtime is built, mounted, proven on real calls, and not running.** On
**2026-08-31 it took two optical calls and filed two real tickets end to end** —
VA-56007 and VA-56072, both since resolved by staff. It has taken none before or
since. So the open question is not whether it works. It is volume, plus four
named gaps that are each small and specific. The distance to GTM is much shorter
than the last two weeks of firefighting suggests.

### The two calls, and what they prove

Identified by `voice_provider = 'grok'` on `call_logs` — a column **the runtime
writes and the old core never does**, which makes it the clean discriminator for
the cutover. Two rows, all-time.

| | call 1 | call 2 |
|---|---|---|
| time (UTC) | 2026-08-31 11:59:41 | 2026-08-31 16:06:27 |
| duration | 66s | 77s |
| ticket | VA-56007 | VA-56072 |
| routing | dept 1 · location 8 · type 5 / reason 20 | same |
| callback captured | yes | yes |
| staff outcome | resolved | resolved |
| transcript · timeline | 698 chars · yes | 819 chars · yes |

**And they expose the gap that matters.** `patient_found = false` on both call
records; `agent_used = 'unknown'` on both tickets, with `agent_outcome`,
`caller_language` and `patient_name` all null. The runtime inherits the identity
gap the forensic found on 484 old-core calls, and its own tickets are invisible
to any report grouped by agent. Two calls filed correctly and neither is
attributable afterwards — exactly the condition under which a cutover cannot be
judged.

---

## 1. Where the runtime lives, and why it looks missing

`src/runtime/` — 20 modules, each with a test file beside it.

It is mounted at **`server/index.ts:396`** (`mountVoiceRuntime`, imported at `:390`), on
the **public** server, before `listen`, unconditionally. Its deploy marker is
`voice-runtime-v3-precontext-diagnosable-20260905` (`src/runtime/readiness.ts:28`), printed
by `GET /voice/health` — which is how you tell in one request whether a build
carries it.

It is **not** mounted in `src/server.ts`. That file carries the reason at
line 43:

> no Twilio Media Streams line mounts here — the Grok voice runtime mounts on
> the public server, because this process sits behind an HTTP-only
> `/api/voice` proxy that cannot forward a WebSocket upgrade.

So a `grep` of `src/server.ts` makes the runtime look orphaned. It is not.
**Do not go looking for a missing mount — there isn't one.**

Its surface (`src/runtime/voiceRuntime.ts:8-11`):

| route | purpose |
|---|---|
| `POST /voice/:slug` | the number's Voice webhook |
| `POST /voice/:slug/after` | post-stream continuation |
| `WS /voice/stream` | Twilio Media Streams |
| `GET /voice/health` | deploy marker, readiness, and the NAMES of missing env |

Mounting is safe by construction: an unconfigured process still boots, still
answers `/voice/health`, and the webhook fails closed with a controlled spoken
line rather than a half-configured call.

## 2. Which lanes the runtime already serves

`laneSupportStatus` (`src/runtime/laneRegistry.ts:160`) refuses a lane for
exactly two reasons, and **the ticketing agents trip neither**.

| refusal set | lanes | why |
|---|---|---|
| `NON_UNIFORM_FACTORY_LANES` (`:85`) | after-hours, drs-scheduler, appointment-confirmation, fantasy-football | their factory signature is not the uniform shape; an adapter must be written deliberately |
| `TRANSFER_CAPABLE_LANES` minus `RUNTIME_TRANSFER_READY_LANES` (`:116`, `:140`) | azul-scheduling | its ordinary `transfer_to_office` reads a per-call side channel only `voiceAgentRoutes` registers |

**Optical, surgery, tech, records and answering-service are in neither set.**
The runtime serves them today. Nothing has to be added to the lane registry for
the fleet Wayne cares about.

Verified mechanically rather than by reading, by parsing the three sets out of
`laneRegistry.ts` and testing each slug: the refused set is exactly
`{after-hours, appointment-confirmation, azul-scheduling, drs-scheduler,
fantasy-football}`. All five ticketing lanes come back SERVED.

Transfer-ready lanes are no-ivr, no-ivr-v2, dev-no-ivr, pcp and runtime-proof.
The queue agents never call handoff at all — that is the operator's 2026-08-12
ruling, and the registry already encodes it.

## 3. Who is who — the agent inventory

Thirteen agent configs are registered in `src/config/agents.ts`. Sorted by what
they actually are:

**The ticketing fleet — our scope (5).**

| slug | file | tools | runtime |
|---|---|---|---|
| `optical` | `src/agents/opticalAgent.ts` | 5, from the registry | **served** |
| `surgery` | `src/agents/surgeryAgent.ts` | 5, from the registry | **served** |
| `tech` | `src/agents/techAgent.ts` | 5, from the registry | **served** |
| `records` | `src/agents/recordsAgent.ts` | 5, from the registry | **served** |
| `answering-service` | `src/agents/answeringServiceAgent.ts` | inline, welded | served, but see §4 |

**Out of scope, still live on the old core (3).** `no-ivr` (also the after-hours
agent), `pcp` (off in Twilio), `azul-scheduling` (off).

**Scaffolding and demos — candidates for deletion (5).** `runtime-proof` (built
to live-test the runtime end to end), `after-hours`, `drs-scheduler`,
`appointment-confirmation`, `fantasy-football`. Each has exactly one importer:
`src/config/agents.ts` itself. Nothing else in the tree references them.

**The registry does not route live calls.** Every entry carries
`twilioNumbers: []` except `answering-service` (`+19094135645`).
`getAgentFactoryByNumber` therefore matches nothing and falls through to the
no-ivr default for every other number. Real routing is per-slug webhooks in
`voiceAgentRoutes.ts`. This is open task #61 and it is worth closing before
anyone trusts that file.

## 4. The tool architecture is already what Wayne asked for

Wayne, 2026-08-30: *"build the runtime, build the tools and functions, then
decide which tools and functions each agent has access to."*

The four queue agents already work exactly that way — a list of names resolved
from a shared registry (`src/tools/registry.ts`, `src/tools/realtimeAdapter.ts`):

```ts
export const OPTICAL_TOOLS = ['lookup_patient', 'resolve_location',
  'check_open_tickets', 'classify_optical_request', 'file_optical_ticket'];
```

All four are the same five-tool shape: identity, location, duplicate check,
classify, file. Only the classify and file tools differ by queue.

**What is not in the registry:** `answering-service`, `pcp`, `azul-scheduling`
and `no-ivr` declare their tools **inline**, welded into their agent files —
roughly 30 tools including `handoff_to_pcp`, `sage_book`, `transfer_to_office`
and `escalate_to_human`. Nothing else can reach them, so they cannot be
assigned to another agent. For our scope this matters for exactly one lane:
answering-service.

**Never set `strict: true` on a generated schema** — see
`.agents/memory/realtime-tool-schemas.md`. That mistake silently killed every
surgery ticket for a day.

## 5. What we send Grok today, against what the docs offer

From `src/runtime/grokSession.ts:121-157`, checked against
`.agents/memory/grok-speech-to-speech-api.md`.

**Sent, and correct:**

| field | value | verdict |
|---|---|---|
| model (URL query) | pinned version | correct — docs say pin in production |
| `audio.*.format` | μ-law 8 kHz both legs | correct — matches Twilio exactly, no transcoding |
| `turn_detection` | `server_vad`, threshold `0.85`, silence `500`, prefix `333` | 0.85 and 333 **are** the documented defaults |
| `audio.input.transcription.language_hint` | per-lane, retargetable mid-call | correct mechanism |
| `reasoning.effort` | from config | on by default per docs |
| `audio.*.transport` | `json` | works; `binary` would drop base64 overhead |

**Available and never sent:**

| field | what it would buy |
|---|---|
| `keyterms` | up to 100 terms biasing ASR — surgeon, office and drug names, the exact vocabulary identity capture keys on (#48) |
| `idle_timeout_ms` | server re-engages a silent caller; re-arms after every response |
| `resumption` | conversation survives a socket drop, 30-minute window |
| `replace` | pronunciation of practice, office and surgeon names |
| `audio.output.speed` | 0.7–1.5 |

`keyterms` and `idle_timeout_ms` are already **typed** in `wireTypes.ts` and
simply never populated.

**And one thing the API cannot give us:** there is no
"wait-for-sustained-speech" parameter. `threshold` (0.85 default, 0.9 ceiling)
is the only barge-in lever and we already run the default. Any hold-off is
local to the bridge. Do not go looking for a session parameter.

## 6. The testing system — it exists, and it has two gaps

**Do not build this from scratch. It is task #23 and it is done.**

`src/runtime/regression/regressionRunner.ts`, driven by
`scripts/run-runtime-regression.ts`. What it does: takes real scored calls from
`call_logs`, replays each one through **`resolveLane`'s real binding** — the
agent's own prompt, the agent's own tools — and scores both the old and new side
with **the same production referee** (`runDeterministicGraders`), the old side
re-graded so grader improvements apply to both identically.

Writes are captured, never executed: `file_*`, `create_ticket`, `submit_*` and
`request_human_handoff` are intercepted at the dispatch seam, the intent
recorded, a simulated success returned. Read tools run for real. Nothing is
filed, nobody is dialled.

That is precisely the instrument Wayne asked for. Two things stop it working
today:

**Gap A — it has no input on `main`.** The runner documents its corpus as coming
from `scripts/build-replay-corpus.ts`. That file is **not on main**. It lives on
the unmerged branch `claude/replay-corpus-builder` (commit `f2ed51c`), and it
imports `src/core/replay/corpusBuilder.ts` — inside `src/core/`, which was
**deleted** on 2026-09-01 (task #66). So the branch cannot be merged as-is; the
builder needs re-homing outside the deleted tree before the harness has a corpus
to chew.

**Gap B — it drives a text model, not the voice model.** The runner says so
itself: same instructions, same tools, but a chat model. Tool selection and
conversation shape are comparable; **prosody, latency, barge-in and
interruption are not measured at all.** Which means the single largest voice
defect we know about cannot be caught by it.

There is also `src/shadow/replayHarness.ts`, an older harness built for the
pipeline that was deleted. It is not the runtime instrument.

## 7. The observatory — built for the wrong agents

Two different things share the name:

- **`docs/observatory/`** — the spec pack. Its own header says
  *"Status: SPEC — nothing here is built unless its checkpoint row says DONE."*
  It scopes itself to "the four Ops Hub voice agents and SAGE."
- **`server/observatory/`** — what is actually built: `queries.ts`,
  `dailyBrief.ts`, `consoleDb.ts`, `fivestarDb.ts`.

The queries key on `agent_id` and `agent_slug` from `call_logs`, so they are not
structurally blind to the queue agents — but nothing in either the spec or the
queries covers the runtime's own signals: lane resolution, readiness refusals,
barge-in counts, force-message delivery, tool latency on the Grok path. That is
the adjustment Wayne is asking for, and it is real work rather than a config
change.

## 8. What gets us to GTM

Ordered. Each item is small and named; none is a rewrite.

**Blocking — the runtime cannot take a real call without these.**

1. **Put volume on optical — the first call is already done.** 2026-08-31, two
   optical calls, both filed, both resolved. The question is not whether the
   runtime functions but whether it holds across a day of real traffic. Optical
   stays the right lane: lowest volume of the four at 37/day, and the only one
   with runtime calls behind it.
2. **Recording disclosure.** Task #54, and compliance. The mechanism already
   exists — `force_message` — and needs `interruptible: false`. The queue TwiML
   on the old core has no `<Say>` at all, so nothing is lost by fixing it here
   first. **The wording is Wayne's and compliance's call, not mine.**
3. **Spanish.** Task #55, reopened — it never worked on any production lane.
   `language_hint` is the right mechanism and is already wired; what is
   undecided is how the runtime establishes the caller's language mid-call
   (task #74).

**Blocking measurement — without these the cutover cannot be judged.**

4. **Re-home the corpus builder** so the regression harness has input (Gap A).
5. **Identity logging and the status callback** (task #57). The forensic found
   patient identity written on **zero of 484 calls**; if the runtime inherits
   that, we cannot tell a good migration from a bad one.
6. **Observatory rows for the runtime** — lane resolution, readiness refusals,
   barge-in, tool latency.

**Should ship with the cutover, not after.**

7. **Medical-safety guardrails on the queue lanes** (task #53). They have none
   today on either pipeline. `agentBinding.ts` already carries guardrails for
   the lanes that declare them; the queue agents declare none.
8. **The teardown sweep** (task #82, AS-04) — 75 lost requests on 09-02, the
   single largest loss of the day, and the runtime should not inherit it.
9. **Trim the queue prompts** (task #25). xAI's own migration guidance is to
   shorten the prompt and strip workaround prompting written for the previous
   model. Our prompts still carry anti-repetition patches built against OpenAI
   Realtime.

**Not blocking, and explicitly not our scope now:** azul-scheduling's office
side channel (#31), the no-ivr on-call hours PR (#32), anything Sage or DRS.

## 9. What this does not answer

- **Which number goes first, and when.** Procedural, Wayne's call.
- **The disclosure wording.** Wayne's and compliance's.
- **Whether the five scaffolding agents get deleted** or kept for testing.
  `runtime-proof` in particular is the lane built to live-test the runtime; it
  has a use even though it serves no patients.

---

## Corrections to this document

**2026-09-03.** The first version said the runtime was "serving nothing" and that
`voice_provider` was "never written." Both were wrong, and Wayne caught them.
The runtime has served two production calls, and `voice_provider` is written —
by the runtime, and only by the runtime. I had read it as a dead column because
it is null on every old-core call, which is the same
absence-is-not-evidence-of-absence trap recorded in
`.agents/memory/measurement-traps.md`.
