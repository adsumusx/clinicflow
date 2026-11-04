-- REP-001/REP-002: ciclo de vida auditavel e consumo atomico de reposicoes.
ALTER TABLE organizations
  ADD COLUMN replacement_credit_validity_days integer NOT NULL DEFAULT 30,
  ADD CONSTRAINT organizations_replacement_credit_validity_valid
    CHECK (replacement_credit_validity_days BETWEEN 1 AND 365);

CREATE INDEX replacement_credits_available_idx
  ON replacement_credits (organization_id, client_id, expires_on, created_at, id)
  WHERE status = 'available';

CREATE TABLE replacement_credit_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  replacement_credit_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  participant_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  CHECK (from_status IS NULL OR from_status IN ('available', 'consumed', 'expired', 'cancelled')),
  CHECK (to_status IN ('available', 'consumed', 'expired', 'cancelled')),
  FOREIGN KEY (organization_id, replacement_credit_id)
    REFERENCES replacement_credits(organization_id, id),
  FOREIGN KEY (organization_id, participant_id)
    REFERENCES appointment_participants(organization_id, id)
);

CREATE INDEX replacement_credit_history_idx
  ON replacement_credit_status_history
    (organization_id, replacement_credit_id, occurred_at, id);

INSERT INTO replacement_credit_status_history
  (organization_id, replacement_credit_id, from_status, to_status,
   participant_id, occurred_at)
SELECT organization_id, id, NULL, status, consumed_by_participant_id, created_at
FROM replacement_credits;

CREATE FUNCTION validate_replacement_credit() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_client_id uuid;
  source_status text;
  source_date date;
  destination_client_id uuid;
  destination_status text;
  destination_date date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id <> OLD.organization_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.source_participant_id <> OLD.source_participant_id
       OR NEW.expires_on <> OLD.expires_on THEN
      RAISE EXCEPTION 'replacement credit identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'available' AND ROW(NEW.status, NEW.consumed_at, NEW.consumed_by_participant_id)
      IS DISTINCT FROM ROW(OLD.status, OLD.consumed_at, OLD.consumed_by_participant_id) THEN
      RAISE EXCEPTION 'replacement credit terminal state is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'available' AND NEW.status NOT IN ('available', 'consumed', 'expired', 'cancelled') THEN
      RAISE EXCEPTION 'invalid replacement credit transition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status <> 'available' OR NEW.consumed_at IS NOT NULL
        OR NEW.consumed_by_participant_id IS NOT NULL THEN
    RAISE EXCEPTION 'replacement credit must be issued as available' USING ERRCODE = '23514';
  END IF;

  SELECT participant.client_id, participant.status,
         (appointment.starts_at AT TIME ZONE unit.timezone)::date
    INTO source_client_id, source_status, source_date
  FROM appointment_participants participant
  JOIN appointments appointment
    ON appointment.organization_id = participant.organization_id
   AND appointment.id = participant.appointment_id
  JOIN units unit
    ON unit.organization_id = appointment.organization_id
   AND unit.id = appointment.unit_id
  WHERE participant.organization_id = NEW.organization_id
    AND participant.id = NEW.source_participant_id;

  IF source_client_id IS NULL OR source_client_id <> NEW.client_id
     OR source_status NOT IN ('absent', 'cancelled') THEN
    RAISE EXCEPTION 'replacement credit source is not eligible' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_on < source_date THEN
    RAISE EXCEPTION 'replacement credit expiration precedes source' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'consumed' THEN
    SELECT participant.client_id, participant.status,
           (appointment.starts_at AT TIME ZONE unit.timezone)::date
      INTO destination_client_id, destination_status, destination_date
    FROM appointment_participants participant
    JOIN appointments appointment
      ON appointment.organization_id = participant.organization_id
     AND appointment.id = participant.appointment_id
    JOIN units unit
      ON unit.organization_id = appointment.organization_id
     AND unit.id = appointment.unit_id
    WHERE participant.organization_id = NEW.organization_id
      AND participant.id = NEW.consumed_by_participant_id;

    IF NEW.consumed_at IS NULL OR destination_client_id IS NULL
       OR destination_client_id <> NEW.client_id
       OR destination_status NOT IN ('booked', 'confirmed', 'attended')
       OR destination_date < source_date OR destination_date > NEW.expires_on THEN
      RAISE EXCEPTION 'replacement credit destination is not eligible' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.consumed_at IS NOT NULL OR NEW.consumed_by_participant_id IS NOT NULL THEN
    RAISE EXCEPTION 'replacement credit consumption state is inconsistent' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER replacement_credits_validate
  BEFORE INSERT OR UPDATE ON replacement_credits
  FOR EACH ROW EXECUTE FUNCTION validate_replacement_credit();

CREATE FUNCTION record_replacement_credit_status() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO replacement_credit_status_history
    (organization_id, replacement_credit_id, from_status, to_status, participant_id)
  VALUES (
    NEW.organization_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status, NEW.consumed_by_participant_id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER replacement_credits_record_initial_status
  AFTER INSERT ON replacement_credits
  FOR EACH ROW EXECUTE FUNCTION record_replacement_credit_status();

CREATE TRIGGER replacement_credits_record_status_change
  AFTER UPDATE OF status ON replacement_credits
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION record_replacement_credit_status();

CREATE FUNCTION protect_replacement_credit_history() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'replacement credit history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER replacement_credit_status_history_append_only
  BEFORE UPDATE OR DELETE ON replacement_credit_status_history
  FOR EACH ROW EXECUTE FUNCTION protect_replacement_credit_history();

ALTER TABLE replacement_credit_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE replacement_credit_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON replacement_credit_status_history
  USING (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  )
  WITH CHECK (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT, INSERT ON replacement_credit_status_history TO clinicflow_app;
  END IF;
END;
$$;
