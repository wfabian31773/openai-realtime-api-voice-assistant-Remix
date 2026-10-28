# Fleet plugin API (`/api/plugin/v1`)

The Support Center SI Assistant (ticketing-app PR #366) places calls, texts
and emails through this fleet. Approved contact requests require a human on
**Pending bot actions**; the bot-only direct-call path below dials immediately.
Writes are dark until
`PLUGIN_WRITES_ENABLED=true`.

The Hub migration is `migrations/add_plugin_api.sql`. **Do not apply it from
this change** — Wayne applies Hub migrations.

Matching contract: bearer tokens `si.<jti>.<secret>`, hashed secret, scopes,
constant-time compare, 5-minute single-use confirm token minted **on approve**.

## Scopes

| scope | tools | who gets it |
|---|---|---|
| `fleet:read` | `list_agents`, `agent_health`, `fleet_today`, `recent_outcomes`, `outbound_status`, `get_contact_request`, `email_replies`, `capabilities` | SI Assistant bot (default at mint) |
| `contacts:prepare` | `prepare_call`, `prepare_sms`, `prepare_email`, `cancel_contact` | SI Assistant bot |
| `contacts:commit` | `commit_contact`, `commit_call_live`, `confirm_token` hand-off, live call controls | SI Assistant bot |
| `contacts:approve` | `GET /approvals`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject` | Support Center **Pending bot actions** page only. **Do not grant this to the bot.** |
| `calls:direct` | `POST /calls/direct`, controls for the token's own direct live sessions | SI Assistant bot, explicit grant only |

Write scopes are never implied. An empty scope list becomes `fleet:read` only.
Minting `calls:direct` together with staff scope `contacts:approve` is refused.

## Approval gate

1. `prepare_*` creates a `contact_approvals` row in `pending`. Nothing is sent.
2. `GET /approvals` returns the full payload and its `payloadHash` to
   `contacts:approve` only, so the staffer sees who will be contacted and
   what will be said.
3. Approve submits that `payloadHash`. A mismatch, or a token approving
   its own request, is refused. Approve mints a confirm token that expires
   in **5 minutes** and is single-use. Consume is one atomic `UPDATE`.
4. The preparing bot retrieves the token with
   `GET /contact_requests/:id/confirm_token` using `contacts:commit`.
   The response is `{ confirmToken, expiresAt }` with `Cache-Control: no-store`.
   Only the row's preparing token jti can fetch it: another jti gets 404;
   pending, cancelled, consumed, expired, or already fetched gets 409.
   Fetch is atomic and succeeds at most once. The plaintext is retained only
   until first fetch, consumption, cancellation, or the expiry sweep (at most
   one minute after expiry). Approval views and audit never contain it.
   Staff approval still requires `contacts:approve`; that scope alone cannot
   fetch the hand-off token or commit a contact. The approve response retains
   its existing confirm token for compatibility.
5. `commit_contact` claims the token (the row moves to `sending`), re-hashes
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
6. `cancel_contact` cancels a pending or approved request only while the
   confirm token is unused. Cancel and get are tied to the token that
   created the row (or to `contacts:approve`).

`PLUGIN_WRITES_ENABLED` defaults **off**. Only `true` / `1` / `yes` enables
prepare, approve, reject, cancel, commit and all live call controls.

## Calls

### Direct open-line calls

`POST /api/plugin/v1/calls/direct` requires `calls:direct` and enabled plugin
writes. Body: `{ "phone": "+19095550123", "purpose": "Ask about office hours", "name": "Optional recipient" }`.
Phone accepts ten US digits or `+1` followed by ten digits; purpose is 1–4000
characters, optional name 1–100. No DOB, approval, confirm token, per-phone
caps, calling-hours window, holiday check, or callback-route probe applies.
The existing outbound/campaign enable switches still apply.

The call immediately uses `siAssistantNumber()` (`+19092553213`, with the
existing `SI_ASSISTANT_NUMBER` override). Purpose supplies the persona and
instructions, wrapped only with Wayne/practice-assistant identification,
honest AI disclosure if asked, and no patient verification or DOB prompts.
Only language, opt-out, outcome and hang-up tools are offered. A single
`plugin_live` campaign attempt prevents scheduler retries, and the ordinary
live registry owns the session by token jti. Success returns
`{ "status": "live", "callSid": "CA...", "sessionId": "..." }`.
Use the same `/live_calls/:sessionId` status/instruct/end endpoints below;
`calls:direct` authorizes only owned direct sessions. Approval-based sessions
retain their existing `contacts:commit` requirement.

The marked `OPT-OUT GUARD (removable)` checks voice DNC and SMS STOP; blocked
calls return HTTP 409 with `reason: "do_not_contact"` and place no call.
Other placement refusals return 503; ambiguous provider errors return 502
with `outcome: "unknown"` and are never retried automatically.

Apply `migrations/add_plugin_direct_call_audit.sql` before deploying. It adds
one nullable audit metadata column; scopes need no database migration.
Every direct attempt, including refusals, writes its token jti (or
`unauthenticated`), timestamp, outcome/reason, last four digits only, and a
160-character purpose preview. Only generic task words survive that preview;
other text is redacted to keep names and clinical details out of logs.
The full purpose stays in process memory with the live session.

### Approved calls

`commit_contact` for approved calls enqueues **one** contact into the existing campaign dialer
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
`outcome: "not_sent"`) instead of reading as queued. A second approval for
a number whose earlier approved call is still queued, retrying or on the
line is refused too (`call_already_queued`, HTTP 409): the dialler would
place only one of them.

A queued call must be FIRST rung within two hours (`custom_data.place_by`).
If it is not, the dialler settles the contact `rescheduled` and never rings
it. When the dialler settles a call that was never dialled — the deadline
passed, the number went on the do-not-contact list, or the number reached
its total cap — the approval moves from `committed` to `failed` with
`result.placed: false`, `result.reason` (`place_by_passed`,
`do_not_contact` or `total_cap`) and a `call_not_placed` audit row. "Never
dialled" means this approval's own row has no attempt Twilio accepted or
might have: a call that may have rung is never reported as not placed, and
an earlier approval's call to the same number does not turn this one into a
retry.

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

## Live calls driven by the bot

`GET /capabilities` requires `fleet:read` and returns:

```json
{ "liveCalls": true, "confirmTokenHandoff": true, "smsHoursEnforced": true }
```

All paths below are under `/api/plugin/v1`. Each requires bearer auth,
`contacts:commit`, and enabled plugin writes. An approve-only token cannot
use them. Sessions belong to the same token jti that prepared and committed
that approval; another jti receives 404 on the session endpoints.

`POST /commit_call_live` with `{ "confirmToken": "..." }` consumes an approved
**call** request and dials immediately from `SI_ASSISTANT_NUMBER` into
`/voice/si-assistant`. Other channels get 400 without consuming the token.
The preparing bot must commit its own request. The locked payload, any-source
do-not-contact list (including SMS STOP), Pacific calling window, holidays,
practice closures, per-number campaign caps, dialing switches, callback
routing and an already queued/in-progress call are checked before dialing.
The dial and cap checks share the scheduler's lock; a busy dialer refuses
this commit. Refusals after consumption fail the approval and return
`outcome: "not_sent"`. An ambiguous Twilio error returns `outcome: "unknown"`.
A live approval gets **one attempt**, never an automatic retry, including
no-answer or unknown results. Its campaign attempt counts toward caps and
returned-call matching just like a scheduled dial.

Success is `{ status: "live", approval, callSid, sessionId }`. Controls:

- `GET /live_calls/:sessionId` returns `status`, `callSid`, `startedAt`,
  `endedAt`, `transcript: [{ role: "agent" | "caller", text, at }]` and
  `nextAfter`. Status is `dialing`, `ringing`, `in_progress`, `completed`,
  `failed`, or `no_answer`. `?after=<index>` returns turns strictly after
  that zero-based index; omit it (or use -1) for all turns. Use `nextAfter`
  for the next poll. An open caller turn can be refined in place; refetch
  the full transcript when current-turn corrections matter.
- `POST /live_calls/:sessionId/instruct` with `{ "text": "..." }` adds up to
  2000 characters of guidance to the running realtime session. Guidance is
  context only: it cannot replace AI disclosure, identity verification,
  privacy rules or tool permissions, and never counts as caller speech or
  verification. Returns `{ status: "instructed" }`, or 409 if not running.
- `POST /live_calls/:sessionId/end` with `{}` completes the Twilio call and
  closes the attached runtime session. Repeating it for a retained ended
  session returns its terminal status.

Live state and transcripts are in-process memory only. Transcripts are not
written to call logs, timed-turn storage, or plugin audit. They
are dropped two minutes after the call ends. Sessions do not survive a
process restart; clients need affinity to the process serving the call.

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
deletes only `sms_stop`. **Any `do_not_contact` row, from any source, blocks
both calls and texts**, including an SMS STOP blocking voice dials and a
voice opt-out blocking SMS. Either order (voice then START, or STOP then
voice then START) leaves both channels blocked by the voice row. START that leaves a voice
row behind sends no reply. HELP always replies, per CTIA, even to a
number blocked by an SMS STOP or a voice row: the program name
(Azul Vision SI Assistant), a contact number and how to opt out. An
inbound text that is
not STOP / HELP / START is a taken message: a body preview goes
through `plugin_message_outbox`. Empty bodies are skipped — they
must not become an empty Support Center item.

Approved outbound SMS is sent only **09:00 through 19:59 Pacific**
(`America/Los_Angeles`, including daylight-saving changes). It skips the
same federal holidays and practice closures as the dialer. Outside the
window or on a closed date, commit fails with `outside_hours`, `closed_day`
or `holiday` and `outcome: "not_sent"`; no provider send is attempted.
Inbound STOP / HELP / START keyword replies remain available at any hour,
including holidays, and follow the opt-out rules above.

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
