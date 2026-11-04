-- PUSH-001/PUSH-002: dispositivos revogaveis, preferencias e entrega confiavel da Outbox.
ALTER TABLE push_devices
  ADD COLUMN token_fingerprint text,
  ADD COLUMN encryption_version smallint NOT NULL DEFAULT 1;

UPDATE push_devices
SET token_fingerprint = md5(token_ciphertext)
WHERE token_fingerprint IS NULL;

ALTER TABLE push_devices
  ALTER COLUMN token_fingerprint SET NOT NULL,
  ADD CONSTRAINT push_devices_token_fingerprint_unique UNIQUE (token_fingerprint),
  ADD CONSTRAINT push_devices_encryption_version_valid CHECK (encryption_version > 0);

ALTER TABLE outbox_events
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_by text,
  ADD COLUMN last_error_code text,
  ADD COLUMN failed_at timestamptz,
  ADD CONSTRAINT outbox_events_attempt_count_valid CHECK (attempt_count >= 0),
  ADD CONSTRAINT outbox_events_lock_consistent CHECK (
    (locked_at IS NULL AND locked_by IS NULL) OR
    (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  );

ALTER TABLE notifications
  ADD CONSTRAINT notifications_outbox_recipient_unique
    UNIQUE (organization_id, outbox_event_id, user_id, channel);

CREATE TABLE push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  push_device_id uuid NOT NULL REFERENCES push_devices(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  provider_message_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, notification_id, push_device_id),
  FOREIGN KEY (organization_id, notification_id)
    REFERENCES notifications(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX push_devices_active_user_idx
  ON push_devices(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX push_deliveries_pending_idx
  ON push_deliveries(available_at, organization_id, notification_id)
  WHERE status = 'pending';

DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_pending_idx
  ON outbox_events(available_at, created_at, id)
  WHERE processed_at IS NULL AND failed_at IS NULL;

ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON push_deliveries
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON push_deliveries TO clinicflow_app;
  END IF;
END;
$$;
