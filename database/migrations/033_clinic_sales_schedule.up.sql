-- Venda de pacotes, serviços com preço e grades de turma recorrente.

ALTER TABLE plans
  ADD COLUMN kind text NOT NULL DEFAULT 'monthly',
  ADD COLUMN session_count integer,
  ADD COLUMN service_id uuid,
  ADD CONSTRAINT plans_kind CHECK (kind IN ('monthly', 'package')),
  ADD CONSTRAINT plans_session_count CHECK (
    (kind = 'monthly' AND session_count IS NULL)
    OR (kind = 'package' AND session_count BETWEEN 1 AND 500)
  ),
  ADD CONSTRAINT plans_service_fk
    FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id);

ALTER TABLE contracts
  ADD COLUMN session_count integer,
  ADD COLUMN professional_id uuid,
  ADD COLUMN schedule_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT contracts_session_count
    CHECK (session_count IS NULL OR session_count BETWEEN 1 AND 500),
  ADD CONSTRAINT contracts_schedule_slots_array
    CHECK (jsonb_typeof(schedule_slots) = 'array'),
  ADD CONSTRAINT contracts_professional_fk
    FOREIGN KEY (organization_id, professional_id) REFERENCES professionals (organization_id, id);

ALTER TABLE appointments
  ADD COLUMN contract_id uuid,
  ADD CONSTRAINT appointments_contract_fk
    FOREIGN KEY (organization_id, contract_id) REFERENCES contracts (organization_id, id);

CREATE INDEX appointments_contract_idx
  ON appointments (organization_id, contract_id)
  WHERE contract_id IS NOT NULL;

ALTER TABLE services
  ADD COLUMN category text,
  ADD COLUMN cost_center text,
  ADD COLUMN price_cents bigint,
  ADD CONSTRAINT services_category_length
    CHECK (category IS NULL OR char_length(btrim(category)) BETWEEN 2 AND 80),
  ADD CONSTRAINT services_cost_center_length
    CHECK (cost_center IS NULL OR char_length(btrim(cost_center)) BETWEEN 2 AND 80),
  ADD CONSTRAINT services_price_cents
    CHECK (price_cents IS NULL OR price_cents >= 0);

CREATE TABLE schedule_grids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL,
  unit_id uuid NOT NULL,
  professional_id uuid NOT NULL,
  service_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  local_start_time time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  capacity integer NOT NULL CHECK (capacity BETWEEN 2 AND 10000),
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  starts_on date NOT NULL,
  occurrence_count integer NOT NULL CHECK (occurrence_count BETWEEN 1 AND 104),
  recurrence_rule_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units (organization_id, id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id),
  FOREIGN KEY (organization_id, recurrence_rule_id) REFERENCES recurrence_rules (organization_id, id)
);

CREATE UNIQUE INDEX schedule_grids_name_unique
  ON schedule_grids (organization_id, lower(btrim(name)));

CREATE TABLE schedule_grid_services (
  organization_id uuid NOT NULL,
  grid_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (organization_id, grid_id, service_id),
  FOREIGN KEY (organization_id, grid_id) REFERENCES schedule_grids (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id)
);

ALTER TABLE schedule_grids ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_grids FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_grid_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_grid_services FORCE ROW LEVEL SECURITY;

CREATE POLICY authenticated_tenant_isolation ON schedule_grids
  USING (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  )
  WITH CHECK (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  );

CREATE POLICY authenticated_tenant_isolation ON schedule_grid_services
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_grids TO clinicflow_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_grid_services TO clinicflow_app;
  END IF;
END;
$$;
