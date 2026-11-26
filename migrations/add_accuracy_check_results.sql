-- add_accuracy_check_results.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The accuracy check's history (server/accuracy/accuracy.ts), 2026-11-26.
--
-- THE APP CREATES THIS TABLE ITSELF on its first run (CREATE TABLE IF NOT
-- EXISTS, the call_events pattern), so nobody has to run this file for the
-- feature to work. It is here so the table is written down where every other
-- table is, and so it can be created ahead of time or recreated by hand.
--
-- One row per check per run: which check, whether the screen's number matched
-- the call records, the two numbers and the one-sentence note. No patient data
-- is in any check, so none is in this table. The run deletes rows older than
-- 90 days.
--
-- Reversal: DROP TABLE accuracy_check_results;
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accuracy_check_results (
  id            BIGSERIAL PRIMARY KEY,
  ran_at        TIMESTAMPTZ NOT NULL,
  check_id      TEXT NOT NULL,
  status        TEXT NOT NULL,          -- pass | fail | unknown
  screen_value  DOUBLE PRECISION,
  truth_value   DOUBLE PRECISION,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS accuracy_check_results_check_ran
  ON accuracy_check_results (check_id, ran_at DESC);
