# Grok Bot operator line

Grok Bot holds open inbound conversations and pursues outbound goals through
free-form conversation. Supply a goal as `purpose`; there is no caller script
or turn limit. The agent identifies itself as an AI assistant, discloses
recording, respects consent and opt-outs, and uses no patient lookup,
verification, scheduling, or ticket tools. See
[the inbound guide](../operator-line-inbound.md) for inbound routing,
owner recognition, the mid-call queue tool, signed alerts, and private fetch.

## Outbound approval policy

Set `initiated_by` (or its alias `requested_by`) to:

- `owner_request`: the owner requested this call, including a call to a third
  party. No approval tap is required.
- `bot_initiative`: the bot chose to initiate this call. Human approval is
  required, except when calling the configured owner number.

Omitted provenance defaults to `bot_initiative`. Invalid or conflicting values
are rejected. Only explicitly scoped operator bots can declare provenance.
The canonical `initiated_by` is locked in the approval payload and persisted
in `plugin_operator_calls`, and returned with live/durable call transcripts.
Calling the owner does not rewrite the provenance supplied by the bot.

`POST /api/plugin/v1/prepare_operator_call` returns `approved` plus a single-use
five-minute `confirmToken` for calls exempt from an approval tap. The preparing
bot sends that token to `POST /api/plugin/v1/commit_call_live`. Preparing alone
does not dial. A default or explicit `bot_initiative` third-party call instead
returns `pending_approval`; a human reviews the complete goal, destination,
duration and payload hash through the existing approval flow before commit.
The preparing bot can fetch the approved token once through
`GET /contact_requests/:id/confirm_token`.

A bot cannot approve its own pending request. Existing staff permissions and
token defaults are unchanged. Mixed `operator:call`/`contacts:approve` tokens
are refused. Operator confirmations cannot be consumed through `commit_contact`.
Commit atomically consumes the confirmation so concurrent calls/replays cannot
dial twice. Signed Twilio callbacks, opt-outs, guidance, logs and duration
controls remain active for both approval paths.

## Configuration and payload

- `OPERATOR_LINE_FROM_NUMBER`: existing authorized E.164 Twilio caller ID;
  must differ from the SI Assistant number. Required at prepare and commit.
- `OPERATOR_OWNER_NUMBER`: owner's E.164 number, used for persona selection
  and the approval exemption for calls to the owner. Never hardcode it.
- `OPERATOR_LINE_MAX_CALL_MINUTES`: safety maximum, default **60**.
- `PLUGIN_WRITES_ENABLED=true`: existing write switch for prepare/approve/
  commit and live controls. It is not required for inbound conversations.
- Existing Twilio credentials, public domain, Hub database and runtime/provider
  settings must work. No operator scheduler or campaign switch is needed.

The bot needs `operator:call`; `fleet:read` is optional for the read endpoints.
No bot gets `contacts:approve`. Prepare accepts `phone` (E.164), `purpose`
(1..4000 characters), optional `language`, optional `maxDurationSec`, and
provenance. Patient/ticket fields, caller scripts, and unknown keys are rejected.
`maxDurationSec` defaults to the env safety maximum and may request a shorter
integer duration from 30 seconds through that maximum. Commit passes it to
Twilio's `timeLimit`; the process also requests REST hangup at the deadline
measured from session creation, including dialing/setup time. Neither calling
windows nor attempt caps apply to operator calls. Each send is one attempt;
ambiguous sends must be reconciled rather than retried automatically.

Example request, with the destination supplied securely as `DESTINATION_E164`:

```bash
jq -n --arg phone "$DESTINATION_E164" \
  '{phone:$phone, purpose:"Find a suitable time for our project meeting", initiated_by:"owner_request"}' \
  > /tmp/operator-prepare.json
curl -sS "$FLEET_BASE/api/plugin/v1/prepare_operator_call" \
  -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/operator-prepare.json > /tmp/operator-confirm.json
jq '{confirmToken}' /tmp/operator-confirm.json > /tmp/operator-commit.json
curl -sS "$FLEET_BASE/api/plugin/v1/commit_call_live" \
  -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/operator-commit.json
rm /tmp/operator-confirm.json /tmp/operator-commit.json /tmp/operator-prepare.json
```

Keep tokens out of source control and shared logs. Use synthetic scenarios
when validating. The older `scenarios/` documents can inform a test goal;
their contents are not scripts for the live agent to follow.

## Live controls and storage

Paths below are relative to `/api/plugin/v1`; all require the preparing bot's
`operator:call` token:

| Endpoint | Behavior |
| --- | --- |
| `GET /live_calls/:sessionId?after=-1` | Incremental transcript, status, provenance, and next turn index |
| `POST /live_calls/:sessionId/instruct` with `{text}` | Conversational guidance |
| `POST /live_calls/:sessionId/end` | REST hangup and session completion |
| `GET /calls/:sessionId/transcript` | Full ordered transcript and provenance, including after memory expiry; works with writes disabled |

The transcript identifier is the session ID. Only the preparing bot can read
outbound transcripts. Approval views expose the locked goal to the human;
bot approval responses mask the destination to its last four digits. Goals,
transcripts and tokens never enter audit logs.

Apply `migrations/add_operator_line.sql` and then
`migrations/add_operator_line_inbound.sql` separately. **Neither has been run
by this change.** The latter adds `initiated_by` with a `bot_initiative`
default and a two-value constraint. Tables retain RLS. Normal completion,
provider callbacks, bridge teardown and duration timers persist ordered
transcripts. A process crash may lose turns not yet finalized; Twilio's
outbound safety duration still applies. Use the deployment's retention
procedure for stored transcripts. US voice/SMS and international operator
opt-outs retain their existing stores.

SI support calls, patient flows, staff permissions and the scheduler's patient
calling policies retain their existing behavior.
