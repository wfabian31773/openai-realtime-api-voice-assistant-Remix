-- Migration: Add replay/backfill safety columns
-- Date: 2026-02-16
-- Purpose: Prevent double-application of costs/grades during reruns

ALTER TABLE daily_reconciliation 
  ADD COLUMN IF NOT EXISTS processed_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS processed_at timestamp DEFAULT NOW();

ALTER TABLE daily_org_usage
  ADD COLUMN IF NOT EXISTS processed_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS processed_at timestamp DEFAULT NOW();

ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS grader_version integer DEFAULT NULL;
