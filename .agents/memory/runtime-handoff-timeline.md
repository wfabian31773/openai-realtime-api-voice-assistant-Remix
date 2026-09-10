---
name: Runtime handoff timeline flush
description: Successful PCP blind transfers must persist tool_timeline the same way failures do; the runtime used to drop the flush when the redirect ended the stream.
---

**Rule:** A runtime tool that settles must flush `call_logs.tool_timeline` and `tool_call_count` even if the call has already ended. Do not gate that flush on `!this.ended`. On a successful transfer, also fill `human_agent_number` from `transfer_outcome.dialedNumber` when the column is null.

**Why:** After #273 (PCP blind/queue transfer), CA41b1e1255bc1031612ddc6d47d2502a6 (PCP-57964) recorded a solid `transfer_outcome` (`method=blind`, `queue_answered`, `dialedNumber` set, `talkSeconds=93`) and left `tool_timeline` / `tool_call_count` / `human_agent_number` NULL. The morning failure the same day had `handoff_to_pcp` events.

The agents' `recordingExecute` only records in memory. Queue tools on SIP flush per-tool (`realtimeAdapter.flushTimelineSafely`); SIP teardown flushes again (`voiceAgentRoutes`). The Grok runtime did neither. Blind success makes that unrecoverable without an after-ended flush: `performBlindTransfer` redirects, the Media Stream dies, teardown runs, and `handleToolCall` used to `return` on `this.ended` after dispatch — so the handoff event was recorded in memory and never written. Failures stay on the call, so the 2h reaper eventually persisted them.

**How to apply:** `VoiceCallBridge` takes `flushTimeline` (wired to `flushAzulTimeline` in `voiceRuntime.ts`). It fires after every settled dispatch and once at teardown. `persistTransferOutcome` COALESCE-fills `human_agent_number` from `dialedNumber` on `accepted` / `handed_to_queue` / `queue_answered` only. Do not change the Dial. Marker: `voice-runtime-v5-handoff-timeline-20260908`.
