# The fleet watcher

**What it is:** one read-only pass over the voice lanes that reports what the
day looks like and, more importantly, refuses to raise an alarm on the six
shapes this project has already misread at least once.

```bash
npx tsx scripts/fleet-watch.ts             # today, UTC
npx tsx scripts/fleet-watch.ts 2026-09-08  # a named day
```

It writes nothing, anywhere. Every statement is a `SELECT` and both pools are
opened with `default_transaction_read_only=on`.

---

## Credentials

| variable | for | required? |
|---|---|---|
| `SUPABASE_POOLER_URL` (else `DATABASE_URL`) | Operations Hub — `call_logs` | **yes** |
| `OBS_SUPPORT_DATABASE_URL` | Support Center — `tickets` | optional |

**Without the second one every filing figure reports `UNKNOWN`, and never
`0%`.** That is deliberate and it is rule 4 below. This repo has no SQL
credential for the Support Center today — it reaches ticketing over HTTP — so
until a read-only role exists there, the filing half comes from a session with
Supabase access rather than from this script.

---

## The six non-alarm rules, and the incident behind each

The interesting content of this instrument is what it refuses to say. Each rule
is in `server/observatory/fleetWatch.logic.ts`, each is mutation-tested in
`fleetWatch.logic.test.ts`, and each exists because the opposite reading was
published as fact at least once.

### 1. A call at the tool ceiling is the ceiling working

`ToolCallCeiling.begin` refuses at `dispatches >= perCallDispatches` (40), so a
call can **reach** 40 and can never exceed it. The check published before
2026-09-09 asked for `tool_call_count > 40` and was therefore blind to every
loop the ceiling stopped.

Measured 2026-09-09, all grok rows: `> 40` = **1** (the pre-ceiling optical call
of 118), `= 40` = **5**, between 25 and 39 = **0**. The empty middle band is what
makes it unambiguous — 40 is the ceiling being struck, not a value calls drift
to.

So: a row at 40 is a `watch`, and only a row **above** 40 is an `alarm`, because
that would mean the ceiling is not in the dispatch path at all.

**And the check is blind to about a third of the population**, because
`tool_call_count` is NULL on roughly that share of grok rows, steady on every
day the lane has run. The watcher prints that blind share beside the result
instead of implying a clean sweep.

### 2. A single hour is never a spike

Surgery's hourly barely-heard rate on 2026-09-08 ran
`16.7 · 14.3 · 42.9 · 31.6 · 36.4 · 5.9 · 31.6 · 7.7 · 0.0` percent across nine
business hours, at n = 9–19 each. Any one hour above the 25% watch level sits
inside that established spread.

The watcher takes a whole-day (or multi-hour) window and reports `info` rather
than `watch` below 25 substantive calls.

### 3. Quiet queue lanes on a weekend or holiday are the routing working

Standing instruction 13 routes everything out of hours to the after-hours agent
(`no-ivr`), which is on the old core. Measured:

| day | | no-ivr | queue lanes |
|---|---|---|---|
| 2026-09-05 | Sat | 133 | 1 |
| 2026-09-06 | Sun | 26 | 0 |
| **2026-09-07** | **Mon — Labor Day** | **276** | **2** |

**A holiday Monday is indistinguishable from a total queue-lane outage on
volume alone.** The discriminator is not the calendar, it is whether `no-ivr` is
absorbing: a real outage leaves *both* quiet, because the numbers simply fail.
`isClosedOfficeShape` encodes exactly that, and the fleet-level note is emitted
once rather than as a finding against every empty lane.

### 4. A filing rate we could not measure is `UNKNOWN`, never `0%`

`tickets` is in the Support Center (`vsmcxhxeirkoobmjcrbn`) and `call_logs` in
the Operations Hub (`pslzngjciiifowemrzza`). **No single statement joins them**,
so the script pulls agent-filed SIDs from one and intersects in memory.

If that read is unavailable or fails, `filed` stays `null` all the way to the
report. Rendering it as 0% would reproduce the 2026-09-03 error that understated
filing by about a third — a broken instrument reported as a broken fleet.

The filing test itself is unchanged from `/CLAUDE.md`: canonical SIDs
(`~* '^CA[0-9a-f]{32}$'`), agent provenance
(`created_by_id IS NULL AND agent_used IS NOT NULL`), anchored on the **call's**
day with `coalesce(call_start_time, created_at)`.

**The lane always comes from `call_logs.agent_used`, never from the ticket's
copy.** On 2026-09-03 the ticket-side column read `unknown` on 91 rows, and
grouping that day by it reported optical = 1 when optical had filed 28.

### 5. `tool_timeline` is reliable for refusals only

It drops about 35% of successful filings fleet-wide, and 100% of them on pcp.
So the watcher reads `outcome.missingFields` from it — which is trustworthy —
and reads filing from `tickets`. An empty timeline is never treated as evidence
that no tool ran.

Related: `call_logs.total_turns` counts something that is not transcript turns
(it fell 16.1 → 9.7 across the tech cutover while callers demonstrably said
*more*). Caller lines are counted from the transcript instead.

### 6. A move at small n is not a move

`isRealMove` is a two-proportion z-test with a hard floor of 25 substantive
calls per side. Below that it returns `false` whatever the gap looks like,
because the test has no power there and reporting its verdict is theatre.

Calibration, from the record: the cutover's filing deltas (tech 49/73 → 46/66,
surgery 22/44 → 18/32) come back **not a move**, which is what was correctly
published at the time. The date-of-birth gate across the same cutover
(2/123 → 23/186) comes back **a real move**, which it was.

---

## The filing-stop alarm

Longest run of consecutive substantive calls, in time order, that filed
nothing. Threshold **12**, derived 2026-09-01: such runs were **185** once (the
08-31 n8n outage) and **never above 8** otherwise. 12 sits between the worst
healthy run and the outage, and would have caught 08-31 at 20:23:06 — seven
minutes in, instead of hours later when staff told Wayne.

The threshold is asserted against the literal `12` in the test, not against the
constant, so raising the limit fails rather than silently passing.

---

## Testing

`server/observatory/fleetWatch.logic.test.ts` — 28 tests. Every rule above was
mutation-checked: reverting it must turn the suite red, or the test is
decoration (failure mode 10 in `/CLAUDE.md`).

Twelve mutations, all killed: the ceiling reverted to the blind `> 40` reading;
the ceiling limit moved off 40; the alarm widened from *above* to *at*; the
after-hours discriminator dropped from the closed-office test; `UNKNOWN`
rendered as `0.0%`; the minimum-n guard removed; the filing-stop threshold moved
off 12; the barely-heard watch level moved off 25; an unmeasured filing half
folded to `0`; an all-NULL `maxToolCalls` folded to `0`; the pipeline dropped
from the grouping key; and the unfiled-run counter reset on the wrong branch.

Two of those mutations were only reachable after a real bug was fixed in the
suite itself, and both are worth recording:

- The filing-stop and ceiling thresholds were originally asserted **against
  their own constants**, so moving a constant moved the assertion with it and
  the mutation survived. Pinned to literals.
- The grouping key was built by joining lane and pipeline into a string and
  splitting it back out. Both separators had been corrupted into **NUL bytes**,
  which made the file read as binary to git and grep — and, because join and
  split shared the same corrupted byte, the code still worked and every test
  still passed. It was found only because a mutation *failed to apply*. The key
  no longer round-trips through a string at all; the parts are carried in the
  map value.

The second one is the sharper lesson: **a mutation that cannot be applied is
not a mutation that was survived**, and a script that does not check whether its
edit landed will report the second as the first.
