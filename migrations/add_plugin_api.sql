-- Plugin API for the SI Assistant (Support Center) to place calls, texts
-- and emails through this fleet. Additive only. DO NOT apply from this
-- change — Wayne applies Hub migrations. Reversal is at the bottom.
--
-- Tables:
--   api_tokens              bearer tokens: jti + sha256(secret) + scopes
--   contact_approvals       pending/approved/sending/rejected/cancelled/committed/failed/unknown
--   plugin_audit_log        append-only, NO phone numbers, bodies or transcripts
--   plugin_message_outbox   taken-message bodies (PHI). Never copy into audit.
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
  phone_key VARCHAR(10),
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
  CONSTRAINT contact_approvals_status_check CHECK (status IN ('pending', 'approved', 'sending', 'rejected', 'cancelled', 'committed', 'failed', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_contact_approvals_status ON contact_approvals (status, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_approvals_ticket ON contact_approvals (ticket_number);
CREATE INDEX IF NOT EXISTS idx_contact_approvals_confirm ON contact_approvals (confirm_token_hash);
CREATE INDEX IF NOT EXISTS idx_contact_approvals_phone_key ON contact_approvals (phone_key);

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

-- Taken-message outbox. The message column is PHI. Retry from this table;
-- never log the body. A persist here is what lets the agent tell the caller
-- the message was taken.
CREATE TABLE IF NOT EXISTS plugin_message_outbox (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid VARCHAR(64),
  ticket_id VARCHAR(64),
  ticket_number VARCHAR(64),
  approval_id VARCHAR(64),
  message TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error VARCHAR(64),
  idempotency_key VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plugin_message_outbox_status_check CHECK (status IN ('pending', 'sending', 'delivered', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_plugin_outbox_due ON plugin_message_outbox (status, next_attempt_at);

-- Upgrade an earlier apply: columns and statuses inside CREATE TABLE IF NOT
-- EXISTS are skipped when the table already exists. These statements are
-- safe to re-run.
ALTER TABLE contact_approvals ADD COLUMN IF NOT EXISTS phone_key VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_contact_approvals_phone_key ON contact_approvals (phone_key);
ALTER TABLE contact_approvals DROP CONSTRAINT IF EXISTS contact_approvals_status_check;
ALTER TABLE contact_approvals ADD CONSTRAINT contact_approvals_status_check
  CHECK (status IN ('pending', 'approved', 'sending', 'rejected', 'cancelled', 'committed', 'failed', 'unknown'));

ALTER TABLE plugin_message_outbox ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_message_outbox_idempotency_key
  ON plugin_message_outbox (idempotency_key);

-- Reversal:
--   DROP TABLE plugin_message_outbox;
--   DROP TABLE plugin_audit_log;
--   DROP TABLE contact_approvals;
--   DROP TABLE api_tokens;
