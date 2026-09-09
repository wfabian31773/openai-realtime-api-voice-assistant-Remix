-- 2026-09-09: the tool ceiling's own stops were uncountable.
--
-- `ToolCallCeiling` short-circuits BEFORE dispatch, so `wrapWithTelemetry`
-- never runs and a stopped dispatch reaches neither `tool_timeline` nor
-- `tool_call_count`. The `[TOOL CEILING]` marker is console-only. That left
-- the SQL check able to infer a stop only from a call sitting exactly ON
-- `perCallDispatches` (40) — and that inference is blind to the two limits
-- that fire far below it, `identicalFailures` (3) and `perToolFailures` (6).
--
-- Measured the same day: five calls sat at exactly 40, every one a runaway
-- loop that was contained and never appeared in monitoring, and
-- `tool_call_count` is NULL on 422 of 1,174 grok calls, so a check built on
-- that column is blind to about a third of the population at any threshold.
--
-- Written by the runtime at teardown for EVERY call it records, zero
-- included: 0 means "the ceiling did not fire", which is the fact that makes
-- the column countable. NULL therefore means only "this row predates the
-- column" (or was not written by the runtime).
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ceiling_stops INTEGER;

COMMENT ON COLUMN call_logs.ceiling_stops IS
  'Tool dispatches the runtime ceiling REFUSED on this call (src/runtime/toolCeiling.ts). Never dispatched, so absent from tool_timeline and tool_call_count. 0 = the ceiling did not fire; NULL = row predates the column or was not written by the runtime.';

-- Calls where the ceiling did work, countable at last. Compare with the
-- tool_call_count >= 40 check in CLAUDE.md: this one also sees the
-- identical-args and same-tool stops, which never reach 40.
-- SELECT call_sid, agent_used, ceiling_stops, tool_call_count
--   FROM call_logs
--  WHERE voice_provider = 'grok' AND ceiling_stops > 0
--  ORDER BY ceiling_stops DESC;
