# Voice runtime — putting a lane live

The runtime (`src/runtime/`) answers a Twilio call on `POST /voice/:slug` and
runs an existing agent on the Grok wire. This is what to do to put a lane on
it, and how to tell what happened.

**Read this first: no live Grok call has ever been made on this runtime.**
Every claim below is proven offline against fake sockets, plus one real
resolution of the agents through their own registry. The wire itself is a
port of the 5Star provider, which does carry live calls — but the first call
on *this* runtime is genuinely the first, and should be treated that way.

---

## 1. Before anything: is the build live?

```
GET /voice/health
```

```json
{"marker":"voice-runtime-v2-transfer-guardrails-tools","knowledgePack":"v1",
 "liveReady":true,"missing":[],"requiredDbEnvVar":"DATABASE_URL","activeCalls":0}
```

**If it still says `voice-runtime-v1-bridge-and-binding`, the pull did not
take.** v1 has no warm transfer, no guardrails and no registered tools —
every transfer test below would fail for that reason alone and prove nothing
about the code.

- **`marker` absent or old** → the code is not live and nothing you observe
  proves anything. This is the failure that cost a round on 2026-08-11: a
  pull that silently failed looks exactly like a fix that did not work.
- **`liveReady: false`** → `missing` names the env vars, by NAME only. The
  webhook fails closed until they are set: the caller hears a controlled
  line, never dead air, and never a half-configured call.
- **`knowledgePack`** identifies the shared cached prefix. If the fleet's
  cache-hit rate moves, check whether this changed before looking anywhere
  else.

## 2. What has to be set

| Variable | Why |
|---|---|
| `XAI_API_KEY` | the Grok connection. Nothing can take a call until it is set. |
| `TWILIO_AUTH_TOKEN` | webhook signature checking, **and** the transfer-accept webhook's signature. Without it every request is refused and every office keypress is rejected. |
| `DATABASE_URL` (or `PRODUCTION_DATABASE_URL` in production) | the agents' tools and the call record. |

Additionally, for a lane that can **transfer** (§3). Missing any of these does
not break ordinary calls — the transfer-capable lanes simply keep being
refused, with the reason logged at mount:

| Variable | Why |
|---|---|
| `TWILIO_PHONE_NUMBER` | the number the office leg is dialled *from*, and the caller ID on the bridge. |
| `DOMAIN` (or `REPLIT_DOMAINS`) | builds the accept/status webhook URLs Twilio posts the keypress to. A localhost resolution yields no domain and transfers stay refused. |
| `HUMAN_AGENT_NUMBER` | destination for the **clinical** policy — the no-IVR family. |
| `PCP_HUMAN_AGENT_NUMBER` | destination for the **pcp** lane's queue. |

Numbers are read from env by policy; **the model never supplies a number.**

Optional, per lane: `XAI_VOICE_NAME_<SLUG>`, `XAI_VOICE_LANGUAGE_<SLUG>`.
The registry's `voice` field is **not** used — it holds OpenAI voice names
(`sage`), which Grok does not have.

## 3. Which lanes this can serve

**Served without transfer:** `optical`, `surgery`, `tech`, `records`,
`answering-service`. These get **no transfer tool at all** — not a disabled
one. A tool the agent cannot see is a promise it cannot make (standing
instruction 9).

**Served WITH warm transfer**, once the §2 transfer variables are set:
`no-ivr`, `no-ivr-v2`, `dev-no-ivr`, `pcp`.

**Refused, and why:**

| lane | reason |
|---|---|
| `azul-scheduling` | its transfer reads a per-call side channel (`registerAzulOfficeTransferCallback`) that only the old routes populate. Serving it through the factory handoff alone would turn **every ordinary scheduling transfer** into `transfer_unavailable` and a callback ticket. Wiring that side channel is the next piece of work, not a config toggle. |
| `after-hours` | its factory takes a different argument layout that this runtime does not model |
| `drs-scheduler`, `appointment-confirmation`, `fantasy-football` | outbound agents |

A refused lane answers with the controlled unavailable line and logs
`[voice-runtime] <reason>`. It never falls back to a different agent — a
surgery caller must not land in the optical prompt.

## 4. Pre-flight, before pointing a number

```
RUNTIME_LANE_SMOKE=1 npx vitest run src/runtime/realLanes.test.ts
```

Resolves each served lane through the real `src/config/agents.ts` and checks
what Grok would actually be sent: a Grok voice, a real prompt with the
knowledge pack in front, real tools that all convert, none skipped, no strict
mode. Needs `DATABASE_URL` and `OPENAI_API_KEY` present (any value — it makes
no calls).

Expected today:

```
optical: OK voice=eve tools=5 promptChars=14464 skipped=0
surgery: OK voice=eve tools=5 promptChars=19861 skipped=0
tech: OK voice=eve tools=5 promptChars=15348 skipped=0
records: OK voice=eve tools=5 promptChars=16373 skipped=0
answering-service: OK voice=eve tools=5 promptChars=33656 skipped=0
```

`skipped` must be `0`. A skipped tool is a promise the agent cannot keep.

## 5. Pointing a number

Set the number's Voice webhook to `POST https://<host>/voice/<slug>`.
Nothing else. The runtime answers with `<Connect><Stream>` plus a
`<Redirect>` to `/voice/<slug>/after`, which speaks a controlled line if the
runtime itself failed and hangs up cleanly otherwise.

Start with **one** number on **one** lane, and prefer a queue that is
forwarded rather than a primary line.

## 6. Reading the first call

Every call records exactly one outcome, visible in `call_logs`:

| outcome | what it means |
|---|---|
| `caller_hangup` | normal — the caller ended it |
| `agent_ended` | the agent's own hangup tool ran, its guards allowed it, and the goodbye was confirmed played |
| `completed` | the final line played and the stream closed |
| `dead_air` | **ours** — nothing was owed to the caller for 30s. Look at the transcript's last line |
| `provider_failure` | **ours** — the Grok session errored, closed, or never finished its handshake |
| `max_duration` | the 10-minute ceiling. Should be rare; if it is not, something is not ending calls |

`dead_air` and `provider_failure` are the two the runtime caused. Both make
the post-stream TwiML speak the technical-trouble line, so the caller is told
something rather than cut off silently.

Log lines worth grepping:

```
[voice-runtime] provider setup timed out for <callSid>
[voice-runtime] no available lane for slug <slug>
[voice-runtime] call setup failed for <callSid>: <message>
[voice-runtime] <slug>: tools not offered — <name> (<reason>)
[voice-runtime] refused a stream with no valid claim
```

The transcript marks a line the caller only partly heard as
`AGENT: … [interrupted]`. An agent line appears **only** once Twilio confirms
it played, so the record never claims words the caller did not hear.

## 6b. The warm-transfer test calls

Six calls, in this order. **Use a test number and a destination phone whose
owner is expecting the call** — every one of these rings a real handset.

Set `HUMAN_AGENT_NUMBER` to the destination and point a Twilio number at
`POST https://<host>/voice/no-ivr`. The no-IVR (clinical) policy is the one
to test first: unlike `pcp` it has **no lunch-closure gate**, so it behaves
the same at any hour.

**Tell whoever holds the destination phone, before you start: they must
press a key to accept. Silence is a decline, by design.** Answering and
saying "hello" does nothing — that is deliberate, because answering machines
say hello too, and AMD guessing wrong is what hung up on live people on the
first PCP transfers.

| # | What to say | What must happen |
|---|---|---|
| 1 | *"I need to change my appointment next week."* | No transfer offered. Agent takes the request and files it. Proves the ordinary path still works before any transfer is involved. |
| 2 | *"I'm having sudden vision loss in my right eye."* | Agent escalates → destination rings → **press 1** → both of you are bridged and can talk. Outcome recorded as `transferred`. |
| 3 | Same as 2 | Answer, then **press nothing** and stay on the line. After the briefing repeats, the agent must come back and take a message. It must **not** say "connecting you now." |
| 4 | Same as 2 | **Do not answer at all.** After ~45s ringing the agent comes back, says it could not reach anyone, and files a callback request. |
| 5 | Same as 2, then **hang up while the destination is still ringing** | The destination phone must **stop ringing** promptly. Nobody should be able to answer into a call that no longer has a caller. |
| 6 | Interrupt the agent mid-sentence, talking over it | It stops speaking immediately and listens. The transcript records the cut-off line as `[interrupted]`. |

Calls 3, 4 and 5 are the ones that matter most. A transfer that works is
easy; the whole design exists so that a transfer that *fails* leaves the
caller with the agent rather than alone in an empty conference — which is
what took the PCP line offline.

Log lines that tell the story:

```
[runtime-xfer] office leg <sid> ringing <number>; caller still with the agent
[runtime-xfer] keypress accept on <sid>
[runtime-xfer] caller <sid> redirected into runtime_xfer_<sid>
[runtime-xfer] <sid> settled as declined|timeout|abandoned
[runtime-xfer] caller <sid> ended; abandoning office leg <sid>
```

Call 2 should end as `transferred` in `call_logs` with `transferred_to_human`
set. Calls 3 and 4 should end normally with a ticket filed — **not** as
`dead_air`. If you see `dead_air` on a transfer attempt, that is a real bug:
tell me the callSid rather than re-dialling.

## 7. What is not covered

- **`azul-scheduling` still cannot transfer** — see §3. Scheduling for San
  Diego is not part of this and is unchanged.
- **The runtime writes no tool timeline.** The agents' own telemetry does,
  into the row the runtime opens at call start.
- **Identity columns** are written only when the runtime is told; it never
  infers a patient from a tool result.
- **Caller-ID pre-context** is fetched and passed, bounded at 1.5s, and
  dropped if slower. A match is a candidate to confirm, never an identity.

## 8. If the first call goes wrong

1. Check the marker on `/voice/health` before anything else.
2. Read the recorded outcome, not the impression.
3. If `provider_failure`, look for `provider setup timed out` — that is the
   handshake, not the agent.
4. Put the failing utterance into an offline test before changing code.
   `src/runtime/voiceRuntime.test.ts` drives a whole call with fake sockets
   on both sides; a real failure should be reproducible there first.
