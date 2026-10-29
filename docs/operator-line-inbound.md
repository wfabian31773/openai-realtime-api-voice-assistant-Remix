# Wayne operator line: inbound

Set the operator number's Twilio **A call comes in / Voice URL** to
`https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app/api/voice/operator-line/inbound`,
with **HTTP POST**. The number must match `OPERATOR_LINE_FROM_NUMBER` (the operator line ending **2660**).
Optionally set its call status callback to the same URL plus `/status`, also POST,
to finalize calls that never establish a media stream. The returned TwiML also
configures signed stream status callbacks there and a signed `/after` redirect.
The public server handles these paths directly, alongside `/voice/stream`.
All three POST routes validate `X-Twilio-Signature` against the forwarded public
protocol/host and original URL using the existing runtime validator. Invalid or
missing signatures return 403, including when the feature is off.

The assistant identifies itself as Wayne Fabian's operator line, discloses AI
and recording, takes a nonmedical request, reads it back, saves the confirmed
summary, and ends. It has only `end_call`, `record_call_outcome`, and
`opt_out_of_calls`. It does no patient lookup, identifier collection, or ticket
creation. Opt-outs use the same US voice DNC/international operator DNC storage
that outbound operator calls check. Anonymous callers cannot receive a persisted
number-based opt-out; the assistant must not claim it succeeded.

## Configuration

- `OPERATOR_LINE_INBOUND_ENABLED=true` enables admission; any other value plays
  a polite unavailable message and hangs up.
- `OPERATOR_LINE_FROM_NUMBER`: the existing operator number, in E.164 format.
- Existing runtime settings: `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID` (recording),
  `XAI_API_KEY`, and `DATABASE_URL`. Keep the existing operator agent enabled.
  This uses the deployed voice runtime and its recording starter; it does not
  require enabling outbound dialing, plugin writes, or an outbound campaign.
- `OPERATOR_INBOUND_NOTIFIER=none|webhook|github`: default `none`. Incomplete or
  unknown notifier configuration is a no-op. Secrets belong in Replit Secrets.
- Webhook: `OPERATOR_INBOUND_WEBHOOK_URL` (HTTPS) and
  `OPERATOR_INBOUND_WEBHOOK_SECRET`.
- GitHub: `OPERATOR_INBOUND_GITHUB_REPO` (`owner/repo`, for example
  `wfabian31773/ai-bridge`), `OPERATOR_INBOUND_GITHUB_ISSUE` (positive issue/PR
  number), and `OPERATOR_INBOUND_GITHUB_TOKEN` (permission to comment).

Notifications run after durable completion, with a three-second timeout per
attempt and one retry. Delivery failure never breaks a call. Delivery is best
effort, without a durable delivery queue; receivers should deduplicate by call id
because a timeout can occur after the receiver accepts a request.

## Webhook contract

JSON fields: `event` (`operator_line.inbound_completed`), `call_id`, `call_sid`,
`started_at`, `ended_at` (ISO timestamps), `duration_seconds`, `caller_last4`
(string or null), `opted_out` (boolean), and `transcript_url`.
The payload contains no transcript, request summary, or full caller number.

For verification, preserve the **raw request body bytes**, read the Unix-seconds
`X-Operator-Timestamp` header, and compute HMAC-SHA256 with the shared secret over
the timestamp, a literal period, and those exact body bytes. Compare
`sha256=` plus the lowercase hex digest to `X-Operator-Signature`, using a
constant-time comparison after checking lengths. Reject stale timestamps (for
example, outside five minutes) and duplicate call ids. Do not reserialize JSON
before checking its signature.

GitHub mode posts exactly three lines: the fixed marker
`<!-- operator_line.inbound_completed -->`, the call id, and the authenticated
fetch URL. It never includes transcript, summary, or caller digits.

## Authenticated fetch and storage

`GET /api/plugin/v1/operator-line/inbound/:callSid` requires a valid bot bearer
token with `operator:call`. Tokens with `contacts:approve` are refused. Any
explicitly scoped operator bot can retrieve these inbound records; inbound calls
have no initiating bot owner. Other calls return 404. Responses use
`Cache-Control: no-store`; audits contain route templates and outcomes, never
transcripts, summaries, or caller numbers. The returned JSON includes transcript,
full caller number (or null), confirmed request summary (or null), timestamps,
status, and opt-out state. The fetch URL carries no credentials: the bot adds
its own bearer token. No list endpoint is provided.

Apply `migrations/add_operator_line_inbound.sql` separately before enabling the
feature. **It has not been applied by this change.** The additive, idempotent
migration creates the RLS-enabled `plugin_operator_inbound_calls` table beside
the existing outbound tables from `add_operator_line.sql`. The production plugin
store must be mounted successfully; admission fails closed if durable storage
is unavailable. Full numbers and transcripts stay in the database and the
authenticated fetch response, never notification payloads or logs. Interrupted
calls can have no confirmed summary. Transcripts are finalized by the existing
bridge on teardown; status callbacks finalize calls that never claim a stream.
