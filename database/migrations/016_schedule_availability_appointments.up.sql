ALTER TABLE availability_rules
  ADD COLUMN kind text,
  ADD COLUMN weekday smallint,
  ADD COLUMN local_start_time time,
  ADD COLUMN local_end_time time,
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN label text,
  ADD COLUMN active boolean NOT NULL DEFAULT true;

UPDATE availability_rules
SET kind = CASE rule_type WHEN 'available' THEN 'working_hours' ELSE 'unavailable' END;

ALTER TABLE availability_rules
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN starts_at DROP NOT NULL,
  ALTER COLUMN ends_at DROP NOT NULL,
  ADD CONSTRAINT availability_rules_kind
    CHECK (kind IN ('working_hours', 'break', 'unavailable', 'vacation')),
  ADD CONSTRAINT availability_rules_weekday
    CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  ADD CONSTRAINT availability_rules_label_length
    CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 2 AND 120),
  ADD CONSTRAINT availability_rules_shape
    CHECK (
      (
        kind IN ('working_hours', 'break')
        AND weekday IS NOT NULL
        AND local_start_time IS NOT NULL
        AND local_end_time IS NOT NULL
        AND local_end_time > local_start_time
        AND starts_at IS NULL
        AND ends_at IS NULL
      )
      OR
      (
        kind IN ('working_hours', 'unavailable', 'vacation')
        AND weekday IS NULL
        AND local_start_time IS NULL
        AND local_end_time IS NULL
        AND starts_at IS NOT NULL
        AND ends_at IS NOT NULL
        AND ends_at > starts_at
      )
    );

CREATE INDEX availability_rules_professional_idx
  ON availability_rules (organization_id, professional_id, unit_id, kind, weekday);
CREATE INDEX availability_rules_interval_idx
  ON availability_rules (organization_id, professional_id, starts_at, ends_at)
  WHERE starts_at IS NOT NULL;

ALTER TABLE appointments
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_membership_id uuid;

-- Compatibiliza eventuais dados locais anteriores antes de tornar o estado
-- estruturalmente obrigatório.
UPDATE appointments SET cancelled_at = updated_at
WHERE status = 'cancelled' AND cancelled_at IS NULL;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_cancellation_state
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT appointments_cancelled_by_fk
    FOREIGN KEY (organization_id, cancelled_by_membership_id)
    REFERENCES memberships(organization_id, id);

CREATE FUNCTION appointment_matches_availability(
  candidate_organization_id uuid,
  candidate_professional_id uuid,
  candidate_unit_id uuid,
  candidate_starts_at timestamptz,
  candidate_ends_at timestamptz
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT
    EXISTS (
      SELECT 1
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
          OR
          (
            available.starts_at IS NOT NULL
            AND candidate_starts_at >= available.starts_at
            AND candidate_ends_at <= available.ends_at
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM availability_rules blocked
      WHERE blocked.organization_id = candidate_organization_id
        AND blocked.professional_id = candidate_professional_id
        AND blocked.unit_id = candidate_unit_id
        AND blocked.active
        AND blocked.kind IN ('break', 'unavailable', 'vacation')
        AND (
          (
            blocked.weekday IS NOT NULL
            AND extract(isodow FROM candidate_starts_at AT TIME ZONE blocked.timezone) = blocked.weekday
            AND (candidate_starts_at AT TIME ZONE blocked.timezone)::date
                = (candidate_ends_at AT TIME ZONE blocked.timezone)::date
            AND (candidate_starts_at AT TIME ZONE blocked.timezone)::time < blocked.local_end_time
            AND (candidate_ends_at AT TIME ZONE blocked.timezone)::time > blocked.local_start_time
          )
          OR
          (
            blocked.starts_at IS NOT NULL
            AND tstzrange(candidate_starts_at, candidate_ends_at, '[)')
                && tstzrange(blocked.starts_at, blocked.ends_at, '[)')
          )
        )
    );
$$;

CREATE FUNCTION validate_scheduled_appointment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'scheduled' THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM professionals
    WHERE organization_id = NEW.organization_id AND id = NEW.professional_id
      AND active AND deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM units
    WHERE organization_id = NEW.organization_id AND id = NEW.unit_id AND active
  ) OR NOT EXISTS (
    SELECT 1 FROM services service
    JOIN modalities modality
      ON modality.organization_id = service.organization_id AND modality.id = service.modality_id
    WHERE service.organization_id = NEW.organization_id AND service.id = NEW.service_id
      AND service.active AND modality.active
  ) OR (
    NEW.room_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM rooms
      WHERE organization_id = NEW.organization_id AND id = NEW.room_id
        AND unit_id = NEW.unit_id AND active
    )
  ) THEN
    RAISE EXCEPTION 'inactive or incompatible schedule resource' USING ERRCODE = '23514';
  END IF;

  IF NOT appointment_matches_availability(
    NEW.organization_id, NEW.professional_id, NEW.unit_id, NEW.starts_at, NEW.ends_at
  ) THEN
    RAISE EXCEPTION 'appointment outside professional availability' USING ERRCODE = '23P01';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM appointment_participants participant
    JOIN appointments other
      ON other.organization_id = participant.organization_id
     AND other.id = participant.appointment_id
    WHERE participant.organization_id = NEW.organization_id
      AND participant.appointment_id = NEW.id
      AND participant.status IN ('booked', 'confirmed', 'attended')
      AND other.status = 'scheduled'
      AND EXISTS (
        SELECT 1
        FROM appointment_participants conflicting_participant
        JOIN appointments conflicting
          ON conflicting.organization_id = conflicting_participant.organization_id
         AND conflicting.id = conflicting_participant.appointment_id
        WHERE conflicting_participant.organization_id = NEW.organization_id
          AND conflicting_participant.client_id = participant.client_id
          AND conflicting_participant.appointment_id <> NEW.id
          AND conflicting_participant.status IN ('booked', 'confirmed', 'attended')
          AND conflicting.status = 'scheduled'
          AND tstzrange(conflicting.starts_at, conflicting.ends_at, '[)')
              && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
      )
  ) THEN
    RAISE EXCEPTION 'client appointment conflict' USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_validate_schedule
  BEFORE INSERT OR UPDATE OF unit_id, service_id, professional_id, room_id, starts_at, ends_at, status
  ON appointments FOR EACH ROW EXECUTE FUNCTION validate_scheduled_appointment();

CREATE FUNCTION validate_participant_schedule() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE candidate appointments%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('booked', 'confirmed', 'attended') THEN RETURN NEW; END IF;

  PERFORM 1 FROM clients
  WHERE organization_id = NEW.organization_id AND id = NEW.client_id
    AND status = 'active' AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inactive appointment client' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO candidate FROM appointments
  WHERE organization_id = NEW.organization_id AND id = NEW.appointment_id;
  IF candidate.status <> 'scheduled' THEN
    RAISE EXCEPTION 'participant requires scheduled appointment' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM appointment_participants participant
    JOIN appointments other
      ON other.organization_id = participant.organization_id
     AND other.id = participant.appointment_id
    WHERE participant.organization_id = NEW.organization_id
      AND participant.client_id = NEW.client_id
      AND participant.id <> NEW.id
      AND participant.status IN ('booked', 'confirmed', 'attended')
      AND other.status = 'scheduled'
      AND tstzrange(other.starts_at, other.ends_at, '[)')
          && tstzrange(candidate.starts_at, candidate.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'client appointment conflict' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_participants_validate_schedule
  BEFORE INSERT OR UPDATE OF appointment_id, client_id, status
  ON appointment_participants FOR EACH ROW EXECUTE FUNCTION validate_participant_schedule();
