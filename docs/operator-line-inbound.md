# Grok Bot operator line: inbound

Set the operator number's Twilio **A call comes in / Voice URL** to
`https://<public-host>/api/voice/operator-line/inbound`, with **HTTP POST**.
The number must match `OPERATOR_LINE_FROM_NUMBER`. Optionally set its call
status callback to the same URL plus `/status`, also POST. Returned TwiML
configures stream status callbacks there and an `/after` redirect.
All operator voice/SMS POST routes validate `X-Twilio-Signature` using the forwarded public
protocol/host and original URL. Missing or invalid signatures return 403,
including when the feature is disabled.

Grok Bot identifies itself as an AI assistant, discloses recording, respects
consent, and holds a free-form two-way conversation. There is no turn limit,
script, readback workflow, calling window, caller allowlist, or request count
cap. There is **NO daily cap and NO peak window** for inbound or outbound
operator calls. Operator calls bypass campaign scheduling, calling windows,
usage caps and retries, including during nights, weekends and holidays.
Only the configurable safety duration bounds a healthy conversation.
Matching `OPERATOR_OWNER_NUMBER` selects the full personal-assistant persona;
other callers get a polite general persona with no owner-private context.
Spoken claims of ownership do not change that selection. Owner context is not
invented or fetched from patient records.

The operator tools are `end_call`, `queue_request_for_grok_bot`, and
`opt_out_of_calls`. Queuing a request does not end the call or require a
confirmation ritual. The tool saves the request privately before returning
`{success: true, status: "queued", request_id: "..."}`. Webhook delivery runs
in the background, so a slow or failed notifier cannot stall conversation.
Queued means saved for Grok Bot, not delivered, performed, or promised.

There is no patient lookup, patient verification, or ticket creation. Opt-outs
use the same US voice DNC/international operator DNC stores that outbound
operator calls check. Anonymous callers cannot receive a persisted number-based
opt-out; Grok Bot must not claim it succeeded.

## Configuration

- `OPERATOR_LINE_INBOUND_ENABLED=true`: hard gate for the entire operator
  line: inbound voice, SMS, voicemail admission and outbound calls. Any other
  value disables it, regardless of the persisted staff switch.
- `OPERATOR_LINE_FROM_NUMBER`: operator Twilio number in E.164; must differ
  from the SI Assistant number.
- `OPERATOR_OWNER_NUMBER`: owner's number in E.164. Unset or invalid values
  select the general persona for every caller; no owner number is hardcoded.
- `OPERATOR_LINE_MAX_CALL_MINUTES`: safety maximum for operator conversations;
  defaults to **60**. Invalid, nonpositive, or timer-overflow values fall back
  to 60. Applies to inbound and the default outbound duration. Operator
  sessions remain available beyond the patient registry's shorter expiry.
- Existing runtime settings: `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID`
  (recording), `XAI_API_KEY`, and `DATABASE_URL`. Keep the operator agent enabled.
  Inbound does not require outbound dialing, plugin writes, or a campaign switch.
- `OPERATOR_INBOUND_NOTIFIER=none|webhook|github`: default `none`. Unknown or
  incomplete configuration is a no-op; saved requests remain fetchable.
- Webhook: `OPERATOR_INBOUND_WEBHOOK_URL` (HTTPS) and
  `OPERATOR_INBOUND_WEBHOOK_SECRET`.
- `OPERATOR_INBOUND_WEBHOOK_AUTH=hmac|bearer|both`: default **both**.
  `hmac` sends `X-Operator-Timestamp` and `X-Operator-Signature`; `bearer`
  sends `Authorization: Bearer <OPERATOR_INBOUND_WEBHOOK_SECRET>`; `both`
  sends all three headers. Unknown auth modes disable notification delivery.
  Existing notifier env names and GitHub mode remain supported.
- GitHub: `OPERATOR_INBOUND_GITHUB_REPO` (`owner/repo`),
  `OPERATOR_INBOUND_GITHUB_ISSUE` (positive issue/PR number), and
  `OPERATOR_INBOUND_GITHUB_TOKEN` (permission to comment).

Keep secrets in the deployment's secret store. Notifications use a three-second
attempt timeout and one retry. Delivery is best effort, without a durable
retry queue; storage is durable, and delivery failures never break a call.
A process restart can interrupt outstanding notification attempts.

## Signed webhook contract

Webhook delivery defaults to **both** bearer and HMAC authentication with
the same shared secret. Receivers in this mode must validate both. Choose
`hmac` for compatibility with an existing signature-only receiver, or
`bearer` for a receiver using bearer authentication. Secrets and provider
responses are never logged. Redirects are refused to protect credentials.

Mid-call events use `event: "operator_line.request_queued"` and `request_id`.
Hangup emits `event: "operator_line.inbound_completed"` once after durable
completion, with the transcript reference and the full queued request list.
Both include:

- `call_id`, `call_sid`, `transcript_url` (authenticated fetch URL).
- `queued_requests`: objects containing only `request_id` and `request_url`.
  Each URL is the fetch URL plus `#request-<id>`; fetch the JSON and select
  the matching `queuedRequests[].id`. Mid-call events list the new request;
  final events list all saved requests, including an empty list if none.
- `started_at`, `ended_at` (null until completion), `duration_seconds`
  (zero until completion), `opted_out`, and `caller_last4` (string or null).

Alerts never contain request text, transcript text, PHI, or full phone numbers.
Only the last four caller digits appear. Receivers should deduplicate using
`(event, call_id, request_id)`; final events use `(event, call_id)`. Mid-call
and final deliveries may arrive out of order. Fetch remains authoritative.

To verify, preserve the **raw body bytes**, read Unix-seconds
`X-Operator-Timestamp`, and compute HMAC-SHA256 using the shared secret over
`timestamp + "." + rawBody`. Compare `sha256=` plus the lowercase hex digest
to `X-Operator-Signature` with a constant-time comparison after checking lengths.
Reject stale timestamps (for example, outside five minutes) and duplicates.
Do not reserialize JSON before checking its signature.

SMS emits `event: "operator_line.sms_received"`, `message_sid`,
`message_url` (authenticated fetch) and `caller_last4`. It never sends the
body, media, or full caller number. Repeated Twilio MessageSids are stored
once and do not produce additional alerts.

Voicemail emits `event: "operator_line.voicemail_received"`, `call_sid`,
`recording_sid` and `voicemail_url` (authenticated fetch). These are IDs and
links only; the recording URL and transcript never appear in alerts.
Recording and transcription may generate separate updates; deduplicate by
event and recording SID, then refetch the current record. Duplicate unchanged
callbacks do not generate additional alerts.

GitHub mode posts a fixed event marker, the call id, authenticated fetch URL,
and queued request URLs, each on its own line. It never includes request or
transcript text, or caller digits.

## Authenticated fetch and storage

`GET /api/plugin/v1/operator-line/inbound/:callSid` requires a valid bot bearer
token with `operator:call`. Tokens with `contacts:approve` are refused. Any
explicitly scoped operator bot can retrieve an inbound record; there is no
initiating bot owner. Other calls return 404. Responses use `Cache-Control:
no-store`. Audits hold route templates and outcomes, never caller information,
requests, or transcripts. The JSON includes full caller number (or null),
`queuedRequests` (`id`, `text`, `createdAt`), transcript, timestamps, status,
and opt-out state. Add the bearer token in the authorization header; URLs
carry no credentials. There is no list endpoint.

Apply `migrations/add_operator_line_inbound.sql` separately before enabling
this feature. **It has not been applied by this change.** It creates the
RLS-enabled inbound table with `queued_requests` JSONB and adds outbound
`initiated_by` to the existing operator call log. It also seeds
`app_settings.operator_line_enabled=true` without overwriting staff decisions,
and creates RLS-enabled `plugin_operator_sms` and
`plugin_operator_voicemails`. The production plugin store
must be available; admission fails closed without durable storage. Requests,
full numbers, and transcripts stay in the database and authenticated fetch,
never alerts or logs. The bridge finalizes transcripts on teardown; signed
status callbacks finalize calls that never establish a stream.

## Staff kill-switch

The **Voice Agents** page in `client/` has a Grok Bot operator line switch.
It uses the existing staff session authentication. Reading the setting uses
the same authenticated access as other readable app settings; changing it
uses the existing **admin** role check. No staff role or permission is changed.

`GET /api/settings/operator-line` returns `enabled` (persisted staff choice),
`environmentEnabled` and `effectiveEnabled`. Admins can
`PUT /api/settings/operator-line` with `{ "enabled": false }` or `true`.
Responses are not cached. The effective state is the persisted choice AND
the env flag. Missing rows inherit the env default; storage errors fail closed.
The setting is read on each admission, with another check immediately before
outbound dialing and at media-stream setup; it is not cached per process.

When disabled, inbound voice politely declines and hangs up without offering
recording; SMS returns empty TwiML without accepting a new message. Outbound
preparation and dialing are refused, including approvals prepared before the
switch was disabled. A call already streaming is not forcibly disconnected.
Already accepted recording callbacks still save their data, and scoped fetch
routes remain available while admission is disabled.

## SMS and voicemail

Set the operator number's Twilio **A message comes in** URL to
`https://<public-host>/api/voice/operator-line/sms` (**POST**). The `To` number
must match the operator line. SMS is saved before best-effort notification,
then the handler returns empty TwiML. Persistence failures return 503 so
Twilio can retry; the operator route does not enter the SI/patient SMS flow.

If realtime is not ready, or setup fails and Twilio reaches the post-stream
redirect, the enabled line offers a voicemail. It discloses recording and
returns `<Record>` with an explicit action, recording callback and
transcription callback. Recording is limited to 120 seconds for
[Twilio native transcription](https://www.twilio.com/docs/voice/twiml/record).
Set Twilio's **Voice Fallback URL** to
`https://<public-host>/api/voice/operator-line/fallback` (**POST**) as well.
Durable call admission must succeed before recording is offered.

The signed voicemail callback accepts only CallSids already admitted to the
operator inbound table; it cannot attach a recording to an SI/patient call.
Recording and transcription callbacks merge atomically by RecordingSid, in
either order, without clearing data omitted by another callback. The recording
URL and transcript are persisted privately. Fetching a voicemail returns the
recording URL; accessing the actual audio still uses Twilio's recording access
controls. Native transcription may fail or be unavailable for a short recording;
the recording reference remains available without a transcript.

| Route | Auth / result |
| --- | --- |
| `POST /api/voice/operator-line/inbound` | Twilio signature, number and both switches; realtime or voicemail TwiML. |
| `POST /api/voice/operator-line/inbound/after` | Twilio signature; clean hangup or setup-failure voicemail fallback. |
| `POST /api/voice/operator-line/inbound/status` | Twilio signature; finalizes calls without a claimed stream. |
| `POST /api/voice/operator-line/sms` | Twilio signature, number and both switches; persists SMS, empty TwiML. |
| `POST /api/voice/operator-line/fallback` | Twilio signature, number and both switches; voicemail TwiML. |
| `POST /api/voice/operator-line/voicemail` | Twilio signature and existing operator CallSid; saves recording/transcription, empty TwiML. |
| `GET /api/plugin/v1/operator-line/inbound/:callSid` | Bot bearer scope `operator:call`; private inbound conversation and requests. |
| `GET /api/plugin/v1/operator-line/sms/:messageSid` | Bot bearer scope `operator:call`; private body, caller number, timestamps and IDs. |
| `GET /api/plugin/v1/operator-line/voicemail/:recordingSid` | Bot bearer scope `operator:call`; private recording URL, transcript, status, timestamps and IDs. |
| `GET /api/settings/operator-line` | Existing staff session authentication; switch and effective state. |
| `PUT /api/settings/operator-line` | Existing staff session authentication and admin role; persist switch. |

All plugin fetches use `Cache-Control: no-store`, deny `contacts:approve`
tokens, return 404 for unknown IDs, and audit route templates/outcomes without
message or recording content. These routes expose no unauthenticated bodies.

## Optional outbound test scenarios

`test-bench/packs/pack-01.md` is vendored from **ai-bridge PR #32**, branch
**claude/test-bench**, source `/workspace/opline-pack-01.md`. The loader parses
scenarios **A1–A10** into `id`, `title`, `dial`, `caller`, `script`, and `expect`,
including wrapped Markdown and A3's build/baseline expectations.

To use a scenario as an outbound free-form goal, post to
`/api/plugin/v1/prepare_operator_call` with e.g.
`{ "phone": "+15555550123", "scenario_id": "A1", "initiated_by": "owner_request" }`
instead of `purpose`. `phone` remains the explicitly chosen E.164 destination;
`dial` describes the target lane and does not dial or configure that lane.
The scenario becomes the locked goal through the ordinary operator approval
and live-commit path. Ordinary `purpose` goals remain supported; unknown
scenario IDs or conflicting goals return 400. There is **no fingerprint
gating**. Scenario selection never changes the called patient agent, adds
patient tools to the operator, or changes staff permissions.

Outbound goal mode and its approval policy are documented in
[operator-line/README.md](operator-line/README.md). SI support, patient flows,
and staff permissions retain their existing behavior.
