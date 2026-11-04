ALTER TABLE appointments
  ADD COLUMN appointment_type text NOT NULL DEFAULT 'individual',
  ADD COLUMN occurrence_index integer;

UPDATE appointments
SET appointment_type = CASE WHEN capacity > 1 THEN 'class' ELSE 'individual' END;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY organization_id, recurrence_rule_id ORDER BY starts_at, id
  ) - 1 AS occurrence_index
  FROM appointments
  WHERE recurrence_rule_id IS NOT NULL
)
UPDATE appointments appointment
SET occurrence_index = ranked.occurrence_index
FROM ranked
WHERE appointment.id = ranked.id;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_type
    CHECK (appointment_type IN ('individual', 'class')),
  ADD CONSTRAINT appointments_type_capacity
    CHECK ((appointment_type = 'individual' AND capacity = 1)
      OR (appointment_type = 'class' AND capacity >= 2)),
  ADD CONSTRAINT appointments_occurrence_index
    CHECK ((recurrence_rule_id IS NULL AND occurrence_index IS NULL)
      OR (recurrence_rule_id IS NOT NULL AND occurrence_index >= 0));

CREATE UNIQUE INDEX appointments_series_occurrence_unique
  ON appointments (organization_id, recurrence_rule_id, occurrence_index)
  WHERE recurrence_rule_id IS NOT NULL;

ALTER TABLE recurrence_rules
  ADD COLUMN frequency text,
  ADD COLUMN interval_count integer,
  ADD COLUMN occurrence_count integer,
  ADD COLUMN created_by_membership_id uuid;

UPDATE recurrence_rules recurrence
SET frequency = 'weekly', interval_count = 1,
    occurrence_count = GREATEST(1, (
      SELECT count(*) FROM appointments appointment
      WHERE appointment.organization_id = recurrence.organization_id
        AND appointment.recurrence_rule_id = recurrence.id
    ));

ALTER TABLE recurrence_rules
  ALTER COLUMN frequency SET NOT NULL,
  ALTER COLUMN interval_count SET NOT NULL,
  ALTER COLUMN occurrence_count SET NOT NULL,
  ADD CONSTRAINT recurrence_rules_frequency CHECK (frequency = 'weekly'),
  ADD CONSTRAINT recurrence_rules_interval CHECK (interval_count BETWEEN 1 AND 52),
  ADD CONSTRAINT recurrence_rules_count CHECK (occurrence_count BETWEEN 1 AND 104),
  ADD CONSTRAINT recurrence_rules_creator_fk
    FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES memberships(organization_id, id);

CREATE FUNCTION enforce_appointment_capacity_limits() RETURNS trigger
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

CREATE TRIGGER appointments_enforce_capacity_limits
  BEFORE INSERT OR UPDATE OF service_id, room_id, capacity, appointment_type
  ON appointments FOR EACH ROW EXECUTE FUNCTION enforce_appointment_capacity_limits();

CREATE FUNCTION enforce_fixed_recurring_participant() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status NOT IN ('booked', 'confirmed', 'attended') THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM appointments appointment
    WHERE appointment.organization_id = NEW.organization_id
      AND appointment.id = NEW.appointment_id
      AND appointment.recurrence_rule_id IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM clients client
    WHERE client.organization_id = NEW.organization_id
      AND client.id = NEW.client_id
      AND client.client_type = 'fixed'
      AND client.status = 'active' AND client.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'recurring appointments require fixed client' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_participants_require_fixed_recurrence
  BEFORE INSERT OR UPDATE OF appointment_id, client_id, status
  ON appointment_participants FOR EACH ROW EXECUTE FUNCTION enforce_fixed_recurring_participant();
