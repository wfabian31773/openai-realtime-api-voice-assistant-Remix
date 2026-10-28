-- Direct-call audit metadata: last four digits and a redacted purpose preview.
-- No scope migration is needed: api_tokens.scopes is an unconstrained TEXT[].
ALTER TABLE plugin_audit_log ADD COLUMN IF NOT EXISTS details JSONB;
