-- Stage C · A6 · Operations Hub (pslzngjciiifowemrzza) · per-call build identity + nightly metric storage
-- Body below copied verbatim from ai-bridge plans/learning-foundation/sql/A6-hub-learning-tables-and-markers.sql
-- (approved by Wayne 2026-10-21). APPLIED BY WAYNE, NOT BY THIS REPO: nothing here runs it.
--
-- ORDER: either order is safe. The writer (src/runtime/buildIdentity.ts) checks information_schema
-- and writes nothing until all three columns exist, re-checking every ten minutes, so a publish
-- before this migration stamps nothing and one after it starts stamping without a republish.
-- The columns are deliberately NOT declared in shared/schema.ts: Drizzle lists every declared
-- column in every insert and select, so declaring them before they exist would break every
-- call_logs read and write.
--
-- PRE-CHECK:  SELECT column_name FROM information_schema.columns
--             WHERE table_schema='public' AND table_name='call_logs'
--               AND column_name IN ('runtime_marker','build_sha','voice_model');   -- expect 0 rows
--             SELECT to_regclass('public.learning_runs'), to_regclass('public.learning_metric_values'); -- expect NULL, NULL
-- POST-CHECK: the first query returns 3 rows, all data_type text, is_nullable YES; both regclasses non-NULL.
--
-- STATUS: DRAFT FOR REVIEW. NOT APPLIED. Wayne approves before anyone runs it.
-- Observed 2026-10-21: call_logs has voice_provider but no runtime_marker, build_sha or voice_model;
-- learning_runs / learning_metric_values do not exist.
-- All changes are additive: nullable columns, new tables. No existing reader changes.
-- Writing the two columns is a separate code PR in the Remix repo (VOICE_RUNTIME_DEPLOY_MARKER
-- and the lane's voice model, set when the row opens).

BEGIN;

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS runtime_marker text;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS voice_model    text;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS build_sha      text;
COMMENT ON COLUMN public.call_logs.runtime_marker IS 'Deploy marker of the build that served this call (learning foundation A6). NULL before the writer shipped.';
COMMENT ON COLUMN public.call_logs.build_sha      IS 'Git SHA of the deployed bundle that served this call, written at build time (learning foundation A6). NULL = unknown, never a guess.';
COMMENT ON COLUMN public.call_logs.voice_model    IS 'Voice model the session opened with (learning foundation A6). NULL before the writer shipped.';

CREATE TABLE IF NOT EXISTS public.learning_runs (
  id            bigserial PRIMARY KEY,
  run_date      date        NOT NULL,           -- the day measured (America/Los_Angeles)
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text        NOT NULL CHECK (status IN ('running','ok','partial','failed')),
  method_version text       NOT NULL,           -- the metric code version; VERIFY refuses a mismatch
  notes         text,
  UNIQUE (run_date, method_version)
);

CREATE TABLE IF NOT EXISTS public.learning_metric_values (
  run_id        bigint      NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  metric_id     text        NOT NULL,           -- e.g. remix.filed_rate, 5star.booked_rate_a
  repo          text        NOT NULL CHECK (repo IN ('Remix','5Star')),
  lane          text        NOT NULL,
  runtime_marker text        NOT NULL DEFAULT '', -- '' = unknown build, reported as such (part of the key)
  numerator     integer     NOT NULL CHECK (numerator >= 0),
  denominator   integer     NOT NULL CHECK (denominator >= 0),
  unknown_count integer     NOT NULL DEFAULT 0, -- e.g. UNKNOWN provenance; never folded into a bucket
  PRIMARY KEY (run_id, metric_id, repo, lane, runtime_marker)
);

ALTER TABLE public.learning_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_metric_values ENABLE ROW LEVEL SECURITY;
-- No policies: only the app owner (the fleet process) reads and writes. No PHI in either table.

COMMIT;

-- ROLLBACK:
-- BEGIN;
--   DROP TABLE IF EXISTS public.learning_metric_values;
--   DROP TABLE IF EXISTS public.learning_runs;
--   ALTER TABLE public.call_logs DROP COLUMN IF EXISTS build_sha;
--   ALTER TABLE public.call_logs DROP COLUMN IF EXISTS voice_model;
--   ALTER TABLE public.call_logs DROP COLUMN IF EXISTS runtime_marker;
-- COMMIT;
-- Dropping the two columns loses any markers written since; take a count first.
