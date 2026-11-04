DROP TRIGGER IF EXISTS appointment_participants_validate_schedule ON appointment_participants;
DROP FUNCTION IF EXISTS validate_participant_schedule();
DROP TRIGGER IF EXISTS appointments_validate_schedule ON appointments;
DROP FUNCTION IF EXISTS validate_scheduled_appointment();
DROP FUNCTION IF EXISTS appointment_matches_availability(uuid, uuid, uuid, timestamptz, timestamptz);

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_cancelled_by_fk,
  DROP CONSTRAINT IF EXISTS appointments_cancellation_state,
  DROP COLUMN IF EXISTS cancelled_by_membership_id,
  DROP COLUMN IF EXISTS cancelled_at;

DROP INDEX IF EXISTS availability_rules_interval_idx;
DROP INDEX IF EXISTS availability_rules_professional_idx;

ALTER TABLE availability_rules
  DROP CONSTRAINT IF EXISTS availability_rules_shape,
  DROP CONSTRAINT IF EXISTS availability_rules_label_length,
  DROP CONSTRAINT IF EXISTS availability_rules_weekday,
  DROP CONSTRAINT IF EXISTS availability_rules_kind;

-- O formato anterior representava repetições em texto. A conversão mantém a
-- intenção dos horários semanais para que o rollback não descarte regras.
UPDATE availability_rules
SET recurrence_expression = concat('FREQ=WEEKLY;BYDAY=', weekday),
    starts_at = (DATE '2000-01-03' + (weekday - 1) + local_start_time) AT TIME ZONE timezone,
    ends_at = (DATE '2000-01-03' + (weekday - 1) + local_end_time) AT TIME ZONE timezone
WHERE weekday IS NOT NULL;

ALTER TABLE availability_rules
  ALTER COLUMN starts_at SET NOT NULL,
  ALTER COLUMN ends_at SET NOT NULL,
  DROP COLUMN IF EXISTS active,
  DROP COLUMN IF EXISTS label,
  DROP COLUMN IF EXISTS timezone,
  DROP COLUMN IF EXISTS local_end_time,
  DROP COLUMN IF EXISTS local_start_time,
  DROP COLUMN IF EXISTS weekday,
  DROP COLUMN IF EXISTS kind;
