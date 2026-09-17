# AFTER-MEASUREMENTS — what the 2026-09-17 republish turns on (v37–v49)

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
`voice-runtime-v49-the-fleet-is-graded-at-teardown-20260917`. A number taken
on an older marker is a before-number.

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

## v45 — the Grok day table

Number: rows in `daily_grok_costs` — **0 today**; one per runtime day from the
first nightly run after the deploy. A re-run of 2026-09-12 must read
`reconciled = false` with the implausible-rate reason.

```sql
-- Hub. The table is created lazily by the reconciler; this says whether it exists yet.
SELECT to_regclass('public.daily_grok_costs');
SELECT * FROM daily_grok_costs ORDER BY day DESC LIMIT 14;
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
