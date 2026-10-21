-- Runtime outbound layer (src/runtime/outbound/), v105.
--
-- Additive only. The outbound store also runs these with IF NOT EXISTS on
-- first use, so the layer works whether or not this file is applied; it is
-- here so the change is written down where the other Hub changes are, and so
-- `drizzle-kit push` (which reads shared/schema.ts, where both are declared)
-- and the database agree.

-- One person per source id per campaign: importing a list twice never queues
-- anybody twice.
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS external_ref VARCHAR;
CREATE UNIQUE INDEX IF NOT EXISTS campaign_contacts_campaign_external_ref_uidx
  ON campaign_contacts (campaign_id, external_ref) WHERE external_ref IS NOT NULL;

-- Numbers that asked not to be called, phone-wide, every campaign. The last
-- ten digits, so every spelling of a number is one request.
CREATE TABLE IF NOT EXISTS do_not_contact (
  phone_key VARCHAR(10) PRIMARY KEY,
  source VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reversal:
--   DROP TABLE do_not_contact;
--   DROP INDEX campaign_contacts_campaign_external_ref_uidx;
--   ALTER TABLE campaign_contacts DROP COLUMN external_ref;
