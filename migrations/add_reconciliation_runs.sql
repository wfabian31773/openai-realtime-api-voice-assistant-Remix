-- Migration: Add reconciliation_runs audit log table
-- Date: 2026-04-27
-- Purpose: Persist a history of every automatic and manual reconciliation run
--          (when it ran, what date it covered, whether it succeeded, and any error message)

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMP NOT NULL DEFAULT NOW(),
  triggered_by VARCHAR NOT NULL DEFAULT 'auto',
  date_reconciled DATE NOT NULL,
  success BOOLEAN NOT NULL,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_run_at ON reconciliation_runs(run_at);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_date ON reconciliation_runs(date_reconciled);
