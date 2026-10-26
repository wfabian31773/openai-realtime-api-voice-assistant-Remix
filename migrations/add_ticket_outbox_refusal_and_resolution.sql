-- 2026-09-25: a 400/422 dead letter is a request a staffer must follow up,
-- not proof that filing has stopped.
--
-- Measured that evening: three ticket_outbox rows were dead-lettered by
-- terminal payload refusals (office / surgeon) after the ticketing app
-- recovered. assessTicketFiling treated ANY dead_letter as a stall, so
-- ticket_filing_stalled re-emailed every five minutes while tickets were
-- still filing 1–4 minutes before each alert. Same false-alarm shape as
-- 2026-09-02.
--
-- refusal_status_code is written ONLY when markFailed(terminal=true) has
-- an enumerated payload-refusal status (400, 422). It is never inferred
-- from last_error. Existing dead letters stay NULL — they keep counting
-- as transport until a human resolves them. This migration does NOT
-- backfill, auto-resolve, or UPDATE any row.
--
-- Reversal:
--   ALTER TABLE ticket_outbox DROP COLUMN IF EXISTS resolution_note;
--   ALTER TABLE ticket_outbox DROP COLUMN IF EXISTS resolved_by;
--   ALTER TABLE ticket_outbox DROP COLUMN IF EXISTS resolved_at;
--   ALTER TABLE ticket_outbox DROP COLUMN IF EXISTS followup_notified_at;
--   ALTER TABLE ticket_outbox DROP COLUMN IF EXISTS refusal_status_code;
--   DROP INDEX IF EXISTS idx_ticket_outbox_unresolved_dead_letter;

ALTER TABLE ticket_outbox ADD COLUMN IF NOT EXISTS refusal_status_code integer;
ALTER TABLE ticket_outbox ADD COLUMN IF NOT EXISTS followup_notified_at timestamp;
ALTER TABLE ticket_outbox ADD COLUMN IF NOT EXISTS resolved_at timestamp;
ALTER TABLE ticket_outbox ADD COLUMN IF NOT EXISTS resolved_by varchar;
ALTER TABLE ticket_outbox ADD COLUMN IF NOT EXISTS resolution_note text;

COMMENT ON COLUMN ticket_outbox.refusal_status_code IS
  'HTTP status when the ticketing app read the payload and refused it (400 or 422). NULL on a transport dead letter and on every row still retrying. The filing alarm treats only NULL (or a non-payload status) dead letters as a stall.';

COMMENT ON COLUMN ticket_outbox.followup_notified_at IS
  'When the one-shot ticket_needs_followup email was sent for this row. Set only after a successful send (or claimed then cleared on send failure). A row is notified at most once.';

COMMENT ON COLUMN ticket_outbox.resolved_at IS
  'When an admin marked this dead letter handled. Resolved rows are excluded from the stall alarm and from the follow-up notice. Nothing in this migration sets it.';

CREATE INDEX IF NOT EXISTS idx_ticket_outbox_unresolved_dead_letter
  ON ticket_outbox (status)
  WHERE status = 'dead_letter' AND resolved_at IS NULL;
