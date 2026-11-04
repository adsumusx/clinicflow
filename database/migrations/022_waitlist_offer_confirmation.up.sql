-- WAIT-003: vincula o consumo da oferta à participação criada atomicamente.
ALTER TABLE waitlist_offers
  ADD COLUMN consumed_by_participant_id uuid,
  ADD CONSTRAINT waitlist_offers_consumed_participant_fk
    FOREIGN KEY (organization_id, consumed_by_participant_id)
    REFERENCES appointment_participants(organization_id, id),
  ADD CONSTRAINT waitlist_offers_consumed_participant_state
    CHECK ((status = 'consumed') = (consumed_by_participant_id IS NOT NULL)),
  ADD CONSTRAINT waitlist_offers_consumed_participant_unique
    UNIQUE (organization_id, consumed_by_participant_id);

CREATE FUNCTION validate_waitlist_offer_consumption() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'consumed' OR OLD.status = 'consumed' THEN RETURN NEW; END IF;

  IF OLD.status <> 'active' OR OLD.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'waitlist offer is not active' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM waitlist_entries entry
    JOIN appointment_participants participant
      ON participant.organization_id = entry.organization_id
     AND participant.id = NEW.consumed_by_participant_id
     AND participant.appointment_id = entry.appointment_id
     AND participant.client_id = entry.client_id
     AND participant.status IN ('booked', 'confirmed', 'attended')
    WHERE entry.organization_id = NEW.organization_id
      AND entry.id = NEW.waitlist_entry_id
      AND entry.appointment_id = NEW.appointment_id
      AND entry.status = 'consumed'
  ) THEN
    RAISE EXCEPTION 'waitlist offer participant mismatch' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER waitlist_offers_validate_consumption
  BEFORE UPDATE OF status, consumed_by_participant_id ON waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION validate_waitlist_offer_consumption();

