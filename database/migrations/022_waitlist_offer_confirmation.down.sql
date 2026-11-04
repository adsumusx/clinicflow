DROP TRIGGER IF EXISTS waitlist_offers_validate_consumption ON waitlist_offers;
DROP FUNCTION IF EXISTS validate_waitlist_offer_consumption();

ALTER TABLE waitlist_offers
  DROP CONSTRAINT IF EXISTS waitlist_offers_consumed_participant_unique,
  DROP CONSTRAINT IF EXISTS waitlist_offers_consumed_participant_state,
  DROP CONSTRAINT IF EXISTS waitlist_offers_consumed_participant_fk,
  DROP COLUMN IF EXISTS consumed_by_participant_id;

