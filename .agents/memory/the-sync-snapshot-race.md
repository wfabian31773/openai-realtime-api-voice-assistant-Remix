# The sync-snapshot race — a column that lands after the row is completed

**Written 2026-09-17 after Codex rounds 10, 11 and 12 on PR #321 found the
same defect in three columns, one round at a time.** Read this before adding
anything to `call_logs` that the ticket needs.

## The shape

`ticketingSyncService` runs every five minutes, selects completed rows with
`call_data_synced = false`, builds ONE payload off the row — transcript,
duration, outcome, `recordingUrl`, `qualityScore`, `sentiment`,
`agentOutcome` — POSTs it to `update-call-data`, and on success marks the row
`call_data_synced = true`. Nothing selects the row again.

So any column that lands on the row AFTER the row was completed can lose the
race twice over:

1. **The sweep already finished the row.** The column's writer is the ONLY
   path left, and if it has no push of its own — or its push fails — the
   value sits on the row and never reaches the ticket.
2. **The sweep is in flight.** It snapshotted the row before the column
   landed, sends a payload without it, and marks the row done afterwards —
   so even a writer that re-opens the sync loses, because the sweep's
   `true` lands after the writer's `false`.

Three columns had this, measured before they were fixed:

| column | writer | when it lands | what it cost |
|---|---|---|---|
| `recording_url` | Twilio's recording-status callback | at hangup (runtime), after the conference ends (old core) | round 3 and 10: the URL from neither side |
| `quality_score`, `sentiment`, `agent_outcome` | the grader — teardown (both pipelines since v49), backfill, admin regrade | seconds to hours after the row | **291 of 383 · 280 of 368 · 296 of 387 agent-filed tickets on 09-14/15/16 with a transcript and no grade**, while every call row had one |

## The rule — BOTH halves, always

A late-landing column needs two things, and one without the other is the
round-10 fix that round 11 reopened:

1. **The writer re-opens the sync.** When the column is written, the same
   write sets `callDataSynced: false, ticketingSyncRetries: 0`. A no-op on a
   row the sweep has not reached; a re-open on one it has. The retry reset is
   not optional — the success write stores the ATTEMPT NUMBER and the
   selector reads `< 3`, so a row that synced on its third attempt would be
   re-opened and never selected. (The recording push does this only on a
   failed push, because its own push delivers the URL when it works; the
   grade's write does it unconditionally, because the grader has no push of
   its own.)
2. **The sweep's mark-done is conditional on what it carried.** `syncCall`'s
   success UPDATE matches only while the row still holds the values the
   payload was built from — `recording_url`, `quality_score`, `agent_outcome`,
   `sentiment`, each `IS NOT DISTINCT FROM` its typed parameter — and
   `.returning()` says whether it matched. Zero rows means something landed
   mid-flight: the row stays pending, retries untouched, and the next pass
   carries it. One console line names it:
   `[TICKETING SYNC] ○ a recording or a grade landed on call … left pending`.

Under every ordering the value reaches the ticket: selected before it landed
→ not marked → next pass; selected after → the payload has it; sync finished
before it landed → the writer's re-open.

## Adding a fifth column

- Put it in the payload in `syncCall`.
- Add `sql\`${callLogs.<col>} IS NOT DISTINCT FROM ${call.<col> ?? null}::<type>\``
  to the `and()` in the success UPDATE. **Type the parameter** — a bare
  parameter beside NULL has no type for Postgres to infer (the v52 lesson:
  `operator is not unique: unknown + unknown`, refused at PARSE 3,749 times a
  day for thirteen days). An **enum column has no equality operator against
  a text parameter**: cast BOTH sides, `${callLogs.<col>}::text … ::text`.
- `PREPARE` the statement against the live Hub before it ships — a source
  pin cannot see a type. `PREPARE x AS UPDATE … AND false RETURNING id;
  DEALLOCATE x;` parses and executes nothing.
- Make the writer set `callDataSynced: false, ticketingSyncRetries: 0` in the
  same write.
- Extend the pin in `ticketingSyncService.test.ts` (the count of
  `IS NOT DISTINCT FROM` inside the one `and()` is asserted) and add a test
  on the writer.

## What this does NOT cover

- The old core's three primary post-call pushes in `voiceAgentRoutes.ts`
  mark `callDataSynced: true` themselves at teardown. They are covered by
  half 1 (the writer's re-open) and not by half 2 — if one of them ever
  pushes a snapshot taken before a late column landed, the sweep's
  conditional mark cannot see it because the sweep never ran. Nothing
  measured has shown that yet.
- Rows already synced without the value stay that way: the fix is
  forward-looking. The one-time re-open for the 814 rows graded after their
  sync stamp since 09-14 is in the 2026-09-17 worksheet's 5AM block, the
  operator's call on timing.
