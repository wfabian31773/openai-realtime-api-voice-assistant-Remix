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

And for a **queue lane that greets a caller by name** (§6c). These are the
ones readiness does NOT check, which is the trap:

| Variable | Why |
|---|---|
| `TICKETING_SYSTEM_URL` | `ticketingApiClient.ensureInitialized()` THROWS without it. Every queue lane's filing tool depends on that client for the location lookup and the ticket itself, so a cutover that starts without this cannot satisfy its own pass mark on any call. |
| `TICKETING_API_KEY` | same client, same throw. |
| `EYECARE_AGENT_API_KEY` | bearer token for `callEyecareTool`. Without it `sage_precontext` returns an error on every call, so **every caller opens cold** — the agent asks who is calling instead of confirming. |
| `EYECARE_SCHEDULING_BASE_URL` | optional. Defaults to the Vercel deployment; set it only to point at another service. Note the name — `EYECARE_BASE_URL` is a *different* variable, read by the urgent-transfer path, and setting it does nothing here. |

**`computeRuntimeReadiness` does not look at either of these.** It checks
`XAI_API_KEY`, `TWILIO_AUTH_TOKEN` and the database, and nothing else — so a
deployment can satisfy every prerequisite above it, report `liveReady: true`,
boot with both startup lines clean, and still have pre-context dead on every
call. That is deliberate, not an oversight: a missing key degrades the opening
but does not stop the lane taking requests and filing tickets, and refusing
calls over it would be worse. But it means readiness cannot be the thing that
tells you, so **check the key before the cutover, not after the first cold
call.** Raised by Codex on #239.

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

**Do not read this test's timings as a lane's timings.** The first lane
resolved pays a one-time cost that is not its own — `defaultLaneSource()`
opens the config read, so whoever goes first absorbs the connect. Against a
dummy `DATABASE_URL` that is a ~2s connection timeout, which can exceed
vitest's default 5s per-test limit and make a perfectly healthy lane look
broken. Verified by control rather than assumed: run `surgery` alone with
`-t "surgery builds"` and it takes the same ~2.1s when it goes first. Use
`--testTimeout=30000`, or a real `DATABASE_URL`, before concluding anything
about a lane from this test's clock.

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

## 6c. The queue-lane cutover — Optical first

§6b proves the warm transfer. It proves **nothing** about `optical`,
`surgery`, `tech`, `records` or `answering-service`: those lanes hold no
transfer tool at all (standing instruction 9), so not one of those six calls
touches a line of code they run. Their question is a different one — does the
agent take the request, and does the ticket land?

Optical goes first, deliberately. It is forwarded overflow rather than a
primary line, it is the queue the operator described as working like a charm,
and it carries enough volume (dept 1, ~1,744 tickets/90d) that a regression
shows up the same day. Survivable and immediately obvious is what you want
from the first lane to move.

### Check pre-context BEFORE anything else

This is the one that decides whether Optical still sounds like Optical. On the
SIP path the agent knows who is calling and **confirms** — "Am I speaking
with…?" — instead of asking cold. On this runtime that opening depends on a
lookup that can fail silently three different ways:

`server/index.ts` wires `fetchPrecontext` to `fetchAzulPrecontext`, which is an
**HTTP call** — `callEyecareTool('sage_precontext')` against
`EYECARE_SCHEDULING_BASE_URL` (which has a default) with
`EYECARE_AGENT_API_KEY` (which does not; see §2). The runtime bounds it at
1.5s and drops it if slower, and `fetchAzulPrecontext` normalizes every
failure to `null`. So the agent asks cold for several different reasons.

**The returned value is indistinguishable; the logs are not.** `callEyecareTool`
says which it was, and this is the first thing to grep when an opening goes
cold:

```
[AZUL-SCHED] EYECARE_AGENT_API_KEY is not set          ← unset key
[AZUL-SCHED] sage_precontext HTTP <status>: <body>     ← service returned non-OK
[AZUL-SCHED] sage_precontext failed: <message>         ← fetch, abort or timeout
```

401/403 take a richer path (`noteAuthFailure`, with a count and an outage
alarm) rather than that middle line. **Only one mode is genuinely quiet:** the
lookup that succeeds but arrives after the runtime's 1.5s deadline. Nothing
logs that from the runtime side — the call simply proceeds without
pre-context.

**A cold greeting with no error lines is NOT proof of a deadline miss.** The
commonest reason for a cold open is the most ordinary one: the lookup ran,
returned, and found nothing to stand behind. `fetchAzulPrecontext` returns any
response carrying a boolean `matched`, `{ matched: false }` included, and
`buildOpticalPrompt` deliberately opens cold for that — an ambiguous number
(Wayne's own resolves to eight records) or a shared family line produces
exactly the symptom a timeout does, with nothing wrong anywhere. Reading
silence as lateness will send you chasing a deadline that was never missed.
Raised by Codex on #239.

**How to tell, in one call.** Steps 2–4 need a log line that ships with the
greeting change (`voiceRuntime.ts`). **Check for it first** — grep one call
for `[runtime] pre-context`. Present, use the full procedure. Absent, you are
on an older build: skip to *Without that line*, below, and expect less.

1. Dial from a number that exists in the mirror. If the agent opens by
   confirming a name, pre-context worked and you are done. **This step needs
   no telemetry** and it settles the positive case on any build.
2. If it asks who you are, **read the outcome the runtime logged.** One line
   per call, and it is the only thing that separates the three cases — they
   all reach the runtime as the same `null`, so neither the greeting nor
   `si_persons` can tell you which happened. `si_persons` shows what data
   exists, not what this request returned:

   ```
   [runtime] pre-context optical <callSid>: recognised
   [runtime] pre-context optical <callSid>: no_match (ran, vouched for nobody …)
   [runtime] pre-context optical <callSid>: unavailable (failed or past the 1.5s deadline …)
   ```

3. **`no_match` means nothing is wrong.** The lookup ran and would not vouch
   for the number — ambiguous, shared, or absent. A cold open is the correct
   behaviour and there is nothing to fix. Stop here.
4. **`unavailable`** is the only case worth digging into. Now the
   `[AZUL-SCHED]` lines above tell you which: an unset key, an HTTP status,
   or a fetch failure. If none of them appear, the 1.5s deadline is what is
   left — that is the one mode nothing logs from the runtime side.

**Without that line** — an older build — say what you can and no more, rather
than guessing:

- A cold open still tells you nothing on its own. Do not read it as a
  timeout; `no_match` is the commoner cause and it looks identical.
- The `[AZUL-SCHED]` lines still separate an unset key, an HTTP status and a
  fetch failure. If one is present, that is your answer and it is complete.
- **A third mode is silent too:** HTTP 200 carrying a body we cannot use.
  `fetchAzulPrecontext` wraps the whole thing in a bare `catch { return
  null }`, so a `JSON.parse` failure vanishes, and a parsed body whose
  `matched` is not a boolean returns `null` as well. `callEyecareTool` logs
  nothing for either — it saw a 200. A service-contract break therefore
  looks exactly like a valid negative. If the service log shows a 200
  answered inside 1.5s and the agent still opened cold, read the response
  BODY before concluding the number simply did not match. Raised by Codex
  on #239.
- If none of that is present, the remaining two — a valid `no_match` and a
  lookup that answered too late — are **not distinguishable from this side.** Only
  the Eye Care service's own log separates them, and **a request entry alone
  does not.** `withinOrNull` races a timer against the lookup and does not
  cancel it, so a request that took 3s still reaches the service, is still
  logged, and still answers — into a call that gave up at 1.5s. You need the
  entry's **outcome and its latency**: answered `matched: false` inside 1.5s
  is a real negative; answered at all beyond 1.5s is a deadline miss no
  matter what it returned. Request presence at the right timestamp is
  consistent with both. Raised by Codex on #239.
- Do not block the cutover on it either way. Pre-context decides whether the
  agent greets by name; it does not decide whether the request is taken or
  the ticket lands, and those are the pass mark below.

Raised by Codex on #239, twice: first that the diagnosis pointed at
`si_persons`, which answers a different question, and then that steps 2–4
were being required on a build that did not yet carry the telemetry.

The durable fix is to read the mirror directly. `patients_master` is mirrored
in the Patient-Console project precisely so this is a fast indexed read, and
`src/services/patientVerification.ts` already reads it and already refuses to
guess between two people. Routing every lane's caller-ID lookup through
azul-scheduling's HTTP tool is both slower and a dependency the queue lanes do
not otherwise have. Not done yet; operator's call on whether it lands before or
after the first cutover.

### Two calls, on a spare number

Point a number you do not mind breaking at `POST https://<host>/voice/optical`
— **not** the live optical number.

1. **An ordinary optical request.** Give a name and date of birth, ask about a
   glasses or contacts order. Watch for: does it find the patient, take the
   request, and say it is filing something?

   **Pick this caller deliberately, and know what the call can and cannot
   prove.** `lookup_patient` still goes to `scheduleLookupService`, which
   queries the Operations Hub `schedule` table — so this step does **not**
   exercise the Console mirror, whatever standing instruction 14 says should
   happen eventually. Two consequences:

   - Use someone with **real appointment history**. A patient who exists only
     in `patients_master` will fail this lookup, and that failure is the known
     pre-existing gap, not a runtime defect. Chasing it during a cutover
     wastes the window.
   - A caller present in *both* the mirror and the schedule will appear to
     pass **without proving anything about which source answered.** So treat a
     green result here as "the tool ran and the ticket landed", never as
     "verification is on the mirror". It is not, yet.
2. **A request this queue does not own.** Ask to schedule an appointment. It
   must take the request and route it to the HVA Hub. It must not tell you to
   call back or send you to another extension (standing instruction 10). A
   surgery *date* is the one exception to the HVA Hub rule.

On the **old core** (not this Grok runtime), hangup without `file_*_ticket`
is no longer a silent loss: `sweepQueueUnfiledCall` files from conversation
state for optical / surgery / tech / records. This runbook is the Grok
wire. That sweep is not wired here. A Grok hangup that never called the
filing tool is still a miss on this path.

### The pass mark is the ticket, not the conversation

A call that sounds good and files nothing is a failure. A stilted call that
files correctly is a pass. After each:

| check | where |
|---|---|
| **`file_optical_ticket` ran, and succeeded** | `tool_timeline` for that callSid |
| **the ticket's `created_at` is AFTER this call started** | ticketing vs `call_logs.start_time` |
| a ticket exists, **in the department the request belongs to** | ticketing |
| patient name, DOB and location are right | the ticket |
| the callback number is the one you gave | the ticket — standing instruction 12 |
| outcome is not `dead_air` or `provider_failure` | `call_logs` — see §6 |

**The first two rows are the ones that matter, and they are first because
the weaker version of this table passed the exact failure described below.**
"the tool timeline is populated" is satisfied by a timeline holding
`lookup_patient`, `classify_optical_request` and `check_open_tickets` and no
filing at all. Worse, every remaining row can be satisfied by a ticket from
an EARLIER call: `check_open_tickets` hands the agent a real ticket number
with the right name, the right location and the right callback number, and
`update-call-data` then stamps this call's `call_sid` onto it — so the
record looks like this call's work. Naming the tool and comparing the
timestamps are what cannot be faked. Raised by Codex on #239.

**Which department is per call, not a constant.** Call 1 (the optical request)
files on **department 1**. Call 2 (the scheduling request) is *supposed* to
leave the queue: `detectCrossQueue` routes it to the **HVA Hub, department 9**,
and `file_optical_ticket` sends that routed department — standing instruction
10. Expecting department 1 after both calls marks the correct behaviour as a
cutover failure, which is the kind of mistake that gets a good deploy rolled
back. Raised by Codex on #239, and confirmed live the same morning: VA-56007
filed on department 1, VA-56008 on department 9, both assigned, both correct.

The dangerous case is an empty tool timeline on a call that sounded fine: the
model talked its way through without calling `file_optical_ticket`, and the
caller was told something that did not happen. That is invisible from the
audio and obvious from the row.

### Before you dial: clear the test numbers

**Both test numbers must start with NO open ticket, and a different number
per call.** `check_open_tickets` searches by phone alone, across every
department, and the optical prompt says: *"If they already have one open,
tell them where it stands instead of opening a second."*

So the agent correctly files nothing when the caller already has an open
request — and the mandatory `file_optical_ticket` check below then fails on a
deployment that is working perfectly. Two different numbers is not enough on
its own: it only rules out call 1 colliding with call 2, not a ticket either
number was already carrying.

**`check_open_tickets` does NOT read the ticketing system.** This matters more
than it sounds, and the first version of this section got it wrong. It calls
`SyncAgentService.checkOpenTickets`, which reads the last ten **completed
Operations Hub `call_logs`** rows for the number and counts a ticket as open
when the row has a `ticket_number`, a NULL `ticketing_synced_at`, and is less
than seven days old. `tickets.status` is never queried. So closing a ticket
in the Support Center does not necessarily clear the condition, and a ticket
that is genuinely open can be invisible to it.

Query the state the tool actually reads:

```sql
-- Operations Hub, per test number
select ticket_number, agent_used, created_at, ticketing_synced_at
from call_logs
where (right(regexp_replace(coalesce("from",''),'\D','','g'),10) = '<10 digits>'
    or right(regexp_replace(coalesce("to",''),'\D','','g'),10) = '<10 digits>')
  and status = 'completed'
  and created_at > now() - interval '7 days'
order by created_at desc limit 10;
```

Any row with a `ticket_number` and a NULL `ticketing_synced_at` will suppress
filing. None, and the number is clear whatever the Support Center shows.
Raised by Codex on #239, correcting a query in this document that pointed at
the wrong system entirely.

**If you do call with a ticket already open**, the pass mark is different and
you should know which test you are running: the agent should *report the open
ticket and not file a second one*. That is correct behaviour and worth
seeing — but it proves nothing about filing, so it does not substitute for
the calls below. Raised by Codex on #239, twice.

**This is not hypothetical, and it is worth reading precisely.** On
2026-08-31 an optical call ran `lookup_patient > lookup_patient >
classify_optical_request > check_open_tickets` with no `file_optical_ticket`,
then said "I've logged your request as ticket VA-56007" — a ticket filed by
an earlier call from the same number, sixteen minutes before.

The agent was **not** inventing a ticket. It was obeying the rule above, and
the tool chain did what it is written to do. Two things around it are wrong:
the wording ("I've logged your request") describes filing when it is
reporting, so it is indistinguishable from a fabrication on the audio; and
the end-of-call `update-call-data` post then overwrote that older ticket's
`call_sid` with this call's, destroying its link to the call that really
created it. So the record came to agree with the misleading sentence.

The lesson for this table is the timing check, not suspicion of the agent:
compare the ticket's `created_at` against `call_logs.start_time` before
believing a `call_sid`.

### Then, and only then, the live number

Move the live optical webhook to `/voice/optical` and watch the first hour.
Keep the old core's webhook to hand — reverting is changing one URL back, and
knowing that in advance is what makes the cutover cheap.

After Optical, one lane at a time, same shape with that queue's own request
type. `surgery`, `tech` and `records` already resolve clean (§4). `no-ivr` and
`pcp` need §6b first, because they do transfer and those six calls are exactly
the code they add.

## 7. What is not covered

- **`azul-scheduling` still cannot transfer** — see §3. Scheduling for San
  Diego is not part of this and is unchanged.
- **The runtime writes no tool timeline.** The agents' own telemetry does,
  into the row the runtime opens at call start.
- **Identity columns** are written only when the runtime is told; it never
  infers a patient from a tool result.
- **Caller-ID pre-context** is fetched and passed, bounded at 1.5s, and
  dropped if slower. A match is a candidate to confirm, never an identity.
  It currently goes through azul-scheduling's `sage_precontext` HTTP tool
  rather than a direct read of the `patients_master` mirror, and a slow
  service, a stale `EYECARE_AGENT_API_KEY` and a thrown error all degrade to
  the same silent `null` — the agent asks cold and nothing says why. See §6c
  for how to tell in one call, and why the mirror is the durable answer.

## 8. If the first call goes wrong

1. Check the marker on `/voice/health` before anything else.
2. Read the recorded outcome, not the impression.
3. If `provider_failure`, look for `provider setup timed out` — that is the
   handshake, not the agent.
4. Put the failing utterance into an offline test before changing code.
   `src/runtime/voiceRuntime.test.ts` drives a whole call with fake sockets
   on both sides; a real failure should be reproducible there first.
