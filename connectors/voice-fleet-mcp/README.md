# voice-fleet MCP

Zero-dependency MCP connector for the fleet plugin API (`/api/plugin/v1`).
Version **4.0.0** shares one core between stdio and a stateless Streamable
HTTP endpoint on the public Express app. **Hosted support is built, not deployed.**

Provenance: imported from the box connector snapshot **681b21d** in commit
`b7f9b822`; the import replaced phone examples with synthetic 555 numbers.

## Grok Bot Team Bots: Remote HTTPS

After this change is published, use:

`https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app/api/plugin/v1/mcp`

1. Add a plugin to the Team Bot and choose **Remote HTTPS**.
2. Paste the endpoint URL above.
3. Add header `Authorization` with value `Bearer <plugin token>` using an
   existing fleet plugin token (`si.<jti>.<secret>`). Keep the value private.
4. Save and test discovery: `initialize` reports `voice-fleet-mcp` version
   `4.0.0`; `tools/list` returns **26 tools**.

The endpoint authenticates every request with the same stored token lookup,
revocation/expiry checks and hashed-secret verification as the REST API.
There is **no new scope**: tool execution forwards the caller's exact bearer
to the fleet API, which enforces its existing scopes, approval rules and
write switches. Typical bot scopes are `fleet:read,contacts:prepare,contacts:commit`;
`operator:call` and `calls:direct` remain explicit grants. Do not give bots
`contacts:approve`. No approval/rejection tool is exposed.

HTTP uses POST with plain JSON replies, supports JSON-RPC batches in input
order and returns 202 with no body for notifications only. It keeps no MCP
session and opens no SSE stream. Invalid JSON returns 400 / `-32700`, bodies
over 1 MB return 413, and authenticated GET/DELETE return 405 with `Allow: POST`.
Missing, invalid, expired or revoked bearers return 401 with
`WWW-Authenticate: Bearer realm="voice-fleet-mcp"`, before body parsing.

The public API server is `server/index.ts`, `API_PORT` default **5000**.
The hosted connector calls `http://127.0.0.1:${API_PORT || 5000}` by default;
`VOICE_FLEET_MCP_INTERNAL_BASE_URL` overrides that trusted internal origin.
Request host/forwarding headers and the stdio token file are never used to
select the hosted upstream or its credential. `VOICE_FLEET_TIMEOUT_MS`
defaults to 30000. Tokens and request/response bodies are never logged by
the connector or transport.

## Stdio

Run `node connectors/voice-fleet-mcp/server.mjs` from the repo root. Existing
newline-delimited JSON-RPC input/output and environment settings are retained:

| variable | default / behavior |
|---|---|
| `VOICE_FLEET_TOKEN_FILE` | `/home/box/.secrets/voice-fleet-bot.token`; read afresh for each fleet call; file paths containing `approve` are refused |
| `VOICE_FLEET_BASE_URL` | `https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app` |
| `VOICE_FLEET_TIMEOUT_MS` | `30000` |

`core.mjs` exports `createVoiceFleetMcp({ baseUrl, getToken, timeoutMs })`.
`handleMessage(message)` returns the JSON-RPC reply, or null for notifications;
it performs no stdin/stdout I/O. Masking and operator preparation helpers
remain exported from both the core and the stdio shell.

## Tools and approval flow

All names have the `voice_fleet_` prefix; there are 26 tools:

- Fleet reads: `health`, `list_agents`, `agent_health`, `fleet_today`,
  `recent_outcomes`, `outbound_status`, `approval_status`, `email_replies`, `capabilities`.
- Contact actions: `prepare_call`, `prepare_text`, `prepare_email`, `commit`, `cancel`.
- Live calls: `commit_call_live`, `live_call_status`, `live_call_instruct`,
  `live_call_end`, `call_direct`.
- Operator line: `operator_prepare_call`, `operator_commit_call`, `get_transcript`,
  `operator_inbound_get`, `operator_sms_get`, `operator_voicemail_get`, `operator_sms_send`.

Prepare → Wayne approves on Support Center **Pending bot actions** → commit.
Approval mints a five-minute, single-use confirm token. `commit`,
`commit_call_live` and `operator_commit_call` accept either `confirmToken` or
`id` (the prepared approval's id). With `id` and no confirmToken, the core
fetches `GET /contact_requests/:id/confirm_token` once and passes the token
directly to commit without displaying it. Only the preparing bearer can
retrieve it, after approval. Omitting **both** `id` and `confirmToken` is a
local error. `approvalId` is not an argument alias; the imported offline
fixture used that stale argument and now checks the documented `id` contract
and the missing-both refusal explicitly.

Live commit/status/instruct/end tools check `liveCalls` via capabilities
before forwarding an action; unsupported fleets receive no commit or
confirm-token fetch. The fleet remains authoritative for calling windows,
holidays, opt-outs and limits. Live state remains in fleet memory.

Operator reads validate Twilio SIDs locally: CA + 32 lowercase hex for
inbound calls, SM/MM + 32 for SMS, RE + 32 for voicemail. Operator SMS send
requires `to`, nonblank `body` and a stable 1–200-character `idempotency_key`.
It uses the operator number; owner texts send immediately and other targets
need approval, with opt-out checks enforced by the API. Operator prepare
normalizes caller_script/opening_line aliases to callerScript/openingLine.

## Masking

Every tool result, including upstream error JSON, passes through the shared
masker. Phones show only the last four digits (`***-***-0113`); names, DOB,
bodies, transcripts, subjects, email fields and token fields are redacted.
Emails embedded in other strings become `[email]`; credential strings are
redacted. Media/recording URLs are omitted. Fetch errors and non-JSON upstream
pages are replaced with generic errors.

**v4 privacy change:** legacy `includeContent: true` is still accepted on
operator read tools but cannot bypass masking on either transport. Fetch
full authorized content through the underlying fleet API when needed.

## Tests

From the repo root, without credentials or external network:

```sh
npx vitest run src/plugin connectors/voice-fleet-mcp/offline.test.ts
node connectors/voice-fleet-mcp/test-offline.mjs
node connectors/voice-fleet-mcp/test-operator-offline.mjs
node connectors/voice-fleet-mcp/test-operator-prepare-offline.mjs
```

The offline `.mjs` scripts mock fetch directly and are also run by Vitest.
HTTP tests use a local server and an in-memory token store; no DB is loaded.
All phone fixtures are synthetic 555 numbers.

Manual scripts, excluded from automated runs:

- `VOICE_FLEET_TOKEN_FILE=... node connectors/voice-fleet-mcp/test.mjs`:
  live read-only smoke test; requires network and an authorized token file.
- `node connectors/voice-fleet-mcp/test-operator-script-e2e.mjs`: operator
  parser/opening check via tsx; `REMIX_DIR` defaults to this repo root (`../..`
  from the connector), with an override available for another checkout.
