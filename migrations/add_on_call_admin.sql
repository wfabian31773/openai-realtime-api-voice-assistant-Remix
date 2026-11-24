-- ============================================================================
-- add_on_call_admin.sql — the After-Hours On-Call admin page (/on-call)
-- ============================================================================
--
-- Operations Hub (pslzngjciiifowemrzza). NOT APPLIED BY THE REPO. Wayne applies
-- it, AFTER migrations/add_on_call_rotation.sql (it adds nothing that refers to
-- those tables by foreign key, but the page is useless without them).
--
-- Until this file is applied the page still reads the rotation (who is on
-- call, the schedule, the calls) but REFUSES every change, because every
-- change the page makes writes its audit row in the same transaction and there
-- is nowhere to write it. The page says so in a banner.
--
-- Two tables:
--   on_call_audit_log   one row per change made from the admin page: who, what,
--                       the row before and after, and the reason (required).
--   on_call_call_events a PLACEHOLDER for per-call facts the voice runtime does
--                       not record yet (a provider's post-call note, SMS
--                       delivery callbacks, keypress detail). NOTHING WRITES IT
--                       YET: no code under src/runtime/ inserts here. The page
--                       reads it and labels the section "placeholder".
--
-- Changes made with scripts/on-call-change.ts (SQL run by hand) are NOT in the
-- audit log.
--
-- Reversal (deletes the audit history):
--   DROP TABLE IF EXISTS on_call_call_events, on_call_audit_log;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS on_call_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id TEXT,
  actor_email   TEXT,
  -- e.g. schedule.swap_week, override.create, provider.update, director.set
  action        TEXT NOT NULL,
  -- provider / schedule / override / director
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before        JSONB,
  after         JSONB,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS on_call_audit_log_created_idx ON on_call_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS on_call_audit_log_entity_idx ON on_call_audit_log (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS on_call_call_events (
  id            BIGSERIAL PRIMARY KEY,
  -- The caller's CallSid, the key call_logs and on_call_attempts use.
  call_sid      TEXT NOT NULL,
  escalation_id INTEGER,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- e.g. twilio_sms_status, provider_keypress, provider_note
  source        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  -- PHI-free detail only: statuses, codes, durations. Never a patient name.
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS on_call_call_events_call_idx ON on_call_call_events (call_sid, at);

-- Staff data: server role only, like the rotation tables.
ALTER TABLE on_call_audit_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_call_call_events ENABLE ROW LEVEL SECURITY;

COMMIT;
