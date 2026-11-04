DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT UPDATE, DELETE ON TABLE audit_events TO clinicflow_app;
  END IF;
END;
$$;

DROP INDEX IF EXISTS audit_events_actor_idx;
DROP INDEX IF EXISTS audit_events_timeline_idx;

ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_metadata_size,
  DROP CONSTRAINT IF EXISTS audit_events_metadata_object,
  DROP CONSTRAINT IF EXISTS audit_events_target_type_format,
  DROP CONSTRAINT IF EXISTS audit_events_action_format;
