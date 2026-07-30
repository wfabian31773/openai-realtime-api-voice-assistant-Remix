-- 2026-07-30: the office leg of a warm transfer is a separate Twilio call and
-- nothing recorded its outcome. answered_by / machine_detection_duration are
-- NULL on every row and describe the INBOUND call, not the office we dialed.
-- Without this, "did Encinitas actually get the call?" cannot be answered from
-- the database at all — which is why a routing bug (Oceanside calls labelled
-- Encinitas) was found by an office manager instead of a dashboard.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transfer_outcome jsonb;

COMMENT ON COLUMN call_logs.transfer_outcome IS
  'Office-leg result of a warm transfer, written from the warm-transfer accept/status webhooks. Keys: officeCallSid, dialedNumber, queueLabel, outcome (accepted|no_answer|busy|failed|canceled|machine), acceptMethod (keypress|stay_on_line|null), amdVerdict, ringSeconds, at. NULL when the call never attempted a transfer.';
