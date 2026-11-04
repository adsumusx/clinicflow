CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, price_cents bigint NOT NULL CHECK (price_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'BRL', billing_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, name)
);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, plan_id uuid NOT NULL, starts_on date NOT NULL, ends_on date,
  agreed_price_cents bigint NOT NULL CHECK (agreed_price_cents >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'suspended', 'ended', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), CHECK (ends_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, plan_id) REFERENCES plans(organization_id, id)
);

CREATE TABLE financial_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('receivable', 'payable', 'both')), name text NOT NULL,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, kind, name)
);

CREATE TABLE receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, contract_id uuid, category_id uuid NOT NULL,
  original_amount_cents bigint NOT NULL CHECK (original_amount_cents > 0), currency char(3) NOT NULL DEFAULT 'BRL',
  due_on date NOT NULL, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_paid', 'paid', 'cancelled', 'overdue')),
  idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, contract_id) REFERENCES contracts(organization_id, id),
  FOREIGN KEY (organization_id, category_id) REFERENCES financial_categories(organization_id, id)
);

CREATE TABLE payables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  category_id uuid NOT NULL, counterparty text NOT NULL, description text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0), currency char(3) NOT NULL DEFAULT 'BRL',
  due_on date NOT NULL, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled', 'overdue')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, category_id) REFERENCES financial_categories(organization_id, id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  receivable_id uuid NOT NULL, reverses_payment_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0), method text NOT NULL,
  external_reference text, paid_at timestamptz NOT NULL, idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, receivable_id) REFERENCES receivables(organization_id, id),
  FOREIGN KEY (organization_id, reverses_payment_id) REFERENCES payments(organization_id, id),
  CHECK ((reverses_payment_id IS NULL AND amount_cents > 0) OR (reverses_payment_id IS NOT NULL AND amount_cents < 0))
);

CREATE UNIQUE INDEX payments_one_full_reversal
  ON payments(organization_id, reverses_payment_id) WHERE reverses_payment_id IS NOT NULL;

CREATE VIEW receivable_balances WITH (security_invoker = true) AS
SELECT r.organization_id, r.id AS receivable_id, r.original_amount_cents,
       COALESCE(sum(p.amount_cents), 0)::bigint AS paid_amount_cents,
       (r.original_amount_cents - COALESCE(sum(p.amount_cents), 0))::bigint AS balance_cents
FROM receivables r LEFT JOIN payments p
  ON p.organization_id = r.organization_id AND p.receivable_id = r.id
GROUP BY r.organization_id, r.id, r.original_amount_cents;

CREATE TABLE fiscal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'processing', 'authorized', 'rejected', 'cancellation_pending', 'cancelled', 'integration_error')),
  provider text NOT NULL, provider_document_id text, idempotency_key text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, receivable_id) REFERENCES receivables(organization_id, id)
);

CREATE UNIQUE INDEX fiscal_documents_one_authorized
  ON fiscal_documents(organization_id, receivable_id) WHERE status = 'authorized';

CREATE TABLE fiscal_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  fiscal_document_id uuid NOT NULL, attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_digest text NOT NULL, response_code text, attempted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, id),
  UNIQUE (organization_id, fiscal_document_id, attempt_number),
  FOREIGN KEY (organization_id, fiscal_document_id) REFERENCES fiscal_documents(organization_id, id)
);

CREATE TABLE fiscal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  fiscal_document_id uuid NOT NULL, event_type text NOT NULL, provider_event_id text,
  sanitized_payload jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, id),
  UNIQUE (organization_id, provider_event_id),
  FOREIGN KEY (organization_id, fiscal_document_id) REFERENCES fiscal_documents(organization_id, id)
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  storage_key text NOT NULL, media_type text NOT NULL, size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  checksum text NOT NULL, classification text NOT NULL CHECK (classification IN ('internal', 'personal', 'sensitive')),
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'rejected')),
  uploaded_by_membership_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, storage_key),
  FOREIGN KEY (organization_id, uploaded_by_membership_id) REFERENCES memberships(organization_id, id)
);

CREATE TABLE file_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  file_id uuid NOT NULL, target_type text NOT NULL CHECK (target_type IN ('clinical_record', 'assessment', 'workout_plan', 'fiscal_document')),
  target_id uuid NOT NULL, purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, file_id, target_type, target_id),
  FOREIGN KEY (organization_id, file_id) REFERENCES files(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id), channel text NOT NULL CHECK (channel IN ('push', 'email')),
  event_type text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, user_id, channel, event_type)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, event_type text NOT NULL,
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb, idempotency_key text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id), outbox_event_id uuid,
  channel text NOT NULL CHECK (channel IN ('push', 'email')),
  safe_template_key text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, outbox_event_id) REFERENCES outbox_events(organization_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_membership_id uuid, action text NOT NULL, target_type text NOT NULL, target_id uuid NOT NULL,
  minimal_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id)
);

CREATE INDEX receivables_due_idx ON receivables(organization_id, due_on, status);
CREATE INDEX payables_due_idx ON payables(organization_id, due_on, status);
CREATE INDEX outbox_pending_idx ON outbox_events(available_at) WHERE processed_at IS NULL;
CREATE INDEX audit_events_target_idx ON audit_events(organization_id, target_type, target_id, occurred_at DESC);
