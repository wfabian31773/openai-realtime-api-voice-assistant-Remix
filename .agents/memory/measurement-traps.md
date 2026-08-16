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

### The worst version: a log written *after* validation

The ticketing agent could not tell whether my `suggested*` hints were arriving,
because `submit-ticket` logged `validation.data` — the object **after** zod had
stripped every unrecognised key. Their words: *"that zero is worthless… the
table that exists to record what you send was recording what survived my
validation."*

A zero there reads identically for "the sender never sent it" and "I threw it
away on arrival", and those need opposite fixes. **Log the raw body before
parsing, and warn by name on keys you drop.** Any instrumentation downstream of
a filter measures the filter.

This is the same shape as the strict-mode tool bug — the rejection happened
upstream of every counter — and it is now the third time in this thread a zero
has meant *not recorded*.

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

## Two agents agreeing is not verification

I proposed a mechanism for department 8's reason 159 — "the fallback picks the
first active reason of the default type". The ticketing agent confirmed it in
writing. **Neither of us had read the code and there is no such fallback**; the
real cause was a two-character keyword (`er`) matched with `String.includes`.
See [reason-fallback-leak.md](reason-fallback-leak.md).

The agreement felt like corroboration and was the same story told twice. What
made it possible: the classifier opened a database connection at import, so it
had no tests and could not be loaded to inspect. **The bug was not hard to see,
it was impossible to look at** — the same condition that hid "a list containing
a prefix of itself".

When a mechanism has been asserted and confirmed but nobody has pointed at the
line that does it, it is still a hypothesis. Say so in the sentence.

## A test that reads the wall clock is not flaky — it is wrong at a known time

Six `handoffPolicy` tests and four `director` tests failed on 2026-08-13 at
12:05 Pacific and passed at 12:05 every other hour. `resolveHandoffDestination`
and `PcpDirector` read the real clock for the **12:00–13:00 lunch closure**
unless it is injected, and these tests did not inject it. Both already
supported injection; `lunchClosure.test.ts` used it correctly, so the gap was
invisible from the code.

The trap is the diagnosis, not the bug: they went red in the middle of an
unrelated change and looked exactly like a regression I had just caused.
**Confirm a failure exists on a clean checkout before debugging it** — `git
stash`, re-run, compare. Every PCP director and policy test now pins the clock.

## Import-time database connections make code impossible to LOOK AT

`azulSchedulingAgent.ts` imports `toolTimeline`, which opens a DB connection at
import, so the whole module threw `DATABASE_URL: Required` in any test. The
largest prompt in the fleet — ~275 lines, roughly thirty rules each paid for by
a real call — could not be asserted on at all.

That is the same shape as the ticketing app's reason-159 classifier: it also
connected at import, so it had no tests, could not be loaded to inspect, and a
two-character keyword sat in it for months while two agents guessed at the
mechanism. **The bug was not hard to see, it was impossible to look at.**

The fix is mechanical: extract the pure part into a module that imports nothing
stateful (`agents/azulSchedulingPrompt.ts`) and re-export it. `p0Hardening.test.ts`
still fails this way and is the remaining instance.

## "We don't have that" is a claim about your data, not about the world

I told the operator a caller had named an optical office we do not have —
"Downtown LA". His reply: *"we do have downtwon la that is our main los angeles
office."*

It was invisible from both ends. The NextGen mirror calls it **Azul Vision
DTLA**; the ticketing app calls it **Los Angeles**. The caller's own words
matched neither, and neither system's name matched the other's.

Three more offices had the same defect, found only by listing every clinic
beside its brand-stripped alias:

| caller says | mirror | ticketing app | vol/90d |
|---|---|---|---|
| "Downtown LA" | `Azul Vision DTLA` | Los Angeles | 4,810 |
| "Riverside" | `Azul Vision Riverside Latham` | Riverside | **11,399** |
| "Mission Hills" | `Azul Vision Mission Hlls` | Mission Hills | 7,259 |
| "Willow" | `Azul Vision Willow` | Long Beach Willow | 3,373 |

**26,841 appointments a quarter — a fifth of clinic volume**, including the
busiest clinic in the practice. `Mission Hlls` is a typo in NextGen itself.

Three things to carry forward:

- **A lookup that returns nothing is evidence about the index, not the world.**
  Before reporting an entity as non-existent, check what the other systems call
  it — and ask the operator, who knows the building.
- **Fixing the match alone is half a fix.** Even resolved, we handed on the
  mirror's form, and the receiver sets its foreign key by name. Two systems,
  two names, and the caller's word is a third.
- **I had already been told this.** The ticketing agent measured exactly this
  drift across 11,296 appointments — for PROVIDERS. I checked providers,
  wrote it up, and never asked whether locations had the same problem. When a
  class of bug is found in one column, go and look in the others.

`LOCATION_ALIASES` in `services/consoleDirectory.ts` is deliberately a
named-exceptions list, not a fuzzy matcher: fuzzy would hide the drift this
exists to expose, and would eventually route someone to the wrong clinic.
`long beach` is explicitly NOT aliased to Willow — a different clinic with
9,241 a quarter. **An alias that steals a key is worse than one that does not
resolve.**

## A deploy that did not take looks exactly like a fix that did not work

Wayne pulls and republishes on Replit. On 2026-08-11 a GitHub rate limit made his
pull fail at 00:34; he called at 00:36 and the next round analysed stale code.
On 2026-08-12 the `call_data_synced` sweeper "was broken" because the **workspace**
had been republished and the **Deployment** had not.

Before diagnosing behaviour, confirm the build under test is the build running.

## A tool that records `{}` is not a tool that did nothing

2026-08-14. Wayne: *"still bad, pull the last two calls to the pcp line."* On
`CAf00cfcb4` the tool timeline held this nine times:

    {"tool":"record_pcp_intake","args":{},"outcome":{}}

I read that as "the model is calling the intake tool empty." It was not. Every
argument `record_pcp_intake` takes is an identifier, so `SAFE_ARG_KEYS` dropped
all of them; and it returns a `PcpDirectorDecision`, none of whose keys were in
`summarizeResult`'s list. **The most important tool on the line was invisible in
both directions, and had been since the day it was written.**

Nine empty records is indistinguishable from nine useless calls. I could not
tell the operator which he had, on the exact question he was asking.

The general trap: **an allow-list that drops everything produces a record that
looks like an observation.** A tool whose arguments are ALL identifiers and
whose result is ALL policy will silently record nothing, forever, and no test
notices because `{}` is a valid object. When adding a tool, ask what its
timeline row will look like — if the answer is `{}`, the row is a lie.

What is safe to record, and the reasoning that generalizes:

- **Field NAMES, never values.** `Object.keys(args)` answers "did it record the
  name?" without storing the name. Same discipline `missingFields` already used.
- **A closed enum that names a DESK is routing, not identity.** `callPurpose`
  and `callerFacilityType` are the same class as `department_id` — they decide
  where the request lands and describe no person. They belong in the allow-list.
- **Policy verdicts are not PHI.** `disposition`, `handoffEligible`,
  `mayTerminate` are what the server decided, not what the caller said.
- **But not the WORDING.** `nextQuestion.prompt` is fixed text from `PROMPTS`
  today and is deliberately not stored: it is the one field a later change
  could make quote the caller back, and by then nobody revisits the allow-list.

Pinned in `services/pcpIntakeTelemetry.test.ts`, including a test that
serializes the whole record and asserts the real call's name, organization,
phone and DOB appear nowhere in it.

## The accurate number was computed, then overwritten — 99% of the time

2026-08-16. Operator: *"track down the cost discrepancy... this is the most
important piece, if we can't get this to agree, we don't know if we are being
efficient and if we are getting an roi."*

The decisive query, and the shape of it is reusable for any "is this column
real?" question — **check whether the stored value equals a formula**:

    select count(*) filter (where openai_cost_cents = ceil(duration * 0.19)),
           count(*) filter (where openai_cost_cents = round(duration/60.0*19)),
           count(*) filter (where openai_cost_cents = round(duration/60.0*15))
    from call_logs where input_audio_tokens > 0;

Of 2,318 calls carrying REAL OpenAI token counts, **2,181 matched
`ceil(duration * 0.19)` exactly** and only 29 — 1.3% — were priced from the
tokens. A column can be populated, non-null, and derived from something else
entirely.

Root cause: five writers of one column, four different rates (11.4¢/min,
19¢/min, 15¢/min, 6+24¢/min), racing after every call with no ordering.
`recalculateOpenAICostFromDuration` had no `inputAudioTokens == null` guard
while its two siblings did, and it runs from six places including the teardown
that just wrote the good number, plus retries at 30s and 90s.

**The token columns survived the overwrite.** So a row showed real usage next
to a cost never derived from it, and any audit assuming "tokens present =>
token-derived cost" was wrong. That is the trap: the evidence of measurement
outlives the measurement.

### A column that exists is not a column that is written

`input_cached_audio_tokens` was **0 on every row ever written**. The column was
in the schema, the pricing code read it, nothing populated it — OpenAI reports
the split at `input_token_details.cached_tokens_details.{audio_tokens,
text_tokens}` and we only captured the undifferentiated `cached_tokens`.

Worth the specific note because of the asymmetry: cached audio is **$0.40/M
against $32/M — 80x** — while cached text is $0.40 against $4, only 10x. The
pro-rata split the code fell back on pushes cached tokens toward text and away
from audio, so it inflates. A token recalculation came out at $55 for a day
OpenAI billed $44.

### Comparing two estimates tells you nothing; find the third source

I spent a while comparing `call_logs` sums against `daily_org_usage.
estimated_cost_cents` and got a contradiction, because BOTH are our own rate
card applied to different token sources. The authoritative number is OpenAI's
Costs API, stored in `daily_openai_costs.realtime_cost_cents`.

Against that: **$0.27-0.37 per call**, and our per-call sum was +1%, +41%, +5%,
-15%, +1%, -43% across six days. Not a bias to correct with a coefficient —
noise, which is exactly what a duration proxy produces when the call mix moves.

### And an alert that cannot fire correctly

`orgBillingLedger` compares whole-org spend against voice-only spend — no
`project_ids[]` filter — while the SAME function computes a realtime/other
split and uses only the realtime part when writing `daily_openai_costs`. One
run persists a scope-matched comparison in one table and an apples-to-oranges
one in another, and alerts on the second.

I reported that as the cause of the 43% gap and **it was not**:
`other_cost_cents` is $0.00 every day — essentially all spend here is voice.
Real bug, immaterial effect. Check the magnitude before naming a cause.
