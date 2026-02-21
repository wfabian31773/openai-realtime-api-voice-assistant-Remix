-- Migration: Add DB-level handoff state machine constraints
-- Date: 2026-02-16
-- Purpose: Enforce valid state transitions at the database level (not just app logic)

-- 1. Trigger function to validate state transitions
CREATE OR REPLACE FUNCTION validate_handoff_transition()
RETURNS TRIGGER AS $$
DECLARE
  valid_transitions text[];
  terminal_states text[] := ARRAY['answered', 'voicemail', 'failed', 'blocked_policy', 'completed', 'timeout'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state = ANY(terminal_states) THEN
    RAISE EXCEPTION 'Cannot transition from terminal state "%" to "%"', OLD.state, NEW.state;
  END IF;

  CASE OLD.state
    WHEN 'requested' THEN valid_transitions := ARRAY['dialing', 'blocked_policy', 'failed'];
    WHEN 'dialing' THEN valid_transitions := ARRAY['initiated', 'failed'];
    WHEN 'initiated' THEN valid_transitions := ARRAY['ringing', 'answered', 'failed', 'timeout', 'completed'];
    WHEN 'ringing' THEN valid_transitions := ARRAY['answered', 'failed', 'timeout', 'completed', 'voicemail'];
    WHEN 'answered' THEN valid_transitions := ARRAY['completed'];
    ELSE valid_transitions := ARRAY[]::text[];
  END CASE;

  IF NOT (NEW.state = ANY(valid_transitions)) THEN
    RAISE EXCEPTION 'Invalid handoff transition: "%" -> "%" (valid: %)', OLD.state, NEW.state, array_to_string(valid_transitions, ', ');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Trigger on handoff_states table
DROP TRIGGER IF EXISTS trg_validate_handoff_transition ON handoff_states;
CREATE TRIGGER trg_validate_handoff_transition
  BEFORE UPDATE ON handoff_states
  FOR EACH ROW
  EXECUTE FUNCTION validate_handoff_transition();

-- 3. Unique constraint: only one terminal state per call_log_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_handoff_terminal_per_call 
ON handoff_states (call_log_id) 
WHERE state IN ('answered', 'voicemail', 'failed', 'blocked_policy', 'completed', 'timeout')
AND call_log_id IS NOT NULL;
