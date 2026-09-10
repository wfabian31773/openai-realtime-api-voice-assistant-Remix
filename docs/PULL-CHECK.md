# Did the pull actually take?

**A failed pull looks exactly like a failed fix.** On 2026-08-11 a GitHub rate
limit made a pull fail at 00:34, a call came in at 00:36, and the next round
was spent analysing stale code. This page is the sixty-second check that
stops that happening again.

Run it after every republish, before drawing any conclusion from a call.

---

## 1. Two lines that print at BOOT, every time

If these are absent, **the build is not live and no call proves anything.**

```
[voice-runtime] lanes this deployment can serve (5/8): optical, surgery, tech, records, answering-service
[GROK COST] reconciler DORMANT — set XAI_MANAGEMENT_KEY and XAI_TEAM_ID to switch it on …
```

The first is new in this build and did not exist before it — it is the
fastest single tell. The second says the cost reconciler is installed but has
no credential yet; once the two variables are set it changes to

```
[GROK COST] Starting cost reconciler (every 360 minutes; settles the previous UTC day …)
```

Alongside them, from earlier builds, both still expected:

```
[TICKET OUTBOX] Starting retry worker (every 60s; up to 12 attempts, backoff 30s → 30m …)
[ALERT SERVICE] Starting ticket-filing alarm (every 5 minutes)
```

## 2. One line per lane, on its first call after the pull

```
[AGENT ID] optical -> 5c01c386-…; call_logs.agent_id will be set on this lane
```

Four of these (optical, surgery, tech, records) means every lane resolved its
agents-table id. Any lane printing this instead is invisible in the
Observatory and in every cost and quality report until it is fixed:

```
[AGENT ID] no agents row for slug "…" — call_logs.agent_id stays NULL, so this lane
  is INVISIBLE in the Observatory scorecard and in every cost and quality report
```

## 3. `/voice/health` answers the rest without shell access

```
GET https://<domain>/voice/health
```

- `marker` — the deploy marker string.
- `lanes` — per lane: `servable`, and `blockedBy` with the sentence why not.
- `lanes[].transferWarning` — **the one to read for pcp.** A lane can be
  served, sound healthy, and fail every transfer because no number is
  configured. This names it.
- `transferReady` / `transferBlockedBy` / `transferDestinations`.

## 4. One SQL check that must come back empty, and one that need not

The first returned the FULL population before this build, so a zero is proof.

```sql
-- was 239 of 239 on 2026-09-03. Any row here is a lane missing from five reports.
SELECT count(*) FROM call_logs
 WHERE voice_provider = 'grok' AND agent_id IS NULL AND created_at > '<deploy time>';
```

The second is a reading check, not a pass/fail one:

```sql
-- one optical call returned 118 before the tool ceiling shipped.
-- NOT an empty check, and not part of the two above: `begin` refuses at
-- `>= perCallDispatches`, so a stopped loop lands on exactly 40 and a `> 40`
-- threshold can never see one. Each row is a CANDIDATE loop, not a proven
-- one: 40 means 40 dispatches were ALLOWED, and since begin refuses at
-- `>= 40` it is the 41st ATTEMPT that is stopped and never counted. A call
-- that just finished after its 40th tool looks the same here. Confirm by
-- reading tool_timeline — a real loop repeats one tool ~30 times.
-- Only a row ABOVE 40 is a fault, and it means the ceiling is
-- not in the dispatch path. Keep 40 in step with
-- DEFAULT_CEILING_LIMITS.perCallDispatches (src/runtime/toolCeiling.ts);
-- ceilingDocCheck.test.ts fails if they drift.
-- SEES ONE OF THE CEILING'S THREE RULES. identicalFailures (3) and
-- perToolFailures (6) are PER-TOOL counters, not call totals — 20 good calls
-- to one tool then three identical failures of another is a stop at a total
-- of 23. So do not expect a stopped call to read 3 or 6; expect any total
-- BELOW 40, because the call-total check runs first and would have fired
-- otherwise. Such a stop also leaves no trace on the row: `begin` returns
-- before agent.dispatch, so recordingExecute never runs and nothing reaches
-- tool_timeline or tool_call_count. Empty here means "nothing reached the
-- dispatch limit", NOT "the ceiling never fired".
SELECT call_sid, tool_call_count FROM call_logs
 WHERE voice_provider = 'grok' AND tool_call_count >= 40;
```

And one that will stay at the full count until the xAI management key exists —
it is the measure of how many calls are still priced from a constant rather
than from the bill:

```sql
SELECT count(*) FROM call_logs
 WHERE voice_provider = 'grok' AND cost_reconciled_at IS NULL;
```

## 5. Live counters — these print only when the thing happens

Each one is both a deploy marker and a running count of what the change is
worth. None of them carries a name, a date of birth or a phone number.

```
[DOB ESCAPE] file_optical_ticket: asked once and still no usable date of birth —
  filing anyway, marked unavailable (CA…)
[DOB] refused a date of birth in the shape (none)
[REQUEST SWEEP] tech: recovered request filed as VA-… (CA…)
[REQUEST SWEEP] surgery: a request was made and nobody was identified —
  not filed, needs a callback (CA…)
[TOOL CEILING] file_optical_ticket not dispatched — 3 consecutive failures …
[ALERT SERVICE] Ticket filing OK — 3 call(s) since the last ticket …
```

`[DOB ESCAPE]` is the one to watch on day one: every line is a request that
would have been lost before this build. The gate it removes killed 23 of 23
calls it touched on 2026-09-03.
