DROP TABLE IF EXISTS push_deliveries;

DROP INDEX IF EXISTS outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox_events(available_at) WHERE processed_at IS NULL;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_outbox_recipient_unique;

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_lock_consistent,
  DROP CONSTRAINT IF EXISTS outbox_events_attempt_count_valid,
  DROP COLUMN IF EXISTS failed_at,
  DROP COLUMN IF EXISTS last_error_code,
  DROP COLUMN IF EXISTS locked_by,
  DROP COLUMN IF EXISTS locked_at,
  DROP COLUMN IF EXISTS attempt_count;

DROP INDEX IF EXISTS push_devices_active_user_idx;

ALTER TABLE push_devices
  DROP CONSTRAINT IF EXISTS push_devices_encryption_version_valid,
  DROP CONSTRAINT IF EXISTS push_devices_token_fingerprint_unique,
  DROP COLUMN IF EXISTS encryption_version,
  DROP COLUMN IF EXISTS token_fingerprint;
