-- Additive only. Do not run automatically; apply separately to the Hub.
-- Existing approval rows use channel='call', payload.callKind='operator'.
-- Scripts stay in the approved payload; transcripts never enter audit logs.
CREATE TABLE IF NOT EXISTS plugin_operator_calls (
  session_id VARCHAR(64) PRIMARY KEY,
  approval_id VARCHAR(64) NOT NULL,
  token_jti VARCHAR(32) NOT NULL,
  call_sid VARCHAR(64),
  status VARCHAR(24) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  turns JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- US targets continue to use the existing voice/SMS do_not_contact lists.
CREATE TABLE IF NOT EXISTS plugin_operator_dnc (
  phone VARCHAR(16) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE plugin_operator_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_operator_dnc ENABLE ROW LEVEL SECURITY;
