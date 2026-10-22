# Fleet plugin API (`/api/plugin/v1`)

The Support Center SI Assistant (ticketing-app PR #366) places calls, texts
and emails through this fleet. Nothing leaves until a human approves the
request on **Pending bot actions**. Writes are dark until
`PLUGIN_WRITES_ENABLED=true`.

The Hub migration is `migrations/add_plugin_api.sql`. **Do not apply it from
this change** — Wayne applies Hub migrations.

Matching contract: bearer tokens `si.<jti>.<secret>`, hashed secret, scopes,
constant-time compare, 5-minute single-use confirm token minted **on approve**.

## Scopes

| scope | tools | who gets it |
|---|---|---|
| `fleet:read` | `list_agents`, `agent_health`, `fleet_today`, `recent_outcomes`, `outbound_status`, `get_contact_request`, `email_replies` | SI Assistant bot (default at mint) |
| `contacts:prepare` | `prepare_call`, `prepare_sms`, `prepare_email`, `cancel_contact` | SI Assistant bot |
| `contacts:commit` | `commit_contact` | SI Assistant bot |
| `contacts:approve` | `GET /approvals`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject` | Support Center **Pending bot actions** page only. **Do not grant this to the bot.** |

Write scopes are never implied. An empty scope list becomes `fleet:read` only.

## Approval gate

1. `prepare_*` creates a `contact_approvals` row in `pending`. Nothing is sent.
2. A staffer approves (or rejects) on Pending bot actions.
3. Approve mints a confirm token that expires in **5 minutes** and is
   single-use.
4. `commit_contact` consumes that token, then sends.
5. `cancel_contact` cancels a pending or approved request.

`PLUGIN_WRITES_ENABLED` defaults **off**. Only `true` / `1` / `yes` enables
prepare, approve, reject, cancel and commit.

## Calls

Approved calls enqueue **one** contact into the existing campaign dialer
(`src/runtime/outbound/`). They go out from `SI_ASSISTANT_NUMBER`
(+1 909-255-3213). The dialer already enforces:

- `do_not_contact`
- 9:00 AM – 8:00 PM Pacific (federal holidays and practice closures skipped)
- 1 call per day, 3 per week

The same number answers inbound callbacks on the `si-assistant` runtime lane.
That lane identifies itself as an **AI assistant** and never pretends to be
human. Each finished SI Assistant call is reported to the ticketing app
(`SI_ASSISTANT_CALLBACK_WEBHOOK_URL` + HMAC
`SI_ASSISTANT_CALLBACK_WEBHOOK_SECRET`, header `X-SI-Assistant-Signature`).
The payload is PHI-bounded: callSid, outcome, duration, ticket number,
approval id. No phones, bodies or transcripts.

`/api/test-call` and surgery-line routing are untouched.

**Twilio still needs setting for +1 909-255-3213:**

- Voice URL: `https://<this-host>/voice/si-assistant`
- Messaging (SMS) webhook: `https://<this-host>/api/plugin/v1/webhooks/twilio-sms`

Until those point here, outbound dials fail the returned-call check and
inbound SMS STOP/HELP/START is not received.

## SMS

Sent **from this fleet**, from `SI_ASSISTANT_NUMBER`, through Twilio.
Not delegated to the ticketing app: that sender uses a different number
(+1 909-310-8277). Every body is prefixed
`Azul Vision SI Assistant (AI):`. STOP / HELP / START are honoured on the
inbound webhook. STOP writes `do_not_contact` source `sms_stop` without
overwriting a call opt-out. START clears only `sms_stop`.

## Email

Sent from `SI_ASSISTANT_EMAIL` (default `Support-Assistant@azulvision.com`)
via Microsoft Graph `sendMail`, app-only client credentials. The Entra app is
**SI Assistant Mail**. It is scoped through Exchange **RBAC for Applications**
to that one mailbox. Replies are read from the same mailbox
(`GET /email_replies`).

Use exactly these names:

| env | purpose |
|---|---|
| `SI_MAIL_TENANT_ID` | Entra tenant |
| `SI_MAIL_CLIENT_ID` | App registration id. In the live tenant this is `f9cdfde5-7685-42bc-a0dd-32e5c16bf4e3` — set it in env, do not hardcode it |
| `SI_MAIL_CLIENT_SECRET` | Client secret. Never commit a value |
| `SI_ASSISTANT_EMAIL` | From / mailbox UPN. Default `Support-Assistant@azulvision.com` |

Tests inject a mock Graph client. This repo never stores the secret.

## Audit

`plugin_audit_log` records token jti, tool, route, method, approval id,
ticket id, outcome and HTTP status. **No phone numbers, message bodies or
transcripts.**

## Mint a token

```
npx tsx scripts/plugin-token.ts --label "si-assistant-bot" --scopes fleet:read,contacts:prepare,contacts:commit
```

The plaintext `si.<jti>.<secret>` is printed once. Only the hash is stored.
Grant `contacts:approve` only to the Support Center page token.

The mint script does not apply the migration. If the tables are missing it
fails closed.

## Required environment variables

Blank values only. Copy into the deployment secrets; never commit a filled
secret.

```
PLUGIN_WRITES_ENABLED=
SI_ASSISTANT_NUMBER=
OUTBOUND_CAMPAIGN_SI_ASSISTANT=
RUNTIME_OUTBOUND_DIALING=
SI_ASSISTANT_CALLBACK_WEBHOOK_URL=
SI_ASSISTANT_CALLBACK_WEBHOOK_SECRET=
SI_ASSISTANT_EMAIL=
SI_MAIL_TENANT_ID=
SI_MAIL_CLIENT_ID=
SI_MAIL_CLIENT_SECRET=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
```

Also required for the tables, already on this app: `DATABASE_URL`.

The live mailbox is `SI_ASSISTANT_EMAIL=Support-Assistant@azulvision.com`
(not a secret; the Entra app is scoped to that UPN only). Put it in the
deployment env. `SI_MAIL_CLIENT_ID` in that tenant is
`f9cdfde5-7685-42bc-a0dd-32e5c16bf4e3` — docs only, never hardcoded.

`PLUGIN_WRITES_ENABLED` stays empty or `false` until the Support Center
Pending bot actions page is live. `OUTBOUND_CAMPAIGN_SI_ASSISTANT` and
`RUNTIME_OUTBOUND_DIALING` stay off until the Twilio Voice URL on
+1 909-255-3213 points at `/voice/si-assistant`.
