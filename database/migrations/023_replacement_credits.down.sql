DROP TRIGGER IF EXISTS replacement_credit_status_history_append_only
  ON replacement_credit_status_history;
DROP FUNCTION IF EXISTS protect_replacement_credit_history();
DROP TRIGGER IF EXISTS replacement_credits_record_status_change ON replacement_credits;
DROP TRIGGER IF EXISTS replacement_credits_record_initial_status ON replacement_credits;
DROP FUNCTION IF EXISTS record_replacement_credit_status();
DROP TRIGGER IF EXISTS replacement_credits_validate ON replacement_credits;
DROP FUNCTION IF EXISTS validate_replacement_credit();
DROP TABLE IF EXISTS replacement_credit_status_history;
DROP INDEX IF EXISTS replacement_credits_available_idx;
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_replacement_credit_validity_valid,
  DROP COLUMN IF EXISTS replacement_credit_validity_days;
