# The after-hours on-call rotation

Built 2026-11-23 for a December 1, 2026 start. Code in `src/runtime/onCall/`,
the tables in `migrations/add_on_call_rotation.sql`, the operator scripts in
`scripts/on-call-seed.ts` and `scripts/on-call-change.ts`.

**It ships dark.** With `ON_CALL_ROTATION_MODE` unset, an urgent after-hours
call rings the fixed on-call number (`HUMAN_AGENT_NUMBER`) exactly as it does
today, and nothing in this document runs.

---

## 1. What it does

It changes only what happens **after** the after-hours agent has classified a
call as urgent and the escalation gate has sanctioned the transfer. The urgent
triggers, the triage flow and the gate are unchanged. It covers the after-hours
line (`no-ivr`) only: `no-ivr-v2` and `dev-no-ivr` keep the fixed number,
because their agents do not yet know the chain's "already paging" answer to a
second transfer request and would read it as a failed transfer.

1. **Who is on call.** The rotation week runs **Tuesday 5:00 PM Pacific to the
   next Tuesday 8:00 AM Pacific**. Weekday daytime (Monday to Friday,
   8:00 AM to 4:59 PM Pacific) is not on call, and the rotation does not
   decide those calls: the old fixed number stands. Holidays rotate like any
   other day. On a day the practice is closed, the daytime hours are on call
   too (`holiday_daytime` in the log), because nobody is in the office.
   When that closed day is a Tuesday, its daytime hours (8:00 AM to 4:59 PM)
   belong to the **outgoing** week's provider, because the week does not turn
   over until 5:00 PM. Enter an override if the incoming provider should take
   that day instead.
2. **Who gets the call.** The on-call provider, for every urgent call:
   patients, hospitals and other providers alike. There is no OD/MD split.
3. **The one exception: a recent surgery.** If the caller's identity is
   CERTAIN (the record is matched, RULE ZERO) and that patient had surgery in
   the last 7 days, the call goes to their surgeon instead. 7 days ago goes
   to the surgeon; 8 days ago goes to on-call. The surgery date and the
   surgeon come from the Eye Care Patient Console (`si_appointment_facts`
   joined to `si_providers`) and nowhere else. A cancelled surgery, or one
   moved and not kept, does not count. A surgery dated today counts only once
   it has started: when the Console marks it kept, or when its start time
   (`begin_time`) has passed by the Pacific clock. Before then, the call goes
   to on-call and the text says the surgery is booked for later today and has
   not started (`surgery_not_started`); a day-of surgery with no start time
   and not marked kept is treated the same way. If the Console cannot say for certain
   (two surgeons on the latest surgery date, a surgeon not in the provider
   pool or marked inactive, a lookup that fails or runs past 1.5 seconds, or
   no confirmed identity), the call goes to on-call and the text says why.
   One surgeon is one surgeon whether a Console row carries their NPI or
   only their name: a row the pool matches is keyed on the pool's provider,
   and two rows the pool does not know are told apart by NPI, then by name.
   The whole routing decision (the rotation read and the Console lookup
   together) has one 2.5-second deadline, so a slow read cannot hold the
   caller longer than that; the Console gets whatever is left of it, never
   more than 1.5 seconds, and is not asked at all once the deadline is spent.
4. **The cadence, per level:**
   - a. A text with the patient's details (the same details as today's urgent
     text, in the text itself, never behind a link), then the transfer call.
   - b. No answer is logged as `no_answer`, not as a failure.
   - c. Within 5 minutes of the original call: a second call and a reminder
     text. The reminder says "REMINDER — the urgent transfer to you was not
     taken. We are calling you again now." when the first call was the
     in-call transfer, and "REMINDER — we are calling you again now."
     otherwise, followed by the patient's details again.
   - d. A key press on any of our calls takes the patient and stops the chain.
     Any other call of ours still ringing for that patient is hung up and
     logged `taken_elsewhere`.
   - e. Otherwise the region's medical director, with the same cadence.
   - f. Then Dr. Logan, with the same cadence. San Diego and Coachella Valley
     go straight from the provider to Dr. Logan, because he is their
     director.
   - A director marked inactive is never rung: the level is left out of the
     chain and the plan says why (`region_director_inactive`,
     `final_director_inactive`).
   - A level whose phone number cannot be dialled (missing or malformed in
     the table) gets one `failed` attempt row and the chain moves straight to
     the next level, with no second call and no wait.
5. **Every attempt is logged** in `on_call_attempts`: who, when, answered or
   not, the text sent, the level, and the caller's CallSid as the
   conversation ID.

The first call of level 0 is the in-call warm transfer, with the caller still
on the line. Every attempt after it is a **callback**: the caller is no longer
connected, so the text says so, and the provider presses a key on our call to
take the patient and then calls the patient back.

### What the provider hears

Our call to the provider says:

> This is the Azul Vision answering service. You have an urgent patient who
> needs a call back. The details are in the text message we just sent you.
> Press any key to take this patient.

A key press answers "Thank you. This patient is yours. The callback number is
in the text message. Goodbye." No patient detail is ever spoken on the call;
the details are only in the text. A provider who presses a key after someone
else has taken the patient hears "This patient has already been taken."
If two providers press a key at nearly the same moment, the one the
escalation records as having taken the patient (`accepted_by`) is told it is
theirs and the other hears that it has already been taken. A key press whose
close of the chain does not land (another writer was moving the record at the
same moment) still takes the patient: the press is logged as accepted, the
chain is brought due at once, and the next pass finds the press and closes
the chain on it. Nothing else is rung in between.

### When the first call is not taken

When the on-call provider does not take the in-call transfer, the caller is
not connected, but the chain has only started. The agent is told the on-call
team is being paged (not that the transfer failed), tells the caller so,
confirms the callback number and files the ticket. The urgent ring-out ticket
says the rotation is still calling: the provider again, then the region's
medical director and the final director, so a staffer working it knows the
patient may already be getting a call back from one of them.

The agent and the ticket say the team is being paged only when the chain's
record confirmed, within 2 seconds of the ring-out, that the chain is open and
calling. If the record could not be opened, came back closed, or did not
answer in time, the agent says the on-call team could not be reached and will
call back, and the ticket carries no line about the rotation calling. That
errs toward saying less: a chain that does page after a slow write still
calls the provider, but the caller was not promised it. A record that has not
answered after 20 seconds releases the call's claim, so a later request on the
same call is not held back by it.

### One chain per call

A call has at most one escalation chain running at a time.

- If the caller asks for the on-call team again while a chain is running for
  their call, nothing new is dialled: the agent is told the team is already
  being paged, tells the caller so, and files anything new on the ticket.
  This includes a second request that arrives while the first is still
  being routed. The chain is claimed the moment the first request reaches
  the transfer, before anything is read, so two requests in the same instant
  cannot both start one.
- If the caller asks again after their chain has finished (someone took the
  patient, every level was tried, or it was stopped), the second request
  takes today's path: the fixed on-call number, rung as before the rotation.
  It does not start a second chain.
- If the chain's record for this call cannot be read (a database outage), the
  second request also takes today's path, so an urgent caller always rings a
  person rather than being told a chain is paging when nobody can see one.
- If the first request could not open its record at all (a database outage
  at the moment it started), the next request routes through the rotation
  again.
- If the in-call dial fails outright after the provider was texted, the chain
  is handed on as a failed first call, so the retry and the directors still
  follow.

The rotation also runs when `HUMAN_AGENT_NUMBER` is not set: the number to
ring comes from the rotation. With the rotation off, an unset
`HUMAN_AGENT_NUMBER` still means nothing is dialled, as today.

### The levels and their timing

| when (from the original call) | what |
|---|---|
| 0:00 | text + in-call warm transfer to the on-call provider (or the surgeon) |
| after it rings out, at least 1:00 later, no later than 4:00 | second call + reminder text |
| next | region director: text + call, then a second call + reminder text |
| last | Dr. Logan: text + call, then a second call + reminder text |
| after the last call | the escalation is marked `exhausted` |

When nobody takes the patient, the urgent notification number
(`URGENT_NOTIFICATION_NUMBER`) gets one text with the patient's details and
what happened, from today's number (`TWILIO_PHONE_NUMBER`):

- "NOBODY TOOK THIS URGENT CALL" when every level was tried;
- "THE ON-CALL ESCALATION STOPPED" when the chain ended before it rang a
  level it had planned, and nobody else is rung: it came due more than two
  hours after it opened (a restart or an outage held it), its next level
  could not be read, or the rotation was switched to test while it ran and
  the next level is not a test number;
- "THE ON-CALL ESCALATION COULD NOT START" when the in-call transfer was not
  taken and the chain's record could not be written.

For a chain that started in test mode, that text goes to the first test number
instead and starts with `[TEST MODE]`, so a test chain never asks a real person
to call a test caller back. A chain that started live keeps sending it to
`URGENT_NOTIFICATION_NUMBER`, even if the rotation is switched to test while it
runs, because a real patient is waiting. A chain that started in test mode and
is still open when the rotation is switched to live rings nobody else, and its
closing text is not sent (the log says so), because the test numbers are gone
with test mode; such a chain only ever holds a test caller.

Each of our callback calls rings for 30 seconds (the in-call warm transfer
rings as it does today). A call whose status never comes back is hung up and
logged `no_status` after 6.5 minutes, and the chain carries on.

---

## 2. The switches

All of them are environment variables on the voice deployment. Only Wayne
sets them.

| variable | values | what it does |
|---|---|---|
| `ON_CALL_ROTATION_MODE` | `off` (default), `test`, `live` | `off`: today's behaviour. `test`: the whole chain runs, but every call and text goes to a test number. `live`: the rotation's own numbers. |
| `ON_CALL_TEST_PHONES` | comma list of phone numbers | Test mode only, and required there. Level 1 rings the first number, level 2 the second, level 3 the third; a shorter list reuses its last number. |
| `ON_CALL_CALLER_ID` | a phone number | The number provider calls and texts come from. Defaults to `TWILIO_PHONE_NUMBER`. **Refused if it is the Wayne Operator Line** (`OPERATOR_LINE_FROM_NUMBER`). |
| `ON_CALL_POST_OP_REQUIRE_KEPT` | `1` or unset | Unset: a booked surgery in the last 7 days goes to the surgeon even if NextGen has not marked it kept yet (the note on the text says so). `1`: only a surgery marked kept goes to the surgeon. See section 8. |

If any setting cannot be honoured (an unknown mode, no caller ID, the operator
line as caller ID, test mode with no test numbers, a test number that is not a
phone number), the whole rotation turns **off** and says why. It never rings a
number nobody chose.

### How to tell it is running

The boot log prints one of:

```
[voice-runtime] on-call rotation TEST: urgent after-hours calls ring the week's on-call provider, then retry and escalate
[voice-runtime] on-call rotation LIVE: urgent after-hours calls ring the week's on-call provider, then retry and escalate
[voice-runtime] on-call rotation off — urgent transfers ring the fixed on-call number as before
[voice-runtime] on-call rotation off (<the reason>) — urgent transfers ring the fixed on-call number as before
```

`/voice/health` carries an `onCall` block:

```json
"onCall": { "mode": "test", "testPhones": 3, "requireKept": false, "running": true }
```

`running: false` with a `disabledBecause` or `blockedBy` says why it is off.
Phone numbers are never shown there, only how many test numbers are set.

---

## 3. First load (once, before going live)

1. **Apply the migration** on the Operations Hub (`pslzngjciiifowemrzza`):
   `migrations/add_on_call_rotation.sql`. It creates six tables and enables
   row-level security on each. The reversal is at the top of the file (only
   before go-live: it deletes the attempt log). Until the tables exist the
   rotation reports `store_unavailable` and every urgent call takes today's
   path.
2. **Build the seed SQL on your own machine.** The CSVs and the SQL hold staff
   phones and emails, so they never go into the repository:

   ```sh
   npx tsx scripts/on-call-seed.ts On_Call_Rotation_Pool_2026.csv On_Call_Schedule_Run1.csv \
     --final "Dr. Dwayne K. Logan" --out ~/on-call-seed.sql
   ```

   - The pool CSV needs columns for name, phone, region and escalation
     director; email and NPI are read when present. Header names are matched
     loosely ("Escalation Director", "Director", "Phone Number" and so on).
     The NPI is how a post-op patient's surgeon is found in the pool, so a
     surgeon with no NPI is matched by name only.
   - The schedule CSV needs a week column (the Tuesday the week starts) and a
     provider column.
   - A director who is not in the pool goes in `--directors <file.csv>` with
     the same columns (name, phone, email, region, NPI).
   - `--out` refuses a path inside the repository and writes the file
     readable only by you. Without `--out` the SQL goes to the screen.
   - Every problem is reported at once and nothing is written: a week that is
     not a Tuesday, a week listed twice, a provider on the schedule who is not
     in the pool, a region with two directors, a number that is not a phone.
   - The summary names providers and regions and never a phone or email. Read
     its warnings before running the SQL: a gap in the schedule, or a
     director in the pool who has no week and is placed at the end of the
     rotation.
3. **Run the seed SQL on the Hub.** It refuses to run if the tables already
   hold anything, and it runs in one transaction.

---

## 4. Changes after the first load

Every change is one command that prints SQL. Read it, then run it on the Hub.
Nothing is written until you run it. Each command runs in one transaction that
checks every name first and writes nothing if a name does not match exactly
one provider (case and spacing aside).

```sh
npx tsx scripts/on-call-change.ts <command> [options] [--out ~/change.sql]
```

### A swap for a whole week

```sh
npx tsx scripts/on-call-change.ts swap --week 2026-12-08 --to "Dr. Name" --note "traded with Dr. Other"
```

The week is the Tuesday it starts. The whole week (Tuesday 5:00 PM to the
next Tuesday 8:00 AM Pacific) goes to the other provider.

### Cover for part of a week

```sh
npx tsx scripts/on-call-change.ts cover --from "2026-12-10 17:00" --to "2026-12-11 08:00" --by "Dr. Name" --reason "family event"
```

Times are Pacific. A cover beats the schedule; when two covers overlap, the
one entered last wins.

### A new provider

```sh
npx tsx scripts/on-call-change.ts add-provider --name "Dr. Name" --phone "909-555-0100" \
  --region "Inland Empire" --email name@example.com --npi 1234567890
```

A new provider goes to **the end of the rotation**. No week already on the
schedule changes; their first week is the first one `extend` adds. The region
must already have a director; a misspelt region is refused. Add `--new-region`
to create a region (then give it a director with `set-director ... --new-region`).
A name already on file is refused: a provider who comes back is `activate`.

A new medical director who takes escalations and no weeks:

```sh
npx tsx scripts/on-call-change.ts add-provider --name "Dr. Name" --phone "..." --region "Los Angeles" --escalation-only
```

### More weeks

```sh
npx tsx scripts/on-call-change.ts extend --weeks 8
```

Adds weeks after the last one on the schedule, continuing the rotation order
among active providers (new providers included, at the end).

### A provider leaving, or coming back

```sh
npx tsx scripts/on-call-change.ts deactivate "Dr. Name"
npx tsx scripts/on-call-change.ts activate "Dr. Name"
```

A deactivated provider is skipped by `extend`, and a swap or cover to them is
refused. Their weeks already on the schedule are listed so you can swap them.
A cover entered before they were deactivated (or before their row was
removed) is not rung: the window falls back to the week's scheduled provider,
and the lookup and the alert say so (`override_provider_inactive` or
`override_provider_missing`).

### A region's director

```sh
npx tsx scripts/on-call-change.ts set-director --region "Orange County" --director "Dr. Name"
npx tsx scripts/on-call-change.ts set-director --region FINAL --director "Dr. Dwayne K. Logan"
```

`FINAL` is the last rung after every region's director. A region not on file
is refused unless `--new-region` is given.

### The directors as built

| region | director |
|---|---|
| Inland Empire | Dr. Pabalan |
| Los Angeles | Dr. Brookman |
| Orange County | Dr. David M. Choi |
| San Fernando Valley, San Gabriel Valley | Dr. Jay Patel |
| San Diego, Coachella Valley | Dr. Dwayne K. Logan |
| FINAL (after every region) | Dr. Dwayne K. Logan |

They are rows in `on_call_escalation_directors`, read from the pool's
escalation-director column at the first load and changed with `set-director`.

---

## 5. Test calls

Test calls file real tickets and send real texts, so the whole flow can be
seen; every provider call and text goes to the test numbers.

1. Set `ON_CALL_ROTATION_MODE=test`, `ON_CALL_TEST_PHONES` to three numbers
   (one per level), and, if needed, `ON_CALL_CALLER_ID`. Republish. Check the
   boot line and `/voice/health` `onCall.running`.

   **Keep the test window short.** While test mode is on it applies to every
   urgent after-hours call, a real caller's included: that caller's chain
   rings and texts the test numbers, not the provider. Today's urgent text to
   `URGENT_NOTIFICATION_NUMBER` and the urgent ticket still go out on every
   such call, test or real, so the patient is not lost, but switch the mode
   back to `off` (or to `live`) as soon as the test calls are done.
2. With the tables seeded, the chain is the real one for the time of the call
   (the real names in the texts, the test numbers on the phone). With the
   tables empty, a test-mode call runs a synthetic three-level chain over the
   test numbers (`test_synthetic` in the log). Texts in test mode start with
   `[TEST MODE]`.
3. Call the after-hours line outside weekday daytime and describe an urgent
   symptom. (A call in weekday daytime takes today's path and rings the fixed
   `HUMAN_AGENT_NUMBER`, test mode or not.) Expect:
   - the first test phone gets the text, then the transfer call. Do not press
     a key. The call rings out.
   - within 5 minutes of the original call, the first test phone gets a
     second call and a reminder text.
   - then the second test phone (the region director's level), text, call,
     second call, reminder.
   - then the third (Dr. Logan's level).
4. Run it again and press a key on any of those calls: nothing rings after it,
   and the escalation reads `accepted`.

### Reading the log

```sql
-- One urgent call, every attempt in order. The CallSid is the caller's.
SELECT level_index, role, kind, attempt_no, outcome, routing_reason,
       started_at, ended_at, provider_call_sid, sms_sid
FROM on_call_attempts
WHERE call_sid = '<CallSid>'
ORDER BY started_at, id;

-- The escalation itself: where it is and how it ended.
SELECT status, level_index, attempt_no, phase, next_at, accepted_at,
       routing->>'reason' AS routing_reason
FROM on_call_escalations
WHERE call_sid = '<CallSid>';
```

`role` is `on_call`, `surgeon`, `region_director` or `final`. `kind` is
`warm_transfer`, `call`, `sms` or `nudge_sms`. `outcome` is `accepted`,
`no_answer`, `declined`, `busy`, `failed`, `no_status`, `taken_elsewhere`
(another of our calls took the patient first, and this one was hung up),
`sent`, `send_failed` or `in_progress`. The patient details and the caller's number are kept on the
escalation only while someone is being paged, and are erased when it closes.

---

## 6. Going live

1. The tables are seeded and the schedule covers the weeks ahead (the seed
   summary and `SELECT max(week_starts_on) FROM on_call_schedule` say how far).
2. Test calls in test mode have passed every step in section 5.
3. Set `ON_CALL_ROTATION_MODE=live` and remove `ON_CALL_TEST_PHONES`.
   Republish. The boot line reads `LIVE`.

To turn it off at any time: `ON_CALL_ROTATION_MODE=off` (or unset) and
republish. Urgent calls go back to the fixed number at once. An escalation
already running rings nobody more, and a key press on a call already placed
hears that the urgent call has been closed.

---

## 7. What it does not do

- **The old core is not covered.** This runs on the Grok runtime, which serves
  the after-hours line since 2026-10-01. An urgent call on the old SIP core
  still rings the fixed number.
- **Retries are callbacks, not a live bridge.** After the in-call transfer the
  caller is not on the line; the provider calls the patient back.
- **What the caller hears is unchanged.** If the in-call transfer is not
  taken, the caller hears today's line and their request is filed as today.
- **Weekday daytime is not decided by the rotation.** Those calls keep today's
  fixed number.

---

## 8. Open questions for Wayne

1. **A surgery not yet marked kept.** NextGen marks a surgery kept a day or
   more after it happens: measured on the Console, 0 of 76 surgeries on the
   day itself were marked kept, 71 of 142 three to six days later, and 67 of
   72 at seven days. Today a booked surgery in the window goes to the surgeon
   (and the text says it is not yet marked kept) once its day has passed or
   its start time has; one booked for later today goes to on-call.
   `ON_CALL_POST_OP_REQUIRE_KEPT=1` sends every not-yet-kept surgery to
   on-call instead.
2. **The surgeon's region director.** On a post-op call the next level is the
   surgeon's own region director, not the on-call provider's.
3. **A surgeon who is not in the pool** routes to on-call, and the text says
   so.
4. **A week nobody is scheduled for** rings only the final director.
5. **Which fixed number stays as the fallback.** The legacy path, and test
   mode's fallback when the rotation cannot decide, dial `HUMAN_AGENT_NUMBER`.
   The old core used `NO_IVR_HUMAN_AGENT_NUMBER` for this line.
   `URGENT_NOTIFICATION_NUMBER` still gets today's urgent text as well.
6. **Voicemail.** A provider's voicemail that answers our call and plays over
   the key-press prompt can read as `declined`; the chain carries on either
   way.
7. **A closed holiday on a Tuesday.** Its daytime hours go to the outgoing
   week's provider, because the week turns over at 5:00 PM. If the incoming
   provider should take those hours, that is an override for the day.
