# Read-only appointment access — Support Desk item #15

Implemented 2026-10-27 for VA-74600, 76186, 67478 and VA-75007. The
regressions use synthetic patients and providers, indexed by ticket id.

## Source and boundary

`lookup_patient` already reads `PatientScheduleContext`, including upcoming
appointments, but previously returned only visit-history fields to the model.
It now carries `appointment_access`, `upcoming_appointments` (provider, office,
ISO date, local time and `America/Los_Angeles`) and booking-review instructions.
These new fields disclose appointments only when that lookup is certain.
The legacy camelCase appointment fields are also withheld on uncertain or
ambiguous results; an `identity_required` assessment must never accompany
another field containing the candidate's bookings.

Optical, Surgery, Tech and Records also expose `check_patient_appointments`.
The call's stored, certain identity supplies `personId`; the model cannot
supply a patient id or call id in its schema. The adapter supplies the call
id. `verifiedIdentityFor` now returns the person key it already stored; its
certainty, expiry and invalidation checks are unchanged. If identity changes
while the read is in flight, the result is withheld.

The reader is the existing `ScheduleLookupService.lookupByPersonId`:
`patients_master.person_id` joins to the Console's `si_appointment_facts`,
with `si_providers` and `si_locations` supplying labels. It uses the existing
`OBS_CONSOLE_DATABASE_URL` configuration, deadlines and Operations Hub
`Schedule.PersonID` fallback. No new endpoint, credential, table or mirror is
needed in Support Center. The existing tool HTTP surface registers the same
tool under its existing authentication.

This reads appointments, never free slots. There are no booking, rescheduling
or cancellation writes. Support Center still owns ticket creation, taxonomy
and assignment. Ticket submission is unchanged; appointment disclosure is
gated in both the original and the new result formats.

## What the caller can be told

Before an appointment request, review the matched record's bookings. Use the
existing result when available; do not ask for known identity details again.
Never claim there is no appointment access when the record is available.
An existing booking must be reviewed before requesting another appointment.
Clarify whether the caller means that booking or a separate request, and carry
the existing booking and any unresolved discrepancy into the request.

`check_patient_appointments` accepts optional `provider` and `office`, taken
from what the caller named. `provider_check` and `office_check` report
`matched`, `not_matched`, `unknown` or `not_requested`. Comparison normalizes
case, accents, punctuation, clinician titles and practice prefixes; it does
not guess aliases or use fuzzy matching. `booking_details_match` requires
both claims on the **same appointment**. A provider on one booking and an
office on another never confirm the combination. A mismatch asks for
clarification; it never rewrites the record or means the provider does not
exist elsewhere in the practice.

The after-hours and answering-service `lookup_schedule` tools accept the
same optional claims and return the same assessment alongside their existing
results. Answering-service phone candidates carry no appointment details in
the initial prompt or phone-only tool response. Its cached-DOB shortcut
requires an unambiguous record and rejects a supplied name that differs from
that record; a supplied name and DOB take precedence over a phone-only search.
Legacy reader errors, tool exceptions and the answering-service timeout
return `unavailable`, never a claim that the patient has no bookings.
Both after-hours prompt variants preserve record/caller discrepancies for
staff to review and carry the read-only rule. PCP's
existing `lookup_patient_appointments` returns schedule availability and
booking-review instructions under its existing patient-specific access gate.

| `appointment_access` | Meaning |
| --- | --- |
| `available` | The read succeeded; an empty list means no upcoming appointments in that result. |
| `partial` | The existing 60-row reader limit was reached. Never infer absence from it. |
| `unavailable` | A join failed, timed out, was skipped, or the stored identity has no person key. This is not an empty schedule. |
| `identity_required` | No certain identity, or identity changed during the read. No new appointment details returned. |

`has_upcoming_appointments` is `null` when absence cannot be established.
`scheduling_action` distinguishes `review_existing_booking`,
`clarify_record_difference`, `request_schedule_review`,
`take_scheduling_request` and `establish_identity`. These are instructions
for the interview, never booking authorization. A read failure still permits
taking a request for staff to check, without promising a new booking.

The service preserves its existing status filtering: removed/cancelled/moved
appointments are excluded; a kept appointment today is a past visit. All
upcoming rows in the bounded read are now returned, instead of silently
discarding everything after the fifth. No new appointment data is logged or
added to the tool-timeline allowlist.

## Offline verification

The four ticket regressions first failed with the old tools. Additional
tests cover a split provider/office across two bookings, uncertain and
invalidated identities, model-supplied ids, complete versus partial or failed
reads, removed appointments, more than five upcoming bookings, and the real
agent/tool bindings. Database and remote-service boundaries are mocked.

```sh
npx vitest run src/tools/patientAppointments.test.ts src/services/appointmentAccessSchedule.test.ts src/agents/appointmentAccess.test.ts src/agents/legacyAppointmentAccess.test.ts
npx tsc --noEmit -p .
```

Initial branch validation: 27 new tests across those four files; the full
relevant run passed 397 tests in 19 files, including existing prompt limits,
tool registration, identity, schedule-join and teardown-sweep regressions.
`npx tsc --noEmit -p .` passed. Four deliberate reversions were caught:
dropping appointments from `lookup_patient`, accepting a provider/office from
different bookings, restoring the five-appointment cap, and reporting an
unavailable join as an empty successful read.

`npm run build` passed server TypeScript compilation, then failed in the
unchanged dashboard: this workspace has no `client/node_modules`, and React,
React Router, React Query and their types cannot be resolved. No dependencies
or lockfiles were changed to work around that environment limitation.

Production behavior and spoken model compliance have not been measured in
this change. No production database was accessed and no migration was
created or applied. The private ai-bridge checkout is absent from this
workspace; these local notes record the handoff under the instruction not
to push.

## Self-review — 2026-10-27

Fixed findings, with synthetic regressions through the built agents and the
real schedule-reader methods:

- **P1:** Legacy camelCase results bypassed `identity_required`. Both legacy
  tools now withhold appointment and visit details unless the match is
  confirmed. The older phone-candidate test's name/DOB mock now reports the
  real reader's `name_and_dob` method instead of incorrectly returning a
  phone match.
- **P1:** Answering-service candidate bookings reached the initial prompt,
  and its cached-DOB shortcut trusted ambiguous records and conflicting
  supplied names. Candidate data is withheld and those shortcuts fall back
  to the name/DOB lookup. A matching unique cached record still works.
- **P2:** Legacy errors and timeouts looked like patient misses. The readers
  preserve failure status, and the tools return the shared unavailable/read
  review contract. Successful misses stay distinct from failures.
- **P2:** The long after-hours prompt still instructed the model to trust the
  caller over the booking. It now preserves the discrepancy against the record,
  matching the runtime prompt. The test checks both instruction variants.
- **P2:** PCP's added tool policy exceeded the existing 6,400-character wire
  limit (6,511). The policy and description were shortened without removing
  the appointment, identity, duplicate, discrepancy or read-only rules. The
  original ceiling is retained.

The new regressions failed before their fixes. The first broad parallel run
also produced test timeouts and subsequent shared-mock failures; reducing
worker concurrency removed those failures without changing their tests.
Previous-pass validation: **504 tests passed across 30 files**, including the opt-in
real-lane smoke tests (`RUNTIME_LANE_SMOKE=1`, `--maxWorkers=2`), all touched
test files, legacy privacy, schedule joins, provider/office checks, PCP access
gates and existing prompt/tool size limits. `npx tsc --noEmit -p .` passed.

Resume validation: **95 tests passed across seven targeted files**: all six
test files changed by this branch or its self-review, plus
`src/runtime/toolFieldDescriptionsReachTheWire.test.ts` to verify the existing
tool-size ceiling. The run used `--maxWorkers=2`. `npx tsc --noEmit -p .` and
`git diff --check` passed again. The full suite was not rerun.

No migration is present in this branch diff. No production measurement or
deployment was performed. No push or ai-bridge PR was made, following the
session's explicit instruction not to push.
