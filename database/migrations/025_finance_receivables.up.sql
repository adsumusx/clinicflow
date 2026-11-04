CREATE TABLE receivable_recurrences (
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
SELECT id, 'receivable', 'Geral' FROM organizations
ON CONFLICT (organization_id, kind, name) DO NOTHING;

ALTER TABLE receivables
  ADD COLUMN description text,
  ADD COLUMN competence_on date,
  ADD COLUMN recurrence_id uuid,
  ADD COLUMN installment_number integer,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD CONSTRAINT receivables_description_length
    CHECK (char_length(btrim(description)) BETWEEN 2 AND 200),
  ADD CONSTRAINT receivables_competence_first_day
    CHECK (competence_on = date_trunc('month', competence_on)::date),
  ADD CONSTRAINT receivables_installment_pair
    CHECK ((recurrence_id IS NULL) = (installment_number IS NULL)),
  ADD CONSTRAINT receivables_installment_positive
    CHECK (installment_number IS NULL OR installment_number > 0);

UPDATE receivables
SET description = 'Conta a receber',
    competence_on = date_trunc('month', due_on)::date,
    cancelled_at = CASE WHEN status = 'cancelled' THEN updated_at ELSE NULL END,
    cancellation_reason = CASE WHEN status = 'cancelled' THEN 'Cancelamento anterior à FIN-002' ELSE NULL END;

ALTER TABLE receivables
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN competence_on SET NOT NULL,
  ADD CONSTRAINT receivables_cancellation_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT receivables_recurrence_fk
    FOREIGN KEY (organization_id, recurrence_id)
    REFERENCES receivable_recurrences(organization_id, id);

CREATE UNIQUE INDEX receivables_recurrence_installment_unique
  ON receivables(organization_id, recurrence_id, installment_number)
  WHERE recurrence_id IS NOT NULL;

CREATE INDEX receivables_finance_list_idx
  ON receivables(organization_id, due_on DESC, id DESC);

ALTER TABLE receivable_recurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_recurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON receivable_recurrences
  USING (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  )
  WITH CHECK (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON receivable_recurrences TO clinicflow_app;
  END IF;
END;
$$;
