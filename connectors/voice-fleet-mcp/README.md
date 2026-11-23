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

Both transports support protocol versions `2025-06-18`, `2025-03-26` and
`2024-11-05`, latest first. `initialize` echoes a supported requested version;
an absent or unsupported version selects `2025-06-18`. HTTP accepts an absent
`MCP-Protocol-Version` header; an unsupported header returns 400 with a JSON error.

HTTP POST validates `Origin` before body parsing or dispatch. If present, it must
exactly match an origin in `VOICE_FLEET_MCP_ALLOWED_ORIGINS` (comma-separated,
whitespace trimmed, e.g. `https://bot.example,http://localhost:3000`) or the app's
own configured public origin. That origin uses the existing app domain resolution:
`DOMAIN` takes precedence, with `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN` fallbacks
(published hosts preferred in production). Bare domains use HTTPS; configured URL
paths, queries and fragments are removed. No implicit localhost origin is added.
Unlisted origins return 403 with a JSON error and no dispatch. An absent `Origin`
is allowed for server-to-server clients. Host/forwarding headers never grant access.

HTTP uses POST with plain JSON replies. Although `2025-06-18` removed JSON-RPC
batching, input batches remain accepted leniently and replies retain input order.
Each message must be an object with `jsonrpc: "2.0"`. Requests require a string
method and a string or finite number id; notifications have a string method and
no id. Invalid envelopes (including `{}` and requests with `id: null`) return
`-32600 Invalid Request` with `id: null`, without downstream fetches for that item.
A single invalid message or empty batch returns HTTP 400; invalid batch members
produce error entries alongside valid replies.
Client responses (`result`/`error` without `method`) and notifications produce
no replies; a POST containing only those returns 202 with no body. Mixed batches
answer requests and omit responses/notifications. It keeps no MCP session and
opens no SSE stream. Invalid JSON returns 400 / `-32700`, bodies
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
`handleMessage(message)` returns the JSON-RPC reply, or null for notifications
and client responses;
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

As in the original connector, live commit/status/instruct/end tools call their
routes directly without probing `/capabilities`. A `calls:direct`-only token
can control its own direct sessions even though `/capabilities` requires
`fleet:read` and returns 403. The fleet remains authoritative for capability,
scope, ownership, calling windows, holidays, opt-outs and limits. Live state
remains in fleet memory.

Operator reads validate Twilio SIDs locally: CA + 32 lowercase hex for
inbound calls, SM/MM + 32 for SMS, RE + 32 for voicemail. Operator SMS send
requires `to`, nonblank `body` and a stable 1–200-character `idempotency_key`.
It uses the operator number; owner texts send immediately and other targets
need approval, with opt-out checks enforced by the API. Operator prepare
normalizes caller_script/opening_line aliases to callerScript/openingLine.
Its optional `scenario_id`, `initiated_by`, `language` and `maxDurationSec`
fields omit empty strings and preserve `null`, matching the imported connector.
Tool schemas describe discovery; the original handlers normalize and validate
their own inputs before sending requests. Other payload validation remains with
the fleet API. A supplied `confirmToken` takes precedence over any unused `id`.
At the JSON-RPC boundary, tool `arguments` must be an object; omission uses `{}`.

## Masking

Both transports retain the original connector's output behavior. The three
operator SID reads and `operator_sms_send` mask phones to their last four
digits (`***-***-0113`) and omit media/recording URL fields at every depth.
By default, string content and name/DOB/email/subject fields become
`[redacted N chars]`; emails embedded in other strings become `[email]`.

On `operator_inbound_get`, `operator_sms_get` and `operator_voicemail_get`,
`includeContent: true` returns content fields (`body`, `text`, `transcript`,
`transcription`, `transcriptionText`, `content`, `turns`, `messages`) and all
their descendants unredacted except for phone masking and URL removal. Names
and emails nested inside content are preserved; fields outside content retain
their usual masking. Omitted or false keeps the default masking. The flag
does not enable content on SMS-send replies.

Other tools, including `get_transcript` and live-call status, return the fleet's
JSON unchanged, as the original did. Fetch errors and non-JSON upstream pages
are replaced with generic errors, and upstream redirects are refused. Tokens
and bodies are never logged.

## Tests

From the repo root, without credentials or external network:

```sh
npx tsc -p . --noEmit
npx vitest run src/plugin/mcpCore.test.ts src/plugin/mcpParity.test.ts src/plugin/mcpRoute.security.test.ts connectors/voice-fleet-mcp/offline.test.ts
npx vitest run src/plugin connectors
node connectors/voice-fleet-mcp/test-offline.mjs
node connectors/voice-fleet-mcp/test-operator-offline.mjs
node connectors/voice-fleet-mcp/test-operator-prepare-offline.mjs
```

The offline `.mjs` scripts mock fetch directly and are also run by Vitest.
`tools-list-b7f9b822.json` records the original connector's full tool catalog;
the core tests compare every name, description and input schema exactly.
`fixtures/server-b7f9b822.txt` is the exact original server source. The parity
tests evaluate its handlers against mocked fetch and compare method, encoded
path/query, serialized body and tool result with the core for all 26 tools, including empty
optional fields, extra fields and snake/camel aliases. Only the original imports,
exports and stdio listener are excluded; no git history or token file is needed.
HTTP security tests run the mounted middleware and raw parser in process without
sockets; the remaining HTTP integration tests use a local server. Both use an
in-memory token store; no DB is loaded.
All phone fixtures are synthetic 555 numbers.

Manual scripts, excluded from automated runs:

- `VOICE_FLEET_TOKEN_FILE=... node connectors/voice-fleet-mcp/test.mjs`:
  live read-only smoke test; requires network and an authorized token file.
- `node connectors/voice-fleet-mcp/test-operator-script-e2e.mjs`: operator
  parser/opening check via tsx; `REMIX_DIR` defaults to this repo root (`../..`
  from the connector), with an override available for another checkout.
