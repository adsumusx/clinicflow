DROP TRIGGER IF EXISTS receivables_schedule_billing_reminders ON receivables;
DROP FUNCTION IF EXISTS schedule_billing_reminders_after_receivable_insert();
DROP FUNCTION IF EXISTS schedule_billing_reminders(uuid, uuid);

ALTER TABLE receivables DROP CONSTRAINT IF EXISTS receivables_generation_run_fk;
DROP INDEX IF EXISTS receivables_contract_competence_unique;
ALTER TABLE receivables DROP COLUMN IF EXISTS generation_run_id;

DROP TABLE IF EXISTS billing_reminders;
DROP TABLE IF EXISTS billing_reminder_policies;
DROP TABLE IF EXISTS receivable_generation_runs;
