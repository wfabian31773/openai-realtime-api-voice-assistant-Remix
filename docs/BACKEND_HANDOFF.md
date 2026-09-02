# Backend and state-machine handoff

**Written 2026-08-20, at the end of a week of work on the four queue agents.**

This exists because the next session will not have the conversation that produced it.
The code is in git; what is not in git is what was *measured*, what was *ruled*, and
what was *tried and got worse*. That is what follows.

Read this before changing anything in the ticket path.

---

## 0. Why this document exists, stated plainly

The week this covers made surgery routing worse, not better. Provider fill on
department 2 went from ~98% (13-14 Aug) to 49% (19 Aug) across three merged PRs
(#215, #216, #217). Every change passed its tests. Every change was locally
reasonable. The failure was method, not mechanics:

- Fixes were shipped without a before-and-after measurement of the production
  number they were meant to move.
- Our own TypeScript interfaces were read as if they were the API's capabilities.
  Three things were requested from another team that already existed
  (`usedFallbackReason`, `providerMatches[]`, `idempotencyKey`).
- A hypothesis about a downstream system was written into a spec before a single
  query against `ticket_events` — a table already accessible — falsified it.

If you take one working rule from this file: **do not merge a change to the ticket
path without measuring the production number before and after.** Green tests did not
prevent any of the above.

---

## 1. The shape of the system

Two Supabase projects. They are not the same database and nothing joins across them.

| | project id | holds |
|---|---|---|
| **Operations Hub** | `pslzngjciiifowemrzza` | `Schedule` (the NextGen mirror), `call_logs`, `call_turns`, `agents`, `agent_prompts`, `agent_tools`, `drs_slots`, cost tables |
| **Support Center** | `vsmcxhxeirkoobmjcrbn` | `tickets`, `departments`, `providers`, `locations`, `request_types`, `request_reasons`, `ticket_events`, `mr_cases` |

### The mirror

`Operations Hub.public."Schedule"` — 975,875 rows, `DataSource = 'Nextgen'`,
appointments from 2025-01-01 to 2027-05-03. It is a copy of NextGen's appointment
book. The voice app never queries NextGen directly.

Facts worth not re-deriving:

- `EntryDateTime` is **when an appointment was booked**, not when the row synced.
  Weekend booking counts collapse to near zero. This was misread once as "the sync
  died" and reported as a root cause. It was wrong.
- `DoctorType` has **four** values, not two. One day of the book (2026-08-18):
  `OD` 1,455 · `MD` 606 · `Retina` 192 · `Equipment` 186.
  `Retina` is a surgeon. `Equipment` is `A-Scan`, `OCT-VF`, `DRS` — machines that
  appear in `RenderingPhysician` and are not people.
- `Schedule.ProviderID` is a NextGen UUID and matches
  `Support Center.providers.nextgen_provider_id` exactly. Coverage as of 2026-08-20:
  **78/78 active providers, 62/62 locations.**
- Surgery callers are typically **pre-operative**. The operating surgeon is on an
  *upcoming* appointment, not a past one. Any "last provider seen" logic looks the
  wrong way for this population.

### The ticket path — traced and confirmed by the ticketing team, 19 Aug 2026

```
voice tool  ->  ticketingApiClient.createTicket  ->  n8n gateway  ->
Next.js route handler (app/api/voice-agent/create-ticket/route.ts)  ->
zod validation  ->  consolidateIfDuplicate()  ->  storage.createTicket()  ->
side effects (auto-assignment, MR case, SMS)
```

**Nothing in that path rewrites `department_id`, `request_type_id` or
`request_reason_id`.** The payload is stored verbatim. Confirmed independently from
our side:

- `resolveLocationQueue()` is the only code that overwrites the triple, and it
  requires `queue: "location"` in the body. Our agents have never sent it — 0 of
  1,113 calls.
- Every create-ticket call arrives from **n8n**. n8n is our orchestration and it does
  not transform the payload.

### Why tickets appear in the "wrong" department

**Staff move them in the UI, and the transfer nulls the type and reason in the same
write.** Verified from our side:

```sql
-- 35 null-type optical tickets, 35 of them transferred. 0 either way.
select count(*) filter (where t.request_type_id is null) as null_type,
       count(*) filter (where t.request_type_id is null and exists (
         select 1 from ticket_events e
         where e.ticket_id = t.id and e.event_type = 'department_transferred')) as transferred
from tickets t where t.agent_used = 'optical' and t.created_at >= '2026-08-13';
```

A worked example: `VA-52623` ("when will my glasses be ready") was filed into Optical
exactly as sent, picked up by a Technicians Support admin 33 minutes later, moved to
their queue, and answered by SMS 88 seconds after that. Read forward that is triage,
not a misroute.

**Do not treat a department change as corruption.** If the routing disagreement
matters, it is a conversation between the queue owners, and `ticket_events` names who
moved what.

---

## 2. The API contract, as it actually is

Read the endpoint, not our interfaces. Our `CreateTicketParams` is a subset of what
the API accepts, and that gap caused three separate mistakes this week.

### `POST /api/voice-agent/create-ticket`

Accepts (beyond the obvious patient fields):

| field | status |
|---|---|
| `departmentId` | **authoritative** — never overridden on the create path |
| `requestTypeId` / `requestReasonId` | required as a pair; `0` is rejected, omission is rejected |
| `idempotencyKey` | **supported. The four queue tools do not send it.** See §4. |
| `queue: "location"` | opt-in inverted mode; derives the triple from a location. Unused by us. |

Returns, and we largely ignore it:

| field | we use it? |
|---|---|
| `ticketNumber`, `ticketId` | yes |
| `usedFallbackReason` | logged only |
| `lookupWarnings[]` | logged only |
| `providerMatched` / `providerSearched` | logged only |
| `locationMatched` / `locationSearched` | logged only |
| `consolidated` | **not handled** — a consolidated response means *appended*, not *filed* |

### `POST /api/voice-agent/lookup`

| field | status |
|---|---|
| `providerName` / `locationName` | string matching; fragile — accents, middle initials, `A-Scan` |
| `nextgenProviderId` / `nextgenLocationId` | **added by the ticketing team 18 Aug.** Unusable values now fall through to the name path rather than 400 (their PR #190). **The voice side does not send these yet.** |
| response `providerMatches[]` / `locationMatches[]` | returned; **we count them for a log line and discard the candidates** |
| response `providerInactive` / `locationInactive` | present, but unreachable today — no inactive row carries a UUID |

The catch-all reason per department lives in `src/tools/otherReason.ts` and is
verified against the database by `otherReasonsMatchDatabase` in the test suite.

Departments: 1 Optical Support · 2 Surgery Coordination · 3 Technicians Support ·
8 After Hours · 9 HVA Hub · 15 OCS Hub · 16 Medical Records · 17 Locations.

---

## 3. What is broken right now, measured

As of 2026-08-19 (the first full day with no manual backfill inflating the numbers):

| queue | tickets | no provider | no location |
|---|---|---|---|
| tech | 126 | 52 | 30 |
| surgery | 67 | 34 | 34 |
| optical | 47 | 37 | 0 |

Optical routes by **location** (0 missing — healthy). Surgery routes by **surgeon**
(34 of 67 missing — broken). Tech's provider gap has never been investigated.

**Surgery provider fill: 98% (13-14 Aug) -> 49% (19 Aug).** The regression is ours.

Contributing causes, in order of confidence:

1. **The phone fallback was removed.** `#216` switched the surgeon lookup from
   `lookupPatient` (name+DOB -> phone -> name) to strict `lookupByNameAndDOB`, on a
   valid review finding that the phone step could attach a *different* patient's
   surgeon. The finding was correct. The cost was never measured. Of 30 unrouted
   tickets on 19 Aug, **22 are not findable by name + DOB at all**.
2. **Name and date-of-birth capture is the dominant failure.** Confirmed examples:
   a caller said "thirteen nineteen fifty-two" and the ticket recorded `1962-02-13`
   (fabricated month, wrong year); `Georgina Weiss` filed `1953-06-22` against
   `1953-02-22` on file; `Ramon Ronquillo` `1955-08-24` against `1955-08-31`.
3. **Only 2 of those 30 patients have any physician on record at all.**

### The model does not carry its own tool results forward

Found 2026-09-02, from five requests that dead-lettered in one afternoon.

Optical call `CA747908b5d46b7ed25cffe733fb792738`, tool timeline in order:

```
lookup_patient (577ms, success)
check_open_tickets
classify_optical_request
file_optical_ticket   -> refused, "Missing required information: office"
resolve_location (3ms, { success: true, verified: true })
file_optical_ticket   -> refused AGAIN, same missing office -> dead letter
```

`resolve_location` verified the office and the very next filing call went out
without it. The gate was working perfectly; the office was in hand the whole
time. `location` and `surgeon` are MODEL arguments — `opticalTools.ts` says so
outright, "The office, as returned by resolve_location" — and the model is not
a reliable courier between two of its own tool calls.

`src/tools/resolvedContext.ts` holds the resolved office server-side for the
length of one call, the same way `verifiedIdentity.ts` holds the verified date
of birth (both exist because of this same failure, found six weeks apart).

**Three things a future change must not undo:**

1. **`verified` is not `usable`.** `resolve_location` sets `verified: true` on
   any Console directory hit and computes `usable_for_this_queue` separately.
   A surgery centre spoken to optical is verified and NOT usable. Only usable
   offices are stored — storing the other kind lets optical fill in a building
   the tool had just told the model not to use, and skip its own gate doing it.
2. **Optical carries only on the SECOND attempt**, after the gate has already
   asked. The carry is last-write-wins with no "is this still what the caller
   said" check, so on a first attempt it could file an office the caller had
   since corrected. Optical assigns BY office: that is a patient sent to the
   wrong building. Wayne's ruling decides which way to err — *"if you gate the
   location, the agent will ask and if no answer, unassigned."* Unassigned is
   sanctioned; a wrong building is not.
3. **Surgery gets NO office carry.** It does not gate on location at all
   (`files WITHOUT a location — unlike Optical`), so a missing office was never
   why its four requests died — a missing surgeon was. And `resolveWith` ANDs
   `cleanLocation` into every `/lookup`, so a carried office would turn a
   provider-only search into provider+location and stop matching a surgeon who
   is not at that building — narrowing the ladder on the queue that most needs
   it. The surgeon carry is a separate change and needs the four timelines
   measured first: `matched_by`, whether the ladder ran, and whether the name
   and date of birth on the filing call agreed with the lookup. See #48.

### Duplicate filings

Real and unfixed. The four queue tools (`opticalTools`, `surgeryTools`, `techTools`,
`medicalRecordsTools`) call `createTicket` **without an `idempotencyKey`**, while
`syncAgentService` and `ticketOutboxService` have sent one (`call-<callSid>`) all
along. The receiving side has a working `idempotency_keys` table with an expiry
sweep — the route checks it on the way in and writes it on the way out. It is a live
mechanism sitting unused because nothing calls it from these four tools.

**Corrected 2026-08-20.** The first version of this section said "one surgery call
filed 7 tickets" on 19 Aug. That was wrong, and wrong in an instructive way: those 7
tickets share the literal `call_sid` string `'unknown'`, so a `GROUP BY call_sid`
collapsed seven unrelated calls into one apparent duplicate. Verify the grouping key
before believing a duplicate count.

Measured properly — real Twilio SIDs (`CA...`) only, four queues, 14 days to 20 Aug:
**4 duplicate incidents, 4 extra tickets.** Gaps of 48ms, 41s, 1m27s, 2m28s — the
shape of a retry or a double tool-call, not two different patients.

`VA-52849` is one ticket row, not three. The ticketing team's request log shows
**three POSTs** (23:12:46, 23:12:49, 23:18:30) with consolidation absorbing the
second and third. Both readings are correct; they measure different planes. This
matters for the fix's metric: **the `tickets` table under-counts, because
consolidation already hides duplicate requests.** Measure requests per `call_sid` in
the ticketing side's `voice_agent_api_logs` as well, or an "after" number can look
perfect while we still POST three times per call.

### The sentinel `call_sid` — a precondition for the idempotency fix

A significant number of tickets carry a literal placeholder in `call_sid` rather than
a SID: `'unknown'`, `'latest'`, `'none'`, `'unknown_sid'`. 29 surgery and 13 optical
tickets share `'unknown'` alone over 13-19 Aug.

**This makes the obvious fix dangerous.** A naive `call-${callSid}` produces the key
`call-unknown` for many unrelated calls, and the route returns the *cached result* on
a key hit. So the second caller's ticket would never be created, and that caller
would be read the first caller's ticket number. That is a lost request plus a
cross-patient disclosure — strictly worse than the duplicate it replaces.

Send `idempotencyKey` **only when the sid matches a real Twilio SID**
(`^CA[0-9a-f]{32}$`); omit the field otherwise. Where the sentinel is written in the
first place is a separate, unfixed item, related to `CallMetadata.twilioCallSid`
being declared and never written.

### Call quality

The `quality_score` on the dashboard is dominated by **one grader**: `latency`, which
measures **first transcript delay against a 4-second threshold**. It is not measuring
ticket correctness — surgery scored 3.09 on the day it filed 66 unrouted tickets.

Latency failures went 0% (13-14 Aug) -> 45% (17 Aug) -> 59% (18 Aug) on surgery.
Failures cluster just over the line (4008ms, 4108ms, 4434ms). The 16 Aug change that
fits the timing is `idx_schedule_roster`, which made `refreshProviderRoster` succeed
for the first time (it had been silently timing out and falling back to a seed list),
changing the transcription vocabulary hints. **This is a hypothesis, not a finding.**
It is testable in one hour by reverting the keyword source and measuring.

`grader_version` has been `9` throughout — the ruler has not moved.

---

## 4. Work that is ready and not done

1. **Send `idempotencyKey` from the four queue tools** — `call-<callSid>`, and
   **only when the sid is a real Twilio SID.** See the sentinel note in §3: an
   unguarded key loses tickets rather than de-duplicating them. The pattern already
   exists in `syncAgentService`. Measure both the ticket-level and request-level
   numbers; the ticket table alone under-counts.
2. **Handle `consolidated: true`** as "appended to an existing ticket", not "filed".
3. **Send `nextgenProviderId`** on lookup, and **use `providerMatches[]`** instead of
   discarding it. Their side is ready.
4. **Decide the phone-fallback trade deliberately.** Either restore it with a guard
   that verifies the returned patient against the submitted name, or accept the
   coverage loss. It was removed by accident of judgement, not by decision.

---

## 5. Operator rulings — do not re-litigate these

- **Never relinquish the caller.** A call ends in a transfer or a ticket. Never both,
  never neither.
- **The hold ladder is fixed at 45 seconds**: "one moment while I try to connect you",
  15s, "still trying", 15s, "my last attempt", 15s, then take a message.
- **Deflect once before passing to the front desk.** Gather who is calling, verify the
  intent, and if it is schedulable, offer to do it.
- **A ticket is blocked without three fields**: who is calling, who it is about, how to
  reach them. Bounded at 3 blocks per conversation, never per field — a per-field
  budget reproduces the 2026-08-06 incident that destroyed 21 records requests.
- **When anyone calls about anyone else**, ask the relation and who the patient is.
- **Ask new-or-existing when the lookup finds nobody.** Existing means the date of
  birth is probably wrong — re-confirm once with name and DOB together. New means stop
  looking.
- **Never leave a ticket unassigned if the record has anyone on it.** An unassigned
  ticket is a manual NextGen lookup nobody volunteers for. An optometrist on the
  ticket is workable; a null is not.
- **Extraction and classification are the model's job, not a regex's.**
- **If you do not know, ask. Do not fill the gap.**

---

## 6. Things that were tried and made it worse

Recorded so they are not repeated.

| change | what happened |
|---|---|
| Putting the numbered intake list in the PCP prompt (#201) | The model recited it instead of asking — two questions 1,141ms apart with no tool call between. Reverted in #213. |
| Per-field strike budget on required fields | 3 fields x 2 strikes = 5 refusals, which is the exact shape of the 08-06 incident. Now per-conversation. |
| Requiring `DoctorType = 'MD'` for the surgeon | Excluded every `Retina` surgeon — 8.6% of the book. |
| Removing the phone fallback (#216) | Correct on the risk, unmeasured on the cost. Surgery fill 98% -> 49%. |
| Annotating unrouted tickets in `description` | `description` becomes the body of a **patient-facing SMS**. Caught in review before shipping. |
| Blaming n8n for the department override | There was no override. Staff transfers null the type. One `ticket_events` query would have shown it. |
| Counting duplicates with `GROUP BY call_sid` | `call_sid` holds sentinel strings (`'unknown'`). Seven unrelated calls looked like one call filing seven tickets. Check the grouping key. |

---

## 7. Instrumentation that exists

- `call_logs.tool_timeline` — per-call tool sequence with timings. Arg **names** only,
  filtered by a PHI allow-list (`SAFE_ARG_KEYS` in `src/services/toolTimeline.ts`).
- `call_logs.grader_results` — `graders[]` with name, pass, score, severity, metadata.
- `call_turns` — per-turn timing including `since_prev_ms`. The decisive instrument
  for turn-taking complaints.
- `ticket_events` — the ticketing app's audit trail. **Use it before theorising about
  ticket state.**
- `voice_agent_api_logs.request_body` (ticketing side) — the request as received.
- Shadow tap (`src/shadow/`) — disabled by default (`SHADOW_MODE_ENABLED=false`,
  0% capture) and spools to the server filesystem.

---

## 8. Open with the ticketing team

- **Their PR #190** (draft) — unusable UUIDs fall through instead of 400-ing.
- **Their note:** the department transfer wiping type and reason destroys reporting
  data; they intend to raise re-mapping to the destination's catch-all.
- **Superseded duplicate provider rows** linger as inactive without UUIDs (103
  "Farzad Jacob Khoubian", 111 "Logan M Haak"). Inert but they are drift.
- Reference documents:
  - Provider UUID change request — https://claude.ai/code/artifact/cdd744c0-768e-4860-aeb8-63c8180058c4
  - Routing trace request and their response — https://claude.ai/code/artifact/e3b36038-aa6c-4f51-9b30-ad78c600d55f

---

## 9. Credential

`VOICE_TOOL_API_KEY` is **unrotated**. It was deferred until agent testing finished.
It is also the credential needed for any authenticated end-to-end test against the
ticketing API, which is why no such test has been run from this side.
