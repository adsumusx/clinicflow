CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id uuid NOT NULL,
  email_normalized text CHECK (email_normalized IS NULL OR email_normalized = lower(email_normalized)),
  token_hash text NOT NULL UNIQUE,
  token_ciphertext text,
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, role_id) REFERENCES roles(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX organization_invitations_token_hash_idx
  ON organization_invitations (token_hash)
  WHERE status = 'pending';

CREATE INDEX organization_invitations_org_idx
  ON organization_invitations (organization_id, status);

CREATE TRIGGER organization_invitations_set_updated_at
  BEFORE UPDATE ON organization_invitations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    REVOKE ALL ON TABLE organization_invitations FROM clinicflow_app;
  END IF;
END;
$$;
