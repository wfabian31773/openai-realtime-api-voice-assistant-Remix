---
name: Handoff silent failures
description: Urgent transfer SMS only fires on a successful clinical handoff; blocked handoffs must surface as tool failures, never silent success.
---

**Rule:** Any callback wrapping the human-handoff path must propagate a non-ok outcome (throw or explicit failure result) to the agent's tool, and error text sent to the model must be a fixed status code — the detailed reason may contain raw provider errors and stays in server logs.

**Why:** On 2026-08-03/04 "missing after-hours SMS" turned out to be zero successful clinical transfers, and the one attempt was blocked by the handoff policy gate while the tool still returned success — the caller was told "transferring you now" with no dial and no SMS.

**How to apply:** When debugging "urgent SMS stopped": the SMS is sent only inside a successful `addHumanAgent` clinical (non-PCP) handoff. Check (1) successful transfers to the clinical on-call number in `call_logs` (`transferred_to_human`, `human_agent_number`), (2) escalate tool attempts in `tool_timeline`, (3) whether the handoff policy gate blocked them (needs allowed callerType + configured number). Clinical transfer volume is low (~1-6/day), so a day with zero can be normal variance.
