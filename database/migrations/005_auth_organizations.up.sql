ALTER TABLE sessions
  ADD COLUMN organization_id uuid REFERENCES organizations(id);

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX password_reset_tokens_active_idx
  ON password_reset_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TRIGGER user_credentials_set_updated_at
  BEFORE UPDATE ON user_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Credenciais e recuperação são dados de plataforma. Somente o backend, usando a
-- conexão administrativa dedicada, pode consultá-los. O papel da aplicação é
-- explicitamente privado dessas tabelas, mesmo após futuros GRANTs globais.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    REVOKE ALL ON TABLE users, sessions, trusted_devices, user_credentials, password_reset_tokens FROM clinicflow_app;
  END IF;
END;
$$;
