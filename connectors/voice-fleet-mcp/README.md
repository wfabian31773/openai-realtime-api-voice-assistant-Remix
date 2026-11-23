# voice-fleet MCP

Zero-dependency stdio MCP server for the voice-agent fleet plugin API (`/api/plugin/v1`, fleet PRs #366/#367).

Tools: reads (`voice_fleet_health`, `list_agents`, `agent_health`, `fleet_today`, `recent_outcomes`, `outbound_status`, `approval_status`, `email_replies`) and writes (`prepare_call`, `prepare_text`, `prepare_email`, `commit`, `cancel`, `commit_call_live`, `live_call_status`, `live_call_instruct`, `live_call_end`, `capabilities`). No approve/reject tool; an approve token file is refused.

Flow: prepare_* -> Wayne approves on Support Center "Pending bot actions" (mints 5-min confirm token) -> commit(approvalId, confirmToken).

Env: `VOICE_FLEET_TOKEN_FILE` (required; token needs `fleet:read,contacts:prepare,contacts:commit`), `VOICE_FLEET_BASE_URL`, `VOICE_FLEET_TIMEOUT_MS`.

Output masking: phone numbers show last 4 only; names, DOB, bodies, subjects, emails and tokens are redacted.

Test: `VOICE_FLEET_TOKEN_FILE=... node test.mjs` (unit + live reads only).

## Live calls and confirm-token hand-off (needs fleet PR #380 deployed)
- `voice_fleet_capabilities` reports which features the fleet has. `commit_call_live`, `live_call_status`, `live_call_instruct` and `live_call_end` refuse locally, without sending, until `liveCalls` is true.
- `commit` and `commit_call_live` take `confirmToken` as optional. If it's omitted, the server fetches it once via `GET contact_requests/:id/confirm_token`. This only works for the bot token that prepared the request, and only after Wayne approves. The token is never shown.
- Live transcripts are returned with phone numbers and emails masked. Live-call state lives only in fleet memory.
- Offline test: `node test-offline.mjs` (uses a mock fleet; no network).

## Operator-line reads (Remix #402, scope `operator:call`)
`voice_fleet_operator_inbound_get` (callSid CA+32hex), `voice_fleet_operator_sms_get` (messageSid SM|MM+32hex), `voice_fleet_operator_voicemail_get` (recordingSid RE+32hex) -> `GET /api/plugin/v1/operator-line/{inbound,sms,voicemail}/:sid`. Bad SIDs are refused locally; bodies, transcripts, names, URLs redacted; phones last-4; emails masked. Offline test: `node test-operator-offline.mjs`.

## Operator-line SMS send (Remix operator-line/sms/send, scope `operator:call`)
`voice_fleet_operator_sms_send` (to, body, idempotency_key[, initiated_by]) -> `POST /api/plugin/v1/operator-line/sms/send`. Sends from the operator number with no hours window or caps; to OPERATOR_OWNER_NUMBER it sends immediately, any other number gets a pending approval; opt-out always blocks; a repeated idempotency_key sends once. Body is never logged or echoed; phones last-4. Inputs validated locally.
