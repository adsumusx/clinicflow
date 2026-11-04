DROP TRIGGER IF EXISTS appointment_participant_status_history_append_only
  ON appointment_participant_status_history;
DROP FUNCTION IF EXISTS protect_participant_status_history();
DROP TRIGGER IF EXISTS appointment_participants_record_initial_status ON appointment_participants;
DROP TRIGGER IF EXISTS appointment_participants_record_status_change ON appointment_participants;
DROP FUNCTION IF EXISTS record_participant_status_history();
DROP TRIGGER IF EXISTS appointment_participants_validate_status_transition ON appointment_participants;
DROP FUNCTION IF EXISTS validate_participant_status_transition();
DROP POLICY IF EXISTS tenant_isolation ON appointment_participant_status_history;
ALTER TABLE IF EXISTS appointment_participant_status_history NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS appointment_participant_status_history DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS appointment_participant_status_history;

DROP INDEX IF EXISTS appointment_equipment_usage_idx;
DROP TRIGGER IF EXISTS appointments_revalidate_equipment ON appointments;
DROP FUNCTION IF EXISTS revalidate_appointment_equipment();
DROP FUNCTION IF EXISTS validate_appointment_equipment_allocation(uuid, uuid, uuid, integer);

CREATE OR REPLACE FUNCTION enforce_equipment_capacity() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE available integer; requested integer;
BEGIN
  SELECT quantity INTO available FROM equipment
    WHERE organization_id = NEW.organization_id AND id = NEW.equipment_id FOR UPDATE;
  SELECT COALESCE(sum(ae.quantity), 0) INTO requested
    FROM appointment_equipment ae
    JOIN appointments existing ON existing.organization_id = ae.organization_id AND existing.id = ae.appointment_id
    JOIN appointments candidate ON candidate.organization_id = NEW.organization_id AND candidate.id = NEW.appointment_id
    WHERE ae.organization_id = NEW.organization_id AND ae.equipment_id = NEW.equipment_id
      AND ae.appointment_id <> NEW.appointment_id AND existing.status = 'scheduled'
      AND tstzrange(existing.starts_at, existing.ends_at, '[)') && tstzrange(candidate.starts_at, candidate.ends_at, '[)');
  IF requested + NEW.quantity > available THEN
    RAISE EXCEPTION 'equipment capacity exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_appointment_conflict() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'scheduled' THEN RETURN NEW; END IF;
  PERFORM 1 FROM professionals
    WHERE organization_id = NEW.organization_id AND id = NEW.professional_id FOR UPDATE;
  IF NEW.room_id IS NOT NULL THEN
    PERFORM 1 FROM rooms
      WHERE organization_id = NEW.organization_id AND id = NEW.room_id FOR UPDATE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.organization_id = NEW.organization_id
      AND a.id <> NEW.id AND a.status = 'scheduled'
      AND (a.professional_id = NEW.professional_id OR (NEW.room_id IS NOT NULL AND a.room_id = NEW.room_id))
      AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'appointment resource conflict' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;
