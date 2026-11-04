CREATE FUNCTION current_organization_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      table_name
    );
  END LOOP;
END;
$$;

CREATE FUNCTION enforce_appointment_conflict() RETURNS trigger
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

CREATE TRIGGER appointments_prevent_conflict
  BEFORE INSERT OR UPDATE OF starts_at, ends_at, professional_id, room_id, status ON appointments
  FOR EACH ROW EXECUTE FUNCTION enforce_appointment_conflict();

CREATE FUNCTION enforce_appointment_capacity() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE maximum integer; occupied integer;
BEGIN
  IF NEW.status NOT IN ('booked', 'confirmed', 'attended') THEN RETURN NEW; END IF;
  SELECT capacity INTO maximum FROM appointments
    WHERE organization_id = NEW.organization_id AND id = NEW.appointment_id FOR UPDATE;
  SELECT count(*) INTO occupied FROM appointment_participants p
    WHERE p.organization_id = NEW.organization_id AND p.appointment_id = NEW.appointment_id
      AND p.id <> NEW.id AND p.status IN ('booked', 'confirmed', 'attended');
  IF occupied >= maximum THEN
    RAISE EXCEPTION 'appointment capacity exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_participants_enforce_capacity
  BEFORE INSERT OR UPDATE OF appointment_id, status ON appointment_participants
  FOR EACH ROW EXECUTE FUNCTION enforce_appointment_capacity();

CREATE FUNCTION prevent_capacity_reduction() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE occupied integer;
BEGIN
  IF NEW.capacity >= OLD.capacity THEN RETURN NEW; END IF;
  SELECT count(*) INTO occupied FROM appointment_participants
    WHERE organization_id = NEW.organization_id AND appointment_id = NEW.id
      AND status IN ('booked', 'confirmed', 'attended');
  IF NEW.capacity < occupied THEN
    RAISE EXCEPTION 'capacity below current occupancy' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_prevent_capacity_reduction
  BEFORE UPDATE OF capacity ON appointments
  FOR EACH ROW EXECUTE FUNCTION prevent_capacity_reduction();

CREATE FUNCTION enforce_equipment_capacity() RETURNS trigger
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

CREATE TRIGGER appointment_equipment_enforce_capacity
  BEFORE INSERT OR UPDATE OF appointment_id, equipment_id, quantity ON appointment_equipment
  FOR EACH ROW EXECUTE FUNCTION enforce_equipment_capacity();

CREATE FUNCTION enforce_one_waitlist_offer() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE appointment uuid;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  SELECT appointment_id INTO appointment FROM waitlist_entries
    WHERE organization_id = NEW.organization_id AND id = NEW.waitlist_entry_id;
  PERFORM 1 FROM appointments WHERE organization_id = NEW.organization_id AND id = appointment FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM waitlist_offers offer
    JOIN waitlist_entries entry ON entry.organization_id = offer.organization_id AND entry.id = offer.waitlist_entry_id
    WHERE offer.organization_id = NEW.organization_id AND offer.id <> NEW.id
      AND offer.status = 'active' AND entry.appointment_id = appointment
  ) THEN
    RAISE EXCEPTION 'active waitlist offer already exists' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER waitlist_offers_one_per_appointment
  BEFORE INSERT OR UPDATE OF waitlist_entry_id, status ON waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION enforce_one_waitlist_offer();

CREATE FUNCTION validate_file_link_target() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_exists boolean;
BEGIN
  CASE NEW.target_type
    WHEN 'clinical_record' THEN SELECT EXISTS(SELECT 1 FROM clinical_records WHERE organization_id = NEW.organization_id AND id = NEW.target_id) INTO target_exists;
    WHEN 'assessment' THEN SELECT EXISTS(SELECT 1 FROM assessments WHERE organization_id = NEW.organization_id AND id = NEW.target_id) INTO target_exists;
    WHEN 'workout_plan' THEN SELECT EXISTS(SELECT 1 FROM workout_plans WHERE organization_id = NEW.organization_id AND id = NEW.target_id) INTO target_exists;
    WHEN 'fiscal_document' THEN SELECT EXISTS(SELECT 1 FROM fiscal_documents WHERE organization_id = NEW.organization_id AND id = NEW.target_id) INTO target_exists;
    ELSE target_exists := false;
  END CASE;
  IF NOT target_exists THEN RAISE EXCEPTION 'invalid file link target' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_links_validate_target
  BEFORE INSERT OR UPDATE OF organization_id, target_type, target_id ON file_links
  FOR EACH ROW EXECUTE FUNCTION validate_file_link_target();

CREATE FUNCTION protect_immutable_row() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END; $$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION protect_immutable_row();
CREATE TRIGGER fiscal_events_append_only BEFORE UPDATE OR DELETE ON fiscal_events
  FOR EACH ROW EXECUTE FUNCTION protect_immutable_row();
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION protect_immutable_row();

CREATE FUNCTION protect_signed_clinical_record() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'signed clinical record requires an addendum' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_records_protect_signed
  BEFORE UPDATE OR DELETE ON clinical_records
  FOR EACH ROW EXECUTE FUNCTION protect_signed_clinical_record();

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (id = current_organization_id()) WITH CHECK (id = current_organization_id());

DO $$
DECLARE table_name text;
DECLARE tenant_tables text[] := ARRAY[
  'units','roles','role_permissions','memberships','professionals',
  'clients','client_contacts','client_consents','clinical_records','assessments','workout_plans','prospects','prospect_interactions',
  'modalities','services','rooms','equipment','availability_rules','recurrence_rules','appointments','appointment_participants',
  'appointment_equipment','checkins','waitlist_entries','waitlist_offers','replacement_credits',
  'plans','contracts','financial_categories','receivables','payables','payments','fiscal_documents','fiscal_attempts','fiscal_events',
  'files','file_links','notification_preferences','notifications','outbox_events','audit_events'
];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id())',
      table_name
    );
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT USAGE ON SCHEMA public TO clinicflow_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO clinicflow_app;
    GRANT SELECT ON receivable_balances TO clinicflow_app;
    GRANT EXECUTE ON FUNCTION current_organization_id() TO clinicflow_app;
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL ON TABLE schema_migrations FROM clinicflow_app';
    END IF;
  END IF;
END;
$$;
