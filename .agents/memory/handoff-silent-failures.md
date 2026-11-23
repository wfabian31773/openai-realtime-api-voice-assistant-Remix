---
name: Handoff silent failures
description: Urgent transfer SMS only fires on a successful clinical handoff; blocked handoffs must surface as tool failures, never silent success.
---

**Rule:** Any callback wrapping the human-handoff path must propagate a non-ok outcome (throw or explicit failure result) to the agent's tool, and error text sent to the model must be a fixed status code — the detailed reason may contain raw provider errors and stays in server logs.

**Why:** On 2026-08-03/04 "missing after-hours SMS" turned out to be zero successful clinical transfers, and the one attempt was blocked by the handoff policy gate while the tool still returned success — the caller was told "transferring you now" with no dial and no SMS.

**How to apply:** When debugging "urgent SMS stopped": the SMS is sent only inside a successful `addHumanAgent` clinical (non-PCP) handoff. Check (1) successful transfers to the clinical on-call number in `call_logs` (`transferred_to_human`, `human_agent_number`), (2) escalate tool attempts in `tool_timeline`, (3) whether the handoff policy gate blocked them (needs allowed callerType + configured number). Clinical transfer volume is low (~1-6/day), so a day with zero can be normal variance.

**From v268 (dark until `ON_CALL_ROTATION_MODE` is set) the no-ivr lane's urgent transfer can also go through the on-call rotation, and that path sends a text of its own.** The provider being rung gets one text before each level's first call and a reminder text before the second. Those texts come from `ON_CALL_CALLER_ID`. The text to `URGENT_NOTIFICATION_NUMBER` is unchanged and still goes out. So "the provider never got the text" is read from `on_call_attempts` (`kind` = `sms` or `nudge_sms`, `outcome` = `sent` or `send_failed`, `sms_sid`) by the caller's CallSid, not from the old clinical-transfer columns. A rotation that turned itself off says why on `/voice/health` `onCall.disabledBecause`, and the call then rang `HUMAN_AGENT_NUMBER`. See `on-call-rotation.md`.
