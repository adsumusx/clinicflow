-- CLI-003/CLI-004: leitura eficiente de conteudo publicado e canais oficiais da clinica.
CREATE INDEX assessments_published_client_idx
  ON assessments (organization_id, client_id, assessed_at DESC, id)
  WHERE publication_status = 'published';

CREATE INDEX workout_plans_published_client_idx
  ON workout_plans (organization_id, client_id, created_at DESC, id)
  WHERE publication_status = 'published';

CREATE TABLE organization_contact_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('phone', 'email', 'whatsapp')),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  value text NOT NULL CHECK (char_length(btrim(value)) BETWEEN 3 AND 160),
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, channel),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT organization_contact_value_valid CHECK (
    (channel = 'email' AND value ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    OR (channel IN ('phone', 'whatsapp') AND value ~ '^\+?[0-9]{10,15}$')
  )
);

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON organization_contact_channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE organization_contact_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_contact_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON organization_contact_channels
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
    GRANT SELECT ON organization_contact_channels TO clinicflow_app;
  END IF;
END;
$$;
