# The ticketing API — what it actually requires, and what it silently overrides

Two endpoints, different contracts. Getting them confused is why tickets land in
department 8.

## `create-ticket` — the full triple, or nothing

Requires a complete, internally consistent `(departmentId, requestTypeId,
requestReasonId)`. There is no "just the department" call, and **no way to
express "this department, but no category"** — a null reason is not accepted.

That constraint is what pushed the taxonomies into guessing a category from a
sentence, which is how *"assistance with eyeglass prescription selection"* ended
up filed in the medication queue.

**Wayne's fix, and the correction that mattered:** I had treated the API as
immovable. He said — *"why don't you just create one? Create another reason, to
satisfy the nulls, the ones that we can't quantify. But we still get the provider
and things like that. We just missed that piece."*

So there is now an **"Other - See Description"** reason per department. A request
that cannot be honestly classified files under it with the caller's own words in
the description, and the receiving team reads the description. That is strictly
better than a confident wrong category, because a wrong category is a fact the
next person acts on.

`src/tools/otherReason.ts` holds the 16-department catch-all table.

| Department | Type | Reason |
|---|---|---|
| 1 Optical | 66 | 536 |
| 2 Surgery Coordination | 65 | 535 |
| 3 Clinical Tech Support | 72 | 542 |

**Per-department catch-alls, not a shared one.** Wayne: *"can we just make it
where five thirty six other… instead of going to department one, it goes to the
department that took the call?"* A single "Other" reason pinned to department 1
would have quietly funnelled every unclassifiable request into Optical.

## `submit-ticket` — re-derives the department server-side

`submitSimplifiedTicket` posts conversational fields and lets the far side map
them. **It ignores any department we send and re-derives its own, defaulting to
8.** So a routing decision made on our side does not survive this endpoint unless
it is expressed in the text.

Do not "fix" a misroute by passing a `departmentId` to this call. It will be
dropped.

### The hints — live on `submit-ticket` as of 2026-08-13

`submitSimplifiedTicket` now carries `suggestedRequestTypeId` /
`suggestedRequestReasonId` / `suggestedRequestReason` / `suggestedUrgent` from
`afterHoursTaxonomy`. The far side reads them at **priority 0**, ahead of both
of its own paths, and **validates rather than trusts** — a pair that does not
exist, or belongs to another department, is refused and logged.

Three things that contract implies for this repo:

- **Verify every pair against the live tables before shipping a taxonomy.** An
  invalid pair does not error; it falls back to their keyword path and looks
  like the hint was ignored. All 19 after-hours pairs were checked on
  2026-08-13 and are valid.
- **159 must never appear in a hint.** It is a disposition — only the code that
  completes a transfer knows one happened — and a hinted 159 is refused on
  arrival by agreement, not by accident.
- **Unknown keys were being dropped silently** until they fixed their logging.
  I shipped these fields before asking, having been explicitly told *"do not
  just start sending them"*. Ask first; the endpoint that accepts a field and
  the endpoint that discards it are indistinguishable from the sending side.

The four CAP fields are **not** sent through `submit-ticket` and will not be
without asking. They go on `create-ticket` only — `file_records_ticket` and the
PCP patient path.

**Consequence worth restating:** a records request arriving through the
answering service structurally cannot carry a requester, because that path
files through `submit-ticket`. Those keep defaulting. Fixing it would mean this
repo choosing the department for the whole answering-service volume — the trade
already declined for `no-ivr`.

## Idempotency

`syncAgentService`/`ticketOutboxService` carried `idempotencyKey: call-<callSid>`
from the start. The four queue tools (optical/surgery/tech/records) did not —
that gap shipped in PR #220 (2026-08-21), guarded to real Twilio SIDs
(`isTwilioCallSid()` in `sharedPatientTools.ts`) because some calls carry a
sentinel `callSid` (`"unknown"`, `"latest"`, `"none"`, `"unknown_sid"`,
`"automated-call-unique-id"` — traced to `metadata.callSid ?? metadata.callId`
in the four `*Agent.ts` files, itself unfixed). An unguarded key built from a
shared sentinel would let one caller's retry read back a different patient's
ticket number, since a key hit returns the cached ticket verbatim.

**What I queried directly**, against `voice_agent_api_logs`/`tickets` in the
Support Center DB (2026-08-19 vs 2026-08-20 post-deploy, same-day full-day
comparison, real Twilio SIDs, four queues): duplicate-POST groups 22 → 7,
uncaught duplicate tickets (two different ticket numbers for one call) 2 → 0,
8 of 206 real-SID calls on the post-deploy day consolidated rather than
filing fresh. ~13% of daily create-ticket traffic still ships with no key at
all (no callSid, or a sentinel) — that residual doesn't close until the
sentinel/no-SID source does.

**What Wayne verified independently and corrected:** he re-ran the same
comparison against the request logs directly (not the numbers above) and got
different raw totals — pre-deploy 298 POSTs/0 cached/35 consolidated/298
unkeyed, post-deploy 255 POSTs/6 cached/12 consolidated/33 unkeyed — which
this file does not reconcile against the count above; treat his totals as the
authoritative measurement of POST volume and the ones above as the
duplicate-group/uncaught-ticket trace. He also checked, on the 8 consolidated
calls found above, whether a keyed retry was leaking past the cache into
consolidation (a TTL or key-mismatch bug) — it wasn't: each of the 8 carries
exactly one POST bearing its key, confirming they are distinct
returning-patient calls consolidating correctly, not the cache missing a
duplicate. **Idempotency and consolidation coexist correctly** is his
finding, verified against the trace, not mine alone.

That is what makes it safe to release our local lock and retry — see
[ticket-creation-lock.md](ticket-creation-lock.md).

**A second, concrete cost of the sentinel callSid, found 2026-08-21 while
investigating an unrelated location-refusal call:** `VA-53731` filed
correctly (a real ticket, for a real patient) but carries `call_sid:
"unknown"` in the Support Center DB. Because `call_logs.ticket_number` syncs
back by matching call_sid, and the ticket's stored call_sid is the sentinel
rather than the real one, that sync had nothing to match and never ran. Our
own call log shows a call that produced nothing, for a call that in fact
filed a ticket. Evidence for the sentinel piece; not started.

**Separately, not fixed:** the four tools return `retryable: true`
unconditionally on any failed `createTicket()` — including a permanent 4xx
Zod rejection that will fail identically on every retry. `makeRequest()`
(`server/services/ticketingApiClient.ts`) throws away `response.status` when
it throws, so `createTicket()`'s catch block can't tell a permanent 400 from
a transient timeout/5xx. Confirmed live twice in 14 days: a `patientPhone`
too-long rejection retried 17 times over 11 minutes (2026-08-19) and 11 times
over 5 minutes (2026-08-20), zero tickets filed either time. The
`retryable: true` → loop is the same failure shape `opticalTools.ts`'s
location-lookup already hit and fixed on 2026-08-13 (nine retries, 236
seconds) — that fix returned the `missing()` envelope instead, which the
prompts are already trained to answer by speaking to the caller rather than
retrying the tool. See `opticalTools.ts:166-186` for the precedent.

**Status 2026-08-21:** the trigger for both observed instances (the
`patientPhone` length rejection) has a fix in progress (PR #222) — send
`normalizePhone()`'s last-10-digit form with a ceiling refusal instead of the
raw string. The `retryable: true` classifier itself — the safety net for
whatever schema constraint fires next — is still open, deliberately a
separate piece.

## GSM-7 and the SMS on the other side

Free text we send becomes the body of a **patient-facing SMS**. One character
outside GSM-7 turns a 160-character segment into 70, and multi-segment long-code
traffic is far more exposed to US carrier A2P filtering — a message can be
accepted, billed, marked `sent`, and silently dropped.

Measured 2026-08-12: **1,700 of 17,446 voice tickets in 90 days (9.7%)** carried
smart punctuation in the description. Found from one curly apostrophe in
*"we've"*. Everything free-text goes through `sanitizeForSms` (`services/gsm7`).

## Known-wrong config still in the tree

- `config/answeringServiceTicketing.ts` still has fallback IDs that predate the
  measured taxonomies.
- `validDepartments = [1,2,3,11,12]` is wrong — it omits departments that take
  real traffic, including the HVA Hub (9).

Neither is load-bearing for the queue agents, which carry their own IDs. Both
will bite whoever trusts them next.
