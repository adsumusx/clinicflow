DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    REVOKE ALL ON TABLE prospect_contacts FROM clinicflow_app;
  END IF;
END;
$$;

DROP POLICY authenticated_tenant_isolation ON prospect_contacts;
ALTER TABLE prospect_contacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE prospect_contacts DISABLE ROW LEVEL SECURITY;
DROP INDEX prospect_interactions_timeline_idx;
DROP INDEX prospect_contacts_search_value_idx;
DROP INDEX prospects_search_name_idx;
DROP INDEX prospects_funnel_idx;
DROP INDEX prospect_contacts_one_preferred_type;
DROP TRIGGER set_updated_at ON prospect_contacts;
DROP TRIGGER prospect_contacts_normalize ON prospect_contacts;
DROP TABLE prospect_contacts;

ALTER TABLE prospect_interactions
  DROP CONSTRAINT prospect_interactions_notes_length,
  DROP CONSTRAINT prospect_interactions_type_valid;

ALTER TABLE prospects
  ALTER COLUMN source DROP NOT NULL,
  DROP CONSTRAINT prospects_conversion_consistent,
  DROP CONSTRAINT prospects_stage_valid,
  DROP CONSTRAINT prospects_next_action_note_length,
  DROP CONSTRAINT prospects_source_length,
  DROP CONSTRAINT prospects_full_name_length,
  DROP COLUMN converted_at,
  DROP COLUMN next_action_note;
