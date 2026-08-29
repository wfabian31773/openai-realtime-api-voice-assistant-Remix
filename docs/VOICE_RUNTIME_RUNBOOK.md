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
{"marker":"voice-runtime-v1-bridge-and-binding","knowledgePack":"v1",
 "liveReady":true,"missing":[],"requiredDbEnvVar":"DATABASE_URL","activeCalls":0}
```

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
| `XAI_API_KEY` | the Grok connection. **Not set today** — nothing can take a call until it is. |
| `TWILIO_AUTH_TOKEN` | webhook signature checking. Without it every request is refused. |
| `DATABASE_URL` (or `PRODUCTION_DATABASE_URL` in production) | the agents' tools and the call record. |

Optional, per lane: `XAI_VOICE_NAME_<SLUG>`, `XAI_VOICE_LANGUAGE_<SLUG>`.
The registry's `voice` field is **not** used — it holds OpenAI voice names
(`sage`), which Grok does not have.

## 3. Which lanes this can serve

**Served:** `optical`, `surgery`, `tech`, `records`, `answering-service`.

**Refused, and why:**

| lane | reason |
|---|---|
| `no-ivr`, `no-ivr-v2`, `dev-no-ivr`, `azul-scheduling`, `pcp` | their agents perform a real call transfer; this transport cannot do one yet |
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

## 7. What is not covered

- **No call transfer.** That is what keeps `no-ivr` and `pcp` off this
  runtime, not a configuration choice.
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
