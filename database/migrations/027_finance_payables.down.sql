DROP INDEX payable_payments_timeline_idx;
DROP INDEX payables_finance_list_idx;
DROP TRIGGER payable_payments_append_only ON payable_payments;
DROP TRIGGER payable_payments_validate_financial_balance ON payable_payments;
DROP FUNCTION validate_payable_payment();
DROP VIEW payable_balances;
DROP TABLE payable_payments;
DROP INDEX payables_recurrence_installment_unique;
ALTER TABLE payables
  DROP CONSTRAINT payables_recurrence_fk,
  DROP CONSTRAINT payables_cancellation_consistent,
  DROP CONSTRAINT payables_idempotency_unique,
  DROP CONSTRAINT payables_installment_positive,
  DROP CONSTRAINT payables_installment_pair,
  DROP CONSTRAINT payables_competence_first_day,
  DROP CONSTRAINT payables_counterparty_length,
  DROP CONSTRAINT payables_description_length,
  DROP CONSTRAINT payables_status_check;
UPDATE payables SET status = 'open' WHERE status = 'partially_paid';
ALTER TABLE payables
  ADD CONSTRAINT payables_status_check CHECK (status IN ('open', 'paid', 'cancelled', 'overdue')),
  DROP COLUMN cancellation_reason,
  DROP COLUMN cancelled_at,
  DROP COLUMN installment_number,
  DROP COLUMN recurrence_id,
  DROP COLUMN idempotency_key,
  DROP COLUMN competence_on;
DROP TABLE payable_recurrences;
