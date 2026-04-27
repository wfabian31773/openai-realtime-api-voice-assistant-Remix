ALTER TABLE daily_reconciliation
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
