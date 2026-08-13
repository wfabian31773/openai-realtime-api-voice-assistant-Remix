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

## Idempotency

Every submit carries `idempotencyKey: call-<callSid>`. The far side dedupes on
it. That is what makes it safe to release our local lock and retry — see
[ticket-creation-lock.md](ticket-creation-lock.md).

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
