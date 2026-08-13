# The ticket-creation lock — a failure must give it back

`submitSimplifiedTicket` takes a **60-second** lock on the call
(`call_logs.ticket_creation_pending`) before it files, so two processes cannot
open two tickets for one call. It released that lock **on success only**.

Every failure return left the lock set. So the retry that failure invites ran
into the lock the failure itself left behind: `claimTicketCreation` returns
`claimed: false`, the code waits 3 seconds, rechecks, finds no ticket, and
returns `'Concurrent ticket creation in progress'`.

**Observed 2026-08-12 23:38 — four create attempts on one call, no ticket, and
the caller on the line for all of it.**

## The recoverable failure is the one that hurt

When the ticketing API answers with `missingFields`, the agent is *told* to
collect them and try again. The caller supplies the date of birth in ten or
twenty seconds — well inside the lease — and the second attempt cannot get
through. **A refusal designed to be recoverable was made unrecoverable for a
minute.**

## This is the after-hours path

Wayne, 2026-08-13: *"all overnight volume is on the no ivr agent which i use as
the after hours agent."* `noIvrAgent`'s `create_ticket` files through
`submitSimplifiedTicket`. Same for `noIvrAgentV2` and `afterHoursAgent`.

I had first described this as an answering-service problem. It is not — it sits
on the line that carries the night.

## The fix (PR #185)

- Release on all three failure returns: missing fields, API error, exception.
- **`resolveTicketLookupFields` moved inside the `try`.** It is a network lookup
  that ran between the claim and the only release, and outside the error
  handling — a throw there left the lock set with no release on *any* path, which
  is the same blackout and much harder to see.
- Release **only when the claim actually succeeded**. Two paths proceed *without*
  the lock (no call log to lock; the claim itself throwing) and releasing there
  would clear a lock another process holds — the exact duplicate the mechanism
  exists to prevent.

Safe against duplicates because of `idempotencyKey: call-<callSid>`. The sibling
`createTicket` had released on failure all along; this made that deliberate.

## Testing note that generalises

My first regression test mocked `claimTicketCreation` as *always granted*, so it
**passed with the bug still in place.** A lock test has to model the lock: the
fake now mirrors `DatabaseStorage.claimTicketCreation`'s compare-and-set with its
own pending timestamp and a controllable clock, and the retry happens fifteen
seconds later.

Also: use `vi.resetAllMocks()`, not `clearAllMocks()`. Clear leaves queued
`mockResolvedValueOnce` values in place, so one test's unconsumed answer becomes
the next test's first answer. That leak made a failing test appear to pass here.

**Always revert the source and re-run.** Five of the ten tests fail against the
old code; the other five guard the opposite direction (never release a lock we do
not hold, never file twice once a ticket exists) and pass either way by design.
