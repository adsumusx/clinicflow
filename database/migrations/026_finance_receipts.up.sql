ALTER TABLE payments ADD COLUMN reversal_reason text;

UPDATE payments
SET reversal_reason = 'Estorno anterior à FIN-003'
WHERE reverses_payment_id IS NOT NULL;

ALTER TABLE payments
  ADD CONSTRAINT payments_reversal_reason_consistent CHECK (
    (reverses_payment_id IS NULL AND reversal_reason IS NULL)
    OR (reverses_payment_id IS NOT NULL AND reversal_reason IS NOT NULL
      AND char_length(btrim(reversal_reason)) BETWEEN 3 AND 200)
  );

CREATE FUNCTION validate_receivable_payment() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receivable_status text;
  current_balance bigint;
  original_payment payments%ROWTYPE;
BEGIN
  SELECT status INTO receivable_status
  FROM receivables
  WHERE organization_id = NEW.organization_id AND id = NEW.receivable_id
  FOR UPDATE;

  IF receivable_status IS NULL THEN
    RAISE EXCEPTION 'receivable not found' USING ERRCODE = '23503';
  END IF;
  IF receivable_status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled receivable cannot receive payments' USING ERRCODE = '23514';
  END IF;

  IF NEW.reverses_payment_id IS NULL THEN
    SELECT balance_cents INTO current_balance
    FROM receivable_balances
    WHERE organization_id = NEW.organization_id AND receivable_id = NEW.receivable_id;
    IF NEW.amount_cents > current_balance THEN
      RAISE EXCEPTION 'payment exceeds receivable balance' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO original_payment
    FROM payments
    WHERE organization_id = NEW.organization_id AND id = NEW.reverses_payment_id
    FOR UPDATE;
    IF original_payment.id IS NULL
       OR original_payment.receivable_id <> NEW.receivable_id
       OR original_payment.reverses_payment_id IS NOT NULL
       OR NEW.amount_cents <> -original_payment.amount_cents THEN
      RAISE EXCEPTION 'invalid payment reversal' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_validate_financial_balance
  BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION validate_receivable_payment();

CREATE INDEX payments_receivable_timeline_idx
  ON payments(organization_id, receivable_id, paid_at DESC, id DESC);
