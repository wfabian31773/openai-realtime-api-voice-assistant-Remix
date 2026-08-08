# Call state — one normalized view, and the invariants over it

`src/services/callState.ts`. A **projection**: one state object per call, updated
by normalized events, readable at any instant, and the thing invariants are
checked against.

It does **not** replace the ~20 Maps that drive behaviour (director ledger, loop
guard, identity guard, tool timeline, …). Ripping those out live on a PHI system
is the change that has already gone wrong twice here. This is the thing you
**read**; those are still the things that **run**.

## Why it exists

Three wrong conclusions in the 2026-08-04/05 review came from state being
unreadable mid-call: tool-using calls reading as "No tools used", a director loop
audible in the transcript but absent from its telemetry, and a deploy read as
not-live off stale rows. In every case the behaviour was fine and the visibility
was not.

## The authoritative-identity rule

`verify_patient_identity` succeeding is a FACT from the Eye Care service, which
holds the personId. It enters as ONE event, emitted in `azulSchedulingAgent`:

```ts
{ type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true }
```

Nothing downstream re-derives it from the transcript. That inference is exactly
what interrupted 22 of 54 verified callers on 08-03. A verified match **is** an
existing patient — the lookup routes, not the caller's memory.

## Invariants

An invariant is a rule the agent cannot violate, evaluated against state rather
than hoped for in a prompt. `INVARIANTS` is a declarative table: `when(state)`
plus the ask topics it `prohibits`. Currently:

- **`identity_reasked_after_verification`** — once verified, `existing patient`,
  `date of birth`, `last name`, `first name` and `full name` are CLOSED.
  `IDENTITY_INVALIDATED` is the only thing that reopens them.
- **`patient_type_asked_at_all`** — once `verify_patient_identity` has succeeded,
  never ask new-vs-existing.

Topics use the same strings `conversationLoopGuard` classifies to, so the panel's
ask counts and the director's escalation can never drift apart.

**Violations are recorded, not enforced.** The reducer names them and the panel
shows them in red; the director's existing ladder does the enforcing. A new rule
that cancels turns is the shape that cost 48 calls on 08-03 — earn the
enforcement with observed data first.

## Reading it

```
GET /api/voice/call-state/:idOrSid     (authenticated)
```

Accepts the OpenAI callId, Twilio callSid, or callLogId. Returns `{state,
snapshots, redacted}`. `snapshots` is the per-turn record — for each agent
response, the state that produced it plus the director decision and any
violation. `state.seq` is monotonic, so a client can skip unchanged polls.

The SD Pilot live card renders it beside the transcript (`CallStatePanel`,
2s poll).

## PHI

The endpoint is authenticated and returns real names and dates of birth, because
judging a call requires seeing whether the surname was heard correctly. With
`DISABLE_PHI_LOGGING=true` (production default) it returns `redactState` instead
— shapes and counts, values gone — matching what `SAFE_ARG_KEYS` already enforces
on the tool timeline. `stateLogLine`, used for the per-turn server log, never
carries values at all. Keep it that way.

## Extending it

Add an event to `CallStateEvent`, handle it in `reduce`, and it appears
everywhere at once. `reduce` is pure — same state plus event gives the same next
state — so a call can be replayed from its events and compared. The tests do
exactly that with the verified-then-re-asked scenario.
