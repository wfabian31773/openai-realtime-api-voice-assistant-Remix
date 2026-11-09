# Filing quality — what was filed against what the transcript called for (v191)

**Operator, 2026-11-09:** "we have always focused on execution of task but
never on quality of task. So even though we are now filing at 95% and above,
we are never tracking the quality of what we file. I want that to be part of
the daybook, I want to measure every filing with what should have filed based
on the actual transcription, nothing else, the actual transcript has to tell
us what should have been filed and what fields should have been populated."

## How it works

1. **The expectation.** Every five minutes a worker in the voice app
   (`src/services/filingQualityWorker.ts`) takes up to 25 substantive calls
   from the last 72 hours (30 seconds or more, a caller line in the
   transcript, not the operator's test line) that have no expectation yet. For
   each it asks the grader's model (`src/services/filingExpectation.ts`) to
   read the transcript and write down the ticket the call called for. A field
   is filled only when the CALLER said it, or confirmed it when the agent read
   it back. The answer goes into the Hub's `filing_expectations` table.
2. **The comparison.** `src/services/filingQuality.ts` compares each
   expectation with the call's agent-filed tickets in the Support Center.
3. **The Daybook.** Run the two exports below for the day, save them to the
   session scratchpad, and run
   `npx tsx scripts/filing-quality.ts expectations.json tickets.json --from <from> --to <to>`.
   It prints counts, rates with denominators, a per-lane table and defect
   lists of call SIDs only. Delete the two files afterwards: they hold PHI.

## What each call is judged on

| | verdicts |
|---|---|
| Filed when due | `filed`, `missed_filing`, `no_ticket_by_ruling` (PCP caller who hung up untold, v100, or chose the live queue, v87), `filed_not_needed`, `correctly_not_filed`, `unreadable` (no usable model answer; judged on nothing) |
| Department | where the AGENT filed it (the ticket's creation event, else the first transfer's `fromDepartmentId`) against the rulings: `match`, `mismatch`, `no_rule`. Only rulings written in CLAUDE.md are encoded — records → Medical Records from every line; PCP: scheduling → HVA Hub, everything else PCP Support; glasses, contacts and optical orders → Optical on every line; scheduling → HVA Hub from the queues (after hours has no rule: a same-day request goes to After Hours and the topic cannot say which); surgery coordination → Surgery; after hours, an urgent symptom → After Hours. |
| Moved by staff | the department it is in now is not the one the agent filed it in |
| Each field the caller gave | `match`, `variant` (a spelling of it — the transcript is speech recognition and the ticket may carry the chart's spelling), `differs` (another value: wrong), `missing`. Fields: patient first and last name, date of birth, callback number, email, office named (a routed `location_id`), provider named (a routed `provider_id`), requester (PCP's caller columns, or a records ticket's requester name) |
| Beyond the transcript | the ticket carries a field the caller never said — often the matched record (RULE ZERO). Counted, never an error |
| Records requester | a records request from a provider, plan, pharmacy, attorney or business filed as the patient's own (`requestor_type = patient` or `roa_patient`) is `wrong` — ticket #73052's defect; filed with no requester is `missing` |
| Urgency missed | the caller described an urgent symptom and no ticket on the call is high or urgent |
| Clean | filed, not routed against a rule, no field the caller gave missing or wrong, requester right, urgency kept |

## Export 1 — Operations Hub (`pslzngjciiifowemrzza`)

```sql
SELECT f.call_sid, f.agent_used, f.call_started_at, c.runtime_outcome,
       f.expectation, f.skipped_reason
FROM filing_expectations f
LEFT JOIN call_logs c ON c.call_sid = f.call_sid
WHERE f.call_started_at >= '<from>'::timestamptz
  AND f.call_started_at <  '<to>'::timestamptz;
```

## Export 2 — Support Center (`vsmcxhxeirkoobmjcrbn`)

```sql
SELECT t.call_sid, t.ticket_number,
       coalesce(
         (SELECT (e.payload->>'departmentId')::int FROM ticket_events e
           WHERE e.ticket_id = t.id AND e.event_type = 'ticket.created'
             AND e.payload->>'mergedFromTicketId' IS NULL
           ORDER BY e.id LIMIT 1),
         (SELECT (e.payload->>'fromDepartmentId')::int FROM ticket_events e
           WHERE e.ticket_id = t.id AND e.event_type = 'department_transferred'
             AND e.payload->>'mergedFromTicketId' IS NULL
           ORDER BY e.occurred_at, e.id LIMIT 1),
         t.department_id) AS filed_department_id,
       t.department_id, t.priority::text AS priority, t.location_id, t.provider_id,
       t.patient_first_name, t.patient_last_name,
       t.patient_birth_month, t.patient_birth_day, t.patient_birth_year,
       t.patient_phone, t.patient_email,
       t.records_requestor_type, t.records_request_pathway, t.records_requestor_name,
       t.pcp_caller_name, t.pcp_caller_organization, t.pcp_caller_callback_number, t.pcp_caller_email,
       (t.merged_into_id IS NOT NULL) AS merged, t.created_at
FROM tickets t
WHERE t.call_sid ~* '^CA[0-9a-f]{32}$'
  AND t.created_by_id IS NULL AND t.agent_used IS NOT NULL
  AND coalesce(t.call_start_time, t.created_at) >= '<from>'::timestamp - interval '1 day'
  AND coalesce(t.call_start_time, t.created_at) <  '<to>'::timestamp + interval '1 day';
```

Archived and merged tickets are included: they were filings. Only
`/submit-ticket` (the after-hours path) writes a `ticket.created` event with a
department, which is why the first transfer's `fromDepartmentId` is the second
source. Measured 2026-11-05..06: 168 of 945 agent tickets were moved to another
department after filing, every move by a named staff member.

## What it does not do

- It changes nothing a caller hears, nothing a ticket carries, no gate.
- It does not judge a department where no ruling is recorded.
- It does not compare office or provider NAMES, only whether the ticket was
  routed to one when the caller named one.
- The model can be wrong. A defect list is a list of calls to read, not a
  verdict; the comparison's rules are pinned in `filingQuality.test.ts`.
- Cost: one gpt-4o-mini call per substantive call, about 570–630 a weekday.
