ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_action_format
    CHECK (action ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  ADD CONSTRAINT audit_events_target_type_format
    CHECK (target_type ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  ADD CONSTRAINT audit_events_metadata_object
    CHECK (jsonb_typeof(minimal_metadata) = 'object'),
  ADD CONSTRAINT audit_events_metadata_size
    CHECK (octet_length(minimal_metadata::text) <= 2048);

CREATE INDEX audit_events_timeline_idx
  ON audit_events (organization_id, occurred_at DESC, id DESC);

CREATE INDEX audit_events_actor_idx
  ON audit_events (organization_id, actor_membership_id, occurred_at DESC)
  WHERE actor_membership_id IS NOT NULL;

-- A aplicação pode anexar e consultar eventos, mas nem sequer recebe privilégios
-- de UPDATE/DELETE. O trigger append-only permanece como segunda barreira.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    REVOKE UPDATE, DELETE ON TABLE audit_events FROM clinicflow_app;
  END IF;
END;
$$;
