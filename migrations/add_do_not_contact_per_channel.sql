-- SMS and voice opt-outs are separate rows on do_not_contact so an SMS
-- START cannot erase a later voice "don't call me". The old unique was
-- phone_key alone: STOP wrote the only row, the voice insert no-op'd,
-- and START deleted that row.
--
-- APPLIED to the Hub (pslzngjciiifowemrzza) 2026-10-22 22:10 UTC, Wayne's
-- approval, by GitHub Assistant. Kept as the record of that change.
--
-- Since v115 the outbound store's ensureSchema only creates the table and
-- the unique index when absent; it never drops the old primary key. A
-- database that still has that key needs this file, not a deploy.

ALTER TABLE do_not_contact DROP CONSTRAINT IF EXISTS do_not_contact_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS do_not_contact_phone_source_uidx
  ON do_not_contact (phone_key, source);

-- Reversal:
--   DROP INDEX IF EXISTS do_not_contact_phone_source_uidx;
--   ALTER TABLE do_not_contact ADD PRIMARY KEY (phone_key);
--   (only if each phone_key has one row)
