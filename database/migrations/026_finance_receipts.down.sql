DROP INDEX payments_receivable_timeline_idx;
DROP TRIGGER payments_validate_financial_balance ON payments;
DROP FUNCTION validate_receivable_payment();
ALTER TABLE payments
  DROP CONSTRAINT payments_reversal_reason_consistent,
  DROP COLUMN reversal_reason;
