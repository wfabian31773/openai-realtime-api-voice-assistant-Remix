---
name: SIP recovery vs deliberate hangup
description: Why terminated OpenAI SIP legs must not be treated as failures — deliberate hangups leave the Twilio caller leg up.
---

The OpenAI realtime `/hangup` endpoint ends only the AI's SIP leg. The Twilio caller leg is a separate conference participant and stays connected until someone hangs it up. Every deliberate session end (terminate_call tools, dead-air watchdog, new-core wrap hangup) therefore leaves a lingering caller leg, and SIP recovery used to interpret that as "assistant crashed mid-call" and warm-transfer finished ghost calls to the on-call number (~8 false TECH FALLBACK transfers/day, Aug 6–10 2026 — transcripts all ended in a goodbye).

**Rule:** every deliberate hangup must call `markCallConcluded` (services/callConclusion.ts) — but ONLY after the hangup succeeds (`response.ok`) and after any escalation guard. `recoverCallerAfterSipTermination` checks the conclusion and hangs up the lingering caller leg instead of transferring.

**Why the alias:** recovery runs ~750ms after the SIP status callback, by which time teardown may have deleted the live conference→callId maps, so `linkConferenceToCall` records a durable alias at session creation.

**How to apply:** any new code path that ends an OpenAI session on purpose must mark conclusion on success; never mark on generic transport close (that would swallow real crashes). State is process-local — revisit if the voice server ever runs multiple instances.

**Operator policy (2026-08-11, explicit and repeated):** ONLY truly urgent calls may ring the on-call personal phone. All tech-fallback paths (mid-call SIP loss, never-connected watchdog, accept failure) transfer + SMS only when `escalationDetailsMap` has an entry for the call (escalate_to_human fired); otherwise apologize + hang up, no SMS, no dial. Do not add new paths that dial HUMAN_AGENT_NUMBER without an established escalation.
