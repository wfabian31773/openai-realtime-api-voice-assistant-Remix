-- v238 (2026-11-14): every tool call's full arguments and result, kept apart
-- from call_logs.tool_timeline. Operator, 2026-11-14: tracking the tools'
-- arguments, approved with 30 days' retention and admins only.
--
-- DOCUMENTATION ONLY. The writer (src/services/toolPayloads.ts,
-- hubToolPayloadStore.ensure) creates this on its first write with
-- CREATE TABLE IF NOT EXISTS, the call_events pattern, so nothing needs to be
-- applied. Kept here so the schema is readable in one place.
--
-- Row-level security is on with NO policy: only the server's own role reads
-- it. The one reader is GET /api/call-logs/:id/tool-payloads (admin-only).
-- The writer deletes rows older than 30 days, at most once an hour.

CREATE TABLE IF NOT EXISTS tool_call_payloads (
  id BIGSERIAL PRIMARY KEY,
  call_id VARCHAR NOT NULL,
  call_sid VARCHAR,
  call_log_id VARCHAR,
  agent_slug VARCHAR,
  seq INTEGER NOT NULL,          -- the event's index in the call's tool timeline
  tool VARCHAR(80) NOT NULL,
  event_at TEXT NOT NULL,        -- the timeline event's own `at`, byte for byte
  at TIMESTAMPTZ NOT NULL,
  ms INTEGER,
  args JSONB,                    -- scrubbed of credentials, capped at 16,000 chars
  result JSONB,                  -- scrubbed of credentials, capped at 32,000 chars
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tool_call_payloads_call_sid_idx ON tool_call_payloads (call_sid);
CREATE INDEX IF NOT EXISTS tool_call_payloads_call_log_id_idx ON tool_call_payloads (call_log_id);
CREATE INDEX IF NOT EXISTS tool_call_payloads_created_at_idx ON tool_call_payloads (created_at);
ALTER TABLE tool_call_payloads ENABLE ROW LEVEL SECURITY;

-- Reversal: DROP TABLE tool_call_payloads;  (and set TOOL_PAYLOADS_DISABLED=1
-- first, or the next tool call creates it again)
