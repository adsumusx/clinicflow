DROP TRIGGER IF EXISTS availability_rules_enforce_client_limit ON availability_rules;
DROP FUNCTION IF EXISTS enforce_availability_client_limit();

ALTER TABLE services
  ADD COLUMN default_capacity integer;

UPDATE services service
SET default_capacity = GREATEST(
  1,
  COALESCE((
    SELECT MAX(appointment.capacity)
    FROM appointments appointment
    WHERE appointment.organization_id = service.organization_id
      AND appointment.service_id = service.id
  ), 1)
);

ALTER TABLE services
  ALTER COLUMN default_capacity SET NOT NULL,
  ADD CONSTRAINT services_capacity_range
    CHECK (default_capacity BETWEEN 1 AND 10000);

CREATE OR REPLACE FUNCTION enforce_appointment_capacity_limits() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE service_limit integer; room_limit integer;
BEGIN
  SELECT default_capacity INTO service_limit
  FROM services
  WHERE organization_id = NEW.organization_id AND id = NEW.service_id;

  IF NEW.capacity > service_limit THEN
    RAISE EXCEPTION 'appointment exceeds service capacity' USING ERRCODE = '23514';
  END IF;

  IF NEW.room_id IS NOT NULL THEN
    SELECT capacity INTO room_limit
    FROM rooms
    WHERE organization_id = NEW.organization_id AND id = NEW.room_id;
    IF NEW.capacity > room_limit THEN
      RAISE EXCEPTION 'appointment exceeds room capacity' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS professional_client_limit(uuid, uuid, uuid, timestamptz, timestamptz);

ALTER TABLE availability_rules
  DROP CONSTRAINT IF EXISTS availability_rules_client_limit,
  DROP COLUMN IF EXISTS client_limit;
