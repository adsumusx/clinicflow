-- O limite de clientes deixa o serviço e passa a valer no expediente do profissional.
ALTER TABLE availability_rules
  ADD COLUMN client_limit integer;

UPDATE availability_rules rule
SET client_limit = GREATEST(
  1,
  COALESCE((
    SELECT MAX(appointment.capacity)
    FROM appointments appointment
    WHERE appointment.organization_id = rule.organization_id
      AND appointment.professional_id = rule.professional_id
      AND appointment.unit_id = rule.unit_id
      AND appointment.status = 'scheduled'
      AND (
        (
          rule.weekday IS NOT NULL
          AND extract(isodow FROM appointment.starts_at AT TIME ZONE rule.timezone) = rule.weekday
          AND (appointment.starts_at AT TIME ZONE rule.timezone)::date
              = (appointment.ends_at AT TIME ZONE rule.timezone)::date
          AND (appointment.starts_at AT TIME ZONE rule.timezone)::time >= rule.local_start_time
          AND (appointment.ends_at AT TIME ZONE rule.timezone)::time <= rule.local_end_time
        )
        OR (
          rule.starts_at IS NOT NULL
          AND appointment.starts_at >= rule.starts_at
          AND appointment.ends_at <= rule.ends_at
        )
      )
  ), 1)
)
WHERE rule.kind = 'working_hours';

ALTER TABLE availability_rules
  ADD CONSTRAINT availability_rules_client_limit
    CHECK (
      (kind = 'working_hours' AND client_limit BETWEEN 1 AND 10000)
      OR (kind <> 'working_hours' AND client_limit IS NULL)
    );

ALTER TABLE services
  DROP CONSTRAINT services_capacity_range,
  DROP COLUMN default_capacity;

CREATE FUNCTION professional_client_limit(
  candidate_organization_id uuid,
  candidate_professional_id uuid,
  candidate_unit_id uuid,
  candidate_starts_at timestamptz,
  candidate_ends_at timestamptz
) RETURNS integer
LANGUAGE sql STABLE
AS $$
  SELECT MIN(available.client_limit)
  FROM availability_rules available
  WHERE available.organization_id = candidate_organization_id
    AND available.professional_id = candidate_professional_id
    AND available.unit_id = candidate_unit_id
    AND available.active
    AND available.kind = 'working_hours'
    AND (
      (
        available.weekday IS NOT NULL
        AND extract(isodow FROM candidate_starts_at AT TIME ZONE available.timezone) = available.weekday
        AND (candidate_starts_at AT TIME ZONE available.timezone)::date
            = (candidate_ends_at AT TIME ZONE available.timezone)::date
        AND (candidate_starts_at AT TIME ZONE available.timezone)::time >= available.local_start_time
        AND (candidate_ends_at AT TIME ZONE available.timezone)::time <= available.local_end_time
      )
      OR (
        available.starts_at IS NOT NULL
        AND candidate_starts_at >= available.starts_at
        AND candidate_ends_at <= available.ends_at
      )
    );
$$;

CREATE OR REPLACE FUNCTION enforce_appointment_capacity_limits() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE professional_limit integer; room_limit integer;
BEGIN
  professional_limit := professional_client_limit(
    NEW.organization_id, NEW.professional_id, NEW.unit_id, NEW.starts_at, NEW.ends_at
  );
  IF professional_limit IS NOT NULL AND NEW.capacity > professional_limit THEN
    RAISE EXCEPTION 'appointment exceeds professional client capacity' USING ERRCODE = '23514';
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

CREATE FUNCTION enforce_availability_client_limit() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM appointments appointment
    WHERE appointment.organization_id = NEW.organization_id
      AND appointment.professional_id = NEW.professional_id
      AND appointment.unit_id = NEW.unit_id
      AND appointment.status = 'scheduled'
      AND appointment.capacity > professional_client_limit(
        appointment.organization_id, appointment.professional_id, appointment.unit_id,
        appointment.starts_at, appointment.ends_at
      )
  ) THEN
    RAISE EXCEPTION 'availability client limit below scheduled capacity' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.professional_id IS DISTINCT FROM NEW.professional_id
       OR OLD.unit_id IS DISTINCT FROM NEW.unit_id THEN
      IF EXISTS (
        SELECT 1
        FROM appointments appointment
        WHERE appointment.organization_id = OLD.organization_id
          AND appointment.professional_id = OLD.professional_id
          AND appointment.unit_id = OLD.unit_id
          AND appointment.status = 'scheduled'
          AND appointment.capacity > professional_client_limit(
            appointment.organization_id, appointment.professional_id, appointment.unit_id,
            appointment.starts_at, appointment.ends_at
          )
      ) THEN
        RAISE EXCEPTION 'availability client limit below scheduled capacity' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER availability_rules_enforce_client_limit
  AFTER INSERT OR UPDATE OF professional_id, unit_id, kind, weekday,
    local_start_time, local_end_time, starts_at, ends_at, timezone, active, client_limit
  ON availability_rules
  FOR EACH ROW EXECUTE FUNCTION enforce_availability_client_limit();
