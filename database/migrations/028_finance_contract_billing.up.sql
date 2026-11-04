-- FIN-005/FIN-006/FIN-007: faturamento contratual, faturas do cliente e lembretes limitados.
CREATE TABLE receivable_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  contract_id uuid,
  category_id uuid NOT NULL,
  competence_on date NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, contract_id) REFERENCES contracts(organization_id, id),
  FOREIGN KEY (organization_id, category_id) REFERENCES financial_categories(organization_id, id),
  CHECK (competence_on = date_trunc('month', competence_on)::date)
);

ALTER TABLE receivables
  ADD COLUMN generation_run_id uuid,
  ADD CONSTRAINT receivables_generation_run_fk
    FOREIGN KEY (organization_id, generation_run_id)
    REFERENCES receivable_generation_runs(organization_id, id);

CREATE UNIQUE INDEX receivables_contract_competence_unique
  ON receivables(organization_id, contract_id, competence_on)
  WHERE contract_id IS NOT NULL;

CREATE TABLE billing_reminder_policies (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  enabled boolean NOT NULL DEFAULT true,
  days_before_due integer NOT NULL DEFAULT 3 CHECK (days_before_due BETWEEN 1 AND 30),
  remind_on_due_date boolean NOT NULL DEFAULT true,
  overdue_interval_days integer NOT NULL DEFAULT 7 CHECK (overdue_interval_days BETWEEN 1 AND 60),
  max_overdue_reminders integer NOT NULL DEFAULT 3 CHECK (max_overdue_reminders BETWEEN 0 AND 6),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_reminder_policies (organization_id)
SELECT id FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE billing_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('due_soon', 'due_today', 'overdue')),
  sequence_number integer NOT NULL CHECK (sequence_number >= 0),
  scheduled_for date NOT NULL,
  outbox_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, receivable_id, stage, sequence_number),
  FOREIGN KEY (organization_id, receivable_id) REFERENCES receivables(organization_id, id),
  FOREIGN KEY (organization_id, outbox_event_id) REFERENCES outbox_events(organization_id, id)
);

CREATE INDEX billing_reminders_timeline_idx
  ON billing_reminders(organization_id, receivable_id, scheduled_for, sequence_number);

ALTER TABLE receivable_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_generation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON receivable_generation_runs
  USING (organization_id = current_organization_id() AND has_active_organization_membership(organization_id))
  WITH CHECK (organization_id = current_organization_id() AND has_active_organization_membership(organization_id));

ALTER TABLE billing_reminder_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_reminder_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_reminder_policies
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

ALTER TABLE billing_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_reminders
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON receivable_generation_runs TO clinicflow_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON billing_reminder_policies TO clinicflow_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON billing_reminders TO clinicflow_app;
  END IF;
END;
$$;

CREATE FUNCTION schedule_billing_reminders(p_organization_id uuid, p_receivable_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  receivable_due_on date;
  receivable_status text;
  policy billing_reminder_policies%ROWTYPE;
  reminder_id uuid;
  event_id uuid;
  scheduled_on date;
  created_count integer := 0;
  reminder_sequence integer;
BEGIN
  PERFORM set_config('app.organization_id', p_organization_id::text, true);
  SELECT due_on, status INTO receivable_due_on, receivable_status
  FROM receivables
  WHERE organization_id = p_organization_id AND id = p_receivable_id;
  IF receivable_due_on IS NULL OR receivable_status = 'cancelled' THEN RETURN 0; END IF;

  SELECT * INTO policy FROM billing_reminder_policies
  WHERE organization_id = p_organization_id AND enabled;
  IF NOT FOUND THEN RETURN 0; END IF;

  scheduled_on := receivable_due_on - policy.days_before_due;
  reminder_id := gen_random_uuid();
  event_id := gen_random_uuid();
  INSERT INTO billing_reminders
    (id, organization_id, receivable_id, stage, sequence_number, scheduled_for, outbox_event_id)
  VALUES (reminder_id, p_organization_id, p_receivable_id, 'due_soon', 0, scheduled_on, event_id)
  ON CONFLICT (organization_id, receivable_id, stage, sequence_number) DO NOTHING;
  IF FOUND THEN
    INSERT INTO outbox_events
      (id, organization_id, aggregate_type, aggregate_id, event_type, safe_payload,
       idempotency_key, available_at)
    VALUES (event_id, p_organization_id, 'billing_reminder', reminder_id,
            'billing.reminder', '{}'::jsonb,
            'billing.reminder:' || reminder_id::text,
            GREATEST(scheduled_on::timestamptz + interval '9 hours', clock_timestamp()));
    created_count := created_count + 1;
  END IF;

  IF policy.remind_on_due_date THEN
    scheduled_on := receivable_due_on;
    reminder_id := gen_random_uuid();
    event_id := gen_random_uuid();
    INSERT INTO billing_reminders
      (id, organization_id, receivable_id, stage, sequence_number, scheduled_for, outbox_event_id)
    VALUES (reminder_id, p_organization_id, p_receivable_id, 'due_today', 0, scheduled_on, event_id)
    ON CONFLICT (organization_id, receivable_id, stage, sequence_number) DO NOTHING;
    IF FOUND THEN
      INSERT INTO outbox_events
        (id, organization_id, aggregate_type, aggregate_id, event_type, safe_payload,
         idempotency_key, available_at)
      VALUES (event_id, p_organization_id, 'billing_reminder', reminder_id,
              'billing.reminder', '{}'::jsonb,
              'billing.reminder:' || reminder_id::text,
              GREATEST(scheduled_on::timestamptz + interval '9 hours', clock_timestamp()));
      created_count := created_count + 1;
    END IF;
  END IF;

  FOR reminder_sequence IN 1..policy.max_overdue_reminders LOOP
    scheduled_on := receivable_due_on + reminder_sequence * policy.overdue_interval_days;
    reminder_id := gen_random_uuid();
    event_id := gen_random_uuid();
    INSERT INTO billing_reminders
      (id, organization_id, receivable_id, stage, sequence_number, scheduled_for, outbox_event_id)
    VALUES (reminder_id, p_organization_id, p_receivable_id, 'overdue', reminder_sequence,
            scheduled_on, event_id)
    ON CONFLICT (organization_id, receivable_id, stage, sequence_number) DO NOTHING;
    IF FOUND THEN
      INSERT INTO outbox_events
        (id, organization_id, aggregate_type, aggregate_id, event_type, safe_payload,
         idempotency_key, available_at)
      VALUES (event_id, p_organization_id, 'billing_reminder', reminder_id,
              'billing.reminder', '{}'::jsonb,
              'billing.reminder:' || reminder_id::text,
              GREATEST(scheduled_on::timestamptz + interval '9 hours', clock_timestamp()));
      created_count := created_count + 1;
    END IF;
  END LOOP;
  RETURN created_count;
END;
$$;

REVOKE ALL ON FUNCTION schedule_billing_reminders(uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT EXECUTE ON FUNCTION schedule_billing_reminders(uuid, uuid) TO clinicflow_app;
  END IF;
END;
$$;

CREATE FUNCTION schedule_billing_reminders_after_receivable_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM schedule_billing_reminders(NEW.organization_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER receivables_schedule_billing_reminders
  AFTER INSERT ON receivables
  FOR EACH ROW EXECUTE FUNCTION schedule_billing_reminders_after_receivable_insert();

SELECT schedule_billing_reminders(organization_id, id) FROM receivables;
