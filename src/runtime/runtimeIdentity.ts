/**
 * src/runtime/runtimeIdentity.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RECORD REACHES THE CALL ROW — v51, 2026-09-17.
 *
 * MEASURED over seven days to 2026-09-17, every substantive call, every lane:
 * `patient_found`, `patient_name` and `patient_dob` were NULL on ALL 2,914 —
 * 2,471 of them on this runtime. Task #57 recorded the runtime half as done:
 * "identity rides on the VoiceCallRecord, sourced from the call-facts ledger".
 * That was the `src/core` runtime, deleted on 2026-09-01; this one was built
 * beside it (PR #227) and `persistRuntimeCall` has taken an `identity`
 * argument nobody supplied ever since. The old core's writers are broken in
 * their own ways (the same task); the answering-service line, the only
 * reliable one, took no calls after 09-01 — which is why 13 of 497 on 08-31
 * became a flat zero everywhere.
 *
 * THE SOURCE IS THE ONE THE TOOLS ALREADY KEEP. `lookup_patient` remembers a
 * unique match per call in `verifiedIdentity.ts`, and `verifiedIdentityFor`
 * answers "who did we establish this caller to be?" for the teardown sweep —
 * refusing an UNCERTAIN entry, because a phone match is a candidate to
 * confirm, never an identity (RULE ZERO step 2, standing instruction 6). So
 * this reads the same accessor with the same refusal: a call row carries a
 * name only when the process established one. Nothing is invented, and an
 * unconfirmed household number is never written as the patient.
 *
 * Read at TEARDOWN, alongside the rest of the record, rather than written
 * mid-call from inside the lookup tool: a database write inside
 * `lookup_patient`'s 6s budget is a latency cost on the ticket path, and the
 * upsert already runs at hangup.
 */
import type { RuntimeCallIdentity } from "./callRecord";
import { verifiedIdentityFor } from "../tools/verifiedIdentity";

export function identityForRow(callSid: string | undefined): RuntimeCallIdentity {
  const v = verifiedIdentityFor(callSid);
  if (!v) return {};
  return {
    patientFound: true,
    patientName: `${v.firstName} ${v.lastName}`.trim(),
    ...(v.dateOfBirth ? { patientDob: v.dateOfBirth } : {}),
  };
}
