-- 2026-08-12: one flag was doing two jobs, and the difference cost 37% of
-- tickets their call details.
--
-- `ticketing_synced` is set when the TICKET is created — during the call, by
-- releaseTicketCreationLock. The transcript, recording and duration only exist
-- AFTER the call ends. The sweeper selected on `ticketing_synced`, so every
-- call that filed a ticket was permanently excluded from sweeping before its
-- data existed — precisely the population that needs it — and the single
-- post-call push has no retry, so one transient failure lost the data for good.
--
-- Measured over 30 consecutive calls: we held a transcript for 30/30, the
-- ticket had one for 19/30. VA-50786 is the shape of it — ticketing_synced
-- true, retries 0, and a 3,443-character transcript the optician never saw.
ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS call_data_synced boolean NOT NULL DEFAULT false;

-- THE SAFETY STEP. Do not skip this, and do not run the ALTER without it.
--
-- Defaulting every historical row to false makes the entire eligible history
-- sweepable at once: 72,842 rows on production at the time of writing, pushed
-- at the ticketing service twenty at a time, forever. The 48-hour window is
-- deliberate — recent enough that someone may still be working those tickets,
-- bounded enough that recovery is ~1,175 calls rather than nine months of them.
--
-- Anything older is declared handled. If a ticket from March is missing its
-- transcript, re-pushing it now helps nobody and costs the ticketing app a
-- sustained flood.
UPDATE call_logs
   SET call_data_synced = true
 WHERE created_at < now() - interval '48 hours';

COMMENT ON COLUMN call_logs.call_data_synced IS
  'Whether this call''s post-call data (transcript, recording, duration, grade) actually reached its ticket via update-call-data. Distinct from ticketing_synced, which only means a ticket exists — that is set mid-call, before the transcript exists. Only a SUCCESSFUL updateTicketCallData sets this; the sweeper selects on it.';
