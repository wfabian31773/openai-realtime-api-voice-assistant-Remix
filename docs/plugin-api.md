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
2. `GET /approvals` returns the full payload and its `payloadHash` to
   `contacts:approve` only, so the staffer sees who will be contacted and
   what will be said.
3. Approve submits that `payloadHash`. A mismatch, or a token approving
   its own request, is refused. Approve mints a confirm token that expires
   in **5 minutes** and is single-use. Consume is one atomic `UPDATE`.
4. `commit_contact` claims the token (the row moves to `sending`), re-hashes
   the stored payload against the lock, then sends exactly that payload. A
   thrown send moves the row to `failed` and writes a PHI-free audit row.
   A crash between claim and send leaves the row `sending`; a timeout sweep
   labels it `unknown` (PHI-free audit) and **never resends**. Graph and
   Twilio sends are bounded at 15 seconds. A successful send is recorded
   `committed` immediately so the sweep cannot overwrite it.
   **A commit error after the token is consumed carries `outcome`** (v115),
   because only the fleet knows what happened to the contact:
   `"not_sent"` — the request is `failed` and nothing went out (a payload
   that no longer matches its lock, dialing switched off, a calling-window
   or cap refusal, a send the provider refused); `"unknown"` — the send may
   have gone out (a timeout or throw after the send started). Classify on
   this field, never on the HTTP status: a 503 sent nothing, a 502 may have.
   A refusal before the token is consumed (bad, used or expired token)
   carries no `outcome`; nothing was claimed.
5. `cancel_contact` cancels a pending or approved request only while the
   confirm token is unused. Cancel and get are tied to the token that
   created the row (or to `contacts:approve`).

`PLUGIN_WRITES_ENABLED` defaults **off**. Only `true` / `1` / `yes` enables
prepare, approve, reject, cancel and commit.

## Calls

Approved calls enqueue **one** contact into the existing campaign dialer
(`src/runtime/outbound/`). They go out from `SI_ASSISTANT_NUMBER`
(+1 909-255-3213). `prepare_call` must send the ticket patient's
`firstName`, `lastName` and a parseable `dateOfBirth` (or `date_of_birth`,
or ticketing's `birthMonth` / `birthDay` / `birthYear`). A missing or
unparseable date is HTTP 400. If `dateOfBirth` and `date_of_birth` both
arrive and parse to different days, the request is refused. Enqueue
copies the resolved date into the contact row and `custom_data.date_of_birth` —
memory and contact data only, never logs or `plugin_audit_log`. Returned
callers read the same field on the campaign candidates. The dialer already enforces:

- `do_not_contact`
- 9:00 AM – 8:00 PM Pacific (federal holidays and practice closures skipped)
- 1 call per day, 3 per week, 3 in total — **per phone number**, across
  every approval for that number

The commit applies the same per-number caps before it queues, so a second
approval for a number already rung today is refused (`daily_cap`,
`outcome: "not_sent"`) instead of reading as queued.

A queued call must be FIRST rung within two hours (`custom_data.place_by`).
If it is not, the dialler settles the contact `rescheduled`, never rings it,
and moves the approval from `committed` to `failed` with
`result.reason: "place_by_passed"` and a `call_not_placed` audit row. The
deadline is the contact row's own: an earlier approval's call to the same
number does not turn this one into a retry.

The same number answers inbound callbacks on the `si-assistant` runtime lane.
That lane identifies itself as an **AI assistant** and never pretends to be
human. Each finished SI Assistant call is reported to the ticketing app
(`SI_ASSISTANT_CALLBACK_WEBHOOK_URL` + HMAC-SHA256 of
`${unixSeconds}.${rawBody}`, headers `X-SI-Assistant-Timestamp` and
`X-SI-Assistant-Signature`). The receiver rejects a timestamp older
than five minutes.
The payload is PHI-bounded: callSid, outcome, duration, ticket number,
ticket id, approval id. No phones, bodies or transcripts. A taken
message is a separate `message` event on the same webhook. The agent
persists that message in `plugin_message_outbox` first and only tells the
caller it was taken after the row exists. Webhook misses retry from the
outbox. If persist itself fails, the agent says so and gives the SI
Assistant number.

An inbound returned call has no outbound session contact. Teardown and
`take_si_assistant_message` use the same identity. Ticket keys attach
ONLY after a full name AND date of birth match the patient on file.
A first name — including one the greeting said — is not identification.
Having dialled a patient is not confirmation: that needs an explicit yes
to "Am I speaking with <name>?" plus a matching date of birth
(`confirm_si_assistant_identity`). If the call records `wrong_person`,
nothing attaches. A phone match never attaches. A message taken before
identification is re-attached to the same keys once they are identified.
If the outbox row is mid-send (`sending`) when that happens, the ticket
keys are stamped on the outbox row (persisted). The in-flight delivery
may still go out unmatched; when `markOutbox` marks it delivered it
compares those current keys to the send snapshot, and if they differ a
follow-up webhook carries `attachmentUpdate: true` with the same
`outboxId` and `idempotencyKey` and the ticket keys. **Ticketing
contract:** that payload is an UPDATE to the existing My Messages item
(attach the ticket keys), not a duplicate to drop and not a second
message. A later identification with no date of birth on file cannot
verify — the agent says so and takes a message; it must not say the
date "does not match". A contact-load failure is a separate error: the
agent says it cannot verify right now and takes a message; it must not
say there is no date of birth on file. `wrong_person` is sticky for the
rest of the call.
Unidentified callbacks go to SI Assistant My Messages with up to three
suggested tickets (ticket number and approval id only, no extra PHI)
drawn from the union of placed dials (actually reached the network, not
merely enqueued) and sent texts or emails in the last 72 hours. The
suggestion lookup runs only on the SI Assistant lane.

`plugin_message_outbox` retries webhook delivery. Stale `sending` rows
are reclaimed to `pending`. Dead rows write a PHI-free audit (`outbox_dead`).
An unset webhook URL leaves rows pending (they do not expire toward dead).
Retries with the same call SID and message reuse one idempotency key
(`outbound_callback_sid` or `outbound_call_sid`). The webhook payload
carries the outbox row id and that key so a redelivery can be deduped.
A re-attach after identification is the same message (same `outboxId`
and `idempotencyKey`) with `attachmentUpdate: true` and the ticket
keys filled in. Ticketing must apply those keys to the existing item.
Delivered bodies are purged; undelivered rows older than 30 days are
deleted and audited (`outbox_expired`, ids only).

A send that times out or throws after it may already have gone out is
labelled `unknown`, never `failed`. Failures where nothing was sent —
token fetch, Graph 4xx, Twilio 4xx before accept — stay `failed`. Do
not resend an `unknown`. A new prepare is the only way out.

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
inbound webhook after `X-Twilio-Signature` is checked the same way as
the voice webhooks (invalid → 403; no auth token → 200 empty TwiML and
no opt-out change). STOP writes `do_not_contact` source `sms_stop`
as its own row — unique is `(phone_key, source)`, not the phone
alone — so a later voice "don't call me" is a second row. START
deletes only `sms_stop`. Voice dials ignore `sms_stop`; SMS send
ignores a voice row. Either order (voice then START, or STOP then
voice then START) leaves the call blocked. START that leaves a voice
row behind sends no reply. HELP always replies, per CTIA, even to a
number blocked by an SMS STOP or a voice row: the program name
(Azul Vision SI Assistant), a contact number and how to opt out. An
inbound text that is
not STOP / HELP / START is a taken message: a body preview goes
through `plugin_message_outbox`. Empty bodies are skipped — they
must not become an empty Support Center item.

## Email

Sent from `SI_ASSISTANT_EMAIL` (default `Support-Assistant@azulvision.com`)
via Microsoft Graph `sendMail`, app-only client credentials. The Entra app is
**SI Assistant Mail**. It is scoped through Exchange **RBAC for Applications**
to that one mailbox. Replies are read from that mailbox's Inbox
only (`GET /users/{mailbox}/mailFolders/inbox/messages` behind
`GET /email_replies`), not the whole mailbox. Sender and subject
are returned only to a `contacts:approve` token; `fleet:read` sees
ids and timestamps.

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
Grant `contacts:approve` only to the Support Center page token. The
mint script refuses `contacts:approve` alongside `contacts:prepare` or
`contacts:commit`.

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
