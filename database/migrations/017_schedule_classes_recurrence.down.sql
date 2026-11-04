DROP TRIGGER IF EXISTS appointment_participants_require_fixed_recurrence ON appointment_participants;
DROP FUNCTION IF EXISTS enforce_fixed_recurring_participant();
DROP TRIGGER IF EXISTS appointments_enforce_capacity_limits ON appointments;
DROP FUNCTION IF EXISTS enforce_appointment_capacity_limits();

ALTER TABLE recurrence_rules
  DROP CONSTRAINT IF EXISTS recurrence_rules_creator_fk,
  DROP CONSTRAINT IF EXISTS recurrence_rules_count,
  DROP CONSTRAINT IF EXISTS recurrence_rules_interval,
  DROP CONSTRAINT IF EXISTS recurrence_rules_frequency,
  DROP COLUMN IF EXISTS created_by_membership_id,
  DROP COLUMN IF EXISTS occurrence_count,
  DROP COLUMN IF EXISTS interval_count,
  DROP COLUMN IF EXISTS frequency;

DROP INDEX IF EXISTS appointments_series_occurrence_unique;
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_occurrence_index,
  DROP CONSTRAINT IF EXISTS appointments_type_capacity,
  DROP CONSTRAINT IF EXISTS appointments_type,
  DROP COLUMN IF EXISTS occurrence_index,
  DROP COLUMN IF EXISTS appointment_type;
