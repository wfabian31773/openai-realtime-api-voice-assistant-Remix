# Validated identity on tickets — Support Desk #1–4, #12, #13

2026-10-27. The live queue filing tools and normal after-hours create tool use
`prepareTicketIdentity` before their individual handlers: read the validated
per-call record, fill held name/DOB/clinic, then ask only one missing question.
DOB and a clinic are required while the caller can answer. A valid record never
causes a repeat demographic question. Recovery/sweep filing preserves captured
facts without running that live interview gate.

`lookup_patient` carries canonical person ID, chart DOB, next appointment and
last visit into `verifiedIdentity`, keyed only by the canonical CallSid. The next
appointment's office wins, then the last visit's office (Oct 25 ruling). The
normal no-IVR and answering-service lookup tools write the same state after a
validated match. A phone-only match is a candidate regardless of uniqueness;
its DOB is not inherited and the runtime greeting stays generic. Another call
on the same number cannot read this state. Conflicting DOBs invalidate same-name
merges; unconfirmed enrichment does not replace validated demographics.

Filing sends optional `validatedPatient` to the existing ticketing API:
`{ status: "validated", callSid, personId?, firstName, lastName, dateOfBirth?,
confirmedClinic?, nextAppointment?, lastVisit? }`. Dates use `YYYY-MM-DD`;
appointments contain `{ date, location, provider? }`; `personId` is a UUID.
This object is attached before durable queue filing and carried by recovery
payloads. It is not a tool parameter the model can invent. Deploy the paired
Support Center change first. It checks call binding, persists the record on a
ticket event, fills DOB/location, prevents phone-only identity replacement,
and conditions summaries on held facts. Legacy clients remain supported.

No transfer-ordering changes are included; PR #375 owns identity before on-call
transfer. The receiving ticket path handles #16 (67395), including failed transfers.
No production DB access, migrations, or live-call testing were performed. Tests
use synthetic identity values indexed by the issue ticket IDs; #12's truncated
description is covered only to the stated identity-persistence scope.

Run `npx vitest run src/tools/identityRootFix.test.ts` for lookup-to-filing,
missing-field, and same-phone/different-call controls. Adjacent suites cover
identity storage, schedule lookup, no-IVR tools, runtime and the recovery sweep.

## Verification (2026-10-27)

Replaying the new lookup-to-filing and HTTP transport regressions against the
original `HEAD` in a disposable copy fails **7 of 8 tests**. Additional tests
written during resumption reproduced repeated lookup and candidate-history leaks
before their fixes. The final focused/adjacent run passes **280 tests in 19 files**,
including all four filing tools, normal no-IVR intake, failed-transfer recovery,
per-call isolation, the HTTP client boundary, the identity import boundary,
schedule lookup, the recovery sweep and greeting identity.
`npx tsc --noEmit -p .` passes.

The socket-based runtime regression (`voiceRuntime.test.ts -t VA-76205`) cannot
execute here: sandbox `listen EPERM` occurs before call processing. The pure
identity-greeting tests pass. `npm run build` compiles the backend, then fails
in the unchanged `client/` dashboard because React/router dependencies/types
are unavailable in its installed module resolution. No client files were changed;
no dependency installation or live call was attempted.

The simulator tests exercise lookup → registry gate → durable payload, shared
HTTP transport, recognized/unrecognized callers, successful filing, and a
controlled transport failure using synthetic identities and mocked services.
The paired receiver tests exercise authenticated HTTP intake → stored ticket
columns and context events. No production measurements or migration was run.

A clinic resolved earlier by `resolve_location` is remembered under the same
CallSid. The shared, no-IVR and answering-service lookups reuse a locked record
without another search. Phone-only and ambiguous lookup responses expose no
selected identity or visit history. Answering-service DOB confirmation cannot
override a different caller-stated surname. An explicit
`identity_corrected` lookup clears it before searching again. Caller-stated
name spelling and valid DOB input remain intact at transport.

## Local self-review (2026-10-27)

Fixed P2 gaps in the paired path:

- Every queue filing tool and the HTTP client's fallback compare the supplied
  DOB before attaching held identity, so a corrected DOB cannot travel with the
  old validated record and cause a permanent receiver refusal.
- The production teardown filer carries DOB, clinic and `validatedPatient` into
  the durable payload. Testing only the injected filer had missed this loss;
  outbox retries now retain those facts after the in-memory identity expires.
- Surgery retains the joined record's physician and last clinician and uses
  them without repeating a name/DOB search. Candidate or conflicting identities
  still supply neither routing facts nor validated context.
- Caller-named clinics survive directory-unavailable and exhausted-resolution
  pass-throughs. They remain unverified; the ticketing API resolves the name.
- The Grok after-hours prompt and both prompt contract suites now match the
  branch's held-DOB/clinic policy, which had only reached the legacy prompt.

New behavioral regressions failed before their fixes. The production sweep test
reaches the durable filer and exercises a queued outcome. Auth/signature checks
and database safeguards are unchanged. No migration or production access is used.

Final verification: **425 tests pass in 23 files**, including touched non-socket
files, the real sweep filer, durable filing, request recovery and identity import
boundaries. `npx tsc --noEmit -p .` passes. Five targeted mutations (DOB guard
removed, sweep identity dropped, joined physician dropped, caller clinic dropped,
runtime identity prompt removed) each fail the corresponding regression.
The complete `voiceRuntime.test.ts` was attempted: all **79 tests** fail because
the sandbox rejects server `listen` with `EPERM`, then each harness times out.
No socket test or security check was disabled to obtain the passing results.
The isolated production build compiles the backend, then fails in the unchanged
client dashboard on unavailable React/router dependencies/types. Full build
success is not claimed.

## Files in this paired change

- `docs/identity-persistence.md`
- `docs/observatory/STATE-OF-PLAY.md`
- `server/services/ticketingApiClient.ts`
- `server/services/ticketingIdentityTransport.test.ts`
- `src/agents/answeringServiceAgent.ts`
- `src/agents/answeringServiceIdentity.test.ts`
- `src/agents/noIvrAgent.ts`
- `src/agents/noIvrIdentityReachesTheCallRow.test.ts`
- `src/runtime/sweepRunner.ts`
- `src/runtime/voiceRuntime.test.ts`
- `src/runtime/voiceRuntime.ts`
- `src/services/greetingPersonalisation.ts`
- `src/services/identityGreeting.test.ts`
- `src/services/lookupJoinsOnPersonId.test.ts`
- `src/services/scheduleLookupService.ts`
- `src/tools/identityRootFix.test.ts`
- `src/tools/lookupCarriesOffice.test.ts`
- `src/tools/lookupFallback.test.ts`
- `src/tools/medicalRecordsTools.test.ts`
- `src/tools/medicalRecordsTools.ts`
- `src/tools/opticalTools.production.test.ts`
- `src/tools/opticalTools.ts`
- `src/tools/registry.ts`
- `src/tools/sentinelCallSid.test.ts`
- `src/tools/sharedPatientTools.test.ts`
- `src/tools/sharedPatientTools.ts`
- `src/tools/surgeryTools.test.ts`
- `src/tools/surgeryTools.ts`
- `src/tools/techTools.test.ts`
- `src/tools/techTools.ts`
- `src/tools/ticketIdentity.ts`
- `src/tools/verifiedIdentity.test.ts`
- `src/tools/verifiedIdentity.ts`
