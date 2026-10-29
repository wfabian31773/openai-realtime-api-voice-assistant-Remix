# Wayne operator line

A human approves each call by default before a bot places it. An optional, disabled-by-default [test pre-approval rule](test-preapproval.md) lets the server approve allowlisted committed test scenarios outside peak hours within a persistent quota. Human review uses the Support Desk / Support Center **Pending bot actions** contract already implemented by the fleet: `GET /approvals` returns the complete locked payload and `payloadHash`, and a human posts that hash to approve. The Support Desk UI lives in the ticketing application, outside this repository. Operator requests appear as `channel: "call"`, `callKind: "operator"` with no ticket. Its existing call path approves without committing and does not require a ticket, so the preparing bot can fetch the confirmation afterward.

The checked ticketing UI currently previews only `purpose` for calls. Until that separate application displays `payload.callerScript`, `language` and `maxDurationSec`, the human must review the complete request through `GET /approvals` before approving. The API workflow below supports that full review today. No staff permissions or ticketing-app files are changed here.

The operator speaks on behalf of Wayne Fabian, discloses it is an AI assistant if asked, and never asks for DOB or patient identifiers. The caller script cannot override these rules. Only language, opt-out, outcome and hangup tools are bound; no patient lookup, verification, scheduling or ticket tools. An operator can speak to another service about a booking, but cannot make a booking directly through the fleet's patient tools.

## Configuration

- `OPERATOR_LINE_FROM_NUMBER`: an existing, owned/authorized E.164 Twilio caller ID, required at both prepare and commit. It must differ from both `+19092553213` and the configured `SI_ASSISTANT_NUMBER`. No number is purchased, provisioned or repointed by this feature.
- `PLUGIN_WRITES_ENABLED=true`: existing write switch, required for prepare, approve, commit and live controls.
- Existing `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, public `DOMAIN` (or the existing Replit domain variables), Hub `DATABASE_URL`, and voice runtime/provider settings must already work. The runtime must be live-ready to serve the answer webhook.
- No operator campaign switch or scheduler is needed. The operator lane is excluded from the scheduler, and its one-attempt ledger rows carry `plugin_live: true`. No cron is created.

Apply the additive SQL separately when ready: [MIGRATION.sql](MIGRATION.sql), also maintained at `migrations/add_operator_line.sql` and in `shared/schema.ts`. **It has not been run by this change.** It creates transcript and international opt-out tables with RLS enabled; only the server's existing owner connection accesses them. US voice and SMS opt-outs continue to use the existing shared list. International operator opt-outs use a full E.164 list. A failed opt-out lookup blocks dialing.

`maxDurationSec` defaults to 600 and must be an integer in 30..1800. Commit passes it as Twilio's [`timeLimit`](https://www.twilio.com/docs/voice/api/call-resource), which caps call duration even across a server restart. A process timer also ends the session and requests REST hangup at the deadline measured from session creation, including dialing/setup time. The REST hangup is independent of whether a model/bridge attached. The call may therefore end sooner than the requested talk time.

## Scopes and endpoints

All paths below are relative to `/api/plugin/v1`.

| Endpoint | Scope / ownership |
| --- | --- |
| `POST /prepare_operator_call` | `operator:call`, bot only |
| `GET /approvals?status=pending` | Existing human `contacts:approve` |
| `POST /approvals/:id/approve` with `{payloadHash}` | Existing human `contacts:approve`; returns a single-use confirm token valid for five minutes |
| `POST /approvals/:id/reject` | Existing human `contacts:approve` |
| `GET /get_contact_request?id=...` | Existing `fleet:read`; preparing owner or human approver |
| `GET /contact_requests/:id/confirm_token` | `operator:call`, preparing bot only; atomic one-time handoff |
| `POST /commit_call_live` with `{confirmToken}` | `operator:call`, same token jti that prepared; consumes confirmation atomically |
| `GET /live_calls/:sessionId?after=-1` | `operator:call`, preparing bot only (`live_call_status`) |
| `POST /live_calls/:sessionId/instruct` with `{text}` | `operator:call`, preparing bot only (`live_call_instruct`) |
| `POST /live_calls/:sessionId/end` | `operator:call`, preparing bot only (`live_call_end`) |
| `GET /calls/:sessionId/transcript` | `operator:call`, preparing bot only; complete ordered turns, including after memory expiry/restart; works with writes disabled |

Mint the bot explicitly, for example `npm run plugin:token -- --label wayne-operator --scopes fleet:read,operator:call`. The default remains `fleet:read`. Never give the bot `contacts:approve`; minting that scope alongside any bot write scope is rejected. Existing staff scopes are unchanged. Even an incorrectly stored mixed human/operator token cannot prepare, approve, commit or steer an operator call. `commit_contact` refuses operator confirmations without consuming them.

Prepare accepts only `phone` (E.164), `purpose` (1..4000 characters), `callerScript` (1..4000), optional `scenarioId` (committed scenario filename without `.md`), optional `language` (e.g. `en`, `es`), and optional `maxDurationSec`. It rejects patient fields, ticket fields, unknown keys, and out-of-range durations. The server adds `callKind: "operator"` to the hashed payload.

## Run a synthetic scenario

Use only synthetic information on the QVO test line **+19094795435**. Pick a file from `scenarios/` and send its contents as `callerScript`. Keep tokens out of source control, shared terminals and logs. With `FLEET_BASE`, `BOT_TOKEN` and `HUMAN_TOKEN` provided securely in your environment, this example uses `jq` and `curl`:

```bash
jq -n --rawfile script docs/operator-line/scenarios/family-bookings.md \
  '{phone:"+19094795435", purpose:"Synthetic family booking scenario", callerScript:$script, language:"en", maxDurationSec:600}' > /tmp/operator-prepare.json

curl -sS "$FLEET_BASE/api/plugin/v1/prepare_operator_call" \
  -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/operator-prepare.json
```

Prepare normally returns `pending_approval` and an approval ID. It does not place a call. If the test rule returns `auto_approved`, the bot proceeds directly to the confirmation handoff below. Otherwise the human reviews the Pending bot actions entry (including script and duration), then approves its exact `payloadHash`:

```bash
curl -sS "$FLEET_BASE/api/plugin/v1/approvals?status=pending" \
  -H "Authorization: Bearer $HUMAN_TOKEN"
# After human review, set APPROVAL_ID and PAYLOAD_HASH from that entry.
jq -n --arg hash "$PAYLOAD_HASH" '{payloadHash:$hash}' > /tmp/operator-approve.json
curl -sS "$FLEET_BASE/api/plugin/v1/approvals/$APPROVAL_ID/approve" \
  -H "Authorization: Bearer $HUMAN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/operator-approve.json

# Preparing bot fetches the handoff once, without copying a human token to it.
curl -sS "$FLEET_BASE/api/plugin/v1/contact_requests/$APPROVAL_ID/confirm_token" \
  -H "Authorization: Bearer $BOT_TOKEN" > /tmp/operator-confirm.json
jq '{confirmToken}' /tmp/operator-confirm.json > /tmp/operator-commit.json
curl -sS "$FLEET_BASE/api/plugin/v1/commit_call_live" \
  -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/operator-commit.json
rm /tmp/operator-confirm.json /tmp/operator-commit.json /tmp/operator-approve.json /tmp/operator-prepare.json
```

Keep the returned `sessionId` for live controls and transcript retrieval. Poll status with `after=nextAfter` for incremental turns. Retrieve `/calls/$SESSION_ID/transcript` for the full ordered transcript after completion. The endpoint's ID is the session ID, not the approval ID or Twilio SID. Only the original preparing token can read it; staff cannot retrieve it through this bot endpoint. Approval views expose the script to the human as the existing flow requires; bot approval responses expose only the masked last four digits. Scripts, transcripts and tokens never enter plugin audit logs.

Transcripts are stored separately in `plugin_operator_calls` without automatic deletion; apply the deployment's data-retention procedure to that table. Normal completion, hangup, signed status callbacks and the hard-stop timer persist the final ordered turns. A process crash can lose turns still in memory before finalization; a call cannot reconnect to a missing operator session and will hang up. Twilio's duration limit still applies. A 502 with `outcome: "unknown"` must never be retried automatically: poll/reconcile the session, or prepare a new request for human review. All sends are single-attempt.

The SI Assistant number **(909) 255-3213**, existing patient DOB checks, one/day and three/week caps, 9AM–8PM Pacific window, and opt-out behavior are unchanged. Operator calls use a separate lane, campaign and caller ID.
