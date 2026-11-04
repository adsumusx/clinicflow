CREATE TABLE payable_recurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  idempotency_key text NOT NULL,
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency = 'monthly'),
  installment_count integer NOT NULL CHECK (installment_count BETWEEN 2 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
);

INSERT INTO financial_categories (organization_id, kind, name)
SELECT id, 'payable', 'Geral' FROM organizations
ON CONFLICT (organization_id, kind, name) DO NOTHING;

ALTER TABLE payables
  DROP CONSTRAINT payables_status_check,
  ADD COLUMN competence_on date,
  ADD COLUMN idempotency_key text,
  ADD COLUMN recurrence_id uuid,
  ADD COLUMN installment_number integer,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD CONSTRAINT payables_status_check
    CHECK (status IN ('open', 'partially_paid', 'paid', 'cancelled', 'overdue')),
  ADD CONSTRAINT payables_description_length
    CHECK (char_length(btrim(description)) BETWEEN 2 AND 200),
  ADD CONSTRAINT payables_counterparty_length
    CHECK (char_length(btrim(counterparty)) BETWEEN 2 AND 160),
  ADD CONSTRAINT payables_competence_first_day
    CHECK (competence_on = date_trunc('month', competence_on)::date),
  ADD CONSTRAINT payables_installment_pair
    CHECK ((recurrence_id IS NULL) = (installment_number IS NULL)),
  ADD CONSTRAINT payables_installment_positive
    CHECK (installment_number IS NULL OR installment_number > 0);

UPDATE payables
SET competence_on = date_trunc('month', due_on)::date,
    idempotency_key = 'legacy:payable:' || id::text,
    cancelled_at = CASE WHEN status = 'cancelled' THEN updated_at ELSE NULL END,
    cancellation_reason = CASE WHEN status = 'cancelled' THEN 'Cancelamento anterior à FIN-004' ELSE NULL END;

ALTER TABLE payables
  ALTER COLUMN competence_on SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ADD CONSTRAINT payables_idempotency_unique UNIQUE (organization_id, idempotency_key),
  ADD CONSTRAINT payables_cancellation_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT payables_recurrence_fk
    FOREIGN KEY (organization_id, recurrence_id)
    REFERENCES payable_recurrences(organization_id, id);

CREATE UNIQUE INDEX payables_recurrence_installment_unique
  ON payables(organization_id, recurrence_id, installment_number)
  WHERE recurrence_id IS NOT NULL;

CREATE TABLE payable_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  reverses_payment_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  method text NOT NULL,
  external_reference text,
  paid_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, payable_id) REFERENCES payables(organization_id, id),
  FOREIGN KEY (organization_id, reverses_payment_id) REFERENCES payable_payments(organization_id, id),
  CHECK ((reverses_payment_id IS NULL AND amount_cents > 0 AND reversal_reason IS NULL)
    OR (reverses_payment_id IS NOT NULL AND amount_cents < 0 AND reversal_reason IS NOT NULL
      AND char_length(btrim(reversal_reason)) BETWEEN 3 AND 200))
);

CREATE UNIQUE INDEX payable_payments_one_full_reversal
  ON payable_payments(organization_id, reverses_payment_id)
  WHERE reverses_payment_id IS NOT NULL;

CREATE VIEW payable_balances WITH (security_invoker = true) AS
SELECT payable.organization_id, payable.id AS payable_id, payable.amount_cents AS original_amount_cents,
       COALESCE(sum(payment.amount_cents), 0)::bigint AS paid_amount_cents,
       (payable.amount_cents - COALESCE(sum(payment.amount_cents), 0))::bigint AS balance_cents
FROM payables payable
LEFT JOIN payable_payments payment
  ON payment.organization_id = payable.organization_id AND payment.payable_id = payable.id
GROUP BY payable.organization_id, payable.id, payable.amount_cents;

CREATE FUNCTION validate_payable_payment() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payable_status text;
  current_balance bigint;
  original_payment payable_payments%ROWTYPE;
BEGIN
  SELECT status INTO payable_status FROM payables
  WHERE organization_id = NEW.organization_id AND id = NEW.payable_id
  FOR UPDATE;
  IF payable_status IS NULL THEN
    RAISE EXCEPTION 'payable not found' USING ERRCODE = '23503';
  END IF;
  IF payable_status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled payable cannot receive payments' USING ERRCODE = '23514';
  END IF;
  IF NEW.reverses_payment_id IS NULL THEN
    SELECT balance_cents INTO current_balance FROM payable_balances
    WHERE organization_id = NEW.organization_id AND payable_id = NEW.payable_id;
    IF NEW.amount_cents > current_balance THEN
      RAISE EXCEPTION 'payment exceeds payable balance' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO original_payment FROM payable_payments
    WHERE organization_id = NEW.organization_id AND id = NEW.reverses_payment_id
    FOR UPDATE;
    IF original_payment.id IS NULL
       OR original_payment.payable_id <> NEW.payable_id
       OR original_payment.reverses_payment_id IS NOT NULL
       OR NEW.amount_cents <> -original_payment.amount_cents THEN
      RAISE EXCEPTION 'invalid payable payment reversal' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payable_payments_validate_financial_balance
  BEFORE INSERT ON payable_payments
  FOR EACH ROW EXECUTE FUNCTION validate_payable_payment();
CREATE TRIGGER payable_payments_append_only
  BEFORE UPDATE OR DELETE ON payable_payments
  FOR EACH ROW EXECUTE FUNCTION protect_immutable_row();

CREATE INDEX payables_finance_list_idx ON payables(organization_id, due_on DESC, id DESC);
CREATE INDEX payable_payments_timeline_idx
  ON payable_payments(organization_id, payable_id, paid_at DESC, id DESC);

ALTER TABLE payable_recurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE payable_recurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON payable_recurrences
  USING (organization_id = current_organization_id() AND has_active_organization_membership(organization_id))
  WITH CHECK (organization_id = current_organization_id() AND has_active_organization_membership(organization_id));

ALTER TABLE payable_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payable_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON payable_payments
  USING (organization_id = current_organization_id() AND has_active_organization_membership(organization_id))
  WITH CHECK (organization_id = current_organization_id() AND has_active_organization_membership(organization_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payable_recurrences TO clinicflow_app;
    GRANT SELECT, INSERT ON payable_payments TO clinicflow_app;
    GRANT SELECT ON payable_balances TO clinicflow_app;
  END IF;
END;
$$;
