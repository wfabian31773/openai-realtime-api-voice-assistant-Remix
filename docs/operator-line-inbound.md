# Grok Bot operator line: inbound

Set the operator number's Twilio **A call comes in / Voice URL** to
`https://<public-host>/api/voice/operator-line/inbound`, with **HTTP POST**.
The number must match `OPERATOR_LINE_FROM_NUMBER`. Optionally set its call
status callback to the same URL plus `/status`, also POST. Returned TwiML
configures stream status callbacks there and an `/after` redirect.
All three POST routes validate `X-Twilio-Signature` using the forwarded public
protocol/host and original URL. Missing or invalid signatures return 403,
including when the feature is disabled.

Grok Bot identifies itself as an AI assistant, discloses recording, respects
consent, and holds a free-form two-way conversation. There is no turn limit,
script, readback workflow, calling window, caller allowlist, or request count
cap. Only the configurable safety duration bounds a healthy conversation.
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

- `OPERATOR_LINE_INBOUND_ENABLED=true`: enables inbound admission.
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
- GitHub: `OPERATOR_INBOUND_GITHUB_REPO` (`owner/repo`),
  `OPERATOR_INBOUND_GITHUB_ISSUE` (positive issue/PR number), and
  `OPERATOR_INBOUND_GITHUB_TOKEN` (permission to comment).

Keep secrets in the deployment's secret store. Notifications use a three-second
attempt timeout and one retry. Delivery is best effort, without a durable
retry queue; storage is durable, and delivery failures never break a call.
A process restart can interrupt outstanding notification attempts.

## Signed webhook contract

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
`initiated_by` to the existing operator call log. The production plugin store
must be available; admission fails closed without durable storage. Requests,
full numbers, and transcripts stay in the database and authenticated fetch,
never alerts or logs. The bridge finalizes transcripts on teardown; signed
status callbacks finalize calls that never establish a stream.

Outbound goal mode and its approval policy are documented in
[operator-line/README.md](operator-line/README.md). SI support, patient flows,
and staff permissions retain their existing behavior.
