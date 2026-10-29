-- Additive only. Apply separately to the Hub; NEVER run automatically.
-- No bot scopes, staff permissions, allowlist table or scheduled jobs are added.
ALTER TABLE contact_approvals ADD COLUMN IF NOT EXISTS preapproval_rule JSONB;
CREATE INDEX IF NOT EXISTS idx_contact_approvals_test_preapproval
  ON contact_approvals (approved_at) WHERE approved_by = 'test-preapproval-rule';

-- Invoker authority only. The existing server/owner DB role calls this;
-- API bearer tokens never receive SQL privileges or contacts:approve.
CREATE OR REPLACE FUNCTION approve_operator_test_call(
  p_id TEXT, p_payload_hash TEXT, p_payload JSONB, p_rule JSONB,
  p_max INTEGER, p_since TIMESTAMPTZ, p_now TIMESTAMPTZ,
  p_confirm_hash TEXT, p_confirm_plaintext TEXT, p_confirm_expires TIMESTAMPTZ
) RETURNS SETOF public.contact_approvals
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Count and UPDATE must see prior lock holders' commits. A single SQL CTE
  -- with an advisory lock could retain its pre-lock snapshot and overrun N.
  IF current_setting('transaction_isolation') <> 'read committed'
     OR p_max IS NULL OR p_max < 1 OR p_since IS NULL OR p_now IS NULL OR p_since >= p_now THEN
    RETURN;
  END IF;
  -- Global across all server instances, bots, numbers and scenarios.
  PERFORM pg_advisory_xact_lock(214395, 1);
  IF (SELECT count(*) FROM public.contact_approvals
      WHERE approved_by = 'test-preapproval-rule' AND approved_at > p_since) >= p_max THEN
    RETURN;
  END IF;

  RETURN QUERY UPDATE public.contact_approvals SET
    status = 'approved', approved_by = 'test-preapproval-rule', approved_at = p_now,
    preapproval_rule = p_rule, confirm_token_hash = p_confirm_hash,
    confirm_token_plaintext = p_confirm_plaintext, confirm_expires_at = p_confirm_expires,
    confirm_used_at = NULL, updated_at = p_now
  WHERE id = p_id AND status = 'pending' AND channel = 'call'
    AND payload->>'callKind' = 'operator' AND payload_hash = p_payload_hash AND payload = p_payload
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION approve_operator_test_call(TEXT,TEXT,JSONB,JSONB,INTEGER,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC;

-- Reversal (after disabling the rule):
-- DROP FUNCTION approve_operator_test_call(TEXT,TEXT,JSONB,JSONB,INTEGER,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TIMESTAMPTZ);
-- DROP INDEX idx_contact_approvals_test_preapproval;
-- ALTER TABLE contact_approvals DROP COLUMN preapproval_rule;
