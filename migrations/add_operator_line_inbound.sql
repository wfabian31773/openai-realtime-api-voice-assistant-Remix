-- Additive and idempotent. Apply separately; never run automatically.
-- Inbound calls have no outbound approval/token owner or patient/ticket fields.
CREATE TABLE IF NOT EXISTS plugin_operator_inbound_calls (
  call_id UUID NOT NULL UNIQUE,
  call_sid VARCHAR(64) PRIMARY KEY,
  lane_slug VARCHAR(64) NOT NULL DEFAULT 'wayne-operator' CHECK (lane_slug = 'wayne-operator'),
  direction VARCHAR(8) NOT NULL DEFAULT 'inbound' CHECK (direction = 'inbound'),
  caller_number VARCHAR(16),
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  turns JSONB NOT NULL DEFAULT '[]'::jsonb,
  queued_requests JSONB NOT NULL DEFAULT '[]'::jsonb,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  transcript_url TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_operator_inbound_started_idx ON plugin_operator_inbound_calls (started_at DESC);
ALTER TABLE plugin_operator_inbound_calls ENABLE ROW LEVEL SECURITY;

-- This migration is not yet applied. Operator outbound provenance is part of
-- the durable call log as well as the locked contact_approvals payload.
ALTER TABLE plugin_operator_calls
  ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(16) NOT NULL DEFAULT 'bot_initiative'
    CHECK (initiated_by IN ('owner_request', 'bot_initiative'));
