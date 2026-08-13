# Measurement traps — how a number lies

Every one of these produced a confident wrong statement to Wayne. They recur
because each is a *reasonable* reading of a real query result.

## Snapshot vs history

A table that holds current state cannot answer a question about the past.
`patients_master` is a **live mirror** — 14,182 rows re-synced in 7 days — so
"how many X are there" is a snapshot, and a row deleted from it comes back on the
next sync.

This is also why I declined to delete the six test patient records when Wayne
said *"you are clear to remove those test records."* Deletion would be undone by
the mirror. The real fix is clearing the phone on those records **in NextGen**,
upstream of the sync. Deleting downstream would have looked like it worked.

## Zero means "not instrumented" until proven otherwise

A count of zero has two causes: it never happened, or nothing recorded it. Check
whether the field is written *at all* before reporting an absence as a finding.
The strict-mode tool bug looked like "the model chose not to call the tool" for
exactly this reason — the rejection happened upstream of every counter we have.

## Floor vs total

A parser floor, a classified subset, a filtered view — none of them is the
denominator. "54.6% of optical tickets carry reason 153" is only meaningful
against *all* optical tickets, not against the ones that got classified.

## Accepted ≠ delivered

An SMS can be accepted, billed, marked `sent`, and silently dropped by US carrier
A2P filtering. `sent` is our side of the handshake, not the patient's. See the
GSM-7 note in [ticketing-api-contract.md](ticketing-api-contract.md).

## Absence in a log is not absence in the world

I told Wayne "there is no `create-ticket` POST in the logs, so it was never
sent", then withdrew it as a log-filtering artefact. **It was the real signal.**
The correction to make is not "trust logs less" — it is: when a log-absence and a
theory disagree, go and prove which one is wrong instead of picking.

## Source-scanning tests prove a line exists, not that it behaves

This gave false confidence **twice in one day**. A test that greps the source for
`strict: false` passes whether or not the schema is right. Assert on produced
behaviour: build the object, call the function, check the output.

The same applies to lock tests that mock the lock as always-granted, and to any
test that mocks away the exact mechanism under test. See
[ticket-creation-lock.md](ticket-creation-lock.md).

**The habit that catches all of these: revert the fix, re-run the test, and
confirm it goes red.** A test that passes both ways is documentation, not
verification — which is fine, as long as you know which one you wrote.

## A deploy that did not take looks exactly like a fix that did not work

Wayne pulls and republishes on Replit. On 2026-08-11 a GitHub rate limit made his
pull fail at 00:34; he called at 00:36 and the next round analysed stale code.
On 2026-08-12 the `call_data_synced` sweeper "was broken" because the **workspace**
had been republished and the **Deployment** had not.

Before diagnosing behaviour, confirm the build under test is the build running.
