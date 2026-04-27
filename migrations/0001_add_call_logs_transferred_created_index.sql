-- Migration: add composite index on call_logs for urgent call lookups
-- The /api/call-logs/urgent endpoint filters by transferred_to_human = true
-- AND created_at >= (now - 90 days). This composite index lets the planner
-- satisfy both conditions from a single index scan instead of a full table scan.
--
-- CONCURRENTLY: builds the index without locking writes, safe on live databases.
--   NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
--   Run this migration outside of a transaction (e.g. with autocommit=true or
--   outside a BEGIN/COMMIT block).
-- IF NOT EXISTS: idempotent, safe to re-run on databases already up to date.
--
-- Performance verification (EXPLAIN ANALYZE on the urgent calls query):
--   Index Scan Backward using idx_call_logs_transferred_created on call_logs
--     Index Cond: ((transferred_to_human = true) AND (created_at >= (now() - '90 days'::interval)))
--     Buffers: shared read=2
--   Execution Time: 0.130 ms   (vs full sequential scan as table grows)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_call_logs_transferred_created
  ON call_logs (transferred_to_human, created_at);
