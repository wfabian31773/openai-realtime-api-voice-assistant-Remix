# AFTER-MEASUREMENTS — what the 2026-09-17 republish turns on (v37–v56)

`docs/BACKEND_HANDOFF.md`'s rule, made runnable: every ship in PR #321 and the
two merged before it (v37, v38) names a number it must move and a guard it must
not. **Every query below was executed against the live databases on
2026-09-17 04:50–05:00 UTC and returns**; the before-values quoted beside each
are what it returned then. Run each after the republish has served a business
day, and compare. Nothing here is a claim about the after — only the
instrument and the before.

**Two projects.** Hub `pslzngjciiifowemrzza` holds `call_logs`, `call_turns`
and `daily_grok_costs`; Support Center `vsmcxhxeirkoobmjcrbn` holds `tickets`.
No statement can join them; where a number needs both, the Hub query lists
SIDs and the Support Center query takes the list.

**Rules that apply to every query** (CLAUDE.md, "HOW TO MEASURE WHETHER A
CALL FILED"): canonical SIDs only (`~* '^CA[0-9a-f]{32}$'`), the CALL's day not
the ticket's (`coalesce(call_start_time, created_at)`), substantive means
`duration >= 30`, and `call_logs.ticket_number` is NOT proof of a non-filing —
check the Support Center before calling a call unfiled.

**First, confirm the build:** `GET /voice/health` must read
`voice-runtime-v56-an-unvoiced-answer-cannot-end-the-call-20260917`. A number
taken on an older marker is a before-number.

---

## v37 — PCP stops asking for title and email BEFORE filing

Number: PCP substantive calls that END on the email question with no ticket of
any provenance — **10 on 2026-09-16, target 0**. Guard: PCP tickets per
substantive call must RISE; `pcp_caller_email` will FALL (accepted).

```sql
-- Hub. The v37 signature: the email ask disappearing from PCP transcripts.
SELECT created_at::date AS day, count(*) AS substantive,
       count(*) FILTER (WHERE transcript ILIKE '%email address%') AS asked_email,
       count(*) FILTER (WHERE transcript ~* 'AGENT:[^\n]*email[^\n]*\s*$') AS ended_on_the_email_ask,
       count(*) FILTER (WHERE ticket_number IS NOT NULL) AS ticket_on_call_logs
FROM call_logs
WHERE agent_used = 'pcp' AND duration >= 30 AND created_at >= '2026-09-16'
GROUP BY 1 ORDER BY 1;
```

## v38 — a tool call is persisted when it finishes

Number: `tool_call_count IS NULL` on substantive PCP calls — **44.3% on the
full day of 2026-09-16 (90.9% on the partial day it was measured), target near
the other lanes' ~15–22%**. Guard: `tool_timeline` event counts must not DROP
on any lane.

```sql
-- Hub. Also carries v44's two columns.
SELECT created_at::date AS day, agent_used, count(*) AS substantive,
       round(100.0 * count(*) FILTER (WHERE tool_call_count IS NULL) / count(*), 1) AS pct_tool_count_null,
       count(*) FILTER (WHERE recording_url IS NOT NULL) AS with_recording,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM call_turns t WHERE t.call_log_id = call_logs.id)) AS with_turns
FROM call_logs
WHERE voice_provider = 'grok' AND duration >= 30 AND created_at >= '2026-09-16'
GROUP BY 1,2 ORDER BY 1,2;
-- 2026-09-16 before: optical 22.2 / pcp 44.3 / surgery 13.2 / tech 15.3 % null;
-- with_recording 0 and with_turns 0 on every lane (v44 not yet deployed).
```

## v39 / v40 / v43 — the disclosure, the invented callback number, the narrated rule

v39 number: substantive optical/surgery/tech/records calls whose transcript
carries the disclosure — **0 of 401 on 2026-09-16, target all**; guard: median
caller lines must not fall, barely-heard must not rise. v40 number: transcripts
containing `ending in .` or `ending in "` + a non-digit — **2 on 2026-09-16
(1 pcp, 1 no-ivr), target 0**. v43 number: agent lines containing "words we
treat" / "Nothing matched" — **1 (surgery) on 2026-09-16, target 0**.

```sql
-- Hub.
SELECT created_at::date AS day, agent_used, count(*) AS substantive,
       count(*) FILTER (WHERE transcript ILIKE '%being recorded%') AS disclosed,
       count(*) FILTER (WHERE transcript ~* 'ending in (\.|"[^0-9])') AS invented_callback,
       count(*) FILTER (WHERE transcript ~ 'AGENT:[^\n]*(words we treat|Nothing matched)') AS narrated_rule
FROM call_logs
WHERE agent_used IN ('optical','surgery','tech','records','pcp','no-ivr') AND duration >= 30 AND created_at >= '2026-09-16'
GROUP BY 1,2 ORDER BY 1,2;
-- 2026-09-16 before: disclosed optical 0/81, surgery 0/121, tech 0/170, records 0/29
-- (pcp 227/228 and no-ivr 32/38 already carry it).
```

## v41 — the after-hours line asks for a date of birth once

Number: no-ivr substantive calls asking for a date of birth 3+ times — **9 on
2026-09-16 (worst 4), 3 on 09-15 (worst 5), 4 on 09-17 by 05:00 (worst 5);
target 0 via the tool path**. Guard: no-ivr tickets per substantive call must
not fall; `patientDOB` holds a date or `Unknown`. (no-ivr is on the OLD CORE:
this needs the republish, not the runtime marker.)

## v47 — a phone match is a candidate

Number: no-ivr substantive calls where an appointment (a clock time) is read by
the agent before any identity question — **4 on 2026-09-16, 5 on 09-15, 2 on
09-17 by 05:00; target 0**. Guard: appointments read AFTER the identity ask
must not vanish (`appointment_read_at_all` minus the first column).

```sql
-- Hub. v41 and v47 together.
SELECT created_at::date AS day, count(*) AS substantive,
       count(*) FILTER (WHERE (SELECT count(*) FROM regexp_matches(transcript, 'AGENT:[^\n]*date of birth', 'gi')) >= 3) AS dob_asked_3plus,
       max((SELECT count(*) FROM regexp_matches(transcript, 'AGENT:[^\n]*date of birth', 'gi'))) AS worst_dob_asks,
       count(*) FILTER (
         WHERE regexp_instr(transcript, 'AGENT:[^\n]*\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)', 1, 1, 0, 'i') > 0
           AND (regexp_instr(transcript, 'AGENT:[^\n]*(date of birth|your name|first and last name|last name)', 1, 1, 0, 'i') = 0
                OR regexp_instr(transcript, 'AGENT:[^\n]*\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)', 1, 1, 0, 'i')
                   < regexp_instr(transcript, 'AGENT:[^\n]*(date of birth|your name|first and last name|last name)', 1, 1, 0, 'i'))
       ) AS appointment_read_before_identity_ask,
       count(*) FILTER (WHERE regexp_instr(transcript, 'AGENT:[^\n]*\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)', 1, 1, 0, 'i') > 0) AS appointment_read_at_all
FROM call_logs
WHERE agent_used = 'no-ivr' AND duration >= 30 AND created_at >= '2026-09-15'
GROUP BY 1 ORDER BY 1;
```

## v42 — a filed ticket is never spoken as a failure

Number: calls where the agent spoke the technical-issue apology WHILE a ticket
exists for the SID — **2 on 2026-09-16, target 0**. Guard: two tickets on one
SID stays 0. Two halves, because the ticket lives in the other project.

```sql
-- Hub: who spoke it.
SELECT created_at::date AS day, agent_used, count(*) AS spoke_technical_issue, array_agg(call_sid) AS sids
FROM call_logs
WHERE duration >= 30 AND created_at >= '2026-09-16'
  AND transcript ~* 'AGENT:[^\n]*technical (system )?(error|issue)'
GROUP BY 1,2 ORDER BY 1,2;

-- Support Center: which of those calls nevertheless has a ticket (paste the SIDs).
SELECT call_sid, ticket_number, coalesce(call_start_time, created_at) AS call_at
FROM tickets WHERE call_sid IN ('<sid>', '<sid>');
```

## v44 — every runtime call gets a recording and timed turns

Number: runtime calls with `recording_url` NULL — **all of them, target ~0**;
runtime calls with zero `call_turns` rows — **all, target 0**. The v38 query
above carries both columns (`with_recording`, `with_turns`). Guard: filing
rate per lane and barely-heard rate must not move. The first console line to
look for on a call that stays NULL: `[RECORDING] failed to start`.

**Round 11 (08:16 UTC), on the recording push.** Two counters, both console
lines, neither in SQL: `[TICKETING SYNC] ○ a recording landed on call … left
pending` (the sync's mark-done matched no row because a URL landed after its
payload was built — the row goes on the next pass) and `[RECORDING] the push
failed on a call the post-call sync had already finished` (the round-10
reopen, now with the retry count reset). The number to watch is the one v44
already names: runtime tickets in the Support Center that carry a transcript
and duration but no recording URL — target 0, whichever ordering the callback
and the sweep landed in.

## v45 — the Grok day table

Number: rows in `daily_grok_costs` — **0 today**; one per runtime day from the
first nightly run after the deploy. A re-run of 2026-09-12 must read
`reconciled = false` with the implausible-rate reason.

```sql
-- Hub. The table is created lazily by the reconciler; this says whether it exists yet.
SELECT to_regclass('public.daily_grok_costs');
SELECT * FROM daily_grok_costs ORDER BY day DESC LIMIT 14;
```

### Round 14 on this ship (09:25 UTC)

The day-summary decision is now atomic (one transaction under a per-day
advisory lock), and a refusal that could not read the day writes NULL in
`runtime_calls`, `runtime_seconds` and `booked_cents` rather than 0. Same
queries; one new reading rule — a NULL row is *unknown*, not an empty day:

```sql
-- A refused day whose measurements are unknown, as opposed to measured at 0.
SELECT day, reconciled, refused_reason, runtime_calls, booked_cents, last_attempt_at
FROM daily_grok_costs WHERE runtime_calls IS NULL ORDER BY day;
-- target: rows here only when both xAI AND the Hub were unreachable in one run.
```

## v46 — a success loop is a loop

Number: substantive runtime calls where one tool returned success 11+ times
with the same recorded arguments — **6 on 2026-09-15 (worst 39), 1 on 09-16
(worst 35); target 0**. Guard: the 5–9 band (**8 and 9 calls** on those days —
legitimate retries) must still file; filing rate per lane must not fall.

```sql
-- Hub.
WITH ev AS (
  SELECT c.call_sid, c.created_at::date AS day, e->>'tool' AS tool, (e->'args')::text AS args
  FROM call_logs c, LATERAL jsonb_array_elements(c.tool_timeline->'events') e
  WHERE c.voice_provider = 'grok' AND c.duration >= 30 AND c.created_at >= '2026-09-15'
    AND coalesce(e->'outcome'->>'success', 'true') <> 'false'
), runs AS (SELECT day, call_sid, tool, args, count(*) AS n FROM ev GROUP BY 1,2,3,4)
SELECT day,
       count(DISTINCT call_sid) FILTER (WHERE n >= 11) AS calls_with_11plus_identical_successes,
       count(DISTINCT call_sid) FILTER (WHERE n BETWEEN 5 AND 9) AS calls_in_the_5_to_9_band,
       max(n) AS worst
FROM runs GROUP BY 1 ORDER BY 1;
```

## v48 — the ambiguous lookup is countable

Number: among `lookup_patient` events with `identity_is_certain = false`, the
share that are the ambiguous branch (`found = false` with a `candidate_count`)
— **unreadable today: 110 uncertain lookups on 2026-09-16 and 0 events carry
`found`**. Readable after one day on this build. Guard: none.

```sql
-- Hub.
SELECT c.created_at::date AS day,
       count(*) FILTER (WHERE e->'outcome'->>'identity_is_certain' = 'false') AS uncertain_lookups,
       count(*) FILTER (WHERE e->'outcome' ? 'found') AS events_carrying_found,
       count(*) FILTER (WHERE e->'outcome'->>'identity_is_certain' = 'false' AND e->'outcome'->>'found' = 'false' AND e->'outcome' ? 'candidate_count') AS ambiguous_branch
FROM call_logs c, LATERAL jsonb_array_elements(c.tool_timeline->'events') e
WHERE c.voice_provider = 'grok' AND e->>'tool' = 'lookup_patient' AND c.created_at >= '2026-09-16'
GROUP BY 1 ORDER BY 1;
```

## v49 — the fleet is graded at teardown

Number: hangup-to-grade lag BY HOUR OF HANGUP — this is the instrument, because
the backfill catches up overnight and a next-morning "agent_outcome NULL" count
reads 0.5% on a day whose peak hours lagged by hours. **2026-09-16 before: p50
2–4 min all day, p90 14 min at 15:00 UTC then 720 / 620 / 502 min at 16–18 and
325 / 243 / 136 min at 20–22; target p90 under a few minutes every hour.** The
second number: rows from 2026-09-15 still ungraded — **103 substantive runtime
calls with `agent_outcome` NULL at 05:00 on 09-17**; the widened backfill should
drain them. Guards: grader LLM calls per substantive call stay at ONE; calls
with no caller line still read `failed`; `ticketing_sync_error` must not rise as
dead_air conversations enter the sync.

```sql
-- Hub. Substitute the day.
SELECT to_char(end_time AT TIME ZONE 'UTC', 'HH24') AS hr_utc, count(*) AS graded,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (graded_at - end_time))/60)::numeric, 1) AS p50_min,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (graded_at - end_time))/60)::numeric, 1) AS p90_min
FROM call_logs
WHERE voice_provider = 'grok' AND duration >= 30 AND graded_at IS NOT NULL AND created_at::date = '<day>'
GROUP BY 1 ORDER BY 1;

-- Hub. The stranded rows, and the dead_air conversations recorded failed.
SELECT created_at::date AS day, count(*) AS substantive_runtime,
       count(*) FILTER (WHERE agent_outcome IS NULL AND end_time < now() - interval '1 hour') AS outcome_null_after_1h,
       count(*) FILTER (WHERE status = 'failed' AND transcript ~ '(^|\n)CALLER: ') AS failed_with_caller_lines
FROM call_logs
WHERE voice_provider = 'grok' AND duration >= 30 AND created_at >= '2026-09-15'
GROUP BY 1 ORDER BY 1;
-- 2026-09-15 before: 103 null after 1h, 19 failed with caller lines. 09-16: 3 and 0.
```

### Round 12 on this ship (08:39 UTC) — the grade reaches the ticket

The teardown grade lands seconds to minutes after the row; the five-minute
sync could snapshot the row first, send nulls, and mark the call done. The
grade's write now re-opens the sync and the sync's mark-done refuses a row
whose grade landed mid-flight. **Before, Support Center, agent-filed tickets
with a synced transcript: 291 of 383 (09-14), 280 of 368 (09-15), 296 of 387
(09-16) carry no `quality_score` and no `agent_outcome`. Target ~0.**

```sql
-- Support Center. The number: synced tickets with no grade, per day.
SELECT coalesce(call_start_time, created_at)::date AS day,
       count(*) FILTER (WHERE transcript IS NOT NULL) AS synced_with_transcript,
       count(*) FILTER (WHERE transcript IS NOT NULL AND quality_score IS NULL) AS synced_no_quality,
       count(*) FILTER (WHERE transcript IS NOT NULL AND agent_outcome IS NULL) AS synced_no_outcome
FROM tickets
WHERE call_sid ~* '^CA[0-9a-f]{32}$' AND created_by_id IS NULL AND agent_used IS NOT NULL
  AND coalesce(call_start_time, created_at)::date >= '<day>'
GROUP BY 1 ORDER BY 1;

-- Hub. The guard: at most one extra update-call-data POST per call, and no
-- rise in sync errors. Rows graded after their sync stamp are the population
-- the re-open exists for (197 · 135 · 185 a day on 09-14/15/16).
SELECT created_at::date AS day,
       count(*) FILTER (WHERE call_data_synced AND quality_score IS NOT NULL AND graded_at > ticketing_synced_at) AS graded_after_sync,
       count(*) FILTER (WHERE ticketing_sync_error IS NOT NULL) AS sync_errors
FROM call_logs WHERE created_at::date >= '<day>' AND duration >= 30 GROUP BY 1 ORDER BY 1;
```

## v51 — the record reaches the call row

Number: runtime substantive calls with `patient_found = true` — **0 of 2,471 in
the seven days to 09-17 (tech 926, pcp 605, surgery 532, optical 408), target ≈
the share whose `lookup_patient` matched one person**. Guard: a row carrying a
name for a call whose lookup was only a phone candidate must stay 0 — compare
`patient_name` against calls whose lookup events carry `identity_is_certain =
false` and no certain event.

```sql
-- Hub.
SELECT agent_used, coalesce(voice_provider,'old-core') AS pipeline, count(*) AS substantive,
       count(*) FILTER (WHERE patient_found) AS patient_found_true,
       count(*) FILTER (WHERE patient_name IS NOT NULL) AS patient_name_set,
       count(*) FILTER (WHERE patient_dob IS NOT NULL) AS patient_dob_set
FROM call_logs
WHERE duration >= 30 AND created_at >= '<day>'
GROUP BY 1,2 ORDER BY 3 DESC;
-- seven days to 09-17 before: 0 / 0 / 0 on every lane.
```

## v52 — the cost write parses

Before-arm (Hub, run 2026-09-17 05:38 UTC). Rows in the log: the Hub's postgres logs,
`event_message ilike '%operator is not unique%'` — **3,749 in the 24h to 05:40**,
`parsed.query` = the `update "call_logs" set … total_cost_cents = CASE … ELSE $4 + $5 END`
statement, `parsed.command_tag` = `PARSE`. Target 0 after deploy.

```sql
-- the columns the failing statement writes, per day. 09-01/02 are the before-before:
-- twilio_cents_set = calls. From 09-04 (8a226a6) it collapses; after v52 it must return
-- to ~calls for NEW rows (the 4h sweep does not reach older ones — see the backfill note).
SELECT created_at::date AS day, count(*) AS calls,
       count(cost_calculated_at) AS cost_calculated,
       count(twilio_cost_cents) AS twilio_cents_set,
       count(total_cost_cents) AS total_cents_set,
       count(cost_reconciled_at) AS reconciled
FROM call_logs
WHERE created_at >= '2026-09-01' AND duration IS NOT NULL AND duration > 0
GROUP BY 1 ORDER BY 1;
-- before: 09-01 544/544 twilio · 09-02 482/482 · 09-04 104/502 · 09-08 43/615 ·
--         09-14 197/822 · 09-15 51/783 · 09-16 175/808. reconciled counts must NOT move.

-- the backlog the code does not drain (the sweep looks back 4h):
SELECT count(*) FILTER (WHERE twilio_cost_cents IS NULL) AS twilio_null,
       count(*) FILTER (WHERE total_cost_cents IS NOT NULL AND twilio_cost_cents IS NULL) AS provider_only_totals
FROM call_logs WHERE status = 'completed' AND created_at >= '2026-09-04' AND duration > 0;
-- before: 4,295 · 4,293 of 5,486.
```

Guard: the cost-preservation trio in CLAUDE.md's cost section (ever_reconciled /
at_grok_rate / at_openai_rate) — `at_openai_rate` must still read 0.

The red-then-green on the live engine, executing nothing (`WHERE false`):

```sql
PREPARE p_bad AS UPDATE call_logs SET total_cost_cents =
  CASE WHEN cost_reconciled_at IS NOT NULL THEN COALESCE(openai_cost_cents, 0) + $1 ELSE $2 + $3 END
  WHERE false;   -- ERROR 42725: operator is not unique: unknown + unknown
PREPARE p_good AS UPDATE call_logs SET total_cost_cents =
  CASE WHEN cost_reconciled_at IS NOT NULL THEN COALESCE(openai_cost_cents, 0) + $1::integer ELSE $2::integer + $3::integer END
  WHERE false;   -- PREPARE
```

### Live database objects created 2026-09-17 05:45–05:50 UTC (Hub) — in no branch

Four partial indexes on `call_logs`, each matching one of `ticketingSyncService`'s
five-minute sweeps, which until now each read every page of the table (28,479
buffers; 11.7–26 s in the postgres log when the cache was cold). `CONCURRENTLY`, so
nothing was locked; no behaviour changes; reversal is `DROP INDEX <name>`. Matching
rows at creation: open-status 0 · twilio-pending 16,856 (the sweep reads only the
last 4h of them) · sync-pending 208 · insights-pending 655.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_call_logs_open_status_created
  ON public.call_logs (created_at) WHERE status IN ('in_progress','initiated','ringing');
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_call_logs_twilio_cost_pending
  ON public.call_logs (end_time) WHERE status = 'completed' AND (twilio_cost_cents IS NULL OR twilio_cost_cents = 0);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_call_logs_sync_pending
  ON public.call_logs (created_at) WHERE status = 'completed' AND call_data_synced = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_call_logs_insights_pending
  ON public.call_logs (start_time DESC) WHERE status = 'completed' AND twilio_insights_fetched_at IS NULL;
```

| sweep (EXPLAIN ANALYZE, warm cache) | before | after |
|---|---|---|
| stale-call reaper (`status IN (open) AND created_at < now()-15m`) | Seq Scan, 28,479 buffers, 79.9 ms | Index Scan `idx_call_logs_open_status_created`, **1 buffer, 0.055 ms** |
| Twilio-cost retry (`twilio_cost_cents IS NULL/0 AND end_time >= now()-4h`) | Seq Scan, 28,479 buffers, 61.7 ms | Index Scan `idx_call_logs_twilio_cost_pending`, **9 buffers, 0.106 ms** |

The cold-cache figures in the log (11.7–26 s) are the ones that matter for the
`lookup_patient` timeouts; the warm-cache before-arm above is what could be measured
at 05:45 on a database that had restarted fifteen minutes earlier. After-number for
task #68: `lookup_patient` events with `ms >= 5900` per day — 39 on 09-16.

## v53 — the record reaches the after-hours call row

Before-arm, Hub, seven days to 2026-09-17: 297 substantive no-ivr calls, `patient_found`
on 0, 139 of them called `create_ticket`.

```sql
SELECT created_at::date AS day,
       count(*) FILTER (WHERE duration >= 30) AS substantive,
       count(*) FILTER (WHERE duration >= 30 AND patient_found) AS patient_found,
       count(*) FILTER (WHERE duration >= 30 AND tool_timeline::text LIKE '%"create_ticket"%') AS called_create_ticket,
       -- the guard: a name on a row whose call never reached create_ticket is the old
       -- factory-time (phone-candidate) write coming back — must stay 0
       count(*) FILTER (WHERE patient_found AND tool_timeline::text NOT LIKE '%"create_ticket"%') AS found_without_create_ticket
FROM call_logs
WHERE agent_used = 'no-ivr' AND created_at >= '2026-09-10'
GROUP BY 1 ORDER BY 1;
-- target: patient_found ≈ the share of create_ticket calls whose name + DOB matched;
--         found_without_create_ticket = 0.
```

## v54 — the affirmed name picks the person

Before-arm, Hub, 2026-09-16: runtime `date_of_birth` refusals on calls whose transcript
carries the greeting's question — **26 (optical 8, surgery 10, tech 8), 16 with no ticket on
the row, all 26 `carry = no_entry`**.

```sql
-- the refusals, by carry — target: the recognised-caller count near 0
SELECT c.created_at::date AS day, c.agent_used, coalesce(e->'outcome'->>'carry', '(none)') AS carry,
       count(DISTINCT c.call_sid) AS calls,
       count(DISTINCT c.call_sid) FILTER (WHERE c.transcript ILIKE '%am i speaking with%') AS on_recognised_callers
FROM call_logs c, LATERAL jsonb_array_elements(c.tool_timeline->'events') e
WHERE c.voice_provider = 'grok' AND c.duration >= 30 AND c.created_at >= '2026-09-16'
  AND e->>'tool' LIKE 'file\_%\_ticket' AND (e->'outcome'->'missingFields')::text ILIKE '%date_of_birth%'
GROUP BY 1,2,3 ORDER BY 1,2,4 DESC;

-- the mechanism firing: a phone match that is CERTAIN — impossible before v54 on a
-- multi-person number. Target: appears on recognised calls.
SELECT c.created_at::date AS day, c.agent_used, count(DISTINCT c.call_sid) AS certain_phone_matches
FROM call_logs c, LATERAL jsonb_array_elements(c.tool_timeline->'events') e
WHERE c.voice_provider = 'grok' AND c.created_at >= '2026-09-16' AND e->>'tool' = 'lookup_patient'
  AND e->'outcome'->>'matched_by' = 'phone' AND e->'outcome'->>'identity_is_certain' = 'true'
GROUP BY 1,2 ORDER BY 1,2;
```

Guard: tickets carrying a date of birth that is not the patient's must stay 0 — read the
`[TOOLS] lookup_patient: the caller's first name picked one of the N people` console line
against the ticket's name.

## v55 — the follow-up does not wait for a done that already passed

Before-arm, Hub, runtime lanes, `duration >= 30`, no ticket on the row, `runtime_outcome =
dead_air`, the last tool event a `file_*` REFUSAL and the last audible agent line the pre-tool
filler: **09-10: 26 · 09-11: 25 · 09-14: 42 · 09-15: 9 · 09-16: 15.** `dead_air` outcomes on
the same lanes: 58 · — · 18 · 29 on 09-14/15/16.

```sql
-- the class, per day — target 0. The filler is the model's own pre-tool line; a refusal
-- answered in milliseconds and then nothing until the 30 s watchdog.
WITH c AS (
  SELECT call_sid, agent_used, created_at::date AS day, ticket_number, runtime_outcome, end_time, tool_timeline,
         regexp_split_to_array(transcript, E'\n') AS ls
  FROM call_logs
  WHERE created_at >= '2026-09-17' AND voice_provider = 'grok' AND duration >= 30
    AND agent_used IN ('optical','surgery','tech','records','pcp')
), x AS (
  SELECT day, agent_used, ticket_number, runtime_outcome, ls[array_length(ls,1)] AS last_line,
         (SELECT e FROM jsonb_array_elements(coalesce(tool_timeline->'events','[]'::jsonb)) e ORDER BY e->>'at' DESC LIMIT 1) AS last_ev
  FROM c
)
SELECT day,
       count(*) FILTER (WHERE last_ev->>'tool' LIKE 'file_%' AND (last_ev->'outcome'->>'success') = 'false'
                          AND last_line LIKE 'AGENT:%' AND (last_line ILIKE '%get this logged%' OR last_line ILIKE '%registrarlo%')
                          AND ticket_number IS NULL AND runtime_outcome = 'dead_air') AS refusal_then_silence,
       count(*) FILTER (WHERE runtime_outcome = 'dead_air') AS dead_air_total,
       count(*) FILTER (WHERE ticket_number IS NULL) AS no_ticket_total
FROM x GROUP BY 1 ORDER BY 1;

-- THE INSTRUMENT — one row per call that owed the model a turn after a tool. This is the
-- first runtime writer call_events has ever had. `events_after_done > 0` confirms the
-- hypothesis the fix rests on (a function-call event landing after its response's done);
-- `last_follow_up_unanswered` high with it at 0 refutes it and names the next link.
SELECT at::date AS day, agent_slug,
       count(*) AS calls_owing_a_follow_up,
       count(*) FILTER (WHERE (data->>'toolCallsAfterDone')::int > 0) AS events_after_done,
       count(*) FILTER (WHERE (data->>'lastUnanswered')::boolean) AS last_follow_up_unanswered,
       count(*) FILTER (WHERE (data->>'lastUnanswered')::boolean AND data->>'outcome' = 'dead_air') AS unanswered_and_dead_air
FROM call_events
WHERE category = 'model' AND message = 'follow_up_summary'
GROUP BY 1,2 ORDER BY 1,2;
```

Guards: filing rate per lane must not fall; `dead_air` outcomes must FALL and not migrate to
`caller_hangup` (the second query above, `dead_air_total`); and `provider_failure` per day
must not rise — a follow-up requested INTO an open response is what that would look like.

### Round 9 on this ship (07:21/07:23 UTC)

Two things changed after the section above was written, and neither changes
the queries. The follow-up for a LATE batch (function-call events after their
response's done) now waits `LATE_TOOL_BATCH_GRACE_MS` = 250 ms after the last
late event settles, so two late tool calls from one response are one
follow-up, not two — the `requested` count in `follow_up_summary` will read 1
where the first cut of v55 would have read 2 on such a call. And the
`follow_up_summary` row is retried on the teardown write's backoff and its
buffer kept for the reaper when the insert fails, so a database blip at
teardown no longer deletes the row on exactly the calls it made unmeasurable;
the instrument query above is unbiased toward healthy-database minutes only
from this build.

## v56 — an unvoiced tool answer cannot end the call

**Before (PCP, runtime, `duration >= 30`, ended by `terminate_call` with
`runtime_outcome = agent_ended`, the agent's LAST line a question or "one
moment"):** 09-14: 17 of 30 · 09-15: 32 of 57 · 09-16: 38 of 61; no ticket on
18 of the 38. The lookup-then-hangup shape with the answer never spoken
(`lookup_patient_appointments > record_automated_resolution > terminate_call`,
last line a question): 9 · 9 · 9.

```sql
-- The class, per day. Target 0 on a v56 build.
WITH calls AS (
  SELECT c.created_at::date AS day, c.ticket_number, c.runtime_outcome,
         (SELECT string_agg(e->>'tool', '>' ORDER BY e->>'at')
            FROM jsonb_array_elements(coalesce(c.tool_timeline->'events','[]'::jsonb)) e) AS tools,
         (SELECT regexp_replace(l, '^\s*AGENT:\s*', '')
            FROM unnest(regexp_split_to_array(c.transcript, E'\n')) WITH ORDINALITY AS t(l, i)
            WHERE l ~ '^\s*AGENT:' ORDER BY i DESC LIMIT 1) AS last_agent
  FROM call_logs c
  WHERE c.created_at::date >= '<day>' AND c.duration >= 30
    AND c.agent_used = 'pcp' AND c.voice_provider = 'grok'
)
SELECT day,
       count(*) FILTER (WHERE tools ~ 'terminate_call$' AND runtime_outcome = 'agent_ended') AS agent_ended,
       count(*) FILTER (WHERE tools ~ 'terminate_call$' AND runtime_outcome = 'agent_ended'
                          AND (last_agent ~ '\?\s*(\[interrupted\])?$' OR last_agent ILIKE '%one moment%')) AS hung_up_on_own_question,
       count(*) FILTER (WHERE tools ~ 'lookup_patient_appointments>record_automated_resolution>terminate_call$'
                          AND runtime_outcome = 'agent_ended'
                          AND (last_agent ~ '\?\s*(\[interrupted\])?$' OR last_agent ILIKE '%one moment%')) AS appt_answer_never_spoken,
       count(*) FILTER (WHERE runtime_outcome IN ('dead_air','max_duration')) AS dead_air_or_max  -- the guard
FROM calls GROUP BY 1 ORDER BY 1;

-- How often the bridge held a hangup (the guard firing), from the v55 row.
SELECT at::date AS day, count(*) FILTER (WHERE (data->>'hangupsHeld')::int > 0) AS calls_with_a_held_hangup,
       sum((data->>'hangupsHeld')::int) AS holds
FROM call_events WHERE category = 'model' AND message = 'follow_up_summary'
GROUP BY 1 ORDER BY 1;
```

### Round 11 on this ship (08:16 UTC)

The line count the hold reads advanced on every response completion, audio or
not, so a silent `response.done` after the tool result unlocked the hold. It
now advances only on words the caller heard. No new number: the v56 queries
above measure it, and `hangupsHeld` still counts the guard firing. If the
class above stays at 09-16 levels on a v56 build while `hangupsHeld` reads 0,
suspect another door of this shape before suspecting the guard.

### Round 12 on this ship (08:39 UTC)

The `lookup > record_automated_resolution > terminate_call` shape above can
arrive in ONE response, and the guard was decided before the sibling had
answered; an end-call now waits for its siblings. And a transcript delta
opened an utterance with zero bytes that read as words. Same queries, same
targets; `hangupsHeld` still counts the guard firing.

### Round 13 on this ship (08:58 UTC)

The round-12 wait read `pendingSiblings`, which is empty when the hangup is
the FIRST event of its batch — the sibling that follows it on the wire has
not been read yet. An end-call now also waits for the batch boundary: the
carrying response's done, or the late-batch grace window (armed at the late
event's arrival, so an end-call waiting on it can see it armed). Same
queries, same targets. One new cost, bounded: a lone late `terminate_call`
is decided 250 ms after it arrives rather than at once — on `call_logs`,
PCP `agent_ended` calls should still hang up, and `max_duration` /
`dead_air` on that lane must not rise.

## Also on this build, not a version of its own

**`unclassified_call` by provenance (task #138)** — the sweep stamps
`pcp_failure_information = 'call_not_classified'`; the model never does.

```sql
-- Support Center.
SELECT coalesce(call_start_time, created_at)::date AS day, count(*) AS dept18_agent_tickets,
       count(*) FILTER (WHERE pcp_call_purpose = 'unclassified_call' AND pcp_failure_information = 'call_not_classified') AS unclassified_by_the_sweep,
       count(*) FILTER (WHERE pcp_call_purpose = 'unclassified_call' AND pcp_failure_information IS DISTINCT FROM 'call_not_classified') AS unclassified_by_the_model
FROM tickets
WHERE department_id = 18 AND created_by_id IS NULL AND agent_used IS NOT NULL
  AND call_sid ~* '^CA[0-9a-f]{32}$' AND coalesce(call_start_time, created_at) >= '2026-09-14'
GROUP BY 1 ORDER BY 1;
-- before: 09-14 0/0 · 09-15 0/18 · 09-16 0/57 (of 104).
```

## v57 — the surgeon ask is claimed before the POST (task #75's after-number, taken 2026-09-17 09:45–10:05 UTC)

The exit merged 2026-09-02 (#254 / ticketing-app #206) and its after-number was never taken. Every query below was run today.

**The surgeon gate, Hub, surgery, `duration >= 30`, 09-08..09-16** — 96 calls took a `file_surgery_ticket` refusal naming the surgeon; 76 took two or more; 75 reached a third filing attempt; 50 filed; **46 left no ticket on the row**:

```sql
WITH per_call AS (
  SELECT c.call_sid, c.created_at::date AS day, c.ticket_number,
         bool_or(e->>'tool' = 'file_surgery_ticket' AND (e->'outcome'->'missingFields')::text ILIKE '%surgeon%') AS surgeon_refused,
         count(*) FILTER (WHERE e->>'tool' = 'file_surgery_ticket') AS filing_attempts,
         bool_or(e->>'tool' = 'file_surgery_ticket' AND e->'outcome'->>'ticket_number' IS NOT NULL) AS filed_event
  FROM call_logs c, LATERAL jsonb_array_elements(c.tool_timeline->'events') e
  WHERE c.agent_used = 'surgery' AND c.duration >= 30 AND c.created_at >= '2026-09-08' AND c.created_at < '2026-09-17'
  GROUP BY 1,2,3
)
SELECT day, count(*) FILTER (WHERE surgeon_refused) AS refused_calls,
       count(*) FILTER (WHERE surgeon_refused AND filing_attempts >= 3) AS reached_attempt_3,
       count(*) FILTER (WHERE surgeon_refused AND ticket_number IS NULL AND NOT filed_event) AS refused_no_ticket
FROM per_call GROUP BY 1 ORDER BY 1;
-- 09-08: 14 / 9 / 9 · 09-09: 14 / 13 / 7 · 09-10: 15 / 13 / 6 · 09-11: 8 / 7 / 1 · 09-14: 11 / 7 / 6 · 09-15: 19 / 16 / 9 · 09-16: 15 / 10 / 8
```

**The 46, checked in the Support Center by SID:** 0 have a ticket of any provenance; 88 create-ticket POSTs between them, **88 of 88 HTTP 400 "Missing required information: surgeon"**; 33 with two or more, 9 with three or more; **0 ever carried `routingAskExhausted`**. `routingAskExhausted` is NOT in `toolTimeline`'s `SAFE_ARG_KEYS` (it is a payload field, not a model argument), so the Hub cannot see the flag — the Support Center's `voice_agent_api_logs` can:

```sql
SELECT created_at::date AS day, count(*) AS posts,
       count(*) FILTER (WHERE request_body->>'routingAskExhausted' = 'true') AS flagged,
       count(*) FILTER (WHERE request_body->>'routingAskExhausted' = 'true' AND http_status_code = 200) AS flagged_accepted,
       count(DISTINCT request_body->'callData'->>'callSid') FILTER (WHERE request_body->>'routingAskExhausted' = 'true') AS flagged_calls
FROM voice_agent_api_logs
WHERE endpoint ILIKE '%create-ticket%' AND request_body->'callData'->>'agentUsed' = 'surgery'
  AND created_at >= '2026-09-08' AND created_at < '2026-09-17'
GROUP BY 1 ORDER BY 1;
-- 82 flagged POSTs on 57 calls, 82 of 82 accepted. 5 of the 57 calls have no ticket by SID: 4 answered
-- `consolidated: true` ("Contact appended to existing open ticket"), 1 a re-stamped SID — the approved consolidation, not a loss.
-- WHERE THE TICKETS ARE NOW (join tickets ON ticket_number): dept 2 Surgery Coordination 18 (15 with provider, 3 unassigned)
-- · dept 3 Technicians Support 19 · dept 9 HVA Hub 13 · dept 15/16/4: 5. THE FIRST READING OF THAT WAS WRONG — see the correction below.
```

**Corrected 10:45 UTC — the exit moves nothing; people do.** The v57 row first said the app's exit *re-routes* a surgeon-less request out of department 2. It does not: `applyRoutingGate` answers `takesUnassignedExit` with `ok: true` and never touches the department, and every flagged surgery POST went to department 2. The tickets were moved afterwards, by hand:

```sql
-- (1) which department each flagged POST was actually sent to, and what came before it on the call
--     dept 2: 74 POSTs / 54 calls, 200 on all, 0 with no dept-2 surgeon refusal before them (62 after two or more)
--     dept 1: 20 POSTs / 17 calls — optical's own exit, not surgery's
SELECT (request_body->>'departmentId')::int AS dept, http_status_code, count(*), count(DISTINCT request_body->'callData'->>'callSid')
FROM voice_agent_api_logs
WHERE endpoint = '/api/voice-agent/create-ticket' AND request_body->>'routingAskExhausted' = 'true'
  AND created_at >= '2026-09-08' AND created_at < '2026-09-17'
GROUP BY 1,2;

-- (2) the exit's dept-2 tickets: where they are now, and whether a person moved them
--     dept 3 Technicians Support 19 (19 with a department_transferred event, actor on all 19)
--     dept 2 Surgery Coordination 18 (0 moves; 15 with provider, 3 unassigned)
--     dept 9 HVA Hub 13 (13 moved, 14 moves) · dept 15 OCS Hub 2 (moved) · dept 16 Medical Records 2 (moved) · dept 4 Billing 1 (moved, 6 times)
--     => 55 created in department 2, 37 moved by a logged-in user, 0 moved by the app
WITH exit_tickets AS (
  SELECT DISTINCT response_body->>'ticketNumber' AS ticket_number FROM voice_agent_api_logs
  WHERE endpoint = '/api/voice-agent/create-ticket' AND request_body->>'routingAskExhausted' = 'true'
    AND (request_body->>'departmentId')::int = 2 AND http_status_code = 200
    AND created_at >= '2026-09-08' AND created_at < '2026-09-17'),
t AS (SELECT tk.id, tk.department_id, tk.provider_id, tk.assigned_to_id FROM tickets tk JOIN exit_tickets e USING (ticket_number)),
moves AS (SELECT ticket_id, count(*) AS n, count(*) FILTER (WHERE actor_id IS NOT NULL) AS by_a_person
          FROM ticket_events WHERE ticket_id IN (SELECT id FROM t) AND event_type = 'department_transferred' GROUP BY ticket_id)
SELECT t.department_id, count(*) AS tickets, count(*) FILTER (WHERE t.provider_id IS NOT NULL) AS with_provider,
       count(*) FILTER (WHERE t.assigned_to_id IS NULL) AS unassigned, count(m.ticket_id) AS moved, coalesce(sum(m.by_a_person),0) AS moves_by_a_person
FROM t LEFT JOIN moves m ON m.ticket_id = t.id GROUP BY 1 ORDER BY 2 DESC;
```

One residue not read: 12 of the 74 flagged dept-2 POSTs had only ONE dept-2 surgeon 400 before them in the API log (the threshold is two confirmed refusals per call). Whether that is a refusal logged under a different SID or endpoint, or the flag arriving one refusal early, is the next thing to read on #75 — it is a fact about the BEFORE build, since v57 is not deployed.

**The control that named the link** — POST timestamps on the 9 lost calls with three or more POSTs against six calls where the flag fired:

```sql
-- per call: row_number() and the gap to the previous create-ticket POST, from voice_agent_api_logs.created_at
-- LOST (no flag ever):   gaps between POSTs 2 and 3 = 0.0 · 0.5 · 0.8 · 0.0 · 0.1 · 0.0 · 0.1 · 0.0 · 0.0 s  (all 400)
-- CONTROL (flag on 3rd): gaps = 8.2 · 6.6 · 27.1 · 17.2 · 42.5 · 17.5 s                                    (3rd = 200)
```

The counter was noted only after each response (`noteGateRefusal` at the refusal) and read at the top of the tool; three invocations dispatched in one model response all read 0. Optical, same window: 17 flags sent, 0 calls with two or more office refusals, no flag and a sub-second gap — optical does not have it.

**Department-2 provider fill (the guard), Support Center, agent-filed, canonical SIDs, by the call's day:** 100% on every day 08-25..09-14; 09-15 48/49 (98.0%); 09-16 60/64 (93.8%). The 5 unassigned: 3 the exit's own (flagged), 2 unflagged — one POST carried `providerId` the app did not keep, one had a second POST carrying the surgeon answered from the idempotency cache (the #137 shape: a cached hit does not enrich).

```sql
SELECT coalesce(call_start_time, created_at)::date AS day, count(*) AS dept2_agent_tickets,
       count(*) FILTER (WHERE provider_id IS NOT NULL) AS with_provider
FROM tickets WHERE department_id = 2 AND created_by_id IS NULL AND agent_used IS NOT NULL
  AND call_sid ~* '^CA[0-9a-f]{32}$' AND coalesce(call_start_time, created_at) >= '2026-08-25'
GROUP BY 1 ORDER BY 1;
```

**After-number for v57:** re-run the first two queries. Surgery calls that took the surgeon refusal, reached a third POST and left no ticket — 29 over the seven days, 9 of them batched (POST gap under 1 s) — the batched share should read 0; flagged POSTs per day should rise by about that. Guards: provider fill on department 2 (must not fall), and sequential attempt-2 rescues (the flag must never appear on a call's second POST).

### Round 15 on this ship (09:44 UTC) — the sync's failure writes

```sql
SELECT ticketing_sync_retries, call_data_synced, count(*) FROM call_logs
WHERE created_at >= now() - interval '14 days' AND status = 'completed' GROUP BY 1,2 ORDER BY 1,2;
-- 0/false 78 · 0/true 569 · 1/true 5,327 · 2/true 4 · nothing at 3. The race needs a row on retry 2 whose pass fails
-- after a grade or recording reset it: latent on this window. Taken as one expression in the write that branch already makes.
```

## #104 — ten full runs, and what shuffling found instead (10:00 UTC)

Five full `npx vitest run`s in default order: **4,709 passed × 5, 0 failures** — the `costRateConsolidation` guard did not reproduce. Five more with `--sequence.shuffle`: runs 6, 7, 9, 10 failed **1–6 tests each, none of them the guard**. The tests that fail under a shuffled WITHIN-FILE order (they pass in declaration order, which is what CI runs): `locationQueueTicket.test.ts` ("probes before posting the ticket", 4 of 5 runs), `realtimeAdapter.test.ts` ("does not blank a model argument the context has no value for", 3), `lookupJoinsOnPersonId.test.ts` / `lookupJoinBudget.test.ts` ("keeps the identity when the join HANGS", a 5 s timeout — a fake-timer leak between tests; "CAPS the refinement at the remaining budget"), `handoffResumesAfterTicket.test.ts` ("an AUTOMATE resolution is not a durable ticket"; "dials once the ticket has landed"). Module-level state shared between tests in one file — the `pcpDirector`-keyed-on-call-id shape `replay20260914.test.ts` already records. Not fixed tonight: test hygiene, not lane behaviour; recorded on the task with the names.

### Round 16 on this ship (10:11 UTC) — two P2s, both on the round-15 / v57 changes

(1) The sync's failure writes still decided the *GAVE UP* text and `retriesExhausted` from the snapshot, so the row the atomic increment left at 1 would have carried a terminal error string and been reported exhausted. Now a `CASE` in the same statement plus `RETURNING`. Proven on the Hub:

```sql
PREPARE r16_probe AS
UPDATE call_logs
SET ticketing_sync_error = CASE WHEN COALESCE(ticketing_sync_retries, 0) + 1 >= $1::integer THEN $2 ELSE $3 END,
    ticketing_sync_retries = COALESCE(ticketing_sync_retries, 0) + 1
WHERE id = $4 AND false
RETURNING ticketing_sync_retries;
EXECUTE r16_probe(3, 'GAVE UP after 3 attempts: x', 'x', 1);   -- parses, executes, 0 rows
DEALLOCATE r16_probe;
```

(2) v57's first version counted attempts in flight AS refusals, so a concurrent batch whose first two answered 503 (or refused another field) would have flagged its third — a request filed unassigned on an ask the caller never heard. Exposure in the window: 0 — all 88 POSTs on the 46 lost calls were surgeon 400s and 751 of 751 department-2 refusals since 08-25 name the surgeon — but the door was new and mine, so it is closed regardless of the base rate: a claim now WAITS for the attempts ahead of it to settle and reads confirmed refusals only (`claimGateAttemptAfterSettlement`, bounded at 20 s). Serialises a batch through the POST; costs the third attempt the ~100 ms its siblings take.

### Round 17 on this ship (10:26 UTC) — one P2 on the round-16 wait, taken on `34d3ecc`

The claim held ONE 20 s deadline for the whole queue, and a POST alone may take the client's 15 s (`ticketingApiClient.makeRequest`). A batch of three whose first two predecessors were both slow: the third released at 20 s with the second still pending, read one confirmed refusal where there were two, sent no flag — the lost-third-attempt case back in through the bound. Now one bounded wait PER PREDECESSOR: `waitForSettlement` parks until the next settle on the key or 20 s of none, and the claim loop re-arms on every settle that wakes it. The floor is unchanged (a settle that never comes releases at 20 s); a released waiter removes itself from the list, so a late settle wakes nobody who has gone.

`gateAttempts.test.ts` +3, with fake timers: (a) three claims, the first settles at 15 s, the second at 30 s → the third reads 2 (RED on the single deadline: it read 1 at 20 s); (b) the bound runs from the LAST settle — released at 35 s, not 20 s; (c) a waiter the bound released has left the list, and the late settles count normally. **3 mutations, 3 caught** (against the scratch copy in `mut30/fixed/`): the single deadline restored (2 fail); the bound never releasing — the timeout resolving true (3, by timeout); the wait ending after one predecessor (3). `surgeryUnassignedExit.test.ts` 13/13, typecheck clean, full suite 257 files / 4,726 tests. Base rate in the window: 0 — the 88 refusals on the 46 lost calls answered in well under a second, so no batch reached the bound; taken because the wait is this PR's.

### Round 18 on this ship (10:38 UTC) — one P2 on the round-17 wait, taken on `8a11864`

Every waiter started its own bound on ARRIVAL, so a single predecessor that legitimately outlasted it released every waiter at once, and attempts two and three both claimed before attempt one had answered — the third could again send no flag. Codex's figure for a legitimate attempt is exact and was verified in `server/services/ticketingApiClient.ts`: `warmUpIfStale(2, 500)` is a 3 s probe, a 500 ms sleep and a second 3 s probe (the file's own comment: worst case 6.5 s before the POST), then the 15 s POST — about 21.5 s, past the 20 s bound. Two changes: claims on a key are QUEUED (`claimQueues`, a per-key promise chain) and released one at a time — a claim's wait starts only when the claim ahead of it has claimed or given up — and `GATE_SETTLEMENT_WAIT_MS` is 25 s, above the longest legitimate attempt, so a bound crossing is a lost settle and nothing else.

`gateAttempts.test.ts` +3: the floor pinned above 21.5 s; a stuck predecessor releases ONLY the next claim, the one behind it starts its wait then and reads both refusals once both settle (RED on the round-17 code: both released at the bound, the third read 0); a predecessor that never answers releases each waiter one full bound after the one ahead of it. **3 mutations, 3 caught** (`mut31/fixed/`): the queue removed (2 fail); the queue never draining — `claimed()` dropped from the `finally` (6, by timeout); the floor back to 20 s (1). `surgeryUnassignedExit.test.ts` 13/13, typecheck clean, full suite 257 files / 4,729 tests.

### Round 19 on this ship (10:47 UTC) — one P2 on the round-18 queue, taken on `1b6eb33`

With the first of three concurrent attempts STUCK, the queue released the second after one bound (25 s) and then made the third wait a SECOND full bound on the same stuck attempt — 50 s — while `mediaStreamBridge.ts` arms a 45 s tool-dispatch watchdog (`DEFAULT_DEAD_AIR_MS` 30 s + `TOOL_DISPATCH_GRACE_MS` 15 s) and tears the call down first. `abandonInFlight`: when a claim's bound passes with no settle, the attempt it was waiting on is let go of (its pending slot released), so the claims queued behind wait only for what actually answers. A claim's total wait is now one bound for a stuck predecessor plus the real duration of the attempts that answer. A late answer for an abandoned attempt is clamped at zero and can only wake a later claim EARLY with a SMALLER count — a missed flag, never a false one — and on the production path that answer is a client timeout anyway (`makeRequest` aborts the POST at 15 s), which settles unrefused.

**The round-18 test that had the first attempt REFUSE at 26 s encoded a scenario the client cannot produce** (a refusal arrives inside 21.5 s or not at all) and is rewritten to the possible shape: the late answer is a timeout, it wakes the next claim early with count 0, and never authorises a flag. New: the stuck-first case — the second released at the bound and answering at once, the third claiming THEN rather than a bound later (hangs on the round-18 code).

Base rate, Support Center, 30 days of surgery create-ticket POSTs (`processing_time_ms`):

```sql
SELECT count(*), percentile_disc(0.5) WITHIN GROUP (ORDER BY processing_time_ms) AS p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY processing_time_ms) AS p95, max(processing_time_ms),
       count(*) FILTER (WHERE processing_time_ms > 10000) AS over_10s, count(*) FILTER (WHERE processing_time_ms > 20000) AS over_20s
FROM voice_agent_api_logs
WHERE endpoint = '/api/voice-agent/create-ticket' AND request_body->'callData'->>'agentUsed' = 'surgery'
  AND created_at >= now() - interval '30 days';
-- 2,532 POSTs · p50 2,261 ms · p95 5,188 ms · max 14,099 ms · 11 over 10 s · 0 over 20 s
```

No attempt has come within 10 s of the 25 s bound; the serialised third of a batch waits about 10 s at p95 in practice. **2 mutations** (`mut32/fixed/`): the abandon removed — 2 fail, by timeout; the abandon moved to the START of every wait — an EQUIVALENT mutant (the loop then iterates exactly once and the behaviour is identical), recorded rather than claimed. `surgeryUnassignedExit.test.ts` 13/13, typecheck clean, full suite 257 files / 4,730 tests.

### Round 20 on this ship (10:58 UTC) — two P2s on the round-19 abandon, both taken at the root on `3f66bc9`

(1) A stuck first attempt abandoned at 25 s plus a full-length legitimate second (21.5 s) still reached 46.5 s against the bridge's 45 s tool watchdog. `GATE_SETTLEMENT_WAIT_MS` is now 23 s — above 21.5 s and below 45 − 21.5 — and a test pins both inequalities against `DEFAULT_DEAD_AIR_MS + TOOL_DISPATCH_GRACE_MS`.

(2) The shared pending count cannot tell which attempt a late settle belongs to — and Codex found why a late REFUSAL was possible at all: `server/services/ticketingApiClient.ts` `makeRequest` ran `clearTimeout(timeoutId)` the moment `fetch` resolved (the headers) and then `await response.json()` with no bound. Verified in the source. So the round-19 sentence *"a late answer is a client timeout, which settles unrefused"* was an assumption. Fixed at the root: the timer stays armed until the body is read, and an `AbortError` during the body read passes through the parse catch as a timeout (no `statusCode`, so `createTicketDurable` captures and retries it) instead of being reported as *Invalid JSON response: 400* with the status attached — which would have been read as a TERMINAL refusal and dropped from the outbox. With that, no attempt settles more than 15 s after its POST, every settle lands inside the 23 s floor, and an abandoned attempt never answers late: the misattribution has nothing to misattribute, and no ownership token is added.

`server/services/ticketingApiClientBodyReadIsBounded.test.ts` drives the REAL client with `fetch` stubbed (the pattern of `createTicketWritesTheNumberBack.test.ts`): a POST whose headers arrive at once as a 400 and whose body never does is answered as a timeout at the request bound; the old code hangs it forever (the test times out). **3 mutations, 3 caught** (`mut33/fixed/`): the timer cleared at the headers again (1, by timeout); the abort reported as a bad body with the status (1 — the assertion on the word *timeout*); the floor back to 25 s (1). Typecheck clean, full suite 258 files / 4,732 tests.
