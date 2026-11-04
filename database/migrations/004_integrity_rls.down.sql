DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS protect_signed_clinical_record() CASCADE;
DROP FUNCTION IF EXISTS protect_immutable_row() CASCADE;
DROP FUNCTION IF EXISTS validate_file_link_target() CASCADE;
DROP FUNCTION IF EXISTS enforce_one_waitlist_offer() CASCADE;
DROP FUNCTION IF EXISTS enforce_equipment_capacity() CASCADE;
DROP FUNCTION IF EXISTS prevent_capacity_reduction() CASCADE;
DROP FUNCTION IF EXISTS enforce_appointment_capacity() CASCADE;
DROP FUNCTION IF EXISTS enforce_appointment_conflict() CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS current_organization_id();
