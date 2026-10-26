# The PersonID join moves to the Console — before-arm (2026-10-01)

Measured 2026-10-01 15:30 UTC, runtime queue lanes (optical, surgery, tech,
records), `duration >= 30`, calls created 2026-09-21 .. 2026-09-30 (ten days).
`docs/BACKEND_HANDOFF.md` applies: re-run these after v84 deploys and compare.

| measure | before |
|---|---|
| substantive runtime queue calls | 2,838 |
| … that ran `lookup_patient` | 2,425 |
| … whose lookup found nobody | **348 (14.4%)** |
| `lookup_patient` events | 3,412 |
| `lookup_patient` p50 / p95 | 250 ms / 2,038 ms |
| `lookup_patient` events at the 6 s budget | 86 |
| Optical Support agent tickets (canonical SID, agent provenance) | 391 |
| … with no `location_id` | **15** |
| Surgery Coordination agent tickets | 428 |
| … with no `provider_id` | **8** |

## The queries

Found-nobody, from `call_logs.tool_timeline` (Hub):

```sql
WITH calls AS (
  SELECT call_sid, tool_timeline FROM call_logs
  WHERE created_at >= '2026-09-21' AND created_at < '2026-10-01'
    AND voice_provider = 'grok' AND duration >= 30
    AND agent_used IN ('optical','surgery','tech','records')
), lk AS (
  SELECT c.call_sid,
         bool_or((e->>'tool') = 'lookup_patient') AS ran_lookup,
         bool_or((e->>'tool') = 'lookup_patient'
                 AND coalesce((e->'outcome'->>'found')::boolean,
                              (e->'outcome'->>'matched_by') IS NOT NULL)) AS found_somebody
  FROM calls c, LATERAL jsonb_array_elements(coalesce(c.tool_timeline->'events','[]'::jsonb)) e
  GROUP BY 1
)
SELECT count(*) FILTER (WHERE ran_lookup) AS ran_lookup,
       count(*) FILTER (WHERE ran_lookup AND NOT found_somebody) AS found_nobody
FROM lk;
```

Routing fields, from `tickets` (Support Center), per-call provenance rule:

```sql
SELECT d.name, count(*) AS agent_tickets,
       count(*) FILTER (WHERE t.location_id IS NULL) AS no_location,
       count(*) FILTER (WHERE t.provider_id IS NULL) AS no_provider
FROM tickets t JOIN departments d ON d.id = t.department_id
WHERE t.call_sid ~* '^CA[0-9a-f]{32}$'
  AND t.created_by_id IS NULL AND t.agent_used IS NOT NULL
  AND coalesce(t.call_start_time, t.created_at) >= '2026-09-21'
  AND coalesce(t.call_start_time, t.created_at) < '2026-10-01'
  AND d.name IN ('Optical Support','Surgery Coordination')
GROUP BY 1;
```

## After-arm, when it lands

Same windows, same queries, plus the console log: `[ScheduleLookup] PersonID
join (console)` must appear on recognised calls, and `[ScheduleLookup]
PersonID join: the CONSOLE did not answer` must read 0.

## v85 before-arm: who answered `lookup_patient`, same ten days

`lookup_patient` events on the same 2,838 calls, by the outcome's `matched_by`
and `identity_is_certain`. The timeline cannot say which table a `phone`
match came from; after v85 the console line `the PERSON BASE identified this
caller` is the count.

| matched_by | certain | events | calls |
|---|---|---|---|
| phone | true | 1,921 | 1,778 |
| (none) — found nobody | (null) | 838 | 411 |
| phone | false | 318 | 207 |
| name_and_dob | true | 182 | 178 |
| name | false | 79 | 60 |
| (none) — person base ambiguous | false | 65 | 27 |
| name_and_dob | false | 9 | 7 |

## After-arm, first reading: v85 (16 minutes) and v86 (2h20m)

**v85 shipped every phone match as unconfirmed.** It was live 17:21:57 to
17:37:45 UTC. Its first 14 runtime calls carried 10 phone matches, and all
10 read `identity_is_certain: false`. The agent said "date of birth" on 4 of
the 9 substantive calls. `CA4f3e821538bbe16aaa83bc19b92cb51b` (surgery) is the
worked example: phone/false, phone/false, then name_and_dob/true after the
caller was asked for both. v86 corrected it.

**v86, 17:37:45 to 20:00:55 UTC.** 167 runtime calls, 143 substantive, 86 on
the queue lanes. PCP runs no lookup.

| | v86 | before-arm |
|---|---|---|
| phone matches carried as certain | 60 of 60 events | v85: 0 of 10 |
| lookup calls with a certain phone match | 59 of 73 (81%) | 1,778 of 2,425 (73%) |
| lookup calls that found nobody | 7 of 73 (10%) | 14.4% |
| ambiguous numbers resolved later in the call | 6 of 6 | — |
| `lookup_patient` p50 / p95 / at 6 s | 502 ms / 942 ms / 0 of 98 | 250 ms / 2,038 ms / 86 |
| `patient_found` on queue-lane rows | 65 of 86 (76%) | 282 of 404 (70%), 09-28 |
| date-of-birth refusals on greeted callers | 1 of 56 | 26 a day, 09-16 |
| Optical Support tickets with no office | 0 of 10 | 15 of 391 |
| Surgery Coordination tickets with no provider | 0 of 15 | 8 of 428 |
| provider failures | 0 of 167 | — |

Deployment log over the same window: 69 `PersonID join (console)`, 0
`(hub)`, 69 `the PERSON BASE identified this caller`, 0 `the CONSOLE did not
answer`, 0 setup failures. One call was lost to the republish itself
(`CA82fd58ab734d87e153a606f980b341b6`, on the v85 process when it was
replaced); the caller rang back and was filed.

The median lookup doubled because it now crosses the network to the Console.
The tail halved and nothing reached the budget. The full-day reading is taken
at 2026-10-02 00:30 UTC.
