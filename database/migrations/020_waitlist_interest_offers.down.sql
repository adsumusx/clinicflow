DROP INDEX IF EXISTS waitlist_queue_idx;
CREATE INDEX waitlist_queue_idx
  ON waitlist_entries(organization_id, appointment_id, queued_at)
  WHERE status = 'queued';

DROP INDEX IF EXISTS waitlist_offers_expiration_idx;
DROP INDEX IF EXISTS waitlist_offers_one_active_per_appointment;

ALTER TABLE waitlist_offers
  DROP CONSTRAINT IF EXISTS waitlist_offers_appointment_fk,
  DROP COLUMN IF EXISTS appointment_id;

ALTER TABLE waitlist_entries
  DROP CONSTRAINT IF EXISTS waitlist_entries_position_unique,
  DROP CONSTRAINT IF EXISTS waitlist_entries_queue_position_positive,
  DROP COLUMN IF EXISTS queue_position;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_waitlist_offer_minutes_valid,
  DROP COLUMN IF EXISTS waitlist_offer_minutes;
