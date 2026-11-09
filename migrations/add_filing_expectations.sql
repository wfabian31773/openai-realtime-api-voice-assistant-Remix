-- v191: what each call SHOULD have filed, read from its transcript alone.
--
-- Operations Hub (pslzngjciiifowemrzza). The worker creates this table itself
-- on first write (src/services/filingQualityWorker.ts, ENSURE_TABLE_SQL), the
-- pattern daily_grok_costs and call_events already use, so applying this file
-- is optional. It is here so the table's shape is written down and reviewable.
--
-- One row per call. `expectation` is the checked model answer
-- (src/services/filingExpectation.ts, FilingExpectation) or NULL with a
-- `skipped_reason` when the model gave no usable answer. Nothing else in the
-- schema changes; call_logs gains no columns (Drizzle lists every declared
-- column in every insert, so a column declared before its migration breaks
-- every write — the v111 lesson).
--
-- Holds PHI (names and dates of birth as the caller said them), exactly as
-- call_logs.transcript already does. The retention policy that covers
-- call_logs should cover it too.

CREATE TABLE IF NOT EXISTS filing_expectations (
  call_sid TEXT PRIMARY KEY,
  agent_used TEXT,
  call_started_at TIMESTAMPTZ,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  expectation JSONB,
  skipped_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_filing_expectations_started
  ON filing_expectations (call_started_at);

-- Reversal:
--   DROP TABLE IF EXISTS filing_expectations;
