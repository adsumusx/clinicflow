-- CLI-001/CLI-002: identidade única do cliente e política de auto check-in.
CREATE UNIQUE INDEX clients_one_user_per_organization
  ON clients (organization_id, user_id)
  WHERE user_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE organizations
  ADD COLUMN self_checkin_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN self_checkin_before_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN self_checkin_after_minutes integer NOT NULL DEFAULT 15,
  ADD CONSTRAINT organizations_self_checkin_before_valid
    CHECK (self_checkin_before_minutes BETWEEN 0 AND 1440),
  ADD CONSTRAINT organizations_self_checkin_after_valid
    CHECK (self_checkin_after_minutes BETWEEN 0 AND 1440);

CREATE INDEX checkins_checked_in_at_idx
  ON checkins (organization_id, checked_in_at DESC, id);
