-- ============================================================================
-- add_on_call_rotation.sql — the after-hours on-call rotation (v268)
-- ============================================================================
--
-- Operations Hub (pslzngjciiifowemrzza). NOT APPLIED BY THE REPO. Wayne applies
-- it; until he does, src/runtime/onCall/store.ts reports the rotation as
-- unavailable and every urgent after-hours call takes today's path (the one
-- fixed on-call number). Nothing here is created lazily at runtime.
--
-- Six tables:
--   on_call_providers             who can be on call or escalated to
--   on_call_escalation_directors  region -> its medical director ('FINAL' = Dr. Logan)
--   on_call_schedule              one row per rotation week -> the provider on call
--   on_call_overrides             a swap or cover for a window, wins over the week
--   on_call_escalations           one row per urgent call the chain is working
--   on_call_attempts              one row per call, text or transfer the chain made
--
-- Seed data (providers, directors, the 49 weeks) is NOT in this file: it
-- carries staff phone numbers and emails, which stay out of git. Generate it
-- locally with `npx tsx scripts/on-call-seed.ts <pool.csv> <schedule.csv>`
-- and run the SQL it prints after this file.
--
-- Reversal (only before go-live; it deletes the attempt log):
--   DROP TABLE IF EXISTS on_call_attempts, on_call_escalations,
--     on_call_overrides, on_call_schedule, on_call_escalation_directors,
--     on_call_providers;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS on_call_providers (
  id             SERIAL PRIMARY KEY,
  full_name      TEXT NOT NULL,
  -- Matches si_providers.npi on the Console, which is how a post-op patient's
  -- surgeon is found in this table. NULL for a provider with no NPI on file.
  npi            TEXT UNIQUE,
  -- E.164. The number the chain rings and texts.
  phone          TEXT NOT NULL,
  email          TEXT,
  -- One of the region keys in on_call_escalation_directors.
  region         TEXT NOT NULL,
  -- Position in the rotation. New providers go at the end (MAX + 1). NULL
  -- means not in the weekly rotation (a director who only takes escalations).
  rotation_order INTEGER UNIQUE,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS on_call_escalation_directors (
  -- 'Inland Empire', 'Los Angeles', 'Orange County', 'San Fernando Valley',
  -- 'San Gabriel Valley', 'San Diego', 'Coachella Valley', and 'FINAL'.
  region      TEXT PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES on_call_providers(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS on_call_schedule (
  -- The Tuesday the week starts on. The week runs Tuesday 5:00 PM Pacific to
  -- the next Tuesday 8:00 AM, and weekday daytime (Mon-Fri 8:00 AM-4:59 PM
  -- Pacific) inside it is not on call. A whole-week swap is an UPDATE of
  -- provider_id here; a partial swap is an on_call_overrides row.
  week_starts_on DATE PRIMARY KEY CHECK (EXTRACT(ISODOW FROM week_starts_on) = 2),
  provider_id    INTEGER NOT NULL REFERENCES on_call_providers(id),
  note           TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS on_call_overrides (
  id          SERIAL PRIMARY KEY,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES on_call_providers(id),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS on_call_overrides_window_idx
  ON on_call_overrides (starts_at, ends_at);

CREATE TABLE IF NOT EXISTS on_call_escalations (
  id             SERIAL PRIMARY KEY,
  call_sid       TEXT NOT NULL UNIQUE,
  -- 'live' rings the real providers; 'test' rings ON_CALL_TEST_PHONES.
  mode           TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  status         TEXT NOT NULL CHECK (status IN ('active', 'accepted', 'exhausted', 'cancelled', 'failed')),
  -- Index into plan.levels (0 = on-call or surgeon, 1 = region director, 2 = Dr. Logan).
  level_index    INTEGER NOT NULL DEFAULT 0,
  attempt_no     INTEGER NOT NULL DEFAULT 1,
  -- 'due': the next attempt starts at next_at. 'ringing': a call is out and
  -- next_at is the guard by which its status callback must have arrived.
  phase          TEXT NOT NULL DEFAULT 'due' CHECK (phase IN ('due', 'ringing')),
  next_at        TIMESTAMPTZ,
  level_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Why the first level is who it is (reason: on_call / post_op_surgeon /
  -- post_op_uncertain / holiday_daytime / test_synthetic), the window and the
  -- rotation week it was read from, plus the PHI-free post-op facts.
  routing        JSONB NOT NULL,
  -- The levels, each { role, providerId, name, phone } (phone already the test
  -- phone in test mode). Fixed when the escalation opens.
  plan           JSONB NOT NULL,
  -- The patient details the texts carry. NULLED when the escalation reaches a
  -- terminal status, so the Hub keeps them only while someone is being paged.
  details        JSONB,
  -- The caller's callback number. Nulled with details.
  caller_number  TEXT,
  accepted_by    INTEGER REFERENCES on_call_providers(id),
  accepted_at    TIMESTAMPTZ,
  -- The on_call_attempts row whose call took the patient. No foreign key:
  -- on_call_attempts references this table, so the reference would be
  -- circular. accepted_by alone cannot name the call, because a test-mode
  -- chain's synthetic levels store no provider id.
  accepted_attempt_id INTEGER,
  lease_until    TIMESTAMPTZ,
  version        INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS on_call_escalations_due_idx
  ON on_call_escalations (next_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS on_call_attempts (
  id                SERIAL PRIMARY KEY,
  escalation_id     INTEGER NOT NULL REFERENCES on_call_escalations(id),
  -- The conversation ID: the caller's CallSid, the same key call_logs uses.
  call_sid          TEXT NOT NULL,
  level_index       INTEGER NOT NULL,
  -- on_call / surgeon / region_director / final
  role              TEXT NOT NULL,
  provider_id       INTEGER REFERENCES on_call_providers(id),
  -- warm_transfer (the in-call transfer), call (a background call),
  -- sms (the full-details text), nudge_sms (the retry text)
  kind              TEXT NOT NULL CHECK (kind IN ('warm_transfer', 'call', 'sms', 'nudge_sms')),
  attempt_no        INTEGER NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  -- The number actually rung or texted (the test phone in test mode).
  dialed_to         TEXT,
  -- accepted / no_answer / declined / busy / failed / no_status /
  -- taken_elsewhere (hung up because another of the chain's calls took the
  -- patient) / sent / send_failed / in_progress. 'no_answer' is logged as no answer, not as a
  -- failure, as today's transfer is.
  outcome           TEXT NOT NULL DEFAULT 'in_progress',
  provider_call_sid TEXT,
  sms_sid           TEXT,
  routing_reason    TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS on_call_attempts_call_idx ON on_call_attempts (call_sid, started_at);
CREATE INDEX IF NOT EXISTS on_call_attempts_escalation_idx ON on_call_attempts (escalation_id);

-- Staff data: server role only, like tool_call_payloads.
ALTER TABLE on_call_providers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_call_escalation_directors ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_call_schedule             ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_call_overrides            ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_call_escalations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_call_attempts             ENABLE ROW LEVEL SECURITY;

COMMIT;
