-- Additive and idempotent. Apply separately; never run automatically.
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by VARCHAR
);
-- Reapplying must preserve the staff decision and its audit fields.
INSERT INTO app_settings (key, value)
VALUES ('operator_scenario_preapproval_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- approved_by='scenario_preapproval' and approved_at use existing columns.
ALTER TABLE contact_approvals ADD COLUMN IF NOT EXISTS approval_metadata JSONB;
