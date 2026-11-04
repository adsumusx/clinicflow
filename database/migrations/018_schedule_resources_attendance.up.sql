-- SCH-005: conflitos de sala e capacidade compartilhada de aparelhos.
CREATE OR REPLACE FUNCTION enforce_appointment_conflict() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'scheduled' THEN RETURN NEW; END IF;

  PERFORM 1 FROM professionals
    WHERE organization_id = NEW.organization_id AND id = NEW.professional_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM appointments existing
    WHERE existing.organization_id = NEW.organization_id
      AND existing.id <> NEW.id AND existing.status = 'scheduled'
      AND existing.professional_id = NEW.professional_id
      AND tstzrange(existing.starts_at, existing.ends_at, '[)')
          && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'professional appointment resource conflict' USING ERRCODE = '23P01';
  END IF;

  IF NEW.room_id IS NOT NULL THEN
    PERFORM 1 FROM rooms
      WHERE organization_id = NEW.organization_id AND id = NEW.room_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM appointments existing
      WHERE existing.organization_id = NEW.organization_id
        AND existing.id <> NEW.id AND existing.status = 'scheduled'
        AND existing.room_id = NEW.room_id
        AND tstzrange(existing.starts_at, existing.ends_at, '[)')
            && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
    ) THEN
      RAISE EXCEPTION 'room appointment resource conflict' USING ERRCODE = '23P01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_appointment_equipment_allocation(
  candidate_organization_id uuid,
  candidate_appointment_id uuid,
  candidate_equipment_id uuid,
  candidate_quantity integer
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  available integer;
  equipment_unit_id uuid;
  equipment_active boolean;
  appointment_unit_id uuid;
  appointment_status text;
  appointment_starts_at timestamptz;
  appointment_ends_at timestamptz;
  requested integer;
BEGIN
  SELECT quantity, unit_id, active
    INTO available, equipment_unit_id, equipment_active
  FROM equipment
  WHERE organization_id = candidate_organization_id AND id = candidate_equipment_id
  FOR UPDATE;

  SELECT unit_id, status, starts_at, ends_at
    INTO appointment_unit_id, appointment_status, appointment_starts_at, appointment_ends_at
  FROM appointments
  WHERE organization_id = candidate_organization_id AND id = candidate_appointment_id;

  IF available IS NULL OR appointment_unit_id IS NULL
     OR NOT equipment_active OR equipment_unit_id <> appointment_unit_id THEN
    RAISE EXCEPTION 'inactive or incompatible equipment resource' USING ERRCODE = '23514';
  END IF;
  IF candidate_quantity < 1 OR candidate_quantity > available THEN
    RAISE EXCEPTION 'equipment capacity exceeded' USING ERRCODE = '23514';
  END IF;
  IF appointment_status <> 'scheduled' THEN RETURN; END IF;

  SELECT COALESCE(sum(linked.quantity), 0)::integer INTO requested
  FROM appointment_equipment linked
  JOIN appointments existing
    ON existing.organization_id = linked.organization_id
   AND existing.id = linked.appointment_id
  WHERE linked.organization_id = candidate_organization_id
    AND linked.equipment_id = candidate_equipment_id
    AND linked.appointment_id <> candidate_appointment_id
    AND existing.status = 'scheduled'
    AND tstzrange(existing.starts_at, existing.ends_at, '[)')
        && tstzrange(appointment_starts_at, appointment_ends_at, '[)');

  IF requested + candidate_quantity > available THEN
    RAISE EXCEPTION 'equipment capacity exceeded' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_equipment_capacity() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM validate_appointment_equipment_allocation(
    NEW.organization_id, NEW.appointment_id, NEW.equipment_id, NEW.quantity
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION revalidate_appointment_equipment() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE allocation record;
BEGIN
  FOR allocation IN
    SELECT equipment_id, quantity
    FROM appointment_equipment
    WHERE organization_id = NEW.organization_id AND appointment_id = NEW.id
    ORDER BY equipment_id
  LOOP
    PERFORM validate_appointment_equipment_allocation(
      NEW.organization_id, NEW.id, allocation.equipment_id, allocation.quantity
    );
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_revalidate_equipment
  AFTER UPDATE OF unit_id, starts_at, ends_at, status ON appointments
  FOR EACH ROW EXECUTE FUNCTION revalidate_appointment_equipment();

CREATE INDEX appointment_equipment_usage_idx
  ON appointment_equipment (organization_id, equipment_id, appointment_id);

-- SCH-006: máquina de estados e histórico imutável de presença/falta/cancelamento.
CREATE TABLE appointment_participant_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor_membership_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (from_status IS NULL OR from_status IN ('booked', 'confirmed', 'attended', 'absent', 'cancelled')),
  CHECK (to_status IN ('booked', 'confirmed', 'attended', 'absent', 'cancelled')),
  CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 2 AND 500),
  FOREIGN KEY (organization_id, participant_id)
    REFERENCES appointment_participants(organization_id, id),
  FOREIGN KEY (organization_id, appointment_id)
    REFERENCES appointments(organization_id, id),
  FOREIGN KEY (organization_id, actor_membership_id)
    REFERENCES memberships(organization_id, id)
);

CREATE INDEX appointment_participant_history_idx
  ON appointment_participant_status_history
    (organization_id, participant_id, occurred_at, id);

INSERT INTO appointment_participant_status_history
  (organization_id, participant_id, appointment_id, from_status, to_status, reason, occurred_at)
SELECT organization_id, id, appointment_id, NULL, status, cancellation_reason, booked_at
FROM appointment_participants;

CREATE FUNCTION validate_participant_status_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE appointment_state text;
DECLARE appointment_start timestamptz;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  IF OLD.status IN ('attended', 'absent', 'cancelled')
     OR NOT (
       (OLD.status = 'booked' AND NEW.status IN ('confirmed', 'attended', 'absent', 'cancelled'))
       OR (OLD.status = 'confirmed' AND NEW.status IN ('attended', 'absent', 'cancelled'))
     ) THEN
    RAISE EXCEPTION 'invalid participant status transition' USING ERRCODE = '23514';
  END IF;

  SELECT status, starts_at INTO appointment_state, appointment_start
  FROM appointments
  WHERE organization_id = NEW.organization_id AND id = NEW.appointment_id
  FOR UPDATE;

  IF appointment_state = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'cancelled appointment participant transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('attended', 'absent') AND appointment_start > now() THEN
    RAISE EXCEPTION 'attendance before appointment start' USING ERRCODE = '23514';
  END IF;
  IF NEW.cancellation_reason IS NOT NULL
     AND char_length(btrim(NEW.cancellation_reason)) NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'invalid participant status reason' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'cancelled' THEN NEW.cancellation_reason = NULL; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_participants_validate_status_transition
  BEFORE UPDATE OF status ON appointment_participants
  FOR EACH ROW EXECUTE FUNCTION validate_participant_status_transition();

CREATE FUNCTION record_participant_status_history() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE actor_id uuid;
BEGIN
  SELECT membership.id INTO actor_id
  FROM memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND membership.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND membership.status = 'active'
  ORDER BY membership.created_at, membership.id
  LIMIT 1;

  INSERT INTO appointment_participant_status_history
    (organization_id, participant_id, appointment_id, from_status, to_status,
     reason, actor_membership_id)
  VALUES (
    NEW.organization_id, NEW.id, NEW.appointment_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status, NEW.cancellation_reason, actor_id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_participants_record_initial_status
  AFTER INSERT ON appointment_participants
  FOR EACH ROW EXECUTE FUNCTION record_participant_status_history();

CREATE TRIGGER appointment_participants_record_status_change
  AFTER UPDATE OF status ON appointment_participants
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION record_participant_status_history();

CREATE FUNCTION protect_participant_status_history() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'appointment participant status history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER appointment_participant_status_history_append_only
  BEFORE UPDATE OR DELETE ON appointment_participant_status_history
  FOR EACH ROW EXECUTE FUNCTION protect_participant_status_history();

ALTER TABLE appointment_participant_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_participant_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointment_participant_status_history
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT, INSERT ON appointment_participant_status_history TO clinicflow_app;
  END IF;
END;
$$;
