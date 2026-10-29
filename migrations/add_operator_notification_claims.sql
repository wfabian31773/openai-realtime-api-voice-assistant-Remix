-- Additive and idempotent. Apply separately; never run automatically.
CREATE TABLE IF NOT EXISTS plugin_operator_notifications (
  event_id VARCHAR PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Rotated on every claim/reclaim to fence off abandoned workers.
  claim_token VARCHAR NOT NULL,
  -- NULL while in-flight; set only after a 2xx delivery response.
  delivered_at TIMESTAMPTZ
);
ALTER TABLE plugin_operator_notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE contact_approvals ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200);
-- Rejected/cancelled requests may reuse a key; every other status retains it,
-- including failed/unknown sends whose outcome must never be retried here.
CREATE UNIQUE INDEX IF NOT EXISTS contact_approvals_token_idempotency_idx
  ON contact_approvals (token_jti, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status NOT IN ('rejected', 'cancelled');
