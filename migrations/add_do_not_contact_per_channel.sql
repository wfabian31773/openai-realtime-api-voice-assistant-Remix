-- SMS and voice opt-outs are separate rows on do_not_contact so an SMS
-- START cannot erase a later voice "don't call me". The old unique was
-- phone_key alone: STOP wrote the only row, the voice insert no-op'd,
-- and START deleted that row.
--
-- Write-only here. The outbound store also applies this on first use
-- (ensureSchema). Do not apply this file from the voice deploy.

ALTER TABLE do_not_contact DROP CONSTRAINT IF EXISTS do_not_contact_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS do_not_contact_phone_source_uidx
  ON do_not_contact (phone_key, source);

-- Reversal:
--   DROP INDEX IF EXISTS do_not_contact_phone_source_uidx;
--   ALTER TABLE do_not_contact ADD PRIMARY KEY (phone_key);
--   (only if each phone_key has one row)
