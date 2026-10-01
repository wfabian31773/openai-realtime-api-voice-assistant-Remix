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
