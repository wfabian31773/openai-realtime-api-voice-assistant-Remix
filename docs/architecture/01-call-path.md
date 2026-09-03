# 01 — The call path: phone ringing → ticket existing

Traced 2026-09-01 by reading the source, not by watching a call. Spine is
**OPTICAL** (department 1, the intended first runtime cutover). Every claim
carries a `file:line`. Paths are relative to the repo root they name:

- `openai-realtime-api-voice-assistant-Remix/` — the voice agents (unprefixed below)
- `ticketing-app/` — the Next.js app the agents file into (prefixed `ticketing-app/`)

> **Superseded in part, 2026-09-01 (later the same day).** `src/core/` and
> `src/standalone/` were deleted — the two unreachable voice pipelines this
> survey identified. Two live paths remain: the OpenAI SIP path
> (`src/voiceAgentRoutes.ts`) and the Grok runtime (`src/runtime/`). Every
> `src/core/…` or `src/standalone/…` path and line number below is historical
> and no longer resolves.

This is a map. No recommendations, no fixes. Where a fact could not be
determined from the source it is written `UNKNOWN —` with what would settle it.

---

## 0. There are TWO transports, and only one of them takes calls today

| | Live SIP path | Grok runtime path |
|---|---|---|
| Entry | `POST /api/voice/optical` → `src/voiceAgentRoutes.ts:6258` | `POST /voice/optical` → `src/runtime/voiceRuntime.ts:428` |
| TwiML | `<Dial><Conference>` — `src/voiceAgentRoutes.ts:6186-6207` | `<Connect><Stream>` + `<Redirect>` — `src/runtime/voiceWebhook.ts:222-229` |
| Audio | Never touches our servers. Twilio → conference → SIP → `sip.api.openai.com` | Twilio Media Streams WebSocket → our process → xAI |
| Process | voice server, `src/server.ts` (port `VOICE_AGENT_PORT ?? 8000`) | API server, `server/index.ts` (port 5000), mounted at `server/index.ts:409` |
| Model | `gpt-realtime` — `src/voiceAgentRoutes.ts:798` | Grok — `src/runtime/config.ts` |
| Status | LIVE (CLAUDE.md line-status table) | Mounted unconditionally; no number points at it |

**Everything from §1 to §7 traces the LIVE SIP path.** §8 records where the
runtime path differs. The existence of two complete transports, each with its
own greeting resolution, pre-context fetch, dead-air watchdog, call-log write
and teardown, is the largest single duplication in the system.

### 0a. The proxy in front of the voice server

`server/index.ts:49` mounts a hand-rolled streaming proxy: everything under
`/api/voice` on port 5000 is forwarded to `localhost:8000` with all non-hop-by-hop
headers preserved (`server/index.ts:54-67`), specifically so Twilio/OpenAI
signature material survives. Registered **before** any body parser
(`server/index.ts:33`) so raw bodies are intact.

- **Reads**: `req.headers`, `req.originalUrl`. Hardcoded `localhost:8000`.
- **Fails**: 30s timeout (`server/index.ts:76`); on proxy error it answers **HTTP 200
  with apology TwiML + `<Hangup/>`** (`server/index.ts:95-108`), because Twilio
  treats any 5xx as a failure regardless of body. Visible: `[PROXY] Error after Nms`.
- **Speaks HTTP only.** It cannot forward a WebSocket upgrade — the stated reason
  the demo line (`server/index.ts:384`) and the Grok runtime (`server/index.ts:409`)
  mount on the API server instead.

---

## 1. Twilio hits the webhook

**Route**: `POST /api/voice/optical`, registered by the `registerOverflowLine`
factory at `src/voiceAgentRoutes.ts:6258-6266`; the handler body is shared and
lives at `src/voiceAgentRoutes.ts:6138-6245`.

Middleware, in order:
- `noCacheHeaders` on all of `/api/voice` — `src/voiceAgentRoutes.ts:5064`
- `webhookRateLimiter` — `src/voiceAgentRoutes.ts:6138`; config at
  `src/middleware/rateLimiter.ts:101-106` (500 req / 60s, keyed
  `path:clientIp`, in-memory `Map` swept every 60s at
  `src/middleware/rateLimiter.ts:20-27`).
- Body is a raw `Buffer` (`src/server.ts:38`, `bodyParser.raw({type:"*/*"})`),
  so the handler does `req.body.toString("utf8")` +
  `new URLSearchParams(...)` — `src/voiceAgentRoutes.ts:6139-6140`.

**No Twilio signature validation on this route.** `X-Twilio-Signature` is never
checked on any `/api/voice/*` webhook in this file. (The Grok runtime does check
it — `src/runtime/voiceWebhook.ts:132-148`. That asymmetry is a finding, not a
recommendation.)

Reads from the POST body (`src/voiceAgentRoutes.ts:6142-6145`): `CallSid`,
`CallToken`, `From`, `To`.

### 1a. Validation

`src/voiceAgentRoutes.ts:6149-6156`.
- Missing `CallSid` or `From` → HTTP 400 `<Response><Say>Invalid request</Say></Response>`.
  Logged — but note the log line is single-quoted, so it prints the literal
  `[${opts.tag}]` rather than `[OPTICAL]` (`src/voiceAgentRoutes.ts:6150`). Same
  defect at `:6155` and `:6227`.
- Missing `CallToken` → warn only, continues with `''`.

### 1b. In-memory maps written before the TwiML is sent

`src/voiceAgentRoutes.ts:6162-6166` — five plain objects keyed by
`conferenceName = "conf_" + CallSid` (`:6159`):

```
callIDtoConferenceNameMapping[callSid]        = conferenceName
ConferenceNametoCallerIDMapping[conf]         = From
ConferenceNametoCalledNumberMapping[conf]     = To
ConferenceNametoCallTokenMapping[conf]        = CallToken
conferenceNameToTwilioCallSid[conf]           = callSid
```

Then `callMetadata.set(conferenceName, {...})` at
`src/voiceAgentRoutes.ts:6169-6180` carrying `agentSlug: 'optical'`,
`agentGreeting` (the hardcoded string at `:6262-6265`), `language: 'english'`,
`voiceForCall: 'sage'`, `languageForCall: 'en'`.

- **Fails**: nothing here can fail. But every one of these is **process-local**.
  If the OpenAI webhook (§2) lands on a different instance, all of it is lost;
  only the slug survives, via the SIP header. The greeting rescue at
  `src/voiceAgentRoutes.ts:4400-4420` exists precisely for that loss.
- **Duplicated**: the same job is also done durably by `callSessionService`
  (`src/services/callSessionService.ts:21-24`, Postgres-backed), read through
  the wrapper functions `getConferenceName` / `getCallerNumber` /
  `getTwilioCallSid` / `getCallIdByConference` / `getCalledNumber`
  (`src/voiceAgentRoutes.ts:396-451`). Two stores, legacy-first.

### 1c. The TwiML returned

`src/voiceAgentRoutes.ts:6186-6210`:

```xml
<Response>
  <Pause length="1"/>
  <Dial>
    <Conference beep="false" waitUrl=""
      startConferenceOnEnter="true" endConferenceOnExit="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${DOMAIN}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${DOMAIN}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST">
      conf_${CallSid}
    </Conference>
  </Dial>
</Response>
```

- **Conference, not Connect/Stream.** No `<Stream>` anywhere on this path.
- `waitUrl=""` — a caller alone in the conference hears **silence**, not hold music.
- `record="record-from-start"` — recording is conference-level; the URL arrives
  later at `/api/voice/recording-status` (§7d).
- **Call-level status callback is NOT set here.** It is configured on the Twilio
  number itself; `twilio-inventory.md:68` shows `+19094135645` (answering-service)
  pointing at `.../api/voice/status`. **UNKNOWN —** whether the optical DID has
  the same Status Callback configured; `twilio-inventory.md` has no optical entry
  and `agentRegistry` carries `twilioNumbers: []` for optical
  (`src/config/agents.ts:112`). Settling it needs the live Twilio console or a
  fresh inventory dump.
- `DOMAIN` comes from `process.env.DOMAIN || req.get('host')`
  (`src/voiceAgentRoutes.ts:6158`). With `DOMAIN` unset behind the proxy this
  resolves to the proxied host.

### 1d. Adding the AI to the conference

`src/voiceAgentRoutes.ts:6213-6244`, **after** the TwiML has already been sent
(`:6209-6210`).

1. Lazily init the Twilio client (`getTwilioClient()`, `:6215`). Failure →
   `console.error` and `return`. The caller is now alone in a silent conference.
2. `twilioClient.conferences(conferenceName).participants.create({...})` at
   `:6230-6240`:
   - `from: envConfig.twilio.phoneNumber` (`TWILIO_PHONE_NUMBER`)
   - `label: 'virtual agent'`
   - `to: sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=…&X-CallerPhone=…&X-agentSlug=optical`
   - `earlyMedia: true`, `callToken: <webhook CallToken or ''>`
   - `conferenceStatusCallback: https://${domain}/api/voice/conference-events`,
     events `['join']`

- **Reads env**: `OPENAI_PROJECT_ID`, `TWILIO_PHONE_NUMBER`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN` (via `src/lib/twilioClient.ts`), `DOMAIN`.
- **Fails**: `catch` at `:6242-6244` logs `[OPTICAL] ✗ Failed to add agent to
  conference` and returns. **Nothing retries.** The caller sits in a silent
  conference until they hang up or the Twilio conference dissolves.
- **Duplicated, and divergently.** `/api/voice/no-ivr` does the same job through
  `addSIPParticipantWithWatchdog` (`src/voiceAgentRoutes.ts:583`, called at
  `:5791`), which gives it a 15s connect watchdog with retries
  (`:745`), a per-agent max-duration ceiling (`:750-754`), and a spoken fallback
  (`:711-735`). **The overflow factory has none of that** — no watchdog entry is
  ever created for an optical call, so `sipWatchdogs` is empty for it and both
  `cancelSIPWatchdog` (`:5284`) and `releaseSIPWatchdog` (`:7526`) are no-ops.

---

## 2. How the agent is chosen

The slug is decided **three times**, from three sources, with three different
allowlists.

### 2a. First decision — the URL

`/api/voice/optical` → `opts.slug = 'optical'`, hardcoded at
`src/voiceAgentRoutes.ts:6260`. It is stamped into (a) `callMetadata`
(`:6170`) and (b) the SIP URI as `X-agentSlug` (`:6235`). This is the only
mapping that matters in the normal case: **one queue, one number, one webhook,
one slug** (the factory's own doc comment, `:6116-6131`; operator standing
instruction 11).

### 2b. Second decision — the OpenAI webhook

`POST /api/voice/realtime`, `src/voiceAgentRoutes.ts:5071`. No rate limiter, no
Twilio validation; OpenAI's own signature is verified at
`src/voiceAgentRoutes.ts:5102-5106` with `openai.webhooks.unwrap`.

- **Fails**: verification failure falls into a manual HMAC recompute
  (`:5117-5135`) that will *accept the event* if the manual check passes
  ("SDK bug?"); otherwise 401. Every branch logs, including the full header dump
  (`:5132`, `:5138`, `:5144`).
- Event type must be `realtime.call.incoming` (`:5152`); no `call_id` → treated
  as an OpenAI dashboard test and acked (`:5165-5169`).
- Duplicate suppression: `activeCallTasks.get(callId)` (`:5172-5176`).

SIP header parsing at `:5193-5258` pulls `X-conferenceName`, `X-CallerPhone`,
`X-agentSlug`, `X-contactId`, `X-campaignId`, `X-Environment`, `To`, `From`.
Environment mismatch is **logged loudly and processed anyway** (`:5322-5336`).

Slug resolution, in order (`:5342-5424`):
1. `X-agentSlug` from SIP (`:5360-5368`) — the reliable path, works across instances.
2. `callMetadata.get(conferenceName)?.agentSlug`, gated by the allowlists
   (`:5371-5397`). The comment at `:5375-5387` records that this block used to
   enumerate four literals and silently dropped `optical` through to
   `after-hours`.
3. Phone-number lookup `storage.getAgentByPhoneNumber(To)` **raced against a
   500 ms timeout** (`:5411-5415`) — a cold Neon connection loses that race and
   the call keeps the default.
4. Default `'after-hours'` (`:5357`).

Final validation `:5467-5488`: if the slug is not in
`validInboundAgents ∪ validOutboundAgents` (`:5353-5354`) it is coerced to
`after-hours`, unless `storage.getAgentBySlug()` says it is an active DB agent.

- **Reads**: `agents` table (Operations Hub) via `server/storage.ts`.
- **Fails**: the coercion is a `console.warn` (`:5485`) and the call record looks
  normal afterwards — the documented mechanism by which the demo line answered
  three calls as the after-hours agent (`:5467-5471`).

### 2c. Third decision — inside `observeCall`

`src/voiceAgentRoutes.ts:2279`. A **second, different allowlist** at `:2297`
(`validAgentSlugs`, which includes `dev-no-ivr` and `no-ivr-v2` where the
webhook list does not), a second legacy-coercion (`:2303-2306`) and a second DB
fallback (`:2313-2328`). The file's own comment at `:5350-5352` names this
duplication: "This list is a SECOND allowlist, separate from `validAgentSlugs`
in `observeCall()`; both must know a slug or the call is silently answered by
the after-hours agent."

Then `agentRegistry.getAgentConfig('optical')` and `getAgentFactory('optical')`
(`:2331-2335`), from `src/config/agents.ts:107-118`
(`enabled: true`, `voice: 'sage'`, `language: 'en'`, `version: '1.0.0'`,
`twilioNumbers: []`).

- **Fails**: a hardcoded agent that exists but is disabled throws
  `Agent disabled or not found` (`:2338-2341`), which surfaces as the
  `task.catch` at `:5496-5506` and a `CallDiagnostics.completeTrace`. The caller
  hears whatever the conference is doing — silence.

---

## 3. Everything that happens before the agent speaks

All inside `observeCall` (`src/voiceAgentRoutes.ts:2279-5055`) unless noted.

### 3a. Caller-ID pre-context

Kicked off at `src/voiceAgentRoutes.ts:2493-2508`, gated on
`PRECONTEXT_SLUGS` (`:2492`) which contains `optical`.

- Calls `fetchAzulPrecontext(from)` — `src/agents/azulSchedulingAgent.ts:506-516`,
  which POSTs `sage_precontext` through `callEyecareTool`
  (`src/agents/azulSchedulingAgent.ts:423-497`).
- **Reads**: `EYECARE_AGENT_API_KEY`, `EYECARE_BASE_URL`
  (`src/agents/azulSchedulingAgent.ts:47`). Headers `X-Pilot-Fence: 1`,
  `X-Zero-Id: 1`, `X-Agent-Version`. Per-tool abort at 5 s
  (`TOOL_TIMEOUT_MS.sage_precontext`, `:384`). The service reads Console
  `si_persons` / `patients_master` (project `kbbmywvasbsxnbblrhot`).
- **Race at the factory**: `racePrecontext()` bounds the *residual* wait at
  1500 ms (`src/voiceAgentRoutes.ts:2664-2672`); the optical branch awaits it at
  `:2760`.
- **Fails**: `fetchAzulPrecontext` swallows everything and returns `null`
  (`azulSchedulingAgent.ts:513-515`). The **return value is indistinguishable**
  across "no match", "HTTP error", "no key", "network", "past the deadline".
  The *logs* do separate them: `[AZUL-SCHED] EYECARE_AGENT_API_KEY is not set`
  (`:429`), `[AZUL-SCHED] <tool> HTTP <status>` (`:473`),
  `[AZUL-SCHED] <tool> failed: <msg>` (`:490`), and 401/403 go through
  `noteAuthFailure` with a 3-strike outage alarm (`:398-413`). The one genuinely
  silent mode is a lookup that succeeds **after** the 1500 ms race — nothing logs
  it. Optical itself logs only the binary outcome:
  `[Optical] Pre-context for ...NNNN: matched 'X' | no unique match` (`:2761-2764`).
- **Not fetched for optical**: the Twilio carrier-name lookup, which is
  `azul-scheduling` only (`:2513-2526`).
- **Duplicated**: the Grok runtime fetches the same pre-context itself, bounded
  at its own `PRECONTEXT_DEADLINE_MS`, and logs a *three-way* outcome the SIP
  path does not (`src/runtime/voiceRuntime.ts:593-631`).

### 3b. The call_logs row — created in the background, deliberately not awaited

`src/voiceAgentRoutes.ts:2546-2642`, launched immediately, awaited only after
`session.connect()` succeeds (`:4235-4254`). Three sequential queries:
`storage.getAgentBySlug` → `storage.getCallLogByCallSid` → `storage.createCallLog`.

- **Reads/writes**: Operations Hub (`pslzngjciiifowemrzza`) `agents`, `call_logs`.
- Guarded by `hasValidCallerData = !!from && from !== 'Unknown'` (`:2535`) —
  a call with no caller ID gets **no row at all** (`:2600-2606`).
- On success, registers with `callLifecycleCoordinator.registerCall`
  (`:2610-2617`).
- **Fails**: caught at `:2632-2638`; the call continues with
  `callLogId === undefined`. Visible as `[DB-BG ERROR]` and
  `[DB-BG] No callLogId resolved` (`:4248`).
- **The `liveCallLogId()` getter** (`:2657`) exists because a captured
  `callLogId` is always `undefined` at factory time; the comment at `:2644-2656`
  records that every agent guarding a write with `if (callLogId)` silently
  skipped it on **3,571 calls over 7 days**.

### 3c. The agent object

`src/voiceAgentRoutes.ts:2748-2787` (the `case 'optical'` branch):

```ts
const opticalMeta = { callId, callSid, callerPhone: from, dialedNumber: to,
                      precontext, get callLogId() { return liveCallLogId(); } };
azulMetadataRef = opticalMeta;                 // :2784 — needed for the GREETING
factoryResult = agentFactory(undefined, opticalMeta);   // :2785 — no handoff callback
```

`undefined` in the handoff slot is deliberate (operator ruling 2026-08-12);
`createOpticalAgent` accepts and ignores it (`src/agents/opticalAgent.ts:249-255`).

`azulMetadataRef = opticalMeta` is load-bearing for greeting personalisation
(§3f) — the comment at `:2773-2783` records the "two orders, one turn" defect
caused by omitting it.

### 3d. Session construction, transcription and VAD

`new RealtimeSession(...)` at `src/voiceAgentRoutes.ts:3150-3183`:

- transport `new OpenAIRealtimeSIP()`
- base options from `sessionOptions` (`:797-818`): `model: 'gpt-realtime'`,
  `outputGuardrails: medicalSafetyGuardrails` (from
  `src/agents/afterHoursAgent.ts`, imported at `:21`) — **the only guardrails
  attached, and they are attached to every agent including optical.**
- A/B carriage: `resolveAbAssignment` (`:3138-3149`) may swap the model.
  `AB_MODEL_B` is commented out in `.replit`, so no experiment is running.
- tracing: `workflowName: AzulVision_optical`, `groupId: twilioCallSid`
  (`:3158-3161`)
- audio in: `format: 'g711_ulaw'`, `noiseReduction: {type:'far_field'}`,
  `turnDetection: {type:'semantic_vad', eagerness: vadEagernessFor(...),
  createResponse: true, interruptResponse: true}` (`:3165-3176`)
- `vadEagernessFor()` ignores its argument and always returns `'low'`
  (`src/voiceAgentRoutes.ts:779-785`).
- transcription: `buildTranscriptionConfig({establishedLanguage})`
  (`src/config/transcription.ts:248-278`). Model default
  `gpt-live-transcribe` (`:81`), overridable by `TRANSCRIPTION_MODEL`.
  Because that model supports vocabulary hints (`:53`), the payload carries
  `languages: ['en','es']` (`:118-123`), `prompt: TRANSCRIPTION_PROMPT`
  (`:132-136`), and `keywords: activeKeywords(...)` (`:217-238`) — live provider
  and office names from `providerRoster` (refresh started at
  `src/voiceAgentRoutes.ts:133`), plus `CLINICAL_KEYWORDS`, plus the caller's
  pre-context surname when `TRANSCRIPTION_CALLER_HINT !== 'false'` (`:196-198`).
- `establishedLanguageCode` is left **undefined** for optical (`:3119-3122`), so
  no language is pinned — the fix for "Bon tardis" (`src/config/transcription.ts:21-28`).

**This same audio block is written out four times**: `sessionOptions`
(`:800-815`), the `RealtimeSession` config (`:3165-3181`), the
`buildInitialConfig` call (`:3845-3867`), and the accept-payload backfill
(`:3889-3914`). A fifth copy exists in the new-core mouthpiece update
(`:4520-4535`). `src/config/transcription.ts:1-9` documents that the model and
language were previously hardcoded at four disagreeing sites.

### 3e. Accept, connect, and the ordering around them

1. `deadAirWatchdog.arm(callId, …)` — `:3208-3239`. Idle threshold 120 000 ms
   (`src/services/deadAirWatchdog.ts:67-72`, `DEAD_AIR_TIMEOUT_MS` override);
   touched only by "activity-shaped" events (`:3319`,
   `src/services/deadAirWatchdog.ts:54`). On fire it POSTs
   `https://api.openai.com/v1/realtime/calls/{id}/hangup` and marks
   `markCallConcluded(callId,'dead_air_watchdog')`.
2. `callMetadataForDB.set(callId, {...})` — `:3782-3818`. Note `twilioCallSid`
   is **deliberately never written** here; the 20-line comment at `:3789-3809`
   explains that populating it would arm two never-executed code paths.
3. `OpenAIRealtimeSIP.buildInitialConfig(...)` raced against 5 000 ms
   (`:3837-3873`). Timeout → throw → call dies. Visible:
   `[SESSION] FATAL: buildInitialConfig failed`.
4. Payload surgery `:3878-3939`: inject `turn_detection` if missing, inject
   `noise_reduction`, inject transcription **with the pre-context surname read
   without awaiting** (`:3910-3913`), then **strip** `audio.input.format` and
   `audio.output.format` (`:3915-3925`) because SIP negotiates the codec in SDP,
   then strip `noise_reduction: null`, `output_modalities`, `audio.output.speed`.
5. `POST https://api.openai.com/v1/realtime/calls/{callId}/accept` — `:3951`,
   loop at `:3959-4010`. Up to **8 attempts**, exponential backoff 200 ms → 3 s
   plus jitter. **404 is the only retryable status** (`:3996-4000`).
6. On success, `transport.sendEvent` is monkey-patched to strip audio formats
   out of every later `session.update` (`:4085-4099`).
7. `await session.connect({apiKey, callId})` — `:4185`. Instructions are read
   here and **frozen** (`:4186-4188`, and the long correction at `:2971-2985`:
   the SDK evaluates the instructions closure only in `#getSessionConfig()`,
   reached solely by `connect()`, `updateAgent()` and handoff, none of which this
   app calls later).
8. Await `backgroundDbOps` (`:4236`), backfill `dbCallLogId` (`:4242-4245`).
9. Await `session.updated` or 3 000 ms (`:4103-4106`, `:4260`).
10. Await caller-ready — **skipped on optical**. `callerReadyPromises` is only
    populated by `/api/voice/incoming-call` (`:5757`), `/api/voice/no-ivr`
    (`:5903`) and `/api/voice/azul-scheduling` (`:6541`). The overflow factory
    never creates one, so the block at `:4266-4285` does not run and the greeting
    fires as soon as the session is ready. The `<Pause length="1"/>` in the TwiML
    (`:6188`) is the only thing covering that gap.

**Accept failure** (`:4012-4070`): after 8 failures, if a valid Twilio CallSid can
be recovered, the caller is updated with apology TwiML + `<Hangup/>`
(`:4043-4049`) — **explicitly no operator transfer and no SMS** (operator
instruction 2026-08-11, `:4039-4042`) — and the call log is set `status:'failed'`
(`:4054-4063`). Otherwise it throws. Visible: `[TRACE-4] ✗✗✗`, `[SESSION] ✗ All 8
accept attempts failed`.

### 3f. Greeting selection and personalisation

`src/voiceAgentRoutes.ts:4400-4446`.

1. Start from `metadata.agentGreeting` — the string hardcoded at
   `src/voiceAgentRoutes.ts:6262-6265` (identical to
   `src/agents/opticalAgent.ts:74-77`, a third copy of the same sentence lives in
   the registry at `src/config/agents.ts:117`).
2. `listenFirst` (`:4413`) is true only when metadata is *present and empty*.
3. `resolveConfiguredGreeting('optical')` (`:4414`) →
   `src/services/greetingResolver.ts:51-83`, reading
   `agents.welcome_greeting` through `storage.getAgentBySlug`, 60 s cache,
   1 500 ms cold-lookup timeout, stale-while-revalidate. Preloaded at boot by
   `scheduleGreetingCacheWarm()` (`src/voiceAgentRoutes.ts:5061`).
   **The DB value outranks all hardcoded copies** (`:4401-4407`).
   - **Fails**: timeout/error → `null` → hardcoded fallback, logged
     `[GREETING] DB lookup failed for 'optical'` (`greetingResolver.ts:77-80`).
4. If pre-context matched, `personaliseGreeting(greeting, firstName,
   greetingStyleFor('optical'))` (`:4437-4444`).
   `src/services/greetingPersonalisation.ts:73-80` maps `optical → 'append'`:
   keep the greeting, strip its trailing question
   (`stripTrailingQuestion`, `:99-121`), append "Am I speaking with <name>?".
   Logged `[GREETING] Personalised for recognised caller (X) on optical`.
5. `RAMP_AGENTS` (`:238`) defaults to `answering-service,pcp,azul-scheduling` —
   **optical is not a ramp line**, so `startRamp` (`:4552`) does not run.
6. `newCoreEnabled('optical')` is false unless `NEW_CORE_LINES` names it
   (`src/core/router.ts:29-34`) — so the mouthpiece stripping at `:4477-4542`
   does not run either.
7. `seedLedger(callId, {...})` at `:4387-4398` — seeds the call-facts ledger with
   caller phone, matched first/last/DOB, language.
8. `armGreetingGuarantee(callId, greeting, "Say this greeting … word-for-word",
   transport)` at `:4559-4564` → `:307-326`. Parks the greeting in
   `pendingGreetings`, sends it immediately unless a response is already in
   flight; re-checked at every `response.done` by `checkGreetingDelivered`
   (`:340`, called from `:3381`), two attempts inside a 20 s window (`:227`).

### 3g. Per-turn machinery attached before the first word

`session.transport.on('*')` at `src/voiceAgentRoutes.ts:3313-3776`. For an
optical call the live pieces are:

| What | Line | Notes |
|---|---|---|
| dead-air touch | `:3319` | activity-shaped events only |
| latency clocks / event log | `:3323-3352`, `:3358-3382` | `src/services/callEventLog.ts` |
| token accumulation | `:3385-3387` | feeds §7c |
| barge-in counting | `:3390-3393` | `conversationLoopGuard.onTruncation` |
| caller transcript | `:3396-3673` | appends to `callTranscripts` + `callLifecycleCoordinator.appendTranscript` |
| `harvestCallerLine` | `:3431` | fills empty ledger slots, every line, every agent |
| `[CONTEXT]` one-liner | `:3456-3462` | the per-turn provenance log |
| `recordCallerSpeech` | `:3596` | `src/services/symptomCorroboration.ts:47` |
| loop guard | `:3601-3604`, `:3701-3702` | `src/services/conversationLoopGuard.ts` |
| `recordTurn` | `:3615-3620`, `:3718-3733` | `src/services/turnLog.ts` |
| agent transcript | `:3674-3734` and again `:3735-3773` | **two capture paths** |
| AirCall DTMF autoreply | `:3622-3672` | fires on any transcript containing "press 1" |
| KNOWN-FACTS injection | `:4137-4176` | at `response.done` only, on change |

**Not** on the optical path: the director (`directorEnabledFor`,
`src/director/director.ts:1120`; `DIRECTOR_AGENTS=""` in `.replit`), the ramp
(`:3534`), the new-core module (`:3470`), `identityArgGuard`
(azul only — `src/agents/azulSchedulingAgent.ts:1764`), `toolDirection`
(azul/pcp/no-ivr/answering-service only). All four are nonetheless *released* at
teardown for every call (`:5013`, `:5014`, `:5024`, `:5026`).

---

## 4. The agent's tools

`src/agents/opticalAgent.ts:83-89` names exactly five, and
`src/agents/opticalAgent.ts:264-285` turns them into SDK tools via
`realtimeToolsFor`:

```ts
tools: realtimeToolsFor(OPTICAL_TOOLS,
  { call_sid, caller_phone, dialed_number, queue: 'optical' },   // injected context
  { callId, callSid, get callLogId(){…}, agentSlug: 'optical' })  // telemetry
```

### 4a. How a tool is actually called

`src/tools/realtimeAdapter.ts:42-192`.

- Unknown name → **throws at agent-construction time** (`:76-79`); a `primitive`
  layer tool given to an agent throws too (`:80-82`).
- `parameters` is the registry's **own JSON Schema** plus
  `additionalProperties:false` (`:117-122`), and **`strict: false`** (`:126`).
  The comment at `:92-116` records why: `strict:true` + a Zod translation put all
  15 `file_surgery_ticket` fields in `required`, the model emitted 13, and the
  SDK rejected the arguments *before* `execute`, producing no log, no timeline
  event and four identical failed live calls on 2026-08-12.
- `execute` (`:130-187`): nulls stripped from the model's args (`:131-135`),
  then `runTool(name, { ...injectedContext, ...suppliedArgs })` (`:152`) —
  **context merged UNDER** so the model cannot blank `call_sid` or `queue`.
- Unconditional `[TOOLS] → name` / `[TOOLS] ← name Nms ok|refused:…|error:…`
  lines (`:150`, `:159`).
- `flushTimelineSafely` (`:175`, `:228-236`) persists the tool timeline **per
  tool call**, not at hangup — because a tool still running at hangup used to
  leave no record at all.
- `wrapWithTelemetry` (`:201-220`) wraps in `recordingExecute`
  (`src/services/toolTimeline.ts:312`), reading `callLogId` through the getter.

`runTool` — `src/tools/registry.ts:162-186`: `validateInput` first
(`:139-159`, required-and-non-empty only, message built from `askAs`), then the
handler raced against the declared `timeoutMs`; a timeout returns
`{success:false, error:'<name> timed out', retryable:true}` and a throw returns
`{success:false, error:<msg>, retryable:true}`. **`runTool` never throws.**

### 4b. The five tools

#### `lookup_patient` — `src/tools/sharedPatientTools.ts:64-207`, `timeoutMs: 6000`

- **Schema**: `phone`, `first_name`, `last_name`, `date_of_birth`. **No `required`
  array** — the handler enforces the rule instead.
- **Refusal path**: neither a phone nor the full name+DOB trio →
  `missing([...], "I need either a phone number, or their full name and date of
  birth, to look them up.")` (`:104-111`).
- **Reads**: `input.caller_phone` (injected) as a fallback for `phone` (`:98`) —
  the fix for the 2026-08-13 call where the model looked up a mis-transcribed
  trio and got "no record found" for a patient already recognised (`:84-97`).
  Then `scheduleLookupService.lookupPatient` (`:113-119`).
- **What it actually queries**: `src/services/scheduleLookupService.ts:557-581`
  → `lookupByNameAndDOB` → `lookupByPhone` → `lookupByName`, all against the
  **Operations Hub `schedule` table** (`src/services/scheduleLookupService.ts:1-2`,
  `import { schedule } from '../../shared/schema'`). **This is the standing-instruction-14
  violation named in CLAUDE.md**: identity is resolved from the appointment book,
  not `patients_master`. `src/services/patientVerification.ts` (the mirror-first
  implementation) is wired into `src/core/router.ts` and the standalone demo line
  only — never into this shared queue tool.
- Second chance: a name+DOB miss retries on the caller's phone (`:130-136`),
  logged `[TOOLS] lookup_patient: name+DOB missed, matched on the caller phone instead`.
- **Queue-awareness**: `usual_clinic` is `mostRecentAcceptable(seen, 'optical')`
  (`:165`, `:388-407`), which asks `consoleDirectory.lookupLocation`
  (`src/services/consoleDirectory.ts:320-324`, backed by
  `OBS_CONSOLE_DATABASE_URL`, 15-min cache at `:26`) and accepts only
  `facility_kind === 'clinic'` for optical (`:37-48`). Directory unreachable →
  falls back to the newest location (`:394`, `:404`).
- **Ambiguity contract**: `identity_is_certain: false` plus an
  `identity_warning` when the phone or surname matched more than one person
  (`:172-189`); grouping is by first+last+DOB in
  `splitByPerson` (`scheduleLookupService.ts:411-446`).
- **Fails**: never returns `success:false` for "not found" — it returns
  `{success:true, found:false, message:…}` (`:138-146`). Log line
  `[ScheduleLookup] N row(s) as of … -> …` (`scheduleLookupService.ts:651-660`)
  is the **current deploy marker** named in CLAUDE.md.

#### `resolve_location` — `src/tools/sharedPatientTools.ts:211-321`, `timeoutMs: 4000`

- **Required**: `spoken_location`.
- **Reads**: `sanitizeLocationName` (`src/services/ticketFieldSanitizers.ts:138`),
  then `consoleDirectory.lookupLocation`.
- **Refusal paths**: empty after sanitising → `missing(['spoken_location'], …)`
  (`:232-234`); **no match → `missing(...)` with a refusal envelope** (`:272-277`).
  The 28-line comment at `:244-271` is the measurement: on 2026-08-13
  `resolve_location` ran 41 times across 29 optical calls, 32 returned
  `verified:false`, five calls looped it 3+ times (one ten times with identical
  arguments), those five averaged 229 s against 134 s, and **not one ended
  resolved** — because the envelope said `success:true`.
- Directory not configured (`OBS_CONSOLE_DATABASE_URL` unset) → passes the
  cleaned string through with `verified:false` rather than blocking (`:237-240`).
- Returns `location: hit.fileAs || sanitize(hit.canonical)` (`:300`) — the form
  the **ticketing app** stores, not the Console's `nextgen_name` (`:282-299`).

#### `check_open_tickets` — `src/tools/sharedPatientTools.ts:325-354`, `timeoutMs: 5000`

- **Required**: `phone`.
- **Reads**: `SyncAgentService.checkOpenTickets`
  (`src/services/syncAgentService.ts:460-500`) which reads
  `storage.getCallHistoryByPhone` — i.e. **the Operations Hub `call_logs` table**,
  treating "has `ticketNumber` and no `ticketingSyncedAt`, within 7 days" as
  "open". It does **not** query the ticketing app's `tickets` table at all.
- **Fails**: an error propagates to `runTool`, which converts it to
  `{success:false, retryable:true}`.
- **Duplicated**: `answeringServiceAgent` declares its own `check_open_tickets`
  inline (`src/agents/answeringServiceAgent.ts:858-914`) over the same service
  with a different result shape (`hasOpenTickets`, `createdWhen`).

#### `classify_optical_request` — `src/tools/opticalTools.ts:23-67`, `timeoutMs: 1000`

- **Required**: `request_description`.
- **Reads**: `classifyOptical` / `OPTICAL_DEPARTMENT_ID = 1`
  (`src/tools/opticalTaxonomy.ts:33`, `:230`).
- **Never refuses.** No match returns `{success:true, classified:false}` with a
  message telling the agent to file anyway and leave the category off (`:47-55`).

#### `file_optical_ticket` — `src/tools/opticalTools.ts:71-409`, `timeoutMs: 30000`

**Required** (`:97`): `first_name`, `last_name`, `date_of_birth`,
`callback_number`, `location`, `request_description`.
Optional: `request_reason_id`, `provider`, `email`, `call_sid`, `caller_phone`,
`dialed_number` — the last three injected, never asked of the model.

Refusal paths, in execution order:

| Line | Condition | Result |
|---|---|---|
| `:109-111` | fewer than 10 digits | `missing(['callback_number'], "I only caught part of that number…")` |
| `:130-135` | more than 11 digits, or 11 not starting with 1 | `missing(['callback_number'], "That's more digits than one phone number…")` |
| `:168-170` | location empty after `sanitizeLocationName` | `missing(['location'], "Which of our offices do you usually visit?")` |
| `:174-177` | DOB not parseable by `normalizeDobParts` (`src/tools/dobParts.ts:14`) | `missing(['date_of_birth'], …)` |
| `:210-238` | `lookupProviderAndLocation` **ran** and matched no location | `missing(['location'], "I'm not finding an office by that name.<candidates>")` — deliberately a *missing field*, not a retryable error (`:211-223`) |
| `:304-313` | no catch-all reason for dept 1 | `{success:false, retryable:false}` — cannot happen with the current table |
| `:381-387` | `createTicket` returned no ticket number | `{success:false, error, retryable:true}` |

Non-refusing transforms:
- `sanitizeForSms(description)` (`src/services/gsm7.ts:105`) — GSM-7, because the
  description becomes a patient-facing SMS body downstream (`:150-161`).
- `sanitizeProviderName` / `sanitizeLocationName`
  (`src/services/ticketFieldSanitizers.ts:104`, `:138`).
- **The lookup-ran distinction** (`:208`): `lookupProviderAndLocation` returns
  `{success:false}` both for "matched nobody" and for "the call itself failed"
  (`server/services/ticketingApiClient.ts:1001-1008`). `lookupRan = lookup.success !== false`
  separates them. If the lookup could not run, the ticket is filed **unassigned**
  with `priority: 'high'` (`:338`) and `locationOfLastVisit` carrying the caller's
  own words, logged
  `[Optical] ✗ LOCATION LOOKUP UNAVAILABLE — filing '<x>' UNASSIGNED` (`:266-270`).
  The comment at `:190-207` records the 2026-08-31 outage: the n8n gateway hit
  its plan execution cap at 20:16 UTC and answered 200 with non-JSON, optical
  went to zero, and 43 callers were told "I'm not finding an office by that name".
- Reason selection (`:145-148`, `:302-314`): the named `request_reason_id` must
  resolve to one of **optical's own** reasons, else re-classify from the text,
  else the per-department catch-all from `src/tools/otherReason.ts:86-95`
  (dept 1 → type 66, reason 536).
- Cross-queue redirect (`:327-344`): `detectCrossQueue`
  (`src/tools/queueRouting.ts:251`) may move the ticket to another department —
  appointments to HVA Hub 9 (`:48`, `:288-298`) from every queue except a surgery
  date. The redirect note is **prepended to the description** (`:332-334`).

Success envelope (`:389-408`) reports `ticket_number`, `request_reason`,
`location_id`, and `routed_to` when redirected — deliberately reporting **what
was filed**, not what the home queue classified.

---

## 5. The intake order the prompt asks for, and what enforces it

Prompt: `buildOpticalPrompt`, `src/agents/opticalAgent.ts:91-247`
(~1,200-token ceiling, `:151-154`). "HOW A CALL RUNS", `:191-214`:

1. `lookup_patient` as soon as a phone, or name+DOB, is available; if
   `identity_is_certain` is false, collect last name + DOB and call it **again**.
2. Find the office — "the one thing a ticket cannot be filed without". Confirm
   `usual_clinic`; otherwise `resolve_location`. **Never ask a patient which city
   one of our offices is in.**
3. `check_open_tickets` before filing.
4. `classify_optical_request`.
5. (step numbering in the prompt skips 5) `file_optical_ticket`, then read the
   number back.

Plus, `:216-230`: the callback number is confirmed **before** filing, never
after (standing instruction 12; the VA-51417 counter-example is quoted at
`:119-137`), and the agent must say "Let me get this logged for you — one
moment." immediately before filing and nothing else.

**What enforces it:**

| Rule | Enforced by | Where |
|---|---|---|
| Cannot file without name, DOB, callback, location, description | `validateInput` on the declared `required` array | `src/tools/registry.ts:139-159`, `src/tools/opticalTools.ts:97` |
| Location must resolve to a real office | tool refusal + the ticketing app's routing gate | `src/tools/opticalTools.ts:210-238`; `ticketing-app/lib/voice-agent/routing-gate.ts:353-361` |
| Callback number is one plausible phone | digit floor + ceiling | `src/tools/opticalTools.ts:108-135` |
| DOB parses | `normalizeDobParts` | `src/tools/opticalTools.ts:173-177` |
| Reason belongs to optical | `classificationByReasonId` + `otherReasonFor` | `src/tools/opticalTools.ts:145-148`, `:302-314` |
| `call_sid` present | injected as context, not asked | `src/agents/opticalAgent.ts:265`, `src/tools/realtimeAdapter.ts:152` |

**Nothing enforces the ORDER.** There is no state machine on this line: no ramp
(`RAMP_AGENTS` excludes optical, `src/voiceAgentRoutes.ts:238`), no new-core
module (`src/core/router.ts:29-34`), no director
(`src/director/director.ts:1120`), no `toolDirection` gate. The model may call
`file_optical_ticket` first; it will simply be refused field by field. The
"confirm the number before filing" rule and the "say the cover line first" rule
are **prompt text only** — nothing in code observes them.

The one order-adjacent code control is the loop guard
(`src/services/conversationLoopGuard.ts`, wired at
`src/voiceAgentRoutes.ts:3601-3604` and `:3701-3702`), which counts repeated
asks per topic and injects a directive, and the tool-level refusal envelopes,
which `sharedPatientTools.ts:244-271` documents as the only thing that reliably
stops a retry loop.

---

## 6. The filing call

### 6a. Client side

`ticketingApiClient.createTicket(params)` —
`server/services/ticketingApiClient.ts:578-669`.

1. `warmUpIfStale(2, 500)` (`:602`) → `:339-349`. Skipped when the app answered
   within `LIVENESS_TTL_MS = 60_000` (`:285`); otherwise `warmUpWithRetry`
   (`:555-576`) probes twice with a 500 ms sleep between. The probe is
   `GET {enrichmentBase}/api/voice-agent/ping` when a direct app base is
   configured, else `GET {baseUrl}/api/health` (`:411-414`), bounded at 3 s
   (`:426-437`). **Advisory, not a gate** (`:594-604`) — failure logs
   `⚠ Warm-up did not confirm liveness — sending anyway`.
   The comment at `:248-283` records the measured cost: `create_ticket` p50 5–8 s,
   p90 11–19 s, max 91 s, against 0.17 s for a read on the same API.
2. `makeRequest('/api/voice-agent/create-ticket', 'POST', params)` — `:607-611`
   → `:452-552`.
   - **Base URL**: `TICKETING_SYSTEM_URL` (`src/config/environment.ts:261`),
     resolved in `ensureInitialized` (`:351-392`) and re-read every 60 s
     (`:246`). `TICKETING_ENRICHMENT_URL` (`:262`) is the direct-to-app base and
     is used **only** by `updateTicketCallData` and `createPcpTicket`
     (`useEnrichmentBase = true`, `:894`, `:928`). So **create-ticket goes
     through the n8n gateway** whenever `TICKETING_SYSTEM_URL` points at n8n —
     which is what the 2026-08-31 optical outage was
     (`src/tools/opticalTools.ts:196-207`).
   - Auth header `X-API-Key: TICKETING_API_KEY` (`:493`).
   - Hard 15 s `AbortController` timeout (`:456`, `:482-486`).
   - Shadow tap emits `n8n_workflow_requested` / `_completed` / `_failed`
     (`:477`, `:520`, `:527`, `:537`).
3. **Missing config** → `ensureInitialized` **throws** (`:377`, `:382`), which is
   caught by `createTicket`'s own `catch` (`:662-668`) and returned as
   `{success:false, error}`.
4. On success, **ticket-number writeback** (`:635-640`):
   `storage.releaseTicketCreationLock(callSid, ticketNumber)` writes
   `call_logs.ticket_number`. Fire-and-forget. The comment at `:617-634` records
   that until 2026-08-13 only the `submit-ticket` path did this, so every
   queue-line ticket left `call_logs.ticket_number` NULL and the grader read
   46.2 % of tech's calls as ticketless on a day tech filed 106 real tickets.
5. **No outbox on this path.** `SyncAgentService.createTicketFromAgentInput`
   writes a durable `ticket_outbox` row first and retries in the background
   (`src/services/syncAgentService.ts:150-187`,
   `src/services/ticketOutboxService.ts:30-80`, 5 retries, 60 s worker started at
   `src/server.ts:195-197`). The four queue tools call `createTicket` directly
   (`src/tools/opticalTools.ts:346`, `surgeryTools.ts:448`, `techTools.ts:242`,
   `medicalRecordsTools.ts:310`) and therefore have **no durability at all**.

### 6b. Payload sent by `file_optical_ticket`

`src/tools/opticalTools.ts:346-379`:

```
departmentId        1 (or redirect.departmentId)
requestTypeId       from classification / catch-all 66
requestReasonId     from classification / catch-all 536
patientFirstName    first
patientLastName     last
patientPhone        normalizePhone(callback)   // last 10 digits — utils/phone.ts:26
patientEmail        optional
preferredContactMethod 'phone'
patientBirthMonth/Day/Year   from normalizeDobParts
locationId          ONLY when the lookup resolved one
locationOfLastVisit cleanLocation (always — the caller's words survive)
providerId          ONLY when resolved
lastProviderSeen    cleanProvider || undefined
description         redirect note + GSM-7-sanitised description
priority            'medium', or 'high' when the location lookup could not run
callData            { agentUsed: 'optical', callSid }
idempotencyKey      `call-${callSid}` — ONLY when callSid matches /^CA[0-9a-f]{32}$/i
```

`isTwilioCallSid` (`src/tools/sharedPatientTools.ts:368-370`) exists because
`metadata.callSid ?? metadata.callId` can be a sentinel ("unknown", "latest"),
and keying idempotency on a sentinel could hand a second caller's retry a
stranger's ticket number.

### 6c. Server side — `POST /api/voice-agent/create-ticket`

`ticketing-app/app/api/voice-agent/create-ticket/route.ts:289-858`, in order:

| # | Step | Line | Failure |
|---|---|---|---|
| 1 | Rate limit (`resolveVoiceAgentRateLimit`, keyed on `X-N8N-Source` or IP) | `:302-320` | 429 + `Retry-After`; logged as `validation_error` |
| 2 | API key, `timingSafeEqual` against `VOICE_AGENT_API_KEY` | `:134-163`, `:327-340` | 401. Missing env → 401 "Service configuration error" + `console.error('CRITICAL: …')` |
| 3 | `request.text()` + `JSON.parse` | `:346-367` | 400 |
| 4 | Location-queue expansion (`queue:'location'`) — fills the ID triple from `locations.queue_request_type_id` **before** validation | `:394-410`, `:176-229` | 422 |
| 5 | Zod `CreateTicketPayloadSchema` | `:31-90`, `:412-427` | 400 with `validationErrors[]`. Note `patientPhone` is `max(20)` (`:38`) — the reason the raw phone string filed zero tickets over 14 days |
| 6 | Idempotency replay from `idempotency_keys` (5-minute TTL) | `:435-463`, `:806-822` | Check failure is swallowed and the request proceeds |
| 7 | **Routing gate** | `:471-506` | see 6d |
| 8 | `generateTicketNumber('VA')`, subject `"<First> <Last> - Voice Agent Request"` | `:515-516` | — |
| 9 | AI call summary from `callData.transcript` | `:539-561` | non-blocking, logged |
| 10 | **Consolidation** | `:567-617` | see 6e |
| 11 | `storage.createTicket(...)` | `:631-669` | 500 + `logger.logDatabaseError` |
| 12 | Medical-records case (`ensureCaseForTicket`) when `departmentId === getMrDepartmentId()` | `:682-689` | non-blocking warn |
| 13 | **Auto-assignment** `applyAutoAssignment` — suppressed for `type === 'review_queue'` | `:694-718` | non-blocking `console.error` |
| 14 | `persistRoutingAdvisories` — writes a `ticket.routing_advisory` event **only if the ticket is still unassigned and the assignee is not `ASSIGNABLE_USER_STATUS`** | `:240-274`, `:724` | non-blocking |
| 15 | **Welcome SMS** via `sendSMS`, gated on `normalizePhone()` returning E.164 | `:732-774` | non-blocking; `welcomeSmsSent:false` is returned so the voice layer does not promise a text |
| 16 | Store idempotency key, sweep expired | `:806-822` | swallowed |
| 17 | `logger.logSuccess` + `{success, ticketId, ticketNumber, welcomeSmsSent}` | `:824-835` | — |

### 6d. The routing gate

`ticketing-app/lib/voice-agent/routing-gate.ts:154-364`;
policy in `ticketing-app/lib/voice-agent/routing-policy.ts`.

- **Which departments are gated**: `DEPARTMENT_ROUTING_KEY` (`routing-policy.ts:9-12`)
  — **1 → location, 2 → provider. Nothing else.** Tech (3) and records (16) are
  ungated.
- Mode: `VOICE_ROUTING_GATE=log` downgrades rejection to a warning
  (`routing-policy.ts:40-42`); default is `enforce`.
- Step 1, identity (`routing-gate.ts:171-229`): `searchPatientByDOBFuzzyName`
  against the schedule DB, timeout-wrapped. A name is only rewritten when the
  composite score ≥ 0.4 **and** `isIdentityCorroborated` passes
  (`routing-policy.ts:101-121`: either the caller's phone matches a number on the
  record, or both name components score ≥ 0.6 with a ≥ 0.15 margin over the
  runner-up on that DOB). `identityVerified:true` in the payload blocks the
  rewrite entirely (`routing-gate.ts:203-213`). Schedule unreachable → note
  `patient verification unavailable`, continue (`:222-228`).
- Step 2, location derivation (`:254-351`): a **supplied** `locationId` is
  dropped if `locationCanReceiveAssignment` says nobody there can take the
  assignment (`:272-286`) — unless `locationFromRecoveryAnswer` is set, in which
  case it is kept on the caller's word and an advisory is recorded. Otherwise the
  patient's **most-attended** offices are walked, resolved by name
  (`resolveLocationByName`, `:130-152`), and the first assignable one wins
  (`:324-350`).
- Step 3, rejection (`:353-361`): still no `locationId` for dept 1 →
  `{ok:false, errorCode:'missing_required_field', error:"Missing required
  information: office. Optical tickets are assigned by office — ask which Azul
  Vision office the patient visits.", missingFields:['location']}` →
  **HTTP 400** at `route.ts:496-505`.
- On the client this becomes `Error(data.error)` at
  `server/services/ticketingApiClient.ts:524`, then
  `{success:false, error}` at `:662-668`, then
  `{success:false, retryable:true}` at `src/tools/opticalTools.ts:381-387`.
  **The gate's speakable sentence does reach the model, but marked retryable.**

### 6e. Consolidation

`ticketing-app/lib/services/ticket-consolidation.ts:161-190`, called at
`route.ts:567`.

- `findExistingOpenTicket` (`:60-122`): same department, status in
  `open|in_progress|waiting_on_customer`, not merged, not archived, and either
  the **last 7 phone digits within 48 h** or an exact first+last name match
  within 24 h. Oldest wins.
- On a hit: `appendContactEntry` writes a `ticket_contact_entries` row carrying
  the callSid, recording URL, transcript, summary and duration (`:128-151`), the
  parent's `updatedAt` is bumped, and **no new ticket is created**. The endpoint
  returns `{success:true, consolidated:true, ticketNumber:<parent>}`
  (`route.ts:594-617`) — so the agent reads back the **parent's** number.
- `backfillRoutingKeys` (`:202-297`) fills a NULL `provider_id`/`location_id`
  from this call as a compare-and-swap (`:247-262`) and re-runs
  `applyAutoAssignment(..., {onlyIfUnassigned:true})` (`:276-287`).
- **Fails**: the whole function is try/caught (`:186-189`) and returns
  `{consolidated:false}` on error — i.e. a consolidation failure silently becomes
  a new ticket.

### 6f. Side effects, summarised

| Effect | Where | Blocking? |
|---|---|---|
| `tickets` row | `route.ts:631-669` | yes — 500 on failure |
| `ticket_contact_entries` row (consolidation) | `ticket-consolidation.ts:132-145` | yes, on that branch |
| `mr_cases` row (dept 16 only) | `route.ts:682-689` | no |
| auto-assignment + `ticket.auto_assigned` event | `route.ts:694-718`, `auto-assignment.ts:472-532` | no |
| `ticket.routing_advisory` event | `route.ts:724`, `:240-274` | no |
| patient welcome SMS | `route.ts:732-774` | no |
| `idempotency_keys` row | `route.ts:806-822` | no |
| `call_logs.ticket_number` writeback | `ticketingApiClient.ts:635-640` (client side) | no |

---

## 7. Teardown

The `finally` block of `observeCall`, `src/voiceAgentRoutes.ts:4670-5054`. The
call ends when the transport closes or the session errors fatally
(`:4587-4663`), or at the hard 10-minute session timeout (`:4588-4594`).

### 7a. Immediate

- `abortedPcpHandoffs.add`, `cancelActiveOfficeLegs` — `:4671-4673` (no-ops here)
- `unregisterAzulHoldingCallback` / `unregisterAzulOfficeTransferCallback` /
  `pcpHandoffProgress.delete` — `:4676-4678` (no-ops for optical)
- **Terminal-disposition sweep: azul and pcp ONLY** — `:4713-4727`, bounded at
  25 s. The 30-line comment at `:4683-4712` records why the gate exists: on
  2026-07-30 the sweep ran for every agent and filed ~30 false "call them back"
  tickets between 09:50 and 12:03 PT. **Optical has no teardown sweep.**
- `flushAzulTimeline(callId)` — `:4729`,
  `src/services/toolTimeline.ts:489-594`. Writes `call_logs.tool_timeline` and
  `tool_call_count`, is **idempotent by event count** (`:522-524`), **never
  deletes the entry** (`:503-520` — deleting it used to gut a third of the
  pilot's QA record), and triggers a forced deterministic-grader pass
  (`:574-590`).

### 7b. Transcript write

`:4782-4828`. `storage.updateCallLog(dbCallLogId, {status:'completed', endTime,
transcript, transferredToHuman, costIsEstimated:true, callerName?})`.
**Duration is deliberately not written here** — Twilio is the source of truth
(`:4788-4790`, `:4815-4816`).
`flushLoopTelemetry` (`:4810`, `:841-862`) writes `totalTurns`,
`interruptionCount`, `truncationCount`, `telemetrySource`.

- **Fails**: whole block is try/caught (`:4987-4989`); nothing else runs if the
  update throws.
- **Skipped entirely** when `callMeta?.dbCallLogId` is falsy (`:4783`) — i.e. a
  call whose DB row never landed writes no transcript at all.

### 7c. Cost and telemetry

- Token-based cost: `:4739-4779`. Reads `callTokenUsage` (accumulated at
  `:3385-3387`), calls `callCostService.updateCallCostsWithTokens(...,
  String(modelForCall))` — priced against the model that actually ran, not a
  hardcoded string (`:4759-4771`).
- `flushTurns` → `releaseTurns` — `:5029`
- `emitCallEvent('session teardown')` then `flushCallEvents` →
  `releaseCallEvents` — `:5030-5031`
- Post-call block, `setTimeout(..., 3000)` at `:4846-4986`:
  polls the DB for a longer transcript for up to 15 s (`:4853-4874`),
  `recalculateOpenAICostFromDuration` (`:4880`), `callGradingService.gradeCall`
  when the transcript exceeds 200 chars (`:4884-4893`),
  `ticketingApiClient.updateTicketCallData` when
  `twilioCallSid && filesTickets(slug) && hasValidTicket && hasValidTranscript`
  (`:4907-4951`), then `callDataSynced = true` (`:4942-4947`), then a Twilio
  caller-name enrichment (`:4955-4971`) and a QVO event 20 s later (`:4974-4982`).
  `filesTickets('optical')` is `true` (`src/config/agentCapabilities.ts:100-103`).

### 7d. The other teardown paths (all of which also run)

1. **`/api/voice/conference-events`** — `:7390-7627`. On
   `participant-leave (customer)` or `conference-end`: `releaseSIPWatchdog`
   (`:7526`), notifies `callLifecycleCoordinator` (`:7530-7548`), closes the
   session transport (`:7551-7564`), terminates any orphaned SIP leg
   (`:7572-7577`). Also resolves the caller-ready promise on `participant-join`
   (`:7582-7595`) — a no-op for optical, which never creates one.
2. **`/api/voice/recording-status`** — `:7630-7741`. On `completed`: closes a
   still-open session as a backstop (`:7654-7668`), writes
   `call_logs.recording_url` (`:7685-7687`), **pushes the recording URL to the
   ticketing app immediately** via `updateTicketCallData` (`:7695-7727`), marks
   `callDataSynced = true` (`:7720`), and deletes
   `conferenceSidToCallLogId[conferenceSid]` (`:7730`).
3. **`/api/voice/status-callback` / `/api/voice/status`** — `:7760-7996`. Writes
   the authoritative Twilio duration, disposition, error code and cost
   (`:7914-7956`); `costIsEstimated` is set false only when the cost came from
   token counts (`:7931-7950`).
4. **`callLifecycleCoordinator.finalizeCall`** —
   `src/services/callLifecycleCoordinator.ts:748-900`. Writes its **own**
   `status`, `endTime`, `duration` (locally measured — see the comment at
   `:777-806` about Twilio reporting 0 s on diverted conference legs),
   `transcript`, `firstTranscriptDelayMs`, `postTranscriptTailMs`,
   `transcriptWindowSeconds`, then emits `call-ended`.
5. **The `call-ended` listener** — `src/voiceAgentRoutes.ts:8073-8192`. Flushes
   the timeline again (`:8079-8080`), flushes loop telemetry again (`:8085-8089`),
   reconciles Twilio, **grades the call again** (`:8137-8146`), and calls
   `updateTicketCallData` **again** (`:8156-8188`).
6. **`ticketingSyncService`** — `server/services/ticketingSyncService.ts`, 5-minute
   interval (`:13`, `:44-50`), `.limit(20)` per cycle (`:123`), selecting rows
   where `callDataSynced = false` (`:109`). Started at `src/server.ts:192`.
7. **`TicketOutboxService.startWorker()`** — `src/server.ts:195-197`, 60 s. Only
   ever sees rows written by `SyncAgentService`; never sees a queue-line ticket.

### 7e. In-memory release

`src/voiceAgentRoutes.ts:4992-5053`, in this order:

```
activeSessions.delete            :4993
responseInFlight.delete          :4994
pendingGreetings.delete          :4995
lastFactsRender.delete           :4996
(async)  mod.finalize            :5001-5008   — new-core lines only
         releaseLedger           :5012
         releaseDirectionState   :5013
         releaseRamp             :5014
         releaseNewCoreCall      :5015
         cancelPendingHangup     :5016
         newCoreCalls.delete     :5017
callMetadataForDB.delete         :5020
callTranscripts.delete           :5021
deadAirWatchdog.release          :5022
conversationLoopGuard.releaseCall:5023
releaseIdentityGuard             :5024
releaseAzulCallState             :5025
director.release                 :5026
flushTurns / releaseTurns        :5029
flushCallEvents / releaseCallEvents :5031
conference map deletes           :5035-5053
callSessionService.deleteSession :5042
```

And, from the webhook's `.finally` (`:5507-5522`): `activeCallTasks.delete`,
`callMetadata.delete` (both keys), `aircallDTMFSent.delete`,
`pendingConferenceAgentAdditions.delete`, `callerReadyPromises.delete`,
`callerReadyResolvers.delete`.

**Not released on this path**: `escalationDetailsMap`
(`src/services/escalationStore.ts:18`) is deleted only on the escalation path
(`:1752`); `releaseCallerSpeech` runs only inside `flushLoopTelemetry`
(`:842`), which requires a `dbCallLogId`; `officeLegDials`,
`warmTransferAccepts`, `officeLegBridges` and `activeOfficeLegsByCall` are
transfer-path structures optical never populates.

---

## 8. How the others differ

### surgery (dept 2)
`src/agents/surgeryAgent.ts`, `src/tools/surgeryTools.ts`.
Same five-tool shape (`surgeryAgent.ts:97-103`), same factory branch
(`src/voiceAgentRoutes.ts:2789-2827`), same greeting style `append`.
Differences:
- `file_surgery_ticket` requires **five** fields, not six —
  `location` is not required (`surgeryTools.ts:135`).
- Routing key is **provider**, not location
  (`ticketing-app/lib/voice-agent/routing-policy.ts:9-12`). The tool runs a
  three-rung surgeon ladder within a 10 s budget: caller-stated →
  `lastPhysicianSeen` → `lastProviderSeen`, resolving each through
  `lookupProviderAndLocation` (`surgeryTools.ts:331-391`). The rung lookup uses
  `lookupByNameAndDOB` **only**, never the phone fallback (`:346-363`).
- `SURGEON_DOCTOR_TYPES = {MD, Retina}` — `src/services/scheduleLookupService.ts:122`;
  `Equipment` rows are skipped as providers (`:662-679`); the surgeon is taken
  from the **next upcoming** physician before the last past one (`:681-700`).
- Files unrouted with `console.error('[surgery] ✗ SURGEON DID NOT RESOLVE')`
  rather than refusing (`surgeryTools.ts:401-405`).
- Priority ladder has a third rung: `isSurgeryPostOpSymptom` → `'high'`
  (`:407-425`).
- `resolve_location`/`lookup_patient` accept `surgery_center` as well as
  `clinic` (`src/tools/sharedPatientTools.ts:44-47`).
- Catch-all reason: type 65 / reason 535 (`.agents/memory/ticketing-api-contract.md`).
- Was the line that proved `strict:true` broke tool calls — four live calls,
  zero handler runs, no log anywhere (`src/tools/realtimeAdapter.ts:92-116`).

### tech (dept 3)
`src/agents/techAgent.ts`, `src/tools/techTools.ts`. Identical shape to surgery:
five required fields, no location requirement (`techTools.ts:112`),
`TECH_DEPARTMENT_ID = 3` (`src/tools/techTaxonomy.ts:63`), catch-all type 72 /
reason 542. **Ungated** by the routing gate. The medication queue and the
practice's largest (CLAUDE.md line-status table). Webhook registered at
`src/voiceAgentRoutes.ts:6281-6289`.

### records (dept 16)
`src/agents/recordsAgent.ts`, `src/tools/medicalRecordsTools.ts`. Registered at
`src/voiceAgentRoutes.ts:6293-6301`. Differences:
- `file_records_ticket` requires a **sixth** field, `requester`
  (`medicalRecordsTools.ts:138`).
- Sends the four CAP fields `requestorType` / `requestPathway` /
  `capClockApplies` / `requestorName` (`:340-353`), which are read by the Zod
  schema at `ticketing-app/.../create-ticket/route.ts:81-89` and carried into
  `storage.createTicket` (`:650-653`).
- Triggers `ensureCaseForTicket` inline (`route.ts:682-689`), the only department
  that does.
- The caller is frequently **not** the patient (attorney, plan, other clinic) —
  the factory comment at `src/voiceAgentRoutes.ts:2876-2879` says pre-context
  resolves the NUMBER, never the identity.
- A records request arriving via the **answering service** structurally cannot
  carry a requester, because that path files through `submit-ticket`
  (`.agents/memory/ticketing-api-contract.md`).

### answering-service
`src/agents/answeringServiceAgent.ts` (1,298 lines, ~4,900-token prompt).
Same overflow webhook factory (`src/voiceAgentRoutes.ts:6248-6254`), factory
branch at `:2731-2746`. Differences:
- **Declares its own tools inline** rather than using the registry:
  `lookup_schedule` (`:732`), `check_open_tickets` (`:858`), `classify_request`
  (`:917`), `create_ticket` (`:952`), each wrapped in a local `recordedTool`
  (`:635-640`) that composes `withToolDirection` + `recordingExecute`.
- Files through `SyncAgentService` → **`ticket_outbox`** → `createTicket`
  (`src/services/syncAgentService.ts:150-247`), or `submitSimplifiedTicket`
  → `/api/voice-agent/submit-ticket` (`:694`), which **re-derives the department
  server-side and defaults to 8** (`.agents/memory/ticketing-api-contract.md`).
- It **is** a ramp line (`src/voiceAgentRoutes.ts:238`, profile `full_rails` at
  `:4552`).
- Greeting style `append` (`src/services/greetingPersonalisation.ts:74`).
- Receives a `handoffToHuman` parameter it never invokes
  (`src/config/agentCapabilities.ts:83-86`).

### no-ivr
`POST /api/voice/no-ivr`, `src/voiceAgentRoutes.ts:5827`. The only queue-shaped
line with its **own** webhook implementation rather than the factory:
- Creates a caller-ready promise (`:5894-5903`) and awaits it before greeting.
- Uses `addSIPParticipantWithWatchdog` (`:5791`) — retries, max-duration ceiling,
  spoken fallback.
- The **only agent in the fleet with a transfer tool**, `escalate_to_human`
  (`src/config/agentCapabilities.ts:114-123`, `src/agents/noIvrAgent.ts:1423`),
  gated by `afterHoursEscalationGate`.
- Also has `emit_decision` (`:1055`) and `terminate_call` (`:1346`).
- It is the after-hours line and carries all overnight volume (CLAUDE.md
  standing instruction 13).
- Greeting is **never personalised** — deliberately absent from
  `GREETING_STYLES` because the greeting carries the closed-office notice, the
  911 direction and the recording disclosure
  (`src/services/greetingPersonalisation.ts:40-52`).

### pcp
`POST /api/voice/pcp`, `src/voiceAgentRoutes.ts:6410`; factory branch `:2901-2909`.
**OFF in Twilio** (CLAUDE.md line-status table).
- Nine tools (`src/agents/pcpAgent.ts:513-1014`), including `handoff_to_pcp`
  (`:870`) and `terminate_call` (`:1014`).
- Files through `ticketingApiClient.createPcpTicket` →
  `/api/voice-agent/pcp-ticket` with `useEnrichmentBase = true`
  (`server/services/ticketingApiClient.ts:921-967`) — **direct to the app,
  bypassing n8n** — plus a patient-path `createTicket` at
  `src/agents/pcpAgent.ts:809`.
- Has its own teardown sweep, `sweepPcpUnfiledCall`
  (`src/voiceAgentRoutes.ts:4720-4726`).
- Gets the holding-update heartbeat and `pcpHandoffProgress`
  (`:4293-4348`).
- Is a ramp line, profile `professional` (`:4552`).

### azul-scheduling
`POST /api/voice/azul-scheduling`, `src/voiceAgentRoutes.ts:6471`. **OFF.**
- 3 s pre-context race instead of 1.5 s, plus a late-arrival write-through and a
  turn-boundary parking path (`:2911-3001`, applied at `:4129-4133`).
- Carrier-name lookup (`:2513-2526`).
- Files via `createLocationQueueTicket` → `create-ticket` with
  `queue:'location'` (`src/agents/azulSchedulingAgent.ts:658`,
  `server/services/ticketingApiClient.ts:693`), expanded server-side at
  `ticketing-app/.../create-ticket/route.ts:394-410`.
- Greeting style `replace` (`src/services/greetingPersonalisation.ts:79`).
- Has `sweepAzulUnresolvedCall` at teardown, `identityArgGuard`, the handoff
  ladder, and a 20-minute max duration
  (`src/services/callLifecycleCoordinator.ts:39`).

### The Grok runtime (all lanes)
`POST /voice/:slug` → `<Connect><Stream wss://host/voice/stream>` + `<Redirect
POST /voice/:slug/after>` (`src/runtime/voiceWebhook.ts:181-230`).
- **Validates the Twilio signature** (`:132-148`) and fails closed with
  HTTP 200 + spoken TwiML (`:154-163`).
- Audio comes through our process; a `VoiceCallBridge`
  (`src/runtime/mediaStreamBridge.ts:350`) owns marks, dead air
  (`DEFAULT_DEAD_AIR_MS = 30_000`, `:182`) and a 10-minute ceiling (`:171`).
- Agents and tools are **borrowed verbatim** from `src/config/agents.ts` via
  `laneRegistry`/`agentBinding` — no second registry
  (`src/runtime/laneRegistry.ts:1-40`). Lanes whose factory is not
  `(handoff, metadata)` (after-hours, drs-scheduler, …) are **refused**
  (`:66-80`).
- Own call-row lifecycle: `openRuntimeCall` before the first tool can run,
  `persistRuntimeCall` at teardown, `voiceProvider: 'grok'`
  (`src/runtime/callRecord.ts:343`, `:408`, `:374`).
- Own greeting resolution reusing the same two helpers
  (`src/runtime/voiceRuntime.ts:816-820`) plus a `chooseGreeting` guard (`:100`).
- Own transfer implementation (`src/runtime/runtimeTransfer.ts`), armed or
  refused once at mount with the reason logged
  (`src/runtime/voiceRuntime.ts:361-365`).

---

## WHERE STATE LIVES

Every per-call in-memory structure on the live SIP path. "Leaks?" answers
*could this entry outlive the call*.

### `src/voiceAgentRoutes.ts` — module scope

| Name | Line | Key | Written by | Released by | Leaks? |
|---|---|---|---|---|---|
| `activeCallTasks` | 196 | openai callId | `/realtime` `:5494` | task `.finally` `:5508` | No |
| `activeSessions` | 197 | openai callId | `:3194` | teardown `:4993` | No |
| `responseInFlight` | 208 | openai callId | `:3359` / `:3367` | teardown `:4994` | No |
| `pendingGreetings` | 235 | openai callId | `armGreetingGuarantee` `:320` | `:350`, `:4995` | No — 20 s window |
| `newCoreCalls` | 247 | openai callId | `:4468` | `:5017` | No (never set for optical) |
| `pendingHangups` | 257 | openai callId | `:3502` | `:5016` | No |
| `lastFactsRender` | 268 | openai callId | `:4144` | `:351`, `:4996` | No |
| `callMetadata` | 370 | conferenceName **and** callId | webhook `:6169` | `.finally` `:5510`,`:5514` | **Yes if the OpenAI webhook never arrives** — nothing else deletes it |
| `callIDtoConferenceNameMapping` | 371 | callSid then callId | `:6162`, `:5261` | `:5039` | **Yes** — keyed by callSid at `:6162`, deleted by callId at `:5039`; the callSid entry is never removed |
| `ConferenceNametoCallerIDMapping` | 372 | conferenceName | `:6163` | **never** | **Yes — unbounded** |
| `ConferenceNametoCalledNumberMapping` | 373 | conferenceName | `:6164` | **never** | **Yes — unbounded** |
| `ConferenceNametoCallTokenMapping` | 374 | conferenceName | `:6165` | **never** | **Yes — unbounded** |
| `conferenceNameToCallID` | 375 | conf name, conf SID, callSid | `:5261-5292`, `:7482-7487` | `:5038`, `:5048-5052` | Mostly no (reverse scan at `:5048`) |
| `openAIWebhookConfirmed` | 380 | conferenceName | `:5266` | **never** | **Yes — unbounded** |
| `conferenceNameToTwilioCallSid` | 381 | conferenceName | `:6166` | **never** | **Yes — unbounded** |
| `conferenceSidToCallLogId` | 382 | conference SID | `:2621`, `:7498` | `:7730` on recording completion only | **Yes** when no recording callback lands |
| `callerReadyResolvers` / `callerReadyPromises` | 458-459 | conferenceName | `:5748`,`:5894`,`:6532` | `:4281-4282`, `:5518-5519`, `:7590` | No (never created for optical) |
| `handoffReadyResolvers` | 463 | office-leg callSid | handoff path | `:7606` | Transfer path only |
| `pcpHandoffProgress` | 470 | openai callId | `:4335` | `:4678` | No |
| `pendingConferenceAgentAdditions` | 479 | conferenceName | agent-add path | `:5516` | No |
| `sipWatchdogs` | 500 | conferenceName | `:694`, `:756` | `:547`, `:565`, `:706`, `:717` | No — **but never populated for overflow lines at all** |
| `callTranscripts` | 821 | openai callId | `:3422`, `:3693`, `:3745` | `:5021` | No |
| `officeLegDials` | 866 | office-leg callSid | transfer path | transfer path | Transfer only |
| `callTokenUsage` | 1107 | openai callId | `accumulateUsage` `:3386` | `:4741` | No |
| `aircallDTMFSent` | 1133 | openai callId | `:3630` | `:5512` | No |
| `warmTransferAccepts` | 2035 | office-leg callSid | transfer path | transfer path | Transfer only |
| `activeOfficeLegsByCall` | 2045 | openai callId | transfer path | `:4672` | Transfer only |
| `abortedPcpHandoffs` | 2046 | openai callId | `:4671` | `setTimeout` 10 min `:4673` | No |
| `officeLegBridges` | 2067 | office-leg callSid | transfer path | transfer path | Transfer only |
| `toolStartedAt` | 3283 | `callId:toolName` | `:3285` | `:3297` | Per-session closure; an unfinished tool leaves one entry, freed with the session |

### Service modules

| Name | Module:line | Key | Written by | Released by | Leaks? |
|---|---|---|---|---|---|
| `timelines` | `src/services/toolTimeline.ts:57` | callId (falls back to callSid/callLogId) | `recordingExecute` | **2 h reaper**, `:599-615` — the flush deliberately never deletes (`:503-520`) | Bounded at 2 h |
| `ledgers` | `src/services/callFactsLedger.ts:67` | callId | `seedLedger`/`harvestCallerLine` | `releaseLedger` `:5012` | No |
| `buffers` (events) | `src/services/callEventLog.ts:68` | callId | `emitCallEvent` | `releaseCallEvents` `:5031` + reaper `:300` | Bounded |
| `clocks` | `src/services/callEventLog.ts:158` | callId | `markLatency` | same reaper | Bounded |
| `buffers` (turns) | `src/services/turnLog.ts:69` | callId | `recordTurn` | `releaseTurns` `:5029` + reaper `:220` | Bounded |
| `activeTraces` | `src/services/callDiagnostics.ts:68` | callId | `startTrace` `:5179` | `completeTrace` | Only if no terminal stage fires |
| `sessionCache` + 3 indexes | `src/services/callSessionService.ts:21-24` | conferenceName (+ 3 reverse) | `upsertSession` `:5277`, `:7502` | `deleteSession` `:5042` | Postgres-backed; the reverse indexes are the risk |
| `activeCalls`, `callIdMappings`, `cleanupTimeouts`, `pendingMappings`, `pendingTranscripts`, `bufferedTerminations`, `maxDurationTimeouts`, `dbResolvedTranscriptIds` | `src/services/callLifecycleCoordinator.ts:100-266` | callLogId + aliases | `registerCall` `:2610` | `finalizeCall` + its own stale sweep (`:1149`) | `pendingMappings` for a call that never registers is the exposure |
| `concluded`, `conferenceLinks` | `src/services/callConclusion.ts:26,51` | callId / conferenceName | `markCallConcluded`, `linkConferenceToCall` `:3245` | time-based | Bounded |
| `escalationDetailsMap` | `src/services/escalationStore.ts:18` | openai callId | escalate tools | `:1752` only | **Yes** on any call that escalates without reaching that path |
| `callerSpeech` | `src/services/symptomCorroboration.ts:42` | callId | `recordCallerSpeech` `:3596` | `releaseCallerSpeech`, called only from `flushLoopTelemetry` `:842` | **Yes** when `dbCallLogId` is missing |
| `sessions` (ramp) | `src/services/rampEngine.ts:79` | callId | `startRamp` | `releaseRamp` `:5014` | No |
| `attempts`, `attemptCounts` | `src/services/identityArgGuard.ts:213,215` | callId | azul only | `releaseIdentityGuard` `:5024` | No |
| `errorAttempts` | `src/services/toolDirection.ts:23` | callId+tool | non-queue agents | `releaseDirectionState` `:5013` | No |
| `conversations` | `src/core/conversationReader.ts:38` | callId | new-core lines | `releaseNewCoreCall` `:5015` | No |
| `pcpBindings`, `modules` | `src/core/router.ts:24,52` | callId / slug | `registerPcpBindings` `:4455` | `releaseNewCoreCall` | No |
| `holdingCallbacks`, `azulVerifiedCalls`, `handoffIdentityRefusals`, `handoffOfferMade`, `officeTransferCallbacks`, `transferBridgeCallbackIds`, `pendingBridgeUpdates`, `transferTargets`, `transferredCalls`, `failedTransferAttempts`, `transcriptProviders` | `src/agents/azulSchedulingAgent.ts:81-353` | callId | azul path | `releaseAzulCallState` `:5025` | azul only |
| `cache` (greetings) | `src/services/greetingResolver.ts:34` | agent slug | boot warm + per call | never — bounded by slug count | No |
| `cache` (ticket agent cfg) | `src/core/ticketAgentConfig.ts:22` | slug | TTL | TTL | No |
| `rateLimitStore` | `src/middleware/rateLimiter.ts:17` | `path:ip` | every webhook | 60 s sweep `:20-27` | No |
| `circuitBreakers` | `src/services/resilienceUtils.ts:326` | name | on demand | never — bounded set | No |
| `warned` | `src/config/agentCapabilities.ts:162` | slug | once per unknown slug | never — bounded | No |

### Grok runtime

| Name | Module:line | Released by | Leaks? |
|---|---|---|---|
| `CallSessionRegistry.entries` | `src/runtime/sessionRegistry.ts:51` | `consumeOutcome` + a 30-minute TTL sweep (`:48`, `:137`) | Bounded at 30 min |
| per-socket `pendingFrames`, `claimDeadline`, `setupDeadline`, `bridge` | `src/runtime/voiceRuntime.ts:470-505` | socket close/error handlers `:551-562` | No |
| brokered handoffs | released by `onOutcome` `:847`, plus the `finally` at `:924` for the no-bridge paths | Capped at 200 entries |

---

## THE FIVE PLACES A CALL CAN DIE WITHOUT A TICKET

Ranked by how often, using the measurements recorded in the source itself.

### 1. The office cannot be resolved, and dept 1 hard-requires one

`src/tools/sharedPatientTools.ts:272-277` (`resolve_location` refusal) and
`src/tools/opticalTools.ts:210-238` (`file_optical_ticket` refusal), with the
server-side backstop at `ticketing-app/lib/voice-agent/routing-gate.ts:353-361`
→ HTTP 400 at `ticketing-app/app/api/voice-agent/create-ticket/route.ts:496-505`.

Measured, first live day 2026-08-13 (`sharedPatientTools.ts:246-270`):
`resolve_location` ran **41 times across 29 optical calls**; **32 returned
`verified:false`**; five calls looped it three or more times, one **ten times with
identical arguments**; those five averaged **229 s** against 134 s; **none ended
resolved**. Separately, 2026-08-31 (`opticalTools.ts:196-207`): the n8n
execution cap took `lookupProviderAndLocation` down and **43 callers** were told
"I'm not finding an office by that name" about real offices.

Visible: `[TOOLS] ← resolve_location Nms refused:spoken_location`,
`[Optical] ✗ LOCATION LOOKUP UNAVAILABLE`, `[Voice Agent API] Routing gate REJECTED`.

### 2. The caller hangs up before `file_optical_ticket` runs

Closed on the old-core queue path, 2026-09-03. The terminal-disposition sweep
used to be gated to azul and pcp; the four live queue lanes
(optical / surgery / tech / records) fell through to `Promise.resolve()`.
Those lanes have no `terminate_call`, so hangup never built a payload.

`sweepQueueUnfiledCall` now runs on teardown for those four slugs. It files
from conversation state already on the call (`queueCallState` +
`verifiedIdentity`) through `createTicketDurable`. A failed POST goes to the
outbox. It does not invent a ticket number and it does not re-resolve an
office or a surgeon.

Still not covered here: answering-service (different tools), the Grok
runtime, a ghost call with no stated request, and a hangup that never
identified anyone.

Visible: `[QUEUE SWEEP] <slug>: hangup with no ticket — filing from conversation state`,
then `✓ filed VA-…` or `✓ CAPTURED as <outboxId>`. A hangup that stated a
request and still has `call_logs.ticket_number` NULL with no outbox row
means the pull did not take.

### 3. The POST fails — gateway down, timeout, non-JSON, or a 400 from the gate

`server/services/ticketingApiClient.ts:504-509` (JSON parse), `:511-525`
(non-OK → throw), `:534-551` (abort / network), all caught at `:662-668` →
`{success:false}` → `src/tools/opticalTools.ts:381-387` returns
`{retryable:true}` and **nothing is persisted anywhere**. The 15 s request bound
is `:456`; the pre-request warm-up can add up to ~6.5 s before it
(`:248-283`).

Visible: `[TICKETING API] ✗ Request timed out after 15000ms`,
`[TICKETING API] ✗ Failed to create ticket`, `[TOOLS] ← file_optical_ticket Nms error:…`,
plus the shadow tap's `n8n_workflow_failed` (`:537`).

### 4. The OpenAI SIP accept fails all 8 attempts

`src/voiceAgentRoutes.ts:3959-4010` (the loop; **404 is the only retryable
status**, `:3996-4000`), failure handling at `:4012-4070`. The caller hears the
apology line and is hung up (`:4043-4049`); the call log is marked `failed`
(`:4054-4063`). No agent ever spoke, so no ticket is possible.

Visible: `[TRACE-4] ✗✗✗ NON-RETRYABLE ERROR`,
`[SESSION] ✗ All 8 accept attempts failed`, `CallDiagnostics` trace
`accept_failed` (`:5501`).

### 5. The SIP participant never joins the conference

`src/voiceAgentRoutes.ts:6230-6244`. The overflow factory adds the participant
inline with a bare `try/catch`. There is **no watchdog** on this path — that
machinery (`addSIPParticipantWithWatchdog`, `:583`, retries at `:745`,
max-duration ceiling at `:750-754`, spoken fallback at `:711-735`) is wired only
to `/api/voice/no-ivr` (`:5791`). The Twilio client failing to initialise
(`:6217-6220`) has the same effect. With `waitUrl=""` (`:6192`) the caller hears
**silence** until they hang up.

Visible: `[OPTICAL] ✗ Failed to add agent to conference` (`:6243`) or
`✗ Failed to initialize Twilio client` (`:6218`) — one line, then nothing.

**Runner-up, documented in the source but not counted above:** the wrong agent
answers. With the `X-agentSlug` SIP header missing and the 500 ms phone lookup
losing to a cold Neon connection (`:5411-5415`), the call falls through to
`after-hours` (`:5357`, `:5485`). The comment at `:5375-5387` records that
"Optical's first three live calls each died at a different enumerated list."

---

## DUPLICATION INDEX

Each of these does one job in more than one place. Recorded, not judged.

1. **Two complete transports** — SIP conference (`src/voiceAgentRoutes.ts`) and
   Grok media stream (`src/runtime/`). Each has its own webhook, greeting
   resolution, pre-context fetch, dead-air watchdog, call-row write and teardown.
2. **Four ticket-filing routes**, with different durability and different
   server-side behaviour: `createTicket` (queue tools, no outbox),
   `SyncAgentService` → `ticket_outbox` → `createTicket` (answering-service,
   no-ivr), `submitTicket` → `/submit-ticket` (re-derives the department, defaults
   to 8), `createPcpTicket` → `/pcp-ticket` (bypasses n8n),
   `createLocationQueueTicket` (azul).
3. **Post-call enrichment in four places** — `observeCall`'s `setTimeout` block
   (`:4846-4986`), the coordinator's `call-ended` listener (`:8073-8192`),
   `/api/voice/recording-status` (`:7695-7727`), and `ticketingSyncService`'s
   5-minute sweeper. All four call `updateTicketCallData`; the first two also both
   grade the call and recalculate cost.
4. **Two patient-lookup tools over the same service** — `lookup_patient`
   (`src/tools/sharedPatientTools.ts:64`) and `lookup_schedule`
   (`src/agents/answeringServiceAgent.ts:732`, `src/agents/noIvrAgent.ts:938`).
5. **`check_open_tickets` declared twice** — `src/tools/sharedPatientTools.ts:325`
   and `src/agents/answeringServiceAgent.ts:858`.
6. **Two tool-telemetry wrappers** — `recordedTool`
   (`src/agents/answeringServiceAgent.ts:635`, `src/agents/pcpAgent.ts:505`) and
   `realtimeToolsFor`/`recordingExecute` (`src/tools/realtimeAdapter.ts:201`).
7. **Two agent allowlists** — `src/voiceAgentRoutes.ts:5353` and `:2297`; they do
   not contain the same slugs.
8. **Two conference/caller-id stores** — the legacy plain objects
   (`:371-382`) and `callSessionService` (`src/services/callSessionService.ts:21-24`),
   bridged by the wrappers at `:396-451`.
9. **The audio/transcription/VAD block written five times** — `:800-815`,
   `:3165-3181`, `:3845-3867`, `:3889-3914`, `:4520-4535`.
10. **The optical greeting string written three times** — `:6262-6265`,
    `src/agents/opticalAgent.ts:74-77`, `src/config/agents.ts:117` — all three
    outranked at runtime by `agents.welcome_greeting`.
11. **Two duration writers** — `callLifecycleCoordinator.finalizeCall`
    (`src/services/callLifecycleCoordinator.ts:836-854`, local measurement) and
    the Twilio status callback (`src/voiceAgentRoutes.ts:7931-7956`).
12. **Two timeline flush owners plus a per-tool flush** —
    `src/voiceAgentRoutes.ts:4729`, `:8079-8080`, and
    `src/tools/realtimeAdapter.ts:175`.

---

## UNKNOWNS

- **UNKNOWN — the optical DID.** `agentRegistry` carries `twilioNumbers: []`
  (`src/config/agents.ts:112`), `twilio-inventory.md` has no optical entry, and
  the code comment at `src/voiceAgentRoutes.ts:6256-6257` still says "Until that
  number exists the route is harmless" while CLAUDE.md's line-status table says
  optical is LIVE. Settling it needs the live Twilio console or a fresh
  `twilio-inventory.md`.
- **UNKNOWN — whether the optical number has a call-level Status Callback.** The
  conference TwiML sets only the conference and recording callbacks
  (`src/voiceAgentRoutes.ts:6197-6202`); `/api/voice/status` is configured
  per-number and is only documented for `+19094135645`
  (`twilio-inventory.md:68`). Without it, §7d.3 never runs for optical and
  Twilio's authoritative duration and cost never land.
- **UNKNOWN — whether `TICKETING_SYSTEM_URL` currently points at n8n or at the
  app.** Both are strings in the environment (`.env.production.example:45-48`);
  the distinction decides whether `create-ticket` rides the n8n gateway, which
  is what took optical to zero on 2026-08-31. Settling it needs the live Replit
  secret.
- **UNKNOWN — whether `TICKETING_ENRICHMENT_URL` is set.** The comment at
  `server/services/ticketingApiClient.ts:312-314` says it was unset as of
  2026-08-17; if it is now set, the warm-up probe and `create-ticket` address
  different hosts (`:294-301`).
- **UNKNOWN — the runtime cutover state for optical.** `mountVoiceRuntime` is
  unconditional (`server/index.ts:402-424`) and `/voice/optical` will answer, but
  no number is known to point at it. Settling it needs the Twilio console.
- **UNKNOWN — `DEAD_AIR_TIMEOUT_MS`, `RAMP_AGENTS`, `NEW_CORE_LINES`,
  `TICKET_AGENT_LINES`, `VOICE_ROUTING_GATE`, `TRANSCRIPTION_MODEL` in
  production.** None appear in `.replit`, so the code defaults in
  `src/services/deadAirWatchdog.ts:69`, `src/voiceAgentRoutes.ts:238`,
  `src/core/router.ts:29`/`:37`,
  `ticketing-app/lib/voice-agent/routing-policy.ts:41` and
  `src/config/transcription.ts:81` are what this document assumes. Settling it
  needs the live Replit secrets panel.
