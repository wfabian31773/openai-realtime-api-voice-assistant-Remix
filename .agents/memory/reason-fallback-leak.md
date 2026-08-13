# The hardcoded reason fallback, and where it has leaked

One function is responsible for the largest wrong-data population in the
practice. `detectRequestReason()` in `config/answeringServiceTicketing.ts`:

> no keyword matched → return the **first reason of the default type**

Its sibling `detectRequestType()` does the same thing one level up. Neither ever
fails; both always return something, and the something is whatever happens to be
first in the table.

## The count, measured 2026-08-13 over 90 days

| Department | Symptom | Tickets |
|---|---|---|
| 3 Clinical Tech Support | reason **153** Prescription Refill | 6,905 |
| 3 | no reason at all | 1,714 |
| 8 After Hours | reason **159** Transferred to On-Call Provider | 479 |
| 8 | no reason at all | 274 |
| 8 | reason **153** — another department's | 13 |
| 9 HVA Hub | reason **153** on request type 32 | 224 |
| 9 | no reason at all | 463 |
| 16 Medical Records | no type and no reason | 453 |

**Department 8 is 76% mis-recorded. Department 16 is 91.5%.**

## WHOSE FALLBACK — corrected 2026-08-13

I first wrote that all of the above came from our `detectRequestReason()`. It
does not, and the attribution decides who can fix each one.

`detectRequestReason` is imported by `answeringServiceAgent` and **nothing
else**. `no-ivr` files through `submitSimplifiedTicket`, which posts
conversational fields and sends **no department, no request type and no
reason** — the mapping is the ticketing app's. The split proves it:

| Dept | symptom | `answering-service` | `no-ivr` |
|---|---|---|---|
| 3 | reason 153 | **6,119** | 106 |
| 8 | reason **159** | 9 | **413** |
| 9 | reason 153 | 0 | **168** |

**Ours:** department 3. **Theirs:** department 8's 159 and department 9's 153.

The practical consequence: department 8 cannot be corrected from this repo by
picking a better reason, because that path has no field to put one in.
Switching `no-ivr` to `create-ticket` would mean this repo choosing the
DEPARTMENT for every overnight call — the entire answering-service
classification problem, on the line that carries the night. Not a trade worth
making to fix a label.

So `afterHoursTaxonomy`'s classification is sent as a **hint**
(`suggestedRequestTypeId` / `suggestedRequestReasonId` / `suggestedRequestReason`
/ `suggestedUrgent`), inert until the ticketing app reads it. Same shape as the
CAP fields on the records path.

**The general lesson**, and it is the one that keeps recurring: *which* code
produced a row is a separate question from *what* the row says. Both times I
got this wrong I reasoned from the value rather than tracing the writer.

## And the mechanism was wrong too — corrected 2026-08-13

I wrote that department 8's 159s came from "the first active reason of the
default type". The ticketing agent confirmed it. **Neither of us read the code,
and there is no such fallback.**

The real cause is a **two-character keyword**: their `urgent_transfer` mapping
carries `er`, matched with `String.includes`, at the highest priority in the
table. It fires inside call**er**, h**er**, numb**er**, provid**er**,
transf**er** — and Qui**er**o. Their `now` keyword has the same defect one
letter longer: it matches inside "know".

Bigger than we had it, too: not 413 on one path but **479 in 90 days, 97% of
every type-34 ticket, 462 with no urgent word in them at all.** A replay of 300
through their fix reclassifies 287 — **95.7%**.

**TWO AGENTS AGREEING IS NOT VERIFICATION.** I proposed a plausible mechanism,
they confirmed it, and the agreement felt like evidence when it was the same
story told twice. Neither of us could read the classifier: it opened a database
connection at import, so it had no tests and could not be loaded to inspect.
Same shape as "a list containing a prefix of itself" — the bug was not hard to
see, it was impossible to look at.

**So: when a mechanism is asserted and confirmed but nobody has pointed at the
line that does it, it is still a hypothesis.** Say so.

## Why each one is invisible in the obvious report

- **The department is right.** Group by department and department 9 looks
  healthy; the 224 only appear if you group by *reason within department* and
  notice that 153 does not belong to 9 at all.
- **The reason is plausible.** 153 on a medication queue is what you expect. It
  is 6,905 of 8,064 that gives it away, not the value.
- **The harm inverts.** Department 8's 479 do not under-describe emergencies —
  they record *routine* calls as urgent transfers. "Caller is asking for the
  exact office hours of the Eastvale location" and "Worsening pain in right eye
  over the past day" carry the same reason. That is what makes the real ones
  unfindable.

## The fix, and the shape of it

Every queue taxonomy falls to **its own department's "Other - See Description"**
rather than to a default type's first reason, and `classify*Request` never
returns null. The filing tools additionally refuse a reason id that belongs to
another department, whatever the agent names — so 153 is now impossible in
departments 8, 9 and 16 by construction, not by convention.

`159 is a disposition, not a reason.` It records that a transfer *happened*.
Only the code that completes one knows that. It is exported from
`afterHoursTaxonomy.ts` separately and is deliberately absent from the
classification table.

## Still to do

`config/answeringServiceTicketing.ts` itself is untouched — the queue tools
bypass it, but the answering-service path still runs it. Fixing the fallback
there is the change that stops new bad rows arriving from the biggest line of
all; nothing above does that.

Also still true: `validDepartments = [1,2,3,11,12]` in that file omits the HVA
Hub (9), Medical Records (16), PCP Support (18) and After Hours (8).
