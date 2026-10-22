-- Plugin API for the SI Assistant (Support Center) to place calls, texts
-- and emails through this fleet. Additive only. DO NOT apply from this
-- change — Wayne applies Hub migrations. Reversal is at the bottom.
--
-- Tables:
--   api_tokens          bearer tokens: jti + sha256(secret) + scopes
--   contact_approvals   pending/approved/rejected/committed contact requests
--   plugin_audit_log    append-only, NO phone numbers, bodies or transcripts
--
-- The plaintext token is printed once at mint. Only the hash is stored.

CREATE TABLE IF NOT EXISTS api_tokens (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  jti VARCHAR(32) NOT NULL,
  hashed_secret VARCHAR(64) NOT NULL,
  label VARCHAR(128),
  scopes TEXT[] NOT NULL DEFAULT ARRAY['fleet:read']::text[],
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT api_tokens_jti_key UNIQUE (jti)
);

CREATE TABLE IF NOT EXISTS contact_approvals (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel VARCHAR(16) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  token_jti VARCHAR(32) NOT NULL,
  ticket_id VARCHAR(64),
  ticket_number VARCHAR(64),
  -- Bound payload for execution. Never written to plugin_audit_log or logs.
  payload JSONB NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  confirm_token_hash VARCHAR(64),
  confirm_expires_at TIMESTAMPTZ,
  confirm_used_at TIMESTAMPTZ,
  approved_by VARCHAR(64),
  approved_at TIMESTAMPTZ,
  rejected_by VARCHAR(64),
  rejected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  -- Non-PHI result only: provider ids, status codes. No phones or bodies.
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_approvals_channel_check CHECK (channel IN ('call', 'sms', 'email')),
  CONSTRAINT contact_approvals_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'committed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_contact_approvals_status ON contact_approvals (status, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_approvals_ticket ON contact_approvals (ticket_number);
CREATE INDEX IF NOT EXISTS idx_contact_approvals_confirm ON contact_approvals (confirm_token_hash);

CREATE TABLE IF NOT EXISTS plugin_audit_log (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  token_jti VARCHAR(32) NOT NULL,
  tool VARCHAR(64) NOT NULL,
  route VARCHAR(256) NOT NULL,
  method VARCHAR(8) NOT NULL,
  approval_id VARCHAR(64),
  ticket_id VARCHAR(64),
  outcome VARCHAR(32) NOT NULL,
  http_status INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_audit_created ON plugin_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_audit_jti ON plugin_audit_log (token_jti);

-- Reversal:
--   DROP TABLE plugin_audit_log;
--   DROP TABLE contact_approvals;
--   DROP TABLE api_tokens;
