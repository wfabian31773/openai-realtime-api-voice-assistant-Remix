-- Migration: Make daily reconciliation idempotent by date
-- Date: 2026-08-04
-- Purpose: PostgreSQL requires a unique or exclusion constraint for
--          ON CONFLICT (date_utc). The ordinary date index does not qualify.
--
-- Production preflight on 2026-08-04 confirmed that the table contained no
-- duplicate dates (and no rows), so this index is safe to create directly.

CREATE UNIQUE INDEX IF NOT EXISTS daily_reconciliation_date_utc_unique
  ON public.daily_reconciliation (date_utc);

-- Forward-only production rollback, if ever required:
-- DROP INDEX IF EXISTS public.daily_reconciliation_date_utc_unique;
