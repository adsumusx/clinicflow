DROP INDEX IF EXISTS checkins_checked_in_at_idx;
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_self_checkin_after_valid,
  DROP CONSTRAINT IF EXISTS organizations_self_checkin_before_valid,
  DROP COLUMN IF EXISTS self_checkin_after_minutes,
  DROP COLUMN IF EXISTS self_checkin_before_minutes,
  DROP COLUMN IF EXISTS self_checkin_enabled;
DROP INDEX IF EXISTS clients_one_user_per_organization;
