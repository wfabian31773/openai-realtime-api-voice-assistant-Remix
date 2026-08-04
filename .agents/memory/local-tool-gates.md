# Local tool gates — answer a predictable refusal here, not over the wire

`src/services/azulToolGuards.ts` (pure policy) plus thin lookups in
`azulSchedulingAgent`. The pattern predates it: `guardIdentityArgs` is "the single
gate in front of `verify_patient_identity`", returning `{blocked, instruction}`
so the model gets corrective text instead of a bare error.

**Why bother.** A round trip to be told "no" costs the caller ~2 seconds of
silence, and the model's instinct on a bare error is to send the same call again.
`sage_reschedule` burned **34 invocations across 9 calls** doing exactly that.

A local refusal MUST use the same envelope the service does — `{tool, result:
{...}}` — or the agent's own unwrapping misses it. `refusalJson` does this.

## `appointment_reference_unknown` (15 blocked calls, 07-27 → 08-03)

`sage_reschedule`, `sage_confirm_appointment`, `get_appointment_details` and
`cancel_appointment` resolve their target from an ordinal in the
`get_patient_appointments` list **for this call**. Three ways it fails, all
answerable locally because `get_patient_appointments` records `appointmentCount`
in its timeline outcome:

- list never fetched → tell it to call `get_patient_appointments` first
- `appointmentCount: 0` → nothing to act on, **do not retry** (happened 5×)
- ordinal outside `1..count` → name the valid range

## `identity_required` on `sage_handoff` (24 refusals, 07-24 → 08-03)

The catch-22 that made it persistent: **`patient_identity_uncertain` is the reason
you use precisely BECAUSE identity could not be established** — and it was being
refused for want of identity. Call `2a602292` sent it three times and was refused
three times; on 07-27 one call fired seven refused handoffs in 34 seconds. Every
one of these is a caller who asked for a person and got silence.

Two parts to the fix:

1. **`handoffIdentity`** — an unverified call falls back to the name the caller
   already gave this call (`lastIdentityAttempt`). That name failed to *match* a
   record; it is not unknown, and it is exactly what the `patientName` parameter
   exists for. A **verified** call still sends nothing, because the server injects
   the `personId` from its own session — re-sending a name there is the loop the
   param description warns about.
2. **`checkHandoffIdentity`** — the FIRST anonymous attempt is allowed through
   (a refusal noted in `patientResponse` is a legitimate anonymous handoff; do not
   become stricter than the service). The SECOND identical one is blocked locally,
   because the gate is server-side and nothing about the call has changed.

## Gotcha

`azulVerifiedCalls` is populated **before** the `directorEnabledFor` check in
`markDirectorVerified`, on purpose. `DIRECTOR_AGENTS` is a kill switch for the
director; it must not take the handoff identity fallback down with it. Both are
cleared by `releaseAzulCallState`, called from the session cleanup path.
